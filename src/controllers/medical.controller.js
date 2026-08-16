const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { supabaseAdmin } = require('../utils/supabase');
const { success, error } = require('../utils/response');
const { MEDICAL_EXT, MEDICAL_MIME } = require('../middleware/upload');
const { generateOtp, sendWhatsAppOTP } = require('../services/whatsapp.service');

const ALLOWED_FILE_TYPES = ['exam', 'prescription', 'lab_result', 'legal_doc', 'contract', 'id_document', 'other'];

// medical/legal record — business-owner endpoints (the doctor/lawyer who owns the booking).
// we use service-role (bypasses RLS) so we enforce ownership and permission checks in code.

const STORAGE_BUCKET = 'ahgiz-media';
const SIGNED_URL_TTL = 3600; // seconds — matches the medlegal instructions

// Customer self-service storage cap (C13.5 "My Files"): 500 MB per user.
const STORAGE_LIMIT_KB = 500 * 1024; // 512000 KB = 500 MB

// C13.5 files gate — the fallback PIN is exactly 6 digits.
const PIN_RE = /^[0-9]{6}$/;
// Cumulative failed-attempt count at which the files lock becomes permanent
// (recovery-only). Kept in sync with verify_files_pin's v_permanent.
const PIN_PERMANENT_AT = 9;
// Recovery OTP is the same 6-digit code shape produced by the shared OTP transport.
const OTP_RE = /^[0-9]{6}$/;

const RECORD_SELECT =
  'id, booking_id, doctor_id, patient_id, business_id, symptoms, diagnosis, ' +
  'prescription, notes, follow_up_date, is_visible_to_patient, created_at, updated_at';
const FILE_SELECT =
  'id, owner_id, business_id, booking_id, file_type, file_path, file_name, ' +
  'file_size_kb, mime_type, notes, created_at';

// fetches the booking and confirms it belongs to the requester's business.
async function fetchOwnedBooking(bookingId, businessId) {
  const { data, error: dbErr } = await supabaseAdmin
    .from('bookings')
    .select('id, business_id, customer_id, is_manual')
    .eq('id', bookingId)
    .maybeSingle();
  if (dbErr) throw dbErr;
  if (!data || data.business_id !== businessId) return null;
  return data;
}

// an active grant lets this business see all of the customer's files (revoked_at IS NULL and not expired).
// Single source of truth for grant validity is getActiveGrant (defined below, hoisted).
async function hasActiveGrant(patientId, businessId) {
  return (await getActiveGrant(patientId, businessId)) !== null;
}

// adds a temporary signed URL to each file (storage is private — no public links).
async function withSignedUrls(files) {
  return Promise.all(
    (files || []).map(async (f) => {
      let url = null;
      try {
        const { data } = await supabaseAdmin.storage
          .from(STORAGE_BUCKET)
          .createSignedUrl(f.file_path, SIGNED_URL_TTL);
        url = data?.signedUrl || null;
      } catch {
        url = null;
      }
      return { ...f, signed_url: url };
    })
  );
}

// Uploaded filenames arrive percent-encoded in the multipart Content-Disposition
// header (Expo SDK 56's winter fetch runs encodeURIComponent on them), so a
// non-ASCII name like "التقرير.pdf" reaches us as "%D8%A7...". Decode it back to
// the real name; fall back to the raw string if it is not valid percent-encoding
// (e.g. a filename containing a literal '%').
function decodeFileName(name) {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

// ─── Customer file contract (C13.5) ──────────────────────────────────────────
// Maps a raw user_files row to the customer-facing shape used by the "My Files"
// tab. Aliases DB columns to intentional public names: file_type -> type,
// created_at -> uploaded_at. Owner endpoints keep the raw FILE_SELECT shape.
function toClientFile(f) {
  return {
    id:           f.id,
    type:         f.file_type,
    file_name:    f.file_name,
    file_size_kb: f.file_size_kb ?? null,
    mime_type:    f.mime_type ?? null,
    uploaded_at:  f.created_at,
    signed_url:   f.signed_url ?? null,
  };
}

// Sum of file_size_kb over a set of user_files rows (null-safe).
const sumFileSizeKb = (rows) => (rows || []).reduce((sum, r) => sum + (r.file_size_kb || 0), 0);

// Total storage a user currently occupies, in KB (sum of all their files).
async function getUsedStorageKb(ownerId) {
  const { data, error: dbErr } = await supabaseAdmin
    .from('user_files')
    .select('file_size_kb')
    .eq('owner_id', ownerId);
  if (dbErr) throw dbErr;
  return sumFileSizeKb(data);
}

// Storage-usage summary returned alongside the customer file list.
function storageSummary(usedKb) {
  return {
    used_kb:  usedKb,
    limit_kb: STORAGE_LIMIT_KB,
    used_mb:  Math.round((usedKb / 1024) * 10) / 10,
    limit_mb: STORAGE_LIMIT_KB / 1024, // 500
  };
}

// ─── GET /owner/bookings/:id/medical-record ──────────────────────────────────
// returns the medical record for this booking + the patient files available to this business (with signed URLs).
exports.getRecord = async (req, res, next) => {
  try {
    const booking = await fetchOwnedBooking(req.params.id, req.business.id);
    // TODO(i18n): replace with i18n key
    if (!booking) return error(res, 'الحجز غير موجود', 404);
    if (booking.is_manual || !booking.customer_id) {
      // TODO(i18n): replace with i18n key
      return error(res, 'لا يوجد ملف طبي لحجز يدوي (بدون حساب زبون)', 400);
    }

    const { data: record, error: rErr } = await supabaseAdmin
      .from('medical_records')
      .select(RECORD_SELECT)
      .eq('booking_id', booking.id)
      .maybeSingle();
    if (rErr) throw rErr;

    // files: always those uploaded in this business's context, plus all patient files if an active grant exists.
    const granted = await hasActiveGrant(booking.customer_id, req.business.id);
    let q = supabaseAdmin
      .from('user_files')
      .select(FILE_SELECT)
      .eq('owner_id', booking.customer_id)
      .order('created_at', { ascending: false });
    if (!granted) q = q.eq('business_id', req.business.id);

    const { data: files, error: fErr } = await q;
    if (fErr) throw fErr;

    return success(res, {
      record: record || null,
      files: await withSignedUrls(files),
      access: { granted },
    });
  } catch (err) {
    next(err);
  }
};

// ─── PUT /owner/bookings/:id/medical-record ──────────────────────────────────
// create/update the booking record (upsert on booking_id).
exports.upsertRecord = async (req, res, next) => {
  try {
    const booking = await fetchOwnedBooking(req.params.id, req.business.id);
    // TODO(i18n): replace with i18n key
    if (!booking) return error(res, 'الحجز غير موجود', 404);
    if (booking.is_manual || !booking.customer_id) {
      // TODO(i18n): replace with i18n key
      return error(res, 'لا يمكن إنشاء ملف طبي لحجز يدوي', 400);
    }

    const { symptoms, diagnosis, prescription, notes, follow_up_date, is_visible_to_patient } =
      req.body || {};

    const fields = {
      symptoms:    symptoms ?? null,
      diagnosis:   diagnosis ?? null,
      prescription: prescription ?? null,
      notes:       notes ?? null,
      follow_up_date: follow_up_date || null,
      is_visible_to_patient: is_visible_to_patient !== false,
    };

    // no unique constraint on booking_id — look up the existing record then update or insert.
    const { data: existing } = await supabaseAdmin
      .from('medical_records')
      .select('id')
      .eq('booking_id', booking.id)
      .maybeSingle();

    let data, dbErr;
    if (existing) {
      ({ data, error: dbErr } = await supabaseAdmin
        .from('medical_records')
        .update({ ...fields, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
        .select(RECORD_SELECT)
        .single());
    } else {
      ({ data, error: dbErr } = await supabaseAdmin
        .from('medical_records')
        .insert({
          booking_id:  booking.id,
          doctor_id:   req.user.id,
          patient_id:  booking.customer_id,
          business_id: req.business.id,
          ...fields,
        })
        .select(RECORD_SELECT)
        .single());
    }
    if (dbErr) throw dbErr;

    // TODO(i18n): replace with i18n key
    return success(res, data, 'تم حفظ السجل الطبي');
  } catch (err) {
    next(err);
  }
};

// ─── POST /owner/bookings/:id/medical-files ──────────────────────────────────
// upload a patient file to private Storage (medical-files/) + record the path in user_files.
// only PDF/JPG/PNG/WEBP allowed (SVG blocked), max 25MB (enforced by middleware uploadMedical).
exports.uploadFile = async (req, res, next) => {
  try {
    const booking = await fetchOwnedBooking(req.params.id, req.business.id);
    // TODO(i18n): replace with i18n key
    if (!booking) return error(res, 'الحجز غير موجود', 404);
    if (booking.is_manual || !booking.customer_id) {
      // TODO(i18n): replace with i18n key
      return error(res, 'لا يمكن رفع ملفات لحجز يدوي', 400);
    }
    // TODO(i18n): replace with i18n key
    if (!req.file) return error(res, 'الملف مطلوب', 400);

    // extra type check (defense in depth — middleware already filtered)
    const ext = path.extname(req.file.originalname).toLowerCase();
    const mime = (req.file.mimetype || '').toLowerCase();
    if (ext === '.svg' || mime === 'image/svg+xml') {
      // TODO(i18n): replace with i18n key
      return error(res, 'ملفات SVG غير مسموح بها', 400);
    }
    if (!MEDICAL_EXT.includes(ext) || !MEDICAL_MIME.includes(mime)) {
      // TODO(i18n): replace with i18n key
      return error(res, 'صيغة غير مدعومة. يُسمح فقط بـ PDF, JPG, PNG, WEBP', 400);
    }

    let fileType = (req.body?.file_type || 'other').toString();
    if (!ALLOWED_FILE_TYPES.includes(fileType)) fileType = 'other';

    // private path inside the ahgiz-media bucket — no public access at all, signed URL only.
    const storagePath = `medical-files/${booking.customer_id}/${crypto.randomUUID()}${ext}`;
    const { error: upErr } = await supabaseAdmin.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, req.file.buffer, { contentType: mime, upsert: false });
    if (upErr) throw upErr;

    const { data: row, error: dbErr } = await supabaseAdmin
      .from('user_files')
      .insert({
        owner_id:     booking.customer_id,  // the file belongs to the patient
        business_id:  req.business.id,
        booking_id:   booking.id,
        file_type:    fileType,
        file_path:    storagePath,
        file_name:    decodeFileName(req.file.originalname),
        file_size_kb: Math.round(req.file.size / 1024),
        mime_type:    mime,
        uploaded_by:  req.user.id,          // the doctor/lawyer who uploaded it
        notes:        req.body?.notes || null,
      })
      .select(FILE_SELECT)
      .single();

    if (dbErr) {
      // rollback: delete the uploaded file so it does not stay orphaned in Storage
      await supabaseAdmin.storage.from(STORAGE_BUCKET).remove([storagePath]).catch(() => {});
      throw dbErr;
    }

    const [withUrl] = await withSignedUrls([row]);
    // TODO(i18n): replace with i18n key
    return success(res, withUrl, 'تم رفع الملف', 201);
  } catch (err) {
    next(err);
  }
};

// ════════════════════════════════════════════════════════════════════════════
//  Customer self-service (C13.5) — patients managing their own files.
//  service-role bypasses RLS, so ownership is enforced here: a customer may
//  only ever touch files where owner_id === their own id.
// ════════════════════════════════════════════════════════════════════════════

// ─── GET /medical/files/:userId ──────────────────────────────────────────────
exports.listMyFiles = async (req, res, next) => {
  try {
    // /files/me passes no userId; the legacy /files/:userId path must match the token identity
    if (req.params.userId !== undefined && req.params.userId !== req.user.id) {
      // TODO(i18n): replace with i18n key
      return error(res, 'لا يمكنك عرض ملفات مستخدم آخر', 403);
    }

    const { data, error: dbErr } = await supabaseAdmin
      .from('user_files')
      .select(FILE_SELECT)
      .eq('owner_id', req.user.id)
      .order('created_at', { ascending: false });

    if (dbErr) throw dbErr;

    // `data` already holds every file's size (no pagination), so sum inline
    // instead of a second round-trip. uploadMyFile still uses getUsedStorageKb.
    const signed = await withSignedUrls(data || []);
    return success(res, {
      files:   signed.map(toClientFile),
      storage: storageSummary(sumFileSizeKb(data)),
    });
  } catch (err) {
    next(err);
  }
};

// ─── POST /medical/files/upload ──────────────────────────────────────────────
// Patient uploads one of their own documents (no business/booking attached).
exports.uploadMyFile = async (req, res, next) => {
  try {
    // TODO(i18n): replace with i18n key
    if (!req.file) return error(res, 'الملف مطلوب', 400);

    // Defence in depth — middleware already filtered, re-check type here.
    const ext  = path.extname(req.file.originalname).toLowerCase();
    const mime = (req.file.mimetype || '').toLowerCase();
    if (ext === '.svg' || mime === 'image/svg+xml') {
      // TODO(i18n): replace with i18n key
      return error(res, 'ملفات SVG غير مسموح بها', 400);
    }
    if (!MEDICAL_EXT.includes(ext) || !MEDICAL_MIME.includes(mime)) {
      // TODO(i18n): replace with i18n key
      return error(res, 'صيغة غير مدعومة. يُسمح فقط بـ PDF, JPG, PNG, WEBP', 400);
    }

    // Mobile sends `type`; accept `file_type` too. Invalid → 'other'.
    let fileType = (req.body?.type || req.body?.file_type || 'other').toString();
    if (!ALLOWED_FILE_TYPES.includes(fileType)) fileType = 'other';

    // Enforce the per-user storage cap before writing anything to Storage.
    const newFileKb = Math.round(req.file.size / 1024);
    const usedKb = await getUsedStorageKb(req.user.id);
    if (usedKb + newFileKb > STORAGE_LIMIT_KB) {
      // TODO(i18n): replace with i18n key
      return error(
        res,
        'Storage limit reached (500 MB). Delete some files to free up space.',
        413,
        { code: 'storage_quota_exceeded' }
      );
    }

    const storagePath = `medical-files/${req.user.id}/${crypto.randomUUID()}${ext}`;
    const { error: upErr } = await supabaseAdmin.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, req.file.buffer, { contentType: mime, upsert: false });
    if (upErr) throw upErr;

    const { data: row, error: dbErr } = await supabaseAdmin
      .from('user_files')
      .insert({
        owner_id:     req.user.id,
        business_id:  null,
        booking_id:   null,
        file_type:    fileType,
        file_path:    storagePath,
        file_name:    decodeFileName(req.file.originalname),
        file_size_kb: Math.round(req.file.size / 1024),
        mime_type:    mime,
        uploaded_by:  req.user.id,
        notes:        req.body?.notes || null,
      })
      .select(FILE_SELECT)
      .single();

    if (dbErr) {
      await supabaseAdmin.storage.from(STORAGE_BUCKET).remove([storagePath]).catch(() => {});
      throw dbErr;
    }

    const [withUrl] = await withSignedUrls([row]);
    // TODO(i18n): replace with i18n key
    return success(res, toClientFile(withUrl), 'تم رفع الملف', 201);
  } catch (err) {
    next(err);
  }
};

// ─── GET /medical/files/:fileId/signed-url ───────────────────────────────────
exports.getMyFileSignedUrl = async (req, res, next) => {
  try {
    const { data: file, error: dbErr } = await supabaseAdmin
      .from('user_files')
      .select('id, owner_id, file_path')
      .eq('id', req.params.fileId)
      .maybeSingle();

    if (dbErr) throw dbErr;
    // TODO(i18n): replace with i18n key
    if (!file) return error(res, 'الملف غير موجود', 404);
    if (file.owner_id !== req.user.id) {
      // TODO(i18n): replace with i18n key
      return error(res, 'لا يمكنك الوصول إلى هذا الملف', 403);
    }

    const { data, error: urlErr } = await supabaseAdmin.storage
      .from(STORAGE_BUCKET)
      .createSignedUrl(file.file_path, SIGNED_URL_TTL);
    // TODO(i18n): replace with i18n key
    if (urlErr || !data?.signedUrl) return error(res, 'تعذّر إنشاء رابط الملف', 500);

    return success(res, { url: data.signedUrl });
  } catch (err) {
    next(err);
  }
};

// ─── C13.5 "My Files" biometric/PIN gate ─────────────────────────────────────
// Device-local lock over the owner's own files tab. The server's only job is to
// hold the PIN fallback and enforce the failed-attempt lockout; the identity is
// always the token holder (req.user.id), never a body-supplied id.

// ─── GET /medical/pin/status ─────────────────────────────────────────────────
// Tells the app whether the caller has enrolled, and whether PIN entry is locked.
exports.getPinStatus = async (req, res, next) => {
  try {
    const { data, error: dbErr } = await supabaseAdmin
      .from('users')
      .select('biometric_enabled, pin_hash, pin_failed_attempts, pin_locked_until')
      .eq('id', req.user.id)
      .single();
    if (dbErr) throw dbErr;

    const failed = data?.pin_failed_attempts || 0;
    const permanent = failed >= PIN_PERMANENT_AT;       // 9+ cumulative failures → permanent lock
    const lockedUntil = data?.pin_locked_until || null;
    const locked = !permanent && !!lockedUntil && new Date(lockedUntil).getTime() > Date.now();

    return success(res, {
      biometric_enabled: !!data?.biometric_enabled,
      has_pin: !!data?.pin_hash,        // never return the hash itself
      locked,
      locked_until: locked ? lockedUntil : null,
      failed_attempts: failed,          // drives the pre-attempt warning banner
      permanent,
    });
  } catch (err) {
    next(err);
  }
};

// ─── POST /medical/pin/set ───────────────────────────────────────────────────
// INITIAL enrollment only. The RPC rejects if a PIN already exists (pin_already_set)
// so this endpoint can never overwrite an existing PIN without proof — changing goes
// through /pin/change, and a forgotten PIN through /pin/recover/*. Hashing happens in
// the SECURITY DEFINER RPC (bcrypt cost 10 via pgcrypto); the raw PIN never persists.
exports.setPin = async (req, res, next) => {
  try {
    const pin = String(req.body?.pin ?? '');
    if (!PIN_RE.test(pin)) {
      // TODO(i18n): replace with i18n key
      return error(res, 'الرمز يجب أن يكون 6 أرقام', 400, { code: 'invalid_pin_format' });
    }

    const { error: rpcErr } = await supabaseAdmin.rpc('set_files_pin', {
      p_user_id: req.user.id,
      p_pin: pin,
    });
    if (rpcErr) {
      // A PIN already exists → the caller must use /pin/change (proves current PIN).
      if (String(rpcErr.message || '').includes('pin_already_set')) {
        // TODO(i18n): replace with i18n key
        return error(res, 'يوجد رمز مسبقاً — استخدم تغيير الرمز', 409, { code: 'pin_already_set' });
      }
      throw rpcErr;
    }

    // TODO(i18n): replace with i18n key
    return success(res, { ok: true }, 'تم تعيين الرمز');
  } catch (err) {
    next(err);
  }
};

// ─── POST /medical/pin/change ────────────────────────────────────────────────
// Change an existing PIN. Requires the CURRENT pin, verified + throttled inside the
// RPC (same lockout state machine as unlock) so this cannot be a brute-force oracle.
// A wrong/locked/permanent current PIN returns 200 with { ok:false, reason, ... }.
exports.changePin = async (req, res, next) => {
  try {
    const currentPin = String(req.body?.current_pin ?? '');
    const newPin = String(req.body?.new_pin ?? '');
    if (!PIN_RE.test(currentPin) || !PIN_RE.test(newPin)) {
      // TODO(i18n): replace with i18n key
      return error(res, 'الرمز يجب أن يكون 6 أرقام', 400, { code: 'invalid_pin_format' });
    }

    const { data, error: rpcErr } = await supabaseAdmin.rpc('change_files_pin', {
      p_user_id: req.user.id,
      p_current_pin: currentPin,
      p_new_pin: newPin,
    });
    if (rpcErr) throw rpcErr;

    // { ok:true } or the verify verdict ({ ok:false, reason:'invalid'|'locked'|'permanent', ... })
    return success(res, data || { ok: false, reason: 'invalid' });
  } catch (err) {
    next(err);
  }
};

// ─── POST /medical/pin/verify ────────────────────────────────────────────────
// Verify the fallback PIN. A wrong / locked PIN is NOT an HTTP error — it returns
// 200 with { ok:false, reason, ... } so the app reads it as data (attempts left,
// lockout expiry) instead of a thrown request error.
exports.verifyPin = async (req, res, next) => {
  try {
    const pin = String(req.body?.pin ?? '');
    if (!PIN_RE.test(pin)) {
      // TODO(i18n): replace with i18n key
      return error(res, 'الرمز يجب أن يكون 6 أرقام', 400, { code: 'invalid_pin_format' });
    }

    const { data, error: rpcErr } = await supabaseAdmin.rpc('verify_files_pin', {
      p_user_id: req.user.id,
      p_pin: pin,
    });
    if (rpcErr) throw rpcErr;

    // data is the RPC's jsonb verdict: { ok, reason?, attempts_left?, locked_until? }
    return success(res, data || { ok: false, reason: 'invalid' });
  } catch (err) {
    next(err);
  }
};

// ─── POST /medical/pin/biometric-unlock ──────────────────────────────────────
// Called right after a successful Face ID / Touch ID unlock. A successful biometric
// is a legitimate identity proof, so it resets the PIN failure counter + timed lock
// (same as a correct PIN) — the RPC enforces the exception that a PERMANENT lock is
// NOT cleared this way (recovery only, D2). Returns { ok:true } or { ok:false,
// reason:'permanent' } so the client blocks the unlock in the permanent case.
exports.biometricUnlock = async (req, res, next) => {
  try {
    const { data, error: rpcErr } = await supabaseAdmin.rpc('reset_pin_attempts_after_biometric', {
      p_user_id: req.user.id,
    });
    if (rpcErr) throw rpcErr;

    return success(res, data || { ok: false, reason: 'error' });
  } catch (err) {
    next(err);
  }
};

// ─── POST /medical/pin/disable ───────────────────────────────────────────────
// Turn the files lock off. Requires the current PIN (re-auth) so a bystander with
// the phone already in the app cannot silently disable it. On a wrong / locked PIN
// the verdict is relayed as-is (200) and nothing is changed.
exports.disablePin = async (req, res, next) => {
  try {
    const pin = String(req.body?.pin ?? '');
    if (!PIN_RE.test(pin)) {
      // TODO(i18n): replace with i18n key
      return error(res, 'الرمز يجب أن يكون 6 أرقام', 400, { code: 'invalid_pin_format' });
    }

    const { data, error: rpcErr } = await supabaseAdmin.rpc('verify_files_pin', {
      p_user_id: req.user.id,
      p_pin: pin,
    });
    if (rpcErr) throw rpcErr;
    if (!data?.ok) return success(res, data || { ok: false, reason: 'invalid' }); // wrong/locked → don't disable

    const { error: upErr } = await supabaseAdmin
      .from('users')
      .update({
        biometric_enabled: false,
        pin_hash: null,
        pin_failed_attempts: 0,
        pin_locked_until: null,
      })
      .eq('id', req.user.id);
    if (upErr) throw upErr;

    return success(res, { ok: true });
  } catch (err) {
    next(err);
  }
};

// ─── POST /medical/pin/recover/send ──────────────────────────────────────────
// Forgot-PIN recovery, step 1: send a one-time code to the user's REGISTERED phone
// (fetched from the DB, never body-supplied) via the existing WhatsApp/telegram-dev
// transport. Only meaningful when a PIN exists. 60s resend guard.
const RECOVERY_RESEND_MS = 60 * 1000;
const OTP_EXPIRY_MINUTES = () => parseInt(process.env.OTP_EXPIRY_MINUTES || '5', 10);

exports.recoverSend = async (req, res, next) => {
  try {
    const { data: u, error: uErr } = await supabaseAdmin
      .from('users')
      .select('phone, pin_hash')
      .eq('id', req.user.id)
      .single();
    if (uErr) throw uErr;
    if (!u?.pin_hash) {
      // TODO(i18n): replace with i18n key
      return error(res, 'لا يوجد رمز لاستعادته', 400, { code: 'no_pin' });
    }

    // Resend guard — one code per minute.
    const { data: last } = await supabaseAdmin
      .from('files_pin_recovery_otps')
      .select('created_at')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (last) {
      const elapsed = Date.now() - new Date(last.created_at).getTime();
      if (elapsed < RECOVERY_RESEND_MS) {
        const wait = Math.ceil((RECOVERY_RESEND_MS - elapsed) / 1000);
        // TODO(i18n): replace with i18n key
        return error(res, `انتظر ${wait} ثانية قبل إعادة الإرسال`, 429, { code: 'resend_wait', wait });
      }
    }

    // Invalidate any prior unused codes for this user.
    await supabaseAdmin
      .from('files_pin_recovery_otps')
      .update({ is_used: true })
      .eq('user_id', req.user.id)
      .eq('is_used', false);

    const otp = generateOtp();
    const otpHash = await bcrypt.hash(otp, 10);
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES() * 60 * 1000).toISOString();

    const { data: row, error: insErr } = await supabaseAdmin
      .from('files_pin_recovery_otps')
      .insert({ user_id: req.user.id, otp_hash: otpHash, expires_at: expiresAt })
      .select('id')
      .single();
    if (insErr) throw insErr;

    try {
      await sendWhatsAppOTP(u.phone, otp);
    } catch (waErr) {
      // Void the row so the resend guard doesn't block a user who received nothing.
      await supabaseAdmin.from('files_pin_recovery_otps').update({ is_used: true }).eq('id', row.id);
      throw waErr;
    }

    return success(res, { sent: true, expiresIn: OTP_EXPIRY_MINUTES() * 60 });
  } catch (err) {
    next(err);
  }
};

// ─── POST /medical/pin/recover/verify ────────────────────────────────────────
// Forgot-PIN recovery, step 2: verify the code and set a BRAND-NEW PIN (never the
// old one). A wrong/expired code returns 200 with { ok:false, reason, ... }.
exports.recoverVerify = async (req, res, next) => {
  try {
    const code = String(req.body?.code ?? '');
    const newPin = String(req.body?.new_pin ?? '');
    if (!OTP_RE.test(code)) {
      // TODO(i18n): replace with i18n key
      return error(res, 'رمز التحقق غير صحيح', 400, { code: 'invalid_code' });
    }
    if (!PIN_RE.test(newPin)) {
      // TODO(i18n): replace with i18n key
      return error(res, 'الرمز يجب أن يكون 6 أرقام', 400, { code: 'invalid_pin_format' });
    }

    const { data: session } = await supabaseAdmin
      .from('files_pin_recovery_otps')
      .select('*')
      .eq('user_id', req.user.id)
      .eq('is_used', false)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!session) return success(res, { ok: false, reason: 'code_expired' });

    const maxAttempts = parseInt(process.env.OTP_MAX_ATTEMPTS || '3', 10);
    if (session.attempts >= maxAttempts) {
      await supabaseAdmin.from('files_pin_recovery_otps').update({ is_used: true }).eq('id', session.id);
      return success(res, { ok: false, reason: 'too_many_attempts' });
    }

    const valid = await bcrypt.compare(code, session.otp_hash);
    if (!valid) {
      const attempts = session.attempts + 1;
      await supabaseAdmin.from('files_pin_recovery_otps').update({ attempts }).eq('id', session.id);
      return success(res, { ok: false, reason: 'invalid_code', attempts_left: maxAttempts - attempts });
    }

    // Correct code → consume it, then set the brand-new PIN + clear the lock/counter.
    await supabaseAdmin.from('files_pin_recovery_otps').update({ is_used: true }).eq('id', session.id);
    const { error: rpcErr } = await supabaseAdmin.rpc('reset_files_pin', {
      p_user_id: req.user.id,
      p_new_pin: newPin,
    });
    if (rpcErr) throw rpcErr;

    return success(res, { ok: true });
  } catch (err) {
    next(err);
  }
};

// ════════════════════════════════════════════════════════════════════════════
//  Access grants (الوصول) — Phase 2. The customer grants/revokes/lists time-boxed
//  access to their medical/legal files and reviews an audit trail of every open.
//  The business-side reads (inbound grants, a granted patient's files) and the
//  real-time file stream live here too. service-role bypasses RLS, so every
//  ownership/grant check below is enforced in code.
// ════════════════════════════════════════════════════════════════════════════

// 7-day hard cap, expressed in hours (mirrors the client-side cap).
const GRANT_MAX_HOURS = 168;

// Fetches the single active grant (not revoked, not expired) for this (patient,
// business) pair, or null. Returns the id so callers can write the access log.
async function getActiveGrant(patientId, businessId) {
  const { data, error: dbErr } = await supabaseAdmin
    .from('record_access_grants')
    .select('id, expires_at')
    .eq('owner_id', patientId)
    .eq('granted_to_business_id', businessId)
    .is('revoked_at', null)
    .maybeSingle();
  if (dbErr) throw dbErr;
  if (!data) return null;
  if (data.expires_at && new Date(data.expires_at) < new Date()) return null;
  return data;
}

// Derives the UI status of a grant row from its timestamps.
function grantStatus(row) {
  if (row.revoked_at) return 'revoked';
  if (row.expires_at && new Date(row.expires_at) < new Date()) return 'expired';
  return 'active';
}

// ─── POST /medical/access/grant ──────────────────────────────────────────────
// The customer grants a business time-boxed access to all of their files.
exports.grantAccess = async (req, res, next) => {
  try {
    const { granted_to_business_id, duration_value, duration_unit } = req.body;
    const hours = duration_unit === 'hours' ? duration_value : duration_value * 24;
    if (hours < 1 || hours > GRANT_MAX_HOURS) {
      // TODO(i18n): replace with i18n key
      return error(res, 'مدة الإذن يجب أن تكون بين ساعة و7 أيام', 400, { code: 'duration_out_of_range' });
    }

    // The grantee must be a real, active business — check explicitly rather than
    // relying on the FK to fail, so the client gets a clean error.
    const { data: biz, error: bizErr } = await supabaseAdmin
      .from('businesses')
      .select('id, is_active')
      .eq('id', granted_to_business_id)
      .maybeSingle();
    if (bizErr) throw bizErr;
    if (!biz || !biz.is_active) {
      // TODO(i18n): replace with i18n key
      return error(res, 'المحل غير موجود أو غير مفعّل', 404, { code: 'business_not_found' });
    }

    const expiresAt = new Date(Date.now() + hours * 3600 * 1000).toISOString();

    // UNIQUE (owner_id, granted_to_business_id) means a re-grant after a previous
    // revoke/expiry must reuse the existing row — a plain insert would hit a duplicate
    // key. Upsert on that constraint: refresh the window and clear any prior revocation.
    const { data: row, error: dbErr } = await supabaseAdmin
      .from('record_access_grants')
      .upsert(
        {
          owner_id:               req.user.id,
          granted_to_business_id,
          expires_at:             expiresAt,
          revoked_at:             null,
          granted_at:             new Date().toISOString(),
        },
        { onConflict: 'owner_id,granted_to_business_id' }
      )
      .select('id, granted_at, expires_at, revoked_at')
      .single();
    if (dbErr) throw dbErr;

    // TODO(i18n): replace with i18n key
    return success(res, { ...row, status: grantStatus(row) }, 'تم منح الوصول', 201);
  } catch (err) {
    next(err);
  }
};

// ─── GET /medical/access ─────────────────────────────────────────────────────
// The customer's own grants (active + expired + revoked) for the "الوصول" list.
exports.listAccess = async (req, res, next) => {
  try {
    const { data, error: dbErr } = await supabaseAdmin
      .from('record_access_grants')
      .select('id, granted_at, expires_at, revoked_at, granted_to_business_id, grantee:businesses(name)')
      .eq('owner_id', req.user.id)
      .order('granted_at', { ascending: false });
    if (dbErr) throw dbErr;

    const grants = (data || []).map((g) => ({
      id:                     g.id,
      granted_to_business_id: g.granted_to_business_id,
      grantee_name:           g.grantee?.name ?? null,
      granted_at:             g.granted_at,
      expires_at:             g.expires_at,
      revoked_at:             g.revoked_at,
      status:                 grantStatus(g),
    }));
    return success(res, { grants });
  } catch (err) {
    next(err);
  }
};

// ─── DELETE /medical/access/revoke/:id ───────────────────────────────────────
// The customer revokes one of their own grants. Idempotent: revoking an already
// revoked/absent grant returns a generic not-found.
exports.revokeAccess = async (req, res, next) => {
  try {
    const { data, error: dbErr } = await supabaseAdmin
      .from('record_access_grants')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('owner_id', req.user.id)   // only the owner may revoke their own grant
      .is('revoked_at', null)        // don't overwrite an earlier revoke time
      .select('id, granted_at, expires_at, revoked_at')
      .maybeSingle();
    if (dbErr) throw dbErr;
    if (!data) {
      // TODO(i18n): replace with i18n key
      return error(res, 'الإذن غير موجود', 404, { code: 'grant_not_found' });
    }
    // TODO(i18n): replace with i18n key
    return success(res, { ...data, status: grantStatus(data) }, 'تم سحب الإذن');
  } catch (err) {
    next(err);
  }
};

// ─── GET /medical/access/log/:grantId ────────────────────────────────────────
// Full audit trail for one grant (who opened which file, when, view/download).
// Owner-only.
exports.accessLog = async (req, res, next) => {
  try {
    // Ownership check first — the grant must belong to the requesting user.
    const { data: grant, error: gErr } = await supabaseAdmin
      .from('record_access_grants')
      .select('id')
      .eq('id', req.params.grantId)
      .eq('owner_id', req.user.id)
      .maybeSingle();
    if (gErr) throw gErr;
    if (!grant) {
      // TODO(i18n): replace with i18n key
      return error(res, 'الإذن غير موجود', 404, { code: 'grant_not_found' });
    }

    const { data, error: dbErr } = await supabaseAdmin
      .from('medical_access_log')
      .select('id, action, accessed_at, file_id, file:user_files(file_name), accessor:users(full_name)')
      .eq('grant_id', grant.id)
      .order('accessed_at', { ascending: false });
    if (dbErr) throw dbErr;

    const log = (data || []).map((r) => ({
      id:            r.id,
      action:        r.action,
      accessed_at:   r.accessed_at,
      file_name:     r.file?.file_name ?? null,
      accessor_name: r.accessor?.full_name ?? null,
    }));
    return success(res, { log });
  } catch (err) {
    next(err);
  }
};

// ─── GET /medical/access/granted-to-me ───────────────────────────────────────
// Business-side: patients who currently have an ACTIVE grant to this business.
// Requires authorize('business') + requireBusiness (req.business).
exports.listGrantedPatients = async (req, res, next) => {
  try {
    const { data, error: dbErr } = await supabaseAdmin
      .from('record_access_grants')
      .select('id, owner_id, granted_at, expires_at, patient:users(full_name)')
      .eq('granted_to_business_id', req.business.id)
      .is('revoked_at', null)
      .order('granted_at', { ascending: false });
    if (dbErr) throw dbErr;

    const now = new Date();
    const patients = (data || [])
      .filter((g) => !g.expires_at || new Date(g.expires_at) >= now) // active only
      .map((g) => ({
        grant_id:     g.id,
        patient_id:   g.owner_id,
        patient_name: g.patient?.full_name ?? null,
        granted_at:   g.granted_at,
        expires_at:   g.expires_at,
      }));
    return success(res, { patients });
  } catch (err) {
    next(err);
  }
};

// ─── GET /medical/access/patient/:patientId/files ────────────────────────────
// Business-side: file METADATA for a patient who granted this business access. No
// signed URLs — the business opens each file through the stream endpoint, which
// re-validates the grant on every request. Requires an active grant.
exports.listPatientFiles = async (req, res, next) => {
  try {
    const grant = await getActiveGrant(req.params.patientId, req.business.id);
    if (!grant) {
      // Generic — do not reveal whether the patient or their files exist.
      // TODO(i18n): replace with i18n key
      return error(res, 'لا يوجد إذن وصول فعّال', 403, { code: 'no_active_grant' });
    }
    const { data, error: dbErr } = await supabaseAdmin
      .from('user_files')
      .select('id, file_type, file_name, file_size_kb, mime_type, created_at')
      .eq('owner_id', req.params.patientId)
      .order('created_at', { ascending: false });
    if (dbErr) throw dbErr;

    const files = (data || []).map((f) => ({
      id:           f.id,
      type:         f.file_type,
      file_name:    f.file_name,
      file_size_kb: f.file_size_kb ?? null,
      mime_type:    f.mime_type ?? null,
      uploaded_at:  f.created_at,
    }));
    return success(res, { files });
  } catch (err) {
    next(err);
  }
};

// ─── GET /medical/files/:fileId/stream ───────────────────────────────────────
// Business-side real-time file access for GRANTED (third-party) reads. This replaces
// handing out a Supabase signed URL: the grant is re-validated on THIS request, an
// audit row is written BEFORE any bytes leave, and the file is piped straight from
// Storage via the service role. Revoke a grant and the very next open is rejected —
// no time-boxed credential survives revocation. ?download=true logs a 'download'.
// Requires authorize('business') + requireBusiness (req.business).
exports.streamFile = async (req, res, next) => {
  try {
    const { data: file, error: fErr } = await supabaseAdmin
      .from('user_files')
      .select('id, owner_id, file_path, file_name, mime_type')
      .eq('id', req.params.fileId)
      .maybeSingle();
    if (fErr) throw fErr;

    // Generic 403 for both "no file" and "no grant" — never leak whether the file exists.
    const grant = file ? await getActiveGrant(file.owner_id, req.business.id) : null;
    if (!file || !grant) {
      // TODO(i18n): replace with i18n key
      return error(res, 'لا يمكنك الوصول إلى هذا الملف', 403);
    }

    const action = req.query.download === 'true' ? 'download' : 'view';

    // Write the audit row BEFORE streaming begins — records the validated access even
    // if the byte transfer is later interrupted.
    const { error: logErr } = await supabaseAdmin
      .from('medical_access_log')
      .insert({ grant_id: grant.id, accessed_by: req.user.id, file_id: file.id, action });
    if (logErr) throw logErr;

    // Pull the bytes with the service role (never a public/signed URL) and pipe them.
    const { data: blob, error: dlErr } = await supabaseAdmin.storage
      .from(STORAGE_BUCKET)
      .download(file.file_path);
    if (dlErr || !blob) {
      // TODO(i18n): replace with i18n key
      return error(res, 'تعذّر تحميل الملف', 500);
    }
    const buffer = Buffer.from(await blob.arrayBuffer());

    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Cache-Control', 'private, no-store');
    if (action === 'download') {
      // RFC 5987 — file_name is frequently non-ASCII (Arabic), so percent-encode it.
      const encoded = encodeURIComponent(file.file_name || 'file');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encoded}`);
    } else {
      res.setHeader('Content-Disposition', 'inline');
    }
    return res.status(200).send(buffer);
  } catch (err) {
    next(err);
  }
};

const path = require('path');
const crypto = require('crypto');
const { supabaseAdmin } = require('../utils/supabase');
const { success, error } = require('../utils/response');
const { MEDICAL_EXT, MEDICAL_MIME } = require('../middleware/upload');

const ALLOWED_FILE_TYPES = ['exam', 'prescription', 'lab_result', 'legal_doc', 'contract', 'id_document', 'other'];

// medical/legal record — business-owner endpoints (the doctor/lawyer who owns the booking).
// we use service-role (bypasses RLS) so we enforce ownership and permission checks in code.

const STORAGE_BUCKET = 'ahgiz-media';
const SIGNED_URL_TTL = 3600; // seconds — matches the medlegal instructions

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
async function hasActiveGrant(patientId, businessId) {
  const { data, error: dbErr } = await supabaseAdmin
    .from('record_access_grants')
    .select('id, expires_at')
    .eq('owner_id', patientId)
    .eq('granted_to_business_id', businessId)
    .is('revoked_at', null)
    .maybeSingle();
  if (dbErr) throw dbErr;
  if (!data) return false;
  if (data.expires_at && new Date(data.expires_at) < new Date()) return false;
  return true;
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
// only PDF/JPG/PNG/WEBP allowed (SVG blocked), max 10MB (enforced by middleware uploadMedical).
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
        file_name:    req.file.originalname,
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

    const files = await withSignedUrls(data || []);
    return success(res, { files });
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
        file_name:    req.file.originalname,
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
    return success(res, withUrl, 'تم رفع الملف', 201);
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

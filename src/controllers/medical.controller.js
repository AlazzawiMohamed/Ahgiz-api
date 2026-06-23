const { supabaseAdmin } = require('../utils/supabase');
const { success, error } = require('../utils/response');

// الملف الطبي/القانوني — نقاط نهاية صاحب العمل (الطبيب/المحامي صاحب الحجز).
// نستخدم service-role (يتجاوز RLS) لذا نفرض التحقق من الملكية والإذن في الكود.

const STORAGE_BUCKET = 'ahgiz-media';
const SIGNED_URL_TTL = 3600; // ثانية — مطابق لتعليمات medlegal

const RECORD_SELECT =
  'id, booking_id, doctor_id, patient_id, business_id, symptoms, diagnosis, ' +
  'prescription, notes, follow_up_date, is_visible_to_patient, created_at, updated_at';
const FILE_SELECT =
  'id, owner_id, business_id, booking_id, file_type, file_path, file_name, ' +
  'file_size_kb, mime_type, notes, created_at';

// يجلب الحجز ويتأكّد أنّه يخصّ محل صاحب الطلب.
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

// إذن فعّال يمنح هذا المحل رؤية كامل ملفات الزبون (revoked_at IS NULL وغير منتهٍ).
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

// يضيف signed URL مؤقّت لكل ملف (التخزين خاص — لا روابط عامة).
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
// يُرجع السجل الطبي لهذا الحجز + ملفات المريض المتاحة لهذا المحل (مع روابط موقّعة).
exports.getRecord = async (req, res, next) => {
  try {
    const booking = await fetchOwnedBooking(req.params.id, req.business.id);
    if (!booking) return error(res, 'الحجز غير موجود', 404);
    if (booking.is_manual || !booking.customer_id) {
      return error(res, 'لا يوجد ملف طبي لحجز يدوي (بدون حساب زبون)', 400);
    }

    const { data: record, error: rErr } = await supabaseAdmin
      .from('medical_records')
      .select(RECORD_SELECT)
      .eq('booking_id', booking.id)
      .maybeSingle();
    if (rErr) throw rErr;

    // الملفات: المرفوعة في سياق هذا المحل دائماً، وكامل ملفات المريض إن وُجد إذن فعّال.
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
// إنشاء/تحديث سجل الحجز (upsert على booking_id).
exports.upsertRecord = async (req, res, next) => {
  try {
    const booking = await fetchOwnedBooking(req.params.id, req.business.id);
    if (!booking) return error(res, 'الحجز غير موجود', 404);
    if (booking.is_manual || !booking.customer_id) {
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

    // لا يوجد قيد فريد على booking_id — نبحث عن السجل القائم ثم نحدّث أو ندرج.
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

    return success(res, data, 'تم حفظ السجل الطبي');
  } catch (err) {
    next(err);
  }
};

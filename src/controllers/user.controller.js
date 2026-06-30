const { supabaseAdmin } = require('../utils/supabase');
const { success, error } = require('../utils/response');

exports.getProfile = async (req, res, next) => {
  try {
    const { data: user, error: dbErr } = await supabaseAdmin
      .from('users')
      .select('id, full_name, phone, email, role, avatar_url, province, date_of_birth, gender, preferred_payment, preferred_language, profile_completed, created_at')
      .eq('id', req.user.id)
      .is('deleted_at', null)
      .single();

    if (dbErr || !user) return error(res, 'المستخدم غير موجود', 404);

    // province is stored as a governorates.slug — attach the Arabic name for display
    let province_name = null;
    if (user.province) {
      const { data: gov } = await supabaseAdmin
        .from('governorates')
        .select('name_ar')
        .eq('slug', user.province)
        .maybeSingle();
      province_name = gov?.name_ar || null;
    }

    return success(res, { ...user, province_name });
  } catch (err) {
    next(err);
  }
};

// users.province is a FK to governorates(slug). The mobile sends the Arabic name
// (or sometimes a slug), so resolve whatever arrives to a valid slug.
const PROVINCE_SYNONYMS = { 'القادسية': 'qadisiyyah', 'الديوانية': 'qadisiyyah' };

async function resolveProvinceSlug(value) {
  if (value == null) return { slug: null };          // clearing the field is allowed
  const v = String(value).trim();
  if (!v) return { slug: null };

  const { data: rows, error: dbErr } = await supabaseAdmin
    .from('governorates')
    .select('slug, name_ar');
  if (dbErr) throw dbErr;

  const hit = (rows || []).find((g) => g.slug === v || g.name_ar === v);
  if (hit) return { slug: hit.slug };
  if (PROVINCE_SYNONYMS[v]) return { slug: PROVINCE_SYNONYMS[v] };
  return { invalid: true };
}

exports.updateProfile = async (req, res, next) => {
  try {
    const updates = {};

    // Mobile sends `name`; the column is `full_name`.
    const fullName = req.body.full_name ?? req.body.name;
    if (fullName !== undefined) updates.full_name = fullName;

    if (req.body.email !== undefined) updates.email = req.body.email;
    if (req.body.preferred_payment !== undefined) updates.preferred_payment = req.body.preferred_payment;
    if (req.body.date_of_birth !== undefined) updates.date_of_birth = req.body.date_of_birth || null;

    if (req.body.gender !== undefined) {
      if (req.body.gender !== null && !['male', 'female', 'prefer_not_to_say'].includes(req.body.gender)) {
        return error(res, 'قيمة الجنس غير صالحة', 400);
      }
      updates.gender = req.body.gender || null;
    }

    if (req.body.province !== undefined) {
      const { slug, invalid } = await resolveProvinceSlug(req.body.province);
      if (invalid) return error(res, 'المحافظة غير صالحة', 400);
      updates.province = slug;
    }

    if (req.body.preferred_language !== undefined) {
      if (!['ar', 'en', 'ku'].includes(req.body.preferred_language)) {
        return error(res, 'لغة غير صالحة', 400);
      }
      updates.preferred_language = req.body.preferred_language;
    }

    if (!Object.keys(updates).length) {
      return error(res, 'لا توجد حقول صالحة للتحديث', 400);
    }

    const { data, error: dbErr } = await supabaseAdmin
      .from('users')
      .update(updates)
      .eq('id', req.user.id)
      .select('id, full_name, phone, email, role, avatar_url, province, date_of_birth, gender, preferred_payment, preferred_language, profile_completed')
      .single();

    if (dbErr) throw dbErr;

    // Mirror getProfile: attach Arabic governorate name for display
    let province_name = null;
    if (data.province) {
      const { data: gov } = await supabaseAdmin
        .from('governorates')
        .select('name_ar')
        .eq('slug', data.province)
        .maybeSingle();
      province_name = gov?.name_ar || null;
    }

    return success(res, { ...data, province_name }, 'تم تحديث الملف الشخصي');
  } catch (err) {
    next(err);
  }
};

// Consent versions are owned by the server (single source of truth — not the client)
const CONSENT_PRIVACY_VERSION = '1.0';
const CONSENT_TERMS_VERSION   = '1.0';

// ─── POST /users/consent ──────────────────────────────────────────────────────
// Records the authenticated user's acceptance of privacy + terms. The user id
// comes from the token and the IP is captured server-side; neither is trusted
// from the request body.
exports.recordConsent = async (req, res, next) => {
  try {
    const ip = req.ip || req.headers['x-forwarded-for']?.split(',')[0] || null;

    const { error: rpcErr } = await supabaseAdmin.rpc('record_user_consent', {
      p_user_id:        req.user.id,
      p_privacy_v:      CONSENT_PRIVACY_VERSION,
      p_terms_v:        CONSENT_TERMS_VERSION,
      p_consent_method: 'checkbox',
      p_ip_address:     ip,
    });
    if (rpcErr) throw rpcErr;

    return success(res, {
      recorded: true,
      privacy_version: CONSENT_PRIVACY_VERSION,
      terms_version:   CONSENT_TERMS_VERSION,
    }, 'تم تسجيل الموافقة');
  } catch (err) {
    next(err);
  }
};

// ─── POST /users/push-token ───────────────────────────────────────────────────
// Upserts the caller's Expo push token into push_tokens (unique on `token`).
// user_id comes from the session token, never the client (Rule 1).
exports.savePushToken = async (req, res, next) => {
  try {
    const { token, platform, device_name, app_version, environment } = req.body;

    if (!token || typeof token !== 'string') {
      return error(res, 'token مطلوب', 400);
    }
    if (!['ios', 'android'].includes(platform)) {
      return error(res, 'platform يجب أن يكون ios أو android', 400);
    }
    const env = ['development', 'staging', 'production'].includes(environment)
      ? environment : 'production';

    const { error: dbErr } = await supabaseAdmin
      .from('push_tokens')
      .upsert({
        user_id:      req.user.id,
        token,
        platform,
        device_name:  device_name || null,
        app_version:  app_version || null,
        environment:  env,
        is_active:    true,
        last_used_at: new Date().toISOString(),
        updated_at:   new Date().toISOString(),
      }, { onConflict: 'token' });

    if (dbErr) throw dbErr;

    return success(res, { saved: true }, 'تم حفظ توكن الإشعارات');
  } catch (err) {
    next(err);
  }
};

exports.updateAvatar = async (req, res, next) => {
  try {
    if (!req.file) return error(res, 'الصورة مطلوبة', 400);

    const fileName = `avatars/${req.user.id}-${Date.now()}`;
    const { error: uploadErr } = await supabaseAdmin.storage
      .from('uploads')
      .upload(fileName, req.file.buffer, { contentType: req.file.mimetype, upsert: true });

    if (uploadErr) throw uploadErr;

    const { data: { publicUrl } } = supabaseAdmin.storage
      .from('uploads')
      .getPublicUrl(fileName);

    const { data, error: dbErr } = await supabaseAdmin
      .from('users')
      .update({ avatar_url: publicUrl })
      .eq('id', req.user.id)
      .select('id, avatar_url')
      .single();

    if (dbErr) throw dbErr;
    return success(res, data, 'تم تحديث الصورة الشخصية');
  } catch (err) {
    next(err);
  }
};

// POST /users/delete-account — يسجّل الطلب ويجمّد الحساب فوراً (حذف نهائي بعد 30 يوماً)
const DELETE_REASON_CODES = ['bad_experience', 'poor_performance', 'technical_issue', 'not_needed', 'other'];

exports.deleteAccount = async (req, res, next) => {
  try {
    const { reasons, details } = req.body;

    let reasonStr = null;
    if (Array.isArray(reasons)) {
      const valid = reasons.filter((r) => DELETE_REASON_CODES.includes(r));
      reasonStr = valid.length ? valid.join(',') : null;
    } else if (typeof reasons === 'string' && reasons.trim()) {
      reasonStr = reasons.trim();
    }

    const now = new Date();
    const scheduledAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

    const { error: insErr } = await supabaseAdmin
      .from('account_deletions')
      .insert({
        user_id:      req.user.id,
        reason:       reasonStr,
        details:      details || null,
        scheduled_at: scheduledAt,
      });
    if (insErr) throw insErr;

    // Freeze immediately — auth middleware blocks login once deleted_at/is_active are set
    const { error: updErr } = await supabaseAdmin
      .from('users')
      .update({ deleted_at: now.toISOString(), is_active: false })
      .eq('id', req.user.id);
    if (updErr) throw updErr;

    return success(res, { scheduled_at: scheduledAt }, 'تم استلام طلب حذف الحساب');
  } catch (err) {
    next(err);
  }
};

// GET /users/bookings — حجوزاتي مع pagination وفلتر الحالة
exports.getMyBookings = async (req, res, next) => {
  try {
    const { status, page = 1, limit = 10 } = req.query;
    const from = (page - 1) * limit;

    let query = supabaseAdmin
      .from('bookings')
      .select(`
        id, booking_date, start_time, end_time, duration, price,
        status, payment_method, payment_status, booking_type, customer_note, created_at,
        services ( id, name, duration, price ),
        businesses ( id, name, address, phone, logo_url ),
        staff ( id, name, photo_url )
      `, { count: 'exact' })
      .eq('customer_id', req.user.id)
      .order('booking_date', { ascending: false })
      .order('start_time',   { ascending: false })
      .range(from, from + parseInt(limit) - 1);

    if (status) query = query.eq('status', status);

    const { data, error: dbErr, count } = await query;
    if (dbErr) throw dbErr;

    return success(res, {
      bookings: data,
      total:    count,
      page:     +page,
      limit:    +limit,
    });
  } catch (err) {
    next(err);
  }
};

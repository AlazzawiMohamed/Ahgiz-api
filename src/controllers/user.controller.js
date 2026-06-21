const { supabaseAdmin } = require('../utils/supabase');
const { success, error } = require('../utils/response');

exports.getProfile = async (req, res, next) => {
  try {
    const { data: user, error: dbErr } = await supabaseAdmin
      .from('users')
      .select('id, full_name, phone, email, role, avatar_url, province, profile_completed, created_at')
      .eq('id', req.user.id)
      .is('deleted_at', null)
      .single();

    if (dbErr || !user) return error(res, 'المستخدم غير موجود', 404);
    return success(res, user);
  } catch (err) {
    next(err);
  }
};

exports.updateProfile = async (req, res, next) => {
  try {
    const allowed = ['full_name', 'email', 'province'];
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k) && req.body[k] !== undefined)
    );

    if (!Object.keys(updates).length) {
      return error(res, 'لا توجد حقول صالحة للتحديث', 400);
    }

    const { data, error: dbErr } = await supabaseAdmin
      .from('users')
      .update(updates)
      .eq('id', req.user.id)
      .select('id, full_name, phone, email, role, avatar_url, province, profile_completed')
      .single();

    if (dbErr) throw dbErr;
    return success(res, data, 'تم تحديث الملف الشخصي');
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

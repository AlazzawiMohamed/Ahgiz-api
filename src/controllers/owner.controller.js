const { supabaseAdmin } = require('../utils/supabase');
const { success, error } = require('../utils/response');

const OWNER_BOOKING_SELECT = `
  id, booking_date, start_time, end_time, duration, price,
  status, payment_method, payment_status, booking_type,
  customer_note, is_manual, manual_customer_name, manual_customer_phone,
  cancel_reason, created_at, updated_at,
  services ( id, name, duration, price ),
  staff ( id, name, photo_url ),
  customer:users!customer_id ( id, full_name, phone, avatar_url )
`;

const todayStr = () => new Date().toISOString().slice(0, 10);

// ─── GET /owner/dashboard ─────────────────────────────────────────────────────
exports.getDashboard = async (req, res, next) => {
  try {
    const bizId = req.business.id;
    const today = todayStr();

    // Today's bookings (all statuses)
    const { data: todayBookings = [], error: bErr } = await supabaseAdmin
      .from('bookings')
      .select('id, status, price, start_time, end_time, is_manual, manual_customer_name, services(name), staff(name), customer:users!customer_id(full_name, phone)')
      .eq('business_id', bizId)
      .eq('booking_date', today)
      .order('start_time', { ascending: true });

    if (bErr) throw bErr;

    const byStatus = (s) => todayBookings.filter(b => b.status === s);
    const todayStats = {
      date:      today,
      total:     todayBookings.length,
      pending:   byStatus('pending').length,
      confirmed: byStatus('confirmed').length,
      completed: byStatus('completed').length,
      cancelled: byStatus('cancelled').length,
      no_show:   byStatus('no_show').length,
      revenue:   byStatus('completed').reduce((sum, b) => sum + (b.price || 0), 0),
    };

    // Upcoming: next 5 active bookings from today onwards
    const { data: upcoming = [] } = await supabaseAdmin
      .from('bookings')
      .select('id, booking_date, start_time, end_time, status, price, services(name), staff(name), customer:users!customer_id(full_name, phone)')
      .eq('business_id', bizId)
      .in('status', ['pending', 'confirmed'])
      .gte('booking_date', today)
      .order('booking_date', { ascending: true })
      .order('start_time',   { ascending: true })
      .limit(5);

    // Staff count
    const { count: staffCount } = await supabaseAdmin
      .from('staff')
      .select('id', { count: 'exact', head: true })
      .eq('business_id', bizId)
      .eq('is_active', true);

    // Pending bookings total (all-time, needs owner attention)
    const { count: pendingTotal } = await supabaseAdmin
      .from('bookings')
      .select('id', { count: 'exact', head: true })
      .eq('business_id', bizId)
      .eq('status', 'pending');

    return success(res, {
      business:       { id: req.business.id, name: req.business.name },
      today:          todayStats,
      today_bookings: todayBookings,
      upcoming,
      staff_count:    staffCount ?? 0,
      pending_total:  pendingTotal ?? 0,
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /owner/bookings ──────────────────────────────────────────────────────
exports.getBookings = async (req, res, next) => {
  try {
    const { date, status, staff_id, page = 1, limit = 20 } = req.query;
    const from = (page - 1) * limit;

    let query = supabaseAdmin
      .from('bookings')
      .select(OWNER_BOOKING_SELECT, { count: 'exact' })
      .eq('business_id', req.business.id)
      .order('booking_date', { ascending: false })
      .order('start_time',   { ascending: false })
      .range(from, from + parseInt(limit) - 1);

    if (date)     query = query.eq('booking_date', date);
    if (status)   query = query.eq('status', status);
    if (staff_id) query = query.eq('staff_id', staff_id);

    const { data, error: dbErr, count } = await query;
    if (dbErr) throw dbErr;

    return success(res, { bookings: data, total: count, page: +page, limit: +limit });
  } catch (err) {
    next(err);
  }
};

// ─── Shared booking fetch + ownership check ───────────────────────────────────
const fetchBookingForOwner = async (bookingId, businessId) => {
  const { data } = await supabaseAdmin
    .from('bookings')
    .select('id, status, business_id, booking_date, start_time, price')
    .eq('id', bookingId)
    .single();

  if (!data || data.business_id !== businessId) return null;
  return data;
};

// ─── PUT /owner/bookings/:id/confirm ─────────────────────────────────────────
exports.confirmBooking = async (req, res, next) => {
  try {
    const booking = await fetchBookingForOwner(req.params.id, req.business.id);
    if (!booking) return error(res, 'الحجز غير موجود', 404);
    if (booking.status !== 'pending') {
      return error(res, `لا يمكن تأكيد حجز بحالة: ${booking.status}`, 400);
    }

    const { data, error: dbErr } = await supabaseAdmin
      .from('bookings')
      .update({ status: 'confirmed', updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select(OWNER_BOOKING_SELECT)
      .single();

    if (dbErr) throw dbErr;
    return success(res, data, 'تم تأكيد الحجز');
  } catch (err) {
    next(err);
  }
};

// ─── PUT /owner/bookings/:id/complete ────────────────────────────────────────
exports.completeBooking = async (req, res, next) => {
  try {
    const booking = await fetchBookingForOwner(req.params.id, req.business.id);
    if (!booking) return error(res, 'الحجز غير موجود', 404);
    if (booking.status !== 'confirmed') {
      return error(res, `لا يمكن إتمام حجز بحالة: ${booking.status}`, 400);
    }

    const { data, error: dbErr } = await supabaseAdmin
      .from('bookings')
      .update({ status: 'completed', updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select(OWNER_BOOKING_SELECT)
      .single();

    if (dbErr) throw dbErr;
    return success(res, data, 'تم إتمام الحجز بنجاح');
  } catch (err) {
    next(err);
  }
};

// ─── PUT /owner/bookings/:id/no-show ─────────────────────────────────────────
exports.noShowBooking = async (req, res, next) => {
  try {
    const booking = await fetchBookingForOwner(req.params.id, req.business.id);
    if (!booking) return error(res, 'الحجز غير موجود', 404);
    if (!['pending', 'confirmed'].includes(booking.status)) {
      return error(res, `لا يمكن تسجيل غياب لحجز بحالة: ${booking.status}`, 400);
    }

    const { data, error: dbErr } = await supabaseAdmin
      .from('bookings')
      .update({ status: 'no_show', updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select(OWNER_BOOKING_SELECT)
      .single();

    if (dbErr) throw dbErr;
    return success(res, data, 'تم تسجيل الغياب');
  } catch (err) {
    next(err);
  }
};

// ─── GET /owner/staff ─────────────────────────────────────────────────────────
exports.getStaff = async (req, res, next) => {
  try {
    const { data, error: dbErr } = await supabaseAdmin
      .from('staff')
      .select('id, name, photo_url, bio, is_active, sort_order, rating_avg, rating_count, instagram_url, tiktok_url, created_at')
      .eq('business_id', req.business.id)
      .order('sort_order', { ascending: true })
      .order('name',       { ascending: true });

    if (dbErr) throw dbErr;
    return success(res, data);
  } catch (err) {
    next(err);
  }
};

// ─── PUT /owner/business ──────────────────────────────────────────────────────
const OWNER_EDITABLE = [
  'name', 'description', 'bio', 'specialty',
  'phone', 'whatsapp', 'address', 'province', 'maps_url',
  'instagram_url', 'tiktok_url', 'facebook_url',
  'booking_confirmation', 'cancellation_hours',
  'min_booking_gap', 'prep_time_minutes',
  'no_last_minute', 'last_minute_hours',
  'overtime_allowed', 'waitlist_enabled',
];

exports.updateBusiness = async (req, res, next) => {
  try {
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => OWNER_EDITABLE.includes(k))
    );

    if (!Object.keys(updates).length) {
      return error(res, 'لا توجد حقول صالحة للتحديث', 400);
    }

    // Validate booking_confirmation if provided
    if (updates.booking_confirmation &&
        !['auto', 'manual'].includes(updates.booking_confirmation)) {
      return error(res, "booking_confirmation يجب أن يكون 'auto' أو 'manual'", 400);
    }

    updates.updated_at = new Date().toISOString();

    const { data, error: dbErr } = await supabaseAdmin
      .from('businesses')
      .update(updates)
      .eq('id', req.business.id)
      .select(`
        id, name, description, bio, specialty,
        phone, whatsapp, address, province, maps_url,
        logo_url, cover_url, rating_avg, rating_count,
        booking_confirmation, cancellation_hours, min_booking_gap,
        prep_time_minutes, no_last_minute, overtime_allowed, waitlist_enabled,
        instagram_url, tiktok_url, facebook_url, current_plan_code
      `)
      .single();

    if (dbErr) throw dbErr;
    return success(res, data, 'تم تحديث بيانات المحل');
  } catch (err) {
    next(err);
  }
};

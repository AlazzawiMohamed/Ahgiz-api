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
  // Sprint 4 — تتطلب migration 2026-06-23_owner_gap_endpoints.sql
  'calendar_booking_color', 'calendar_break_color',
  'rebooking_reminder_days', 'time_magnet',
];

// تحقق من صيغة لون hex (#RGB أو #RRGGBB)
const isHexColor = (v) => typeof v === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v);

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

    // Validate calendar colors if provided
    for (const key of ['calendar_booking_color', 'calendar_break_color']) {
      if (updates[key] != null && !isHexColor(updates[key])) {
        return error(res, `${key} يجب أن يكون لون hex صالح مثل #22C55E`, 400);
      }
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

// ============================================================
// Sprint 4 — Gap endpoints
// ============================================================

const NOTE_TAGS    = ['⏰', '⚡', '💰', '❌', '👻', '😊', '😤', '⚠️'];
const WARNING_TAGS = ['❌', '👻', '😤', '⚠️'];

// ─── GET /owner/bookings/calendar?date=&staff_id= ────────────────────────────
// حجوزات اليوم (عدا الملغاة) + فترات الاستراحة من ساعات العمل.
exports.getCalendar = async (req, res, next) => {
  try {
    const date = req.query.date || todayStr();
    const { staff_id } = req.query;

    let q = supabaseAdmin
      .from('bookings')
      .select(OWNER_BOOKING_SELECT)
      .eq('business_id', req.business.id)
      .eq('booking_date', date)
      .neq('status', 'cancelled')
      .order('start_time', { ascending: true });
    if (staff_id) q = q.eq('staff_id', staff_id);

    const { data: bookings, error: bErr } = await q;
    if (bErr) throw bErr;

    // ملاحظة: جدول working_hours في هذا الإصدار لا يخزّن فترات استراحة،
    // لذا breaks فارغة حتى يُضاف جدول/أعمدة الاستراحات.
    const breaks = [];

    return success(res, { date, bookings: bookings || [], breaks });
  } catch (err) {
    next(err);
  }
};

// ─── GET /owner/bookings/day-indicators?date=&staff_id= ──────────────────────
// مؤشرات كل حجز: has_note / is_loyal / has_files / has_warning.
exports.getDayIndicators = async (req, res, next) => {
  try {
    const date = req.query.date || todayStr();
    const { staff_id } = req.query;

    let q = supabaseAdmin
      .from('bookings')
      .select('id, customer_id, customer_note')
      .eq('business_id', req.business.id)
      .eq('booking_date', date);
    if (staff_id) q = q.eq('staff_id', staff_id);

    const { data: bookings, error: bErr } = await q;
    if (bErr) throw bErr;

    const customerIds = [...new Set((bookings || []).map((b) => b.customer_id).filter(Boolean))];
    const byCustomer = {};
    if (customerIds.length) {
      const { data: notes } = await supabaseAdmin
        .from('customer_notes')
        .select('customer_id, tag, is_loyal')
        .eq('business_id', req.business.id)
        .in('customer_id', customerIds);
      for (const n of notes || []) {
        const e = byCustomer[n.customer_id] || { is_loyal: false, has_warning: false };
        if (n.is_loyal) e.is_loyal = true;
        if (WARNING_TAGS.includes(n.tag)) e.has_warning = true;
        byCustomer[n.customer_id] = e;
      }
    }

    const indicators = (bookings || []).map((b) => ({
      booking_id:  b.id,
      has_note:    !!b.customer_note,
      is_loyal:    byCustomer[b.customer_id]?.is_loyal || false,
      has_files:   false, // لا يوجد جدول ملفات في هذا الإصدار من قاعدة البيانات
      has_warning: byCustomer[b.customer_id]?.has_warning || false,
    }));

    return success(res, indicators);
  } catch (err) {
    next(err);
  }
};

// ─── GET /owner/clients/:customerId/notes ────────────────────────────────────
const NOTE_SELECT = 'id, note, tag, is_loyal, loyalty_discount, created_at, updated_at';

exports.listClientNotes = async (req, res, next) => {
  try {
    const { data, error: dbErr } = await supabaseAdmin
      .from('customer_notes')
      .select(NOTE_SELECT)
      .eq('business_id', req.business.id)
      .eq('customer_id', req.params.customerId)
      .order('created_at', { ascending: false });
    if (dbErr) throw dbErr;
    return success(res, data);
  } catch (err) {
    next(err);
  }
};

// ─── POST /owner/clients/:customerId/notes ───────────────────────────────────
exports.createClientNote = async (req, res, next) => {
  try {
    const { note, tag = null, is_loyal = false } = req.body || {};
    if (!note || !String(note).trim()) return error(res, 'الملاحظة مطلوبة', 400);
    if (tag != null && !NOTE_TAGS.includes(tag)) return error(res, 'وسم غير صالح', 400);

    const { data, error: dbErr } = await supabaseAdmin
      .from('customer_notes')
      .insert({
        business_id: req.business.id,
        customer_id: req.params.customerId,
        note: String(note).trim(),
        tag,
        is_loyal: !!is_loyal,
      })
      .select(NOTE_SELECT)
      .single();
    if (dbErr) throw dbErr;
    return success(res, data, 'تمت إضافة الملاحظة', 201);
  } catch (err) {
    next(err);
  }
};

// ─── PUT /owner/clients/:customerId/notes/:noteId ────────────────────────────
exports.updateClientNote = async (req, res, next) => {
  try {
    const { note, tag, is_loyal } = req.body || {};
    if (tag != null && tag !== '' && !NOTE_TAGS.includes(tag)) {
      return error(res, 'وسم غير صالح', 400);
    }

    const updates = { updated_at: new Date().toISOString() };
    if (note != null)        updates.note = String(note).trim();
    if (tag !== undefined)   updates.tag = tag || null;
    if (is_loyal != null)    updates.is_loyal = !!is_loyal;

    const { data, error: dbErr } = await supabaseAdmin
      .from('customer_notes')
      .update(updates)
      .eq('id', req.params.noteId)
      .eq('business_id', req.business.id)
      .eq('customer_id', req.params.customerId)
      .select(NOTE_SELECT)
      .maybeSingle();
    if (dbErr) throw dbErr;
    if (!data) return error(res, 'الملاحظة غير موجودة', 404);
    return success(res, data, 'تم تحديث الملاحظة');
  } catch (err) {
    next(err);
  }
};

// ─── DELETE /owner/clients/:customerId/notes/:noteId ─────────────────────────
exports.deleteClientNote = async (req, res, next) => {
  try {
    const { data, error: dbErr } = await supabaseAdmin
      .from('customer_notes')
      .delete()
      .eq('id', req.params.noteId)
      .eq('business_id', req.business.id)
      .eq('customer_id', req.params.customerId)
      .select('id')
      .maybeSingle();
    if (dbErr) throw dbErr;
    if (!data) return error(res, 'الملاحظة غير موجودة', 404);
    return success(res, { id: data.id }, 'تم حذف الملاحظة');
  } catch (err) {
    next(err);
  }
};

// ─── PUT /owner/bookings/:id/cancel ──────────────────────────────────────────
// إلغاء صاحب العمل بسبب — عبر cancel_booking_with_fee (لا رسوم على المالك).
exports.cancelBooking = async (req, res, next) => {
  try {
    const booking = await fetchBookingForOwner(req.params.id, req.business.id);
    if (!booking) return error(res, 'الحجز غير موجود', 404);

    const reason = (req.body?.reason || '').toString().trim() || null;

    const { data, error: dbErr } = await supabaseAdmin.rpc('cancel_booking_with_fee', {
      p_booking_id:   req.params.id,
      p_cancelled_by: req.user.id,
      p_reason:       reason,
    });
    if (dbErr) throw dbErr;

    if (data && data.success === false) {
      return error(res, data.message || 'تعذّر إلغاء الحجز', 400);
    }
    return success(res, data, 'تم إلغاء الحجز');
  } catch (err) {
    next(err);
  }
};

// ─── PUT /owner/bookings/:id/reschedule ──────────────────────────────────────
// body: { booking_date, start_time } — يُعاد حساب end_time من المدة.
exports.rescheduleBooking = async (req, res, next) => {
  try {
    const { booking_date, start_time } = req.body || {};
    if (!booking_date || !start_time) {
      return error(res, 'booking_date و start_time مطلوبان', 400);
    }

    const { data: booking } = await supabaseAdmin
      .from('bookings')
      .select('id, status, business_id, duration')
      .eq('id', req.params.id)
      .single();
    if (!booking || booking.business_id !== req.business.id) {
      return error(res, 'الحجز غير موجود', 404);
    }
    if (!['pending', 'confirmed'].includes(booking.status)) {
      return error(res, `لا يمكن إعادة جدولة حجز بحالة: ${booking.status}`, 400);
    }

    const [h, m] = String(start_time).split(':').map(Number);
    const endMin = h * 60 + m + (booking.duration || 0);
    const end_time =
      `${String(Math.floor(endMin / 60) % 24).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}:00`;

    const { data, error: dbErr } = await supabaseAdmin
      .from('bookings')
      .update({ booking_date, start_time, end_time, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select(OWNER_BOOKING_SELECT)
      .single();
    if (dbErr) throw dbErr;
    return success(res, data, 'تمت إعادة جدولة الحجز');
  } catch (err) {
    next(err);
  }
};

// ─── PUT /owner/reviews/:id/reply ────────────────────────────────────────────
// body: { reply } — تتطلب migration (owner_reply, owner_reply_at).
exports.replyReview = async (req, res, next) => {
  try {
    const reply = (req.body?.reply || '').toString().trim();
    if (!reply) return error(res, 'نص الرد مطلوب', 400);

    const { data: review } = await supabaseAdmin
      .from('reviews')
      .select('id, business_id')
      .eq('id', req.params.id)
      .single();
    if (!review || review.business_id !== req.business.id) {
      return error(res, 'التقييم غير موجود', 404);
    }

    const { data, error: dbErr } = await supabaseAdmin
      .from('reviews')
      .update({ owner_reply: reply, owner_reply_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select('id, owner_reply, owner_reply_at')
      .single();
    if (dbErr) throw dbErr;
    return success(res, data, 'تم نشر الرد');
  } catch (err) {
    next(err);
  }
};

const { supabaseAdmin } = require('../utils/supabase');
const { success, error } = require('../utils/response');
const { sendWhatsAppMessage } = require('../services/whatsapp.service');

// Add minutes to a HH:MM[:SS] time string → HH:MM:SS
const addMinutes = (timeStr, mins) => {
  const [h, m] = timeStr.split(':').map(Number);
  const total = h * 60 + m + mins;
  const rh = Math.floor(total / 60) % 24;
  const rm = total % 60;
  return `${String(rh).padStart(2, '0')}:${String(rm).padStart(2, '0')}:00`;
};

const BOOKING_SELECT = `
  id, booking_date, start_time, end_time, duration, price,
  status, payment_method, payment_status, booking_type,
  customer_note, selected_addons, created_at,
  services ( id, name, duration, price ),
  businesses ( id, name, address, phone, logo_url ),
  staff ( id, name, photo_url )
`;

// ─── POST /bookings ───────────────────────────────────────────────────────────
exports.create = async (req, res, next) => {
  try {
    const {
      business_id, service_id, staff_id,
      booking_date, start_time,
      payment_method = 'cash',
      booking_type   = 'in_person',
      customer_note,
      selected_addons,
    } = req.body;

    if (!business_id || !service_id || !booking_date || !start_time) {
      return error(res, 'business_id, service_id, booking_date, start_time مطلوبة', 400);
    }

    // Validate booking_type
    if (!['in_person', 'online'].includes(booking_type)) {
      return error(res, 'booking_type يجب أن يكون in_person أو online', 400);
    }

    // Validate payment_method
    const validPayments = ['cash', 'points', 'partial_points', 'zaincash', 'asiahawala'];
    if (!validPayments.includes(payment_method)) {
      return error(res, `payment_method غير صالح`, 400);
    }

    // Validate date is not in the past
    if (new Date(booking_date) < new Date(new Date().toDateString())) {
      return error(res, 'لا يمكن الحجز في تاريخ ماضٍ', 400);
    }

    // Fetch service to get duration and validate it belongs to this business
    const { data: service, error: svcErr } = await supabaseAdmin
      .from('services')
      .select('id, duration, buffer_minutes, price')
      .eq('id', service_id)
      .eq('business_id', business_id)
      .eq('is_active', true)
      .single();

    if (svcErr || !service) return error(res, 'الخدمة غير موجودة أو غير نشطة', 404);

    // Validate staff belongs to this business (if provided)
    if (staff_id) {
      const { data: staffMember } = await supabaseAdmin
        .from('staff')
        .select('id')
        .eq('id', staff_id)
        .eq('business_id', business_id)
        .eq('is_active', true)
        .single();

      if (!staffMember) return error(res, 'الموظف غير موجود في هذا المحل', 404);
    }

    // Calculate end_time (duration + buffer)
    const totalDuration = service.duration + (service.buffer_minutes || 0);
    const end_time = addMinutes(start_time, totalDuration);

    // Validate optional add-ons (must be is_addon services of the same business)
    let addonIds = [];
    let addonSnapshot = [];
    if (selected_addons !== undefined) {
      if (!Array.isArray(selected_addons)) {
        return error(res, 'selected_addons يجب أن تكون مصفوفة', 400);
      }
      addonIds = [...new Set(selected_addons)];
      if (addonIds.length) {
        const { data: addonRows, error: addonErr } = await supabaseAdmin
          .from('services')
          .select('id, name, price, duration')
          .in('id', addonIds)
          .eq('business_id', business_id)
          .eq('is_addon', true)
          .eq('is_active', true);

        if (addonErr) throw addonErr;
        if ((addonRows?.length || 0) !== addonIds.length) {
          return error(res, 'إحدى الإضافات المختارة غير صالحة', 400);
        }
        // Snapshot stored on the booking (price frozen at booking time)
        addonSnapshot = addonRows.map(a => ({
          addon_id:      a.id,
          name:          a.name,
          price:         Number(a.price),
          duration_mins: a.duration || 0,
        }));
      }
    }

    // Final price computed server-side in the RPC (urgent surcharge + add-ons)
    const { data: priceData, error: priceErr } = await supabaseAdmin
      .rpc('calculate_booking_price', {
        p_service_id:      service_id,
        p_booking_date:    booking_date,
        p_selected_addons: addonIds,
      });

    if (priceErr) throw priceErr;
    const finalPrice = priceData?.[0]?.final_price ?? service.price;

    // Free-cancellation deadline = booking start (Iraq local, UTC+3) minus 24h
    const startAt = new Date(`${booking_date}T${start_time}+03:00`);
    const freeCancellationUntil = isNaN(startAt)
      ? null
      : new Date(startAt.getTime() - 24 * 60 * 60 * 1000).toISOString();

    // Insert — trigger trg_prevent_booking_conflict handles conflict detection
    const { data: booking, error: dbErr } = await supabaseAdmin
      .from('bookings')
      .insert({
        customer_id:    req.user.id,
        business_id,
        service_id,
        staff_id:       staff_id || null,
        booking_date,
        start_time,
        end_time,
        duration:       service.duration,
        price:          finalPrice,
        payment_method,
        booking_type,
        customer_note:  customer_note || null,
        selected_addons: addonSnapshot,
        free_cancellation_until: freeCancellationUntil,
        status:         'pending',
        payment_status: 'unpaid',
      })
      .select(BOOKING_SELECT)
      .single();

    if (dbErr) {
      // DB trigger raises P0001 on time conflict
      if (dbErr.code === '23505' || dbErr.code === 'P0001') {
        return error(res, 'هذا الموعد محجوز مسبقاً، اختر وقتاً آخر', 409);
      }
      throw dbErr;
    }

    return success(res, booking, 'تم إنشاء الحجز بنجاح', 201);
  } catch (err) {
    next(err);
  }
};

// Same fields as BOOKING_SELECT but with singular aliases the mobile app expects
// (business/service/staff) instead of the raw foreign-table names.
const MY_BOOKING_SELECT = `
  id, business_id, service_id, staff_id,
  booking_date, start_time, end_time, duration, price,
  status, payment_method, payment_status, booking_type,
  customer_note, selected_addons, created_at,
  free_cancellation_until, cancellation_requested, is_reviewed,
  service:services ( id, name, duration, price ),
  business:businesses ( id, name, address, phone, logo_url ),
  staff:staff ( id, name, photo_url )
`;

// ─── GET /bookings/my ─────────────────────────────────────────────────────────
// Customer's own bookings, split into upcoming (today onward) and past tabs.
exports.getMy = async (req, res, next) => {
  try {
    const status = req.query.status === 'past' ? 'past' : 'upcoming';
    const limit  = Math.min(parseInt(req.query.limit, 10) || 20, 50);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    // Today's date (YYYY-MM-DD) — boundary between upcoming and past tabs
    const today = new Date().toISOString().slice(0, 10);

    let query = supabaseAdmin
      .from('bookings')
      .select(MY_BOOKING_SELECT)
      .eq('customer_id', req.user.id);

    if (status === 'past') {
      query = query
        .lt('booking_date', today)
        .order('booking_date', { ascending: false })
        .order('start_time', { ascending: false });
    } else {
      query = query
        .gte('booking_date', today)
        .order('booking_date', { ascending: true })
        .order('start_time', { ascending: true });
    }

    const { data: bookings, error: dbErr } = await query
      .range(offset, offset + limit - 1);

    if (dbErr) throw dbErr;

    return success(res, bookings || []);
  } catch (err) {
    next(err);
  }
};

// ─── GET /bookings/:id ────────────────────────────────────────────────────────
exports.getById = async (req, res, next) => {
  try {
    const { data: booking, error: dbErr } = await supabaseAdmin
      .from('bookings')
      .select(BOOKING_SELECT)
      .eq('id', req.params.id)
      .single();

    if (dbErr || !booking) return error(res, 'الحجز غير موجود', 404);

    // Customer can only see their own bookings
    if (req.user.role === 'customer' && booking.customer_id !== req.user.id) {
      return error(res, 'ليس لديك صلاحية لعرض هذا الحجز', 403);
    }

    return success(res, booking);
  } catch (err) {
    next(err);
  }
};

// ─── POST /bookings/:id/confirm ───────────────────────────────────────────────
// Finalizes a pending booking and schedules all notifications exactly once.
exports.confirm = async (req, res, next) => {
  try {
    const { data: booking } = await supabaseAdmin
      .from('bookings')
      .select('id, customer_id, status')
      .eq('id', req.params.id)
      .single();

    if (!booking) return error(res, 'الحجز غير موجود', 404);

    if (req.user.role === 'customer' && booking.customer_id !== req.user.id) {
      return error(res, 'ليس لديك صلاحية لتأكيد هذا الحجز', 403);
    }

    if (['cancelled', 'completed', 'no_show'].includes(booking.status)) {
      return error(res, `لا يمكن تأكيد حجز بحالة: ${booking.status}`, 400);
    }

    // Idempotent: already confirmed → return as-is without re-scheduling notifications
    if (booking.status === 'confirmed') {
      const { data: existing } = await supabaseAdmin
        .from('bookings').select(BOOKING_SELECT).eq('id', booking.id).single();
      return success(res, existing, 'الحجز مؤكد مسبقاً');
    }

    const { data: updated, error: dbErr } = await supabaseAdmin
      .from('bookings')
      .update({ status: 'confirmed' })
      .eq('id', booking.id)
      .select(BOOKING_SELECT)
      .single();

    if (dbErr) throw dbErr;

    // Schedule all booking notifications once (WhatsApp etc.) — never built manually
    const { error: rpcErr } = await supabaseAdmin
      .rpc('schedule_booking_notifications', { p_booking_id: booking.id });
    if (rpcErr) {
      // Booking is already confirmed; don't fail the request if scheduling hiccups
      console.error('schedule_booking_notifications failed:', rpcErr.message);
    }

    return success(res, updated, 'تم تأكيد الحجز');
  } catch (err) {
    next(err);
  }
};

// ─── PUT /bookings/:id/cancel ─────────────────────────────────────────────────
const CANCEL_REASON_CODES = ['illness', 'emergency', 'booking_error', 'vacation', 'other'];

exports.cancel = async (req, res, next) => {
  try {
    const { cancel_reason_code } = req.body;

    if (cancel_reason_code && !CANCEL_REASON_CODES.includes(cancel_reason_code)) {
      return error(res, 'سبب الإلغاء غير صالح', 400);
    }

    const { data: booking } = await supabaseAdmin
      .from('bookings')
      .select('id, customer_id, status, business_id, booking_date, start_time, price')
      .eq('id', req.params.id)
      .single();

    if (!booking) return error(res, 'الحجز غير موجود', 404);

    if (req.user.role === 'customer' && booking.customer_id !== req.user.id) {
      return error(res, 'ليس لديك صلاحية لإلغاء هذا الحجز', 403);
    }

    if (['cancelled', 'completed', 'no_show'].includes(booking.status)) {
      return error(res, `لا يمكن إلغاء حجز بحالة: ${booking.status}`, 400);
    }

    const { data: updated, error: dbErr } = await supabaseAdmin
      .from('bookings')
      .update({
        status:        'cancelled',
        cancel_reason: cancel_reason_code || null,
        cancelled_by:  req.user.role === 'customer' ? 'customer' : req.user.role,
        cancelled_at:  new Date().toISOString(),
      })
      .eq('id', req.params.id)
      .select(BOOKING_SELECT)
      .single();

    if (dbErr) throw dbErr;

    return success(res, updated, 'تم إلغاء الحجز');
  } catch (err) {
    next(err);
  }
};

// ─── PUT /bookings/:id/cancel-request ─────────────────────────────────────────
// After the free window the customer can't cancel directly — they request it and
// the business owner is notified via WhatsApp to approve manually.
exports.cancelRequest = async (req, res, next) => {
  try {
    const { data: booking } = await supabaseAdmin
      .from('bookings')
      .select(`
        id, customer_id, status, booking_date, start_time, cancellation_requested,
        business:businesses ( name, owner:users!owner_id ( full_name, phone ) )
      `)
      .eq('id', req.params.id)
      .single();

    if (!booking) return error(res, 'الحجز غير موجود', 404);

    if (req.user.role === 'customer' && booking.customer_id !== req.user.id) {
      return error(res, 'ليس لديك صلاحية لهذا الحجز', 403);
    }

    if (['cancelled', 'completed', 'no_show'].includes(booking.status)) {
      return error(res, `لا يمكن طلب إلغاء حجز بحالة: ${booking.status}`, 400);
    }

    // Idempotent: already requested → succeed without re-notifying the owner
    if (booking.cancellation_requested) {
      return success(res, { id: booking.id }, 'تم إرسال طلب الإلغاء مسبقاً');
    }

    const { error: dbErr } = await supabaseAdmin
      .from('bookings')
      .update({ cancellation_requested: true })
      .eq('id', booking.id);

    if (dbErr) throw dbErr;

    // Notify the owner (best-effort — never fail the request if WhatsApp hiccups)
    const ownerPhone = booking.business?.owner?.phone;
    if (ownerPhone) {
      const msg =
        `🔔 طلب إلغاء حجز\n\n` +
        `العميل يطلب إلغاء حجزه في "${booking.business?.name || ''}"\n` +
        `📅 ${booking.booking_date} • ${String(booking.start_time).slice(0, 5)}\n\n` +
        `راجع التطبيق للموافقة أو الرفض.`;
      try {
        await sendWhatsAppMessage(ownerPhone, msg);
      } catch (waErr) {
        console.error('cancel-request owner notify failed:', waErr.message);
      }
    }

    return success(res, { id: booking.id }, 'تم إرسال طلب الإلغاء');
  } catch (err) {
    next(err);
  }
};

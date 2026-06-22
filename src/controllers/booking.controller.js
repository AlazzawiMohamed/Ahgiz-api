const { supabaseAdmin } = require('../utils/supabase');
const { success, error } = require('../utils/response');

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
exports.cancel = async (req, res, next) => {
  try {
    const { reason } = req.body;

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
        status:      'cancelled',
        cancel_reason: reason || null,
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

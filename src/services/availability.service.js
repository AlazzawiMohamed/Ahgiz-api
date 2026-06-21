const { supabaseAdmin } = require('../utils/supabase');

// Converts "HH:MM:SS" or "HH:MM" to total minutes since midnight
const toMinutes = (t) => {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

// Formats total minutes to "HH:MM:SS"
const toTimeStr = (mins) => {
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
};

// day_of_week: 0=Sun, 1=Mon, ..., 6=Sat (matches PostgreSQL's EXTRACT(DOW))
const getDayOfWeek = (dateStr) => new Date(dateStr + 'T00:00:00').getDay();

/**
 * Generate available time slots for a business/staff/service on a given date.
 * Mirrors the logic in the get_available_slots PL/pgSQL function.
 *
 * @returns {Array<{slot_start, slot_end, is_free}>}
 */
const getAvailableSlots = async ({
  businessId, staffId, date, durationMins, slotIntervalMins = 30,
}) => {
  const dayOfWeek = getDayOfWeek(date);
  const isToday   = date === new Date().toISOString().slice(0, 10);

  // ① Business working hours for this day
  const { data: bh } = await supabaseAdmin
    .from('working_hours')
    .select('start_time, end_time, is_closed')
    .eq('business_id', businessId)
    .eq('day_of_week', dayOfWeek)
    .eq('is_active', true)
    .limit(1)
    .single();

  if (!bh || bh.is_closed) return [];

  // ② Check business closures (holidays etc.)
  const { data: closure } = await supabaseAdmin
    .from('business_closures')
    .select('id')
    .eq('business_id', businessId)
    .lte('start_date', date)
    .gte('end_date', date)
    .limit(1)
    .single();

  if (closure) return [];

  // ③ Determine work window — intersect business hours with staff schedule
  let workStart = toMinutes(bh.start_time);
  let workEnd   = toMinutes(bh.end_time);

  if (staffId) {
    const { data: ss } = await supabaseAdmin
      .from('staff_schedules')
      .select('start_time, end_time, is_working')
      .eq('staff_id', staffId)
      .eq('day_of_week', dayOfWeek)
      .eq('is_working', true)
      .limit(1)
      .single();

    if (ss) {
      workStart = Math.max(workStart, toMinutes(ss.start_time));
      workEnd   = Math.min(workEnd,   toMinutes(ss.end_time));
    }

    // ④ Staff time-off
    const { data: timeOff } = await supabaseAdmin
      .from('staff_time_off')
      .select('id')
      .eq('staff_id', staffId)
      .lte('date', date)
      .gte('end_date', date)
      .eq('status', 'approved')
      .limit(1)
      .single();

    if (timeOff) return [];
  }

  if (workStart >= workEnd) return [];

  // ⑤ Skip past times when date is today
  let currentStart = workStart;
  if (isToday) {
    const now = new Date();
    const nowMins = now.getHours() * 60 + now.getMinutes() + 30; // +30 min buffer
    currentStart = Math.max(currentStart, nowMins);
  }

  // ⑥ Fetch existing bookings to check conflicts
  let bookingsQuery = supabaseAdmin
    .from('bookings')
    .select('start_time, end_time, service_id, services(buffer_minutes)')
    .eq('business_id', businessId)
    .eq('booking_date', date)
    .in('status', ['pending', 'confirmed']);

  if (staffId) bookingsQuery = bookingsQuery.eq('staff_id', staffId);

  const { data: existingBookings = [] } = await bookingsQuery;

  // Precompute existing booked windows (with buffer)
  const bookedWindows = existingBookings.map(b => ({
    start: toMinutes(b.start_time),
    end:   toMinutes(b.end_time) + (b.services?.buffer_minutes || 0),
  }));

  // ⑦ Generate slots
  const slots = [];
  while (currentStart + durationMins <= workEnd) {
    const slotEnd = currentStart + durationMins;

    const isFree = !bookedWindows.some(w => currentStart < w.end && slotEnd > w.start);

    slots.push({
      slot_start: toTimeStr(currentStart),
      slot_end:   toTimeStr(slotEnd),
      is_free:    isFree,
    });

    currentStart += slotIntervalMins;
  }

  return slots;
};

module.exports = { getAvailableSlots };

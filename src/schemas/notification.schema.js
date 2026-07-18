const { z, uuid, requiredMedium, isoDateTime, nullish } = require('./common');

// Kept identical to the controller's VALID_* lists.
const VALID_TYPES = [
  'booking_confirmed', 'booking_reminder_24h', 'booking_reminder_2h',
  'booking_cancelled', 'waitlist_available', 'rebooking_reminder',
  'review_request', 'receipt', 'meeting_link', 'new_booking',
  'booking_cancelled_by_customer', 'daily_summary', 'no_show_alert',
  'attendance_confirmation_required', 'grace_period_started',
  'reschedule_requested', 'reschedule_approved', 'reschedule_rejected',
  'account_recovery_approved', 'account_recovery_rejected',
];
const VALID_CHANNELS   = ['whatsapp', 'push', 'in_app', 'both'];
const VALID_PRIORITIES = ['critical', 'high', 'normal', 'low'];

// POST /notifications/send (admin only)
const send = z.object({
  user_id:  uuid,
  type:     z.enum(VALID_TYPES),
  message:  requiredMedium,
  channel:  z.enum(VALID_CHANNELS).optional(),
  priority: z.enum(VALID_PRIORITIES).optional(),
  booking_id:   nullish(uuid),
  scheduled_at: nullish(isoDateTime),
});

module.exports = { send };

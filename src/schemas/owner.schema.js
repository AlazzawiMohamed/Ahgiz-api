const {
  z, shortText, mediumText, longText, requiredMedium,
  nonNegativeNumber, dateOnly, timeOnly, nullish,
} = require('./common');

// Client-note tags — kept identical to the controller's NOTE_TAGS list.
const NOTE_TAGS = ['⏰', '⚡', '💰', '❌', '👻', '😊', '😤', '⚠️'];

// PUT /owner/business — matches the controller's OWNER_EDITABLE allowlist exactly.
// Notes on a few fields:
//   - phone / whatsapp are stored raw and may be landline / non-mobile numbers, so they
//     are length-checked but NOT forced into the Iraqi-mobile format.
//   - calendar colors are length-checked here; the controller enforces the exact hex format.
//   - time_magnet's column type could not be confirmed from the repo, so it accepts a
//     boolean or a non-negative number and rejects anything else.
const updateBusiness = z.object({
  name:        shortText.optional(),
  description: mediumText.optional(),
  bio:         longText.optional(),
  specialty:   shortText.optional(),
  phone:       shortText.optional(),
  whatsapp:    shortText.optional(),
  address:     mediumText.optional(),
  province:    shortText.optional(),
  maps_url:      mediumText.optional(),
  instagram_url: mediumText.optional(),
  tiktok_url:    mediumText.optional(),
  facebook_url:  mediumText.optional(),
  booking_confirmation: z.enum(['auto', 'manual']).optional(),
  cancellation_hours: nonNegativeNumber.optional(),
  min_booking_gap:    nonNegativeNumber.optional(),
  prep_time_minutes:  nonNegativeNumber.optional(),
  no_last_minute:     z.boolean().optional(),
  last_minute_hours:  nonNegativeNumber.optional(),
  overtime_allowed:   z.boolean().optional(),
  waitlist_enabled:   z.boolean().optional(),
  calendar_booking_color: shortText.optional(),
  calendar_break_color:   shortText.optional(),
  rebooking_reminder_days: nonNegativeNumber.optional(),
  time_magnet: z.union([z.boolean(), nonNegativeNumber]).optional(),
});

// PUT /owner/bookings/:id/cancel
const cancelBooking = z.object({
  reason: nullish(mediumText),
});

// PUT /owner/bookings/:id/reschedule
const rescheduleBooking = z.object({
  booking_date: dateOnly,
  start_time:   timeOnly,
});

// POST /owner/clients/:customerId/notes
const createClientNote = z.object({
  note:     requiredMedium,
  tag:      nullish(z.enum(NOTE_TAGS)),
  is_loyal: z.boolean().optional(),
});

// PUT /owner/clients/:customerId/notes/:noteId
// The controller treats an empty-string tag as "clear", so '' is allowed in addition
// to a valid tag or null.
const updateClientNote = z.object({
  note:     mediumText.optional(),
  tag:      nullish(z.union([z.enum(NOTE_TAGS), z.literal('')])),
  is_loyal: z.boolean().optional(),
});

// PUT /owner/reviews/:id/reply
const replyReview = z.object({
  reply: requiredMedium,
});

// PUT /owner/bookings/:id/medical-record (medical.controller.upsertRecord)
// Clinical free text can be long, so the text fields use the long tier.
const upsertMedicalRecord = z.object({
  symptoms:     nullish(longText),
  diagnosis:    nullish(longText),
  prescription: nullish(longText),
  notes:        nullish(longText),
  follow_up_date: nullish(dateOnly),
  is_visible_to_patient: z.boolean().optional(),
});

// POST /owner/bookings/:id/medical-files (multipart; validated AFTER multer)
// file_type stays permissive because the controller coerces any unknown value to 'other'.
const uploadMedicalFile = z.object({
  file_type: shortText.optional(),
  notes:     nullish(mediumText),
});

module.exports = {
  updateBusiness,
  cancelBooking,
  rescheduleBooking,
  createClientNote,
  updateClientNote,
  replyReview,
  upsertMedicalRecord,
  uploadMedicalFile,
};

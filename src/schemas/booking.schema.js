const { z, uuid, dateOnly, timeOnly, mediumText, nullish } = require('./common');

// POST /bookings
// payment_method / booking_type are optional (the controller supplies defaults) but,
// when present, must be one of the values the controller already whitelists.
const create = z.object({
  business_id: uuid,
  service_id:  uuid,
  staff_id:    uuid.optional(),
  booking_date: dateOnly,
  start_time:   timeOnly,
  payment_method: z.enum(['cash', 'points', 'partial_points', 'zaincash', 'asiahawala']).optional(),
  booking_type:   z.enum(['in_person', 'online']).optional(),
  customer_note:  mediumText.optional(),
  selected_addons: z.array(uuid).optional(),
});

// PUT /bookings/:id/cancel — reason is optional free text (controller trims + caps at 200).
const cancel = z.object({
  cancel_reason_code: nullish(mediumText),
});

module.exports = { create, cancel };

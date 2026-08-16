const { z, uuid, positiveInt } = require('./common');

// POST /medical/access/grant — a patient grants a business time-boxed access to their
// medical/legal files. Shape validation only: the duration -> hours conversion and the
// 1..168h (7-day) cap are enforced in the controller so the specific
// `duration_out_of_range` error code can be returned (the shared validate middleware
// only emits a generic `validation_error`).
const grantAccess = z.object({
  granted_to_business_id: uuid,
  duration_value:         positiveInt,
  duration_unit:          z.enum(['hours', 'days']),
});

module.exports = { grantAccess };

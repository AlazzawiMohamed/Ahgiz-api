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

// DELETE /medical/access/:id/dismiss — route param only (validated via
// validateParams, not validate, since the id arrives on req.params not req.body).
// Uses the shared shape-only `uuid` helper deliberately: z.string().uuid() enforces
// the RFC version/variant nibbles and rejects this system's seed ids.
const dismissGrantParams = z.object({ id: uuid });

module.exports = { grantAccess, dismissGrantParams };

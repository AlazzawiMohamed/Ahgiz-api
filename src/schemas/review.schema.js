const { z, uuid, mediumText } = require('./common');

// Ratings: integers 1..5. Coerced so a numeric string is accepted, matching the
// controller which does Number(business_rating).
const rating = z.coerce.number().int().min(1).max(5);

// POST /reviews
// The controller reads business_comment OR the mobile alias `comment`, so BOTH are
// declared here (strip would otherwise remove whichever the client sent).
const create = z.object({
  booking_id:      uuid,
  business_rating: rating,
  staff_id:        uuid.optional(),
  staff_rating:    rating.optional(),
  business_comment: mediumText.optional(),
  comment:          mediumText.optional(), // mobile alias for business_comment
});

module.exports = { create };

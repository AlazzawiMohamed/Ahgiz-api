const { z, requiredShort, shortText, mediumText, uuid, positiveNumber, positiveInt } = require('./common');

// POST /services — controller requires business_id, name, price, duration (rejects
// falsy/zero price and duration, so positive validation matches existing behavior).
const create = z.object({
  business_id: uuid,
  name:        requiredShort,
  description: mediumText.optional(),
  price:       positiveNumber,
  duration:    positiveInt,
  category:    shortText.optional(),
});

// PUT /services/:id — controller allowlist: name, description, price, duration, category, is_active.
const update = z.object({
  name:        shortText.optional(),
  description: mediumText.optional(),
  price:       positiveNumber.optional(),
  duration:    positiveInt.optional(),
  category:    shortText.optional(),
  is_active:   z.boolean().optional(),
});

module.exports = { create, update };

const { z, shortText, longText, token, dateOnly, nullish } = require('./common');

// PUT /users/profile
// The controller reads full_name OR the mobile alias `name`, so BOTH must be declared
// (otherwise strip would drop `name` and the update would silently lose the value).
// province / preferred_payment / date_of_birth / email accept an explicit null to clear.
const updateProfile = z.object({
  full_name: shortText.optional(),
  name:      shortText.optional(), // mobile alias for full_name
  email:     nullish(shortText),   // stored as-is by the controller; not format-checked to avoid breakage
  preferred_payment: nullish(shortText),
  date_of_birth:     nullish(dateOnly),
  gender:    nullish(z.enum(['male', 'female', 'prefer_not_to_say'])),
  province:  nullish(shortText),   // slug or Arabic name; the controller resolves it to a slug
  preferred_language: z.enum(['ar', 'en', 'ku']).optional(),
});

// POST /users/push-token
const pushToken = z.object({
  token,
  platform: z.enum(['ios', 'android']),
  device_name: shortText.optional(),
  app_version: shortText.optional(),
  // environment is permissive: the controller defaults any unknown value to 'production'
  // rather than rejecting it, so validating strictly here would change that behavior.
  environment: shortText.optional(),
});

// POST /users/delete-account
// reasons may be an array of reason codes or a free-text string; the controller filters
// array entries against its own code list, so we do not enum-restrict them here.
const deleteAccount = z.object({
  reasons: z.union([z.array(shortText), shortText]).optional(),
  details: nullish(longText),
});

module.exports = { updateProfile, pushToken, deleteAccount };

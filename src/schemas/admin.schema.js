const {
  z, shortText, mediumText, requiredShort, requiredMedium,
  uuid, nonNegativeNumber, isoDateTime, nullish,
} = require('./common');

// A required free-text reason. Reused by:
//   PUT /admin/businesses/:id/suspend
//   PUT /admin/users/:id/suspend
//   PUT /admin/bookings/:id/cancel
//   PUT /admin/withdrawals/:id/reject
const reasonRequired = z.object({
  reason: requiredMedium,
});

// DELETE /admin/businesses/:id — reason is optional here.
const deleteBusiness = z.object({
  reason: mediumText.optional(),
});

// ── Categories (controller allowlist CATEGORY_FIELDS) ──
const categoryOptional = {
  name_en:   shortText.optional(),
  icon_url:  mediumText.optional(),
  color_dark:    shortText.optional(),
  color_primary: shortText.optional(),
  color_accent:  shortText.optional(),
  color_bg:      shortText.optional(),
  is_active:  z.boolean().optional(),
  sort_order: nonNegativeNumber.optional(),
  supports_online: z.boolean().optional(),
  requires_staff:  z.boolean().optional(),
};
const createCategory = z.object({ name_ar: requiredShort, ...categoryOptional });
const updateCategory = z.object({ name_ar: shortText.optional(), ...categoryOptional });

// ── Subscription plans (controller allowlist PLAN_FIELDS) ──
// category_id references categories(id); that table's column type is not defined in the
// repo (created directly in Supabase), so it is validated as a bounded string rather than
// a strict uuid to avoid rejecting a valid id.
const planOptional = {
  description_ar: mediumText.optional(),
  price_monthly:  nonNegativeNumber.optional(),
  price_yearly:   nonNegativeNumber.optional(),
  includes_reviews:   z.boolean().optional(),
  includes_online:    z.boolean().optional(),
  includes_analytics: z.boolean().optional(),
  includes_ads:       z.boolean().optional(),
  includes_priority:  z.boolean().optional(),
  max_staff:            nonNegativeNumber.optional(),
  max_services:         nonNegativeNumber.optional(),
  max_bookings_monthly: nonNegativeNumber.optional(),
  is_active:  z.boolean().optional(),
  sort_order: nonNegativeNumber.optional(),
};
const createPlan = z.object({
  category_id: requiredShort,
  plan_code:   requiredShort,
  name_ar:     requiredShort,
  ...planOptional,
});
const updatePlan = z.object({
  category_id: shortText.optional(),
  plan_code:   shortText.optional(),
  name_ar:     shortText.optional(),
  ...planOptional,
});

// ── Ads (controller allowlist AD_FIELDS) ──
// `type` is required for create but its value is not restricted (the controller only
// checks presence). business_id's column type is not defined in the repo, so it is a
// bounded string rather than a strict uuid.
const adOptional = {
  business_id: nullish(shortText),
  title:       shortText.optional(),
  image_url:   mediumText.optional(),
  target_url:  mediumText.optional(),
  starts_at:   nullish(isoDateTime),
  ends_at:     nullish(isoDateTime),
  is_active:   z.boolean().optional(),
  is_free:     z.boolean().optional(),
};
const createAd = z.object({ type: requiredShort, ...adOptional });
const updateAd = z.object({ type: shortText.optional(), ...adOptional });

// PUT /admin/reports/:id/resolve — status optional (controller defaults to 'resolved').
const resolveReport = z.object({
  status: z.enum(['reviewed', 'resolved', 'dismissed']).optional(),
});

// PUT /admin/settings/:key — value is required and may be a string, number, or boolean
// (the controller stringifies it). Objects/arrays/undefined are rejected.
const updateSetting = z.object({
  value: z.union([z.string().trim().max(2000), z.number(), z.boolean()]),
});

module.exports = {
  reasonRequired,
  deleteBusiness,
  createCategory,
  updateCategory,
  createPlan,
  updatePlan,
  createAd,
  updateAd,
  resolveReport,
  updateSetting,
};

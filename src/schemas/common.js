const { z } = require('zod');
const { normalizeIraqiPhone } = require('../utils/phone');

// Shared Zod building blocks for request-body validation.
//
// Length tiers (project rule):
//   short text  (names, codes)         -> max 100
//   medium text (descriptions, notes)  -> max 500
//   long text   (bio, details)         -> max 2000
// Every string is trimmed first, so length checks apply to the trimmed value and
// leading/trailing whitespace can never pad a value past a limit.

const shortText  = z.string().trim().max(100);
const mediumText = z.string().trim().max(500);
const longText   = z.string().trim().max(2000);

// Required (non-empty after trim) string variants.
const requiredShort  = z.string().trim().min(1).max(100);
const requiredMedium = z.string().trim().min(1).max(500);

// Opaque tokens / references / secrets. These are NOT "short text": refresh tokens
// are 128 hex chars, push tokens and hawala references vary, so they get a generous
// upper bound rather than the 100-char name limit.
const token = z.string().trim().min(1).max(512);

// Numbers. Everything must be finite. Counts, prices, and time settings are
// non-negative (0 is a legitimate value, e.g. cancellation_hours = 0), so we use
// .nonnegative() rather than .positive() for those; genuinely positive-only values
// (ratings, durations) use the stricter helpers where they are declared.
// z.coerce accepts both JSON numbers and numeric strings, matching the existing
// controllers which pass these straight to Postgres.
const nonNegativeNumber = z.coerce.number().finite().nonnegative();
const positiveNumber    = z.coerce.number().finite().positive();
const positiveInt       = z.coerce.number().int().positive();

// UUIDs — shape-only (8-4-4-4-12 hex), NOT RFC 4122-strict. Postgres `uuid` columns
// accept any hex in this grouping regardless of version/variant nibbles, and this
// system's seed ids exploit that (e.g. b0000003-0000-0000-0000-000000000003, version
// nibble 0). Zod v4's z.string().uuid() enforces the RFC version/variant and rejected
// every such id — which took down all booking creation (business_id). Validate the
// shape, not the RFC class.
const uuid = z.string().trim().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  'Invalid id'
);

// Dates — ISO 8601.
//   dateOnly    -> YYYY-MM-DD               (booking_date, date_of_birth, follow_up_date)
//   timeOnly    -> HH:MM or HH:MM:SS        (start_time)
//   isoDateTime -> ISO 8601 date OR datetime with optional offset (scheduled_at, ad windows)
const dateOnly = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected date as YYYY-MM-DD');
const timeOnly = z.string().trim().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Expected time as HH:MM');
const isoDateTime = z
  .string()
  .trim()
  .regex(
    /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/,
    'Expected an ISO 8601 date or datetime'
  );

// Iraqi mobile phone — validated and normalized to the canonical 9647XXXXXXXXX form
// via the existing single source of truth. Invalid numbers are rejected; valid ones
// reach the controller already normalized (its own re-normalization is idempotent).
const iraqiPhone = z
  .string()
  .trim()
  .refine((v) => normalizeIraqiPhone(v) !== null, { message: 'Invalid Iraqi phone number' })
  .transform((v) => normalizeIraqiPhone(v));

// Allow an explicit null (clearing a field) in addition to omission.
const nullish = (schema) => schema.nullable().optional();

module.exports = {
  z,
  shortText,
  mediumText,
  longText,
  requiredShort,
  requiredMedium,
  token,
  nonNegativeNumber,
  positiveNumber,
  positiveInt,
  uuid,
  dateOnly,
  timeOnly,
  isoDateTime,
  iraqiPhone,
  nullish,
};

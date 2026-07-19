// Canonical Iraqi phone handling — the single source of truth.
//
// Both the value persisted to the database (via whatsapp.service / auth.controller) and the
// OTP rate-limit key (via auth.routes) are derived from normalizeIraqiPhone, so a limiter
// key can never drift from the phone an account is actually stored under.

// Canonical form: 964 + 7 + 9 digits = 13 digits.
// Operator prefixes after 964: 75x Korek, 760 Alkafeel, 77x Asiacell, 78x/79x Zain.
const IRAQI_MOBILE = /^9647[5-9]\d{8}$/;

// Accepts 07XXXXXXXXX, +9647XXXXXXXXX, 009647XXXXXXXXX and the bare 7XXXXXXXXX form, with
// or without spaces, dashes and parentheses. Returns the canonical 9647XXXXXXXXX form, or
// null when the input is not a valid Iraqi mobile number.
const normalizeIraqiPhone = (raw) => {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;

  // Also drops the leading '+', so the '+964' prefix is handled by the '964' branch below.
  const digits = String(raw).replace(/\D/g, '');

  let local;
  if (digits.startsWith('00964')) local = digits.slice(5); // must precede the '0' branch
  else if (digits.startsWith('964')) local = digits.slice(3);
  else if (digits.startsWith('0')) local = digits.slice(1);
  else local = digits; // already bare: 7XXXXXXXXX

  const candidate = `964${local}`;
  return IRAQI_MOBILE.test(candidate) ? candidate : null;
};

module.exports = { normalizeIraqiPhone };

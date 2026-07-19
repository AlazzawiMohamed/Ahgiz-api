const rateLimit = require('express-rate-limit');
const { normalizeIraqiPhone } = require('../utils/phone');

// Every rate limiter in the API is defined here, so the budgets can be read side by side
// rather than hunted down across app.js and the route files.
//
// All of these depend on req.ip being the real client address — i.e. on
// app.set('trust proxy', TRUST_PROXY_HOPS) in app.js. Get that wrong and the per-IP
// limiters collapse into a single global bucket, where one stranger can exhaust the budget
// for everyone. See the comment in app.js.
//
// Where no keyGenerator is given, express-rate-limit keys on req.ip by default. That
// default is deliberate: it masks IPv6 addresses to a subnet, which a hand-written
// `(req) => req.ip` does not — an IPv6 client would otherwise get a fresh bucket per
// address from a range it already controls.

// Global ceiling across the whole API — a backstop, not the real per-endpoint defence.
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 100 : 1000,
  // `code` is the i18n key clients should render; `message` is the English fallback for
  // clients that have not migrated to it yet. Drop `message` once they all read `code`.
  message: {
    status:  'error',
    code:    'too_many_requests',
    message: 'Too many requests, please try again later',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// OTP send/verify. Keyed on the *normalized* phone: keying on the raw string let one number
// be spent several times over by re-typing it in another format (07.., +964.., or with
// spaces or dashes), each spelling opening a fresh bucket for the same account.
const otpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  keyGenerator: (req) => {
    const raw = req.body?.phone;
    if (raw === undefined || raw === null || raw === '') return req.ip;
    // A non-Iraqi number normalizes to null; key it on its raw string so it is still
    // rate-limited rather than blocked outright.
    return normalizeIraqiPhone(raw) ?? String(raw);
  },
  // TODO(i18n): replace with i18n key
  message: { status: 'error', message: 'طلبات كثيرة جداً، حاول بعد ساعة' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Admin password login. Until this existed the password could be guessed indefinitely:
// there is no per-account attempt counter on /admin/auth/login, only a bcrypt compare.
const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: {
    status:      'error',
    message:     'Too many attempts — try again in 15 minutes',
    error:       'too_many_requests',
    retry_after: '15 minutes',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Admin 2FA. Tighter than login: the code is only six digits, so a wider budget here buys
// an attacker far more than it does against a password.
const adminVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  message: {
    status:      'error',
    message:     'Too many attempts — try again in 15 minutes',
    error:       'too_many_requests',
    retry_after: '15 minutes',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Layer 3 break-glass code. The code itself is single-use forever, so the risk here is not
// replay (the database blocks that) but blind guessing. Counts successes as well as
// failures — a successful break-glass only ever happens once anyway.
//
// This slows guessing down but does not prevent it: make the code high-entropy (32+ random
// characters) — that is the real guard, and the limiter is a layer on top of it, not a
// substitute for it. Without a correct trust proxy setting, a single stranger can burn all
// five attempts and lock the owner out of their last way in.
const breakglassLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // one hour
  max: 5,
  message: {
    status: 'error',
    message: 'Too many emergency code attempts — try again in an hour',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = {
  globalLimiter,
  otpLimiter,
  adminLoginLimiter,
  adminVerifyLimiter,
  breakglassLimiter,
};

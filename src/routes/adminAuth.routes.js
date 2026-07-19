const express = require('express');
const router = express.Router();
const adminAuthController = require('../controllers/adminAuth.controller');
const {
  adminLoginLimiter,
  adminVerifyLimiter,
  breakglassLimiter,
} = require('../middleware/rateLimiter');

// Admin authentication — public (no token required): email + password, then 2FA.
// Both are rate limited per IP: these are the only unauthenticated doors into the admin
// panel, and neither controller keeps a per-account attempt counter.
router.post('/login',      adminLoginLimiter,  adminAuthController.login);
router.post('/verify-2fa', adminVerifyLimiter, adminAuthController.verify2fa);

// Admin email verification — single use, protected by a high-entropy token that was
// sent to the mailbox itself.
router.get('/verify-email', adminAuthController.verifyEmail);

// ─── Layer 3: break-glass code ───────────────────────────────────────────────
// 5 attempts per hour per IP. Rationale and caveats live with the limiter itself, in
// middleware/rateLimiter.js.
router.post('/breakglass', breakglassLimiter, adminAuthController.breakglass);

module.exports = router;

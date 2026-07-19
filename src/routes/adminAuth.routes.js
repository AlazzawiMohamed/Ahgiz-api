const express = require('express');
const router = express.Router();
const adminAuthController = require('../controllers/adminAuth.controller');
const {
  adminLoginLimiter,
  adminVerifyLimiter,
  breakglassLimiter,
} = require('../middleware/rateLimiter');

// مصادقة الأدمن — عامة (لا تتطلب توكن): الدخول بالبريد + كلمة المرور ثم 2FA
router.post('/login',      adminLoginLimiter,  adminAuthController.login);
router.post('/verify-2fa', adminVerifyLimiter, adminAuthController.verify2fa);

// توثيق بريد الأدمن — مرّة واحدة، محميّ بتوكن عالي العشوائية أُرسل للصندوق نفسه.
router.get('/verify-email', adminAuthController.verifyEmail);

// ─── Layer 3: break-glass code ───────────────────────────────────────────────
// 5 attempts per hour per IP. Rationale and caveats live with the limiter itself, in
// middleware/rateLimiter.js.
router.post('/breakglass', breakglassLimiter, adminAuthController.breakglass);

module.exports = router;

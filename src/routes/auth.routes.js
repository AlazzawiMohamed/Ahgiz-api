const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const { authenticate } = require('../middleware/auth');

// Strict rate limit for OTP endpoints to prevent abuse
const otpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  keyGenerator: (req) => req.body?.phone || req.ip,
  message: { status: 'error', message: 'طلبات كثيرة جداً، حاول بعد ساعة' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/send-otp',    otpLimiter, authController.sendOtp);
router.post('/verify-otp',  otpLimiter, authController.verifyOtp);
router.post('/refresh',               authController.refresh);
router.post('/logout',      authenticate, authController.logout);
router.get('/me',           authenticate, authController.getMe);

module.exports = router;

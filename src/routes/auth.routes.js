const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const { authenticate } = require('../middleware/auth');
const validate = require('../middleware/validate');
const authSchema = require('../schemas/auth.schema');

// Strict rate limit for OTP endpoints to prevent abuse
const otpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  keyGenerator: (req) => req.body?.phone || req.ip,
  message: { status: 'error', message: 'طلبات كثيرة جداً، حاول بعد ساعة' },
  standardHeaders: true,
  legacyHeaders: false,
});

// validate runs after otpLimiter: the limiter derives its per-phone key from the raw
// body itself, so validation must not sit in front of it.
router.post('/send-otp',    otpLimiter, validate(authSchema.sendOtp), authController.sendOtp);
router.post('/verify-otp',  otpLimiter, validate(authSchema.verifyOtp), authController.verifyOtp);
router.post('/refresh',               validate(authSchema.refresh), authController.refresh);
router.post('/logout',      authenticate, validate(authSchema.logout), authController.logout);
router.get('/me',           authenticate, authController.getMe);

module.exports = router;

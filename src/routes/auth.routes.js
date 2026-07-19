const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const { authenticate } = require('../middleware/auth');
const { otpLimiter } = require('../middleware/rateLimiter');
const validate = require('../middleware/validate');
const authSchema = require('../schemas/auth.schema');

// validate runs after otpLimiter: the limiter derives its per-phone key from the raw
// body itself, so validation must not sit in front of it.
router.post('/send-otp',    otpLimiter, validate(authSchema.sendOtp), authController.sendOtp);
router.post('/verify-otp',  otpLimiter, validate(authSchema.verifyOtp), authController.verifyOtp);
router.post('/refresh',               validate(authSchema.refresh), authController.refresh);
router.post('/logout',      authenticate, validate(authSchema.logout), authController.logout);
router.get('/me',           authenticate, authController.getMe);

module.exports = router;

const express = require('express');
const router = express.Router();
const adminAuthController = require('../controllers/adminAuth.controller');

// مصادقة الأدمن — عامة (لا تتطلب توكن): الدخول بالبريد + كلمة المرور ثم 2FA
router.post('/login',      adminAuthController.login);
router.post('/verify-2fa', adminAuthController.verify2fa);

// توثيق بريد الأدمن — مرّة واحدة، محميّ بتوكن عالي العشوائية أُرسل للصندوق نفسه.
router.get('/verify-email', adminAuthController.verifyEmail);

module.exports = router;

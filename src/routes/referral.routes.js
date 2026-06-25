const express = require('express');
const router = express.Router();
const referralController = require('../controllers/referral.controller');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

router.get('/my-code', referralController.getMyCode);
router.get('/history',  referralController.getHistory);

module.exports = router;

const express = require('express');
const router = express.Router();
const loyaltyController = require('../controllers/loyalty.controller');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

router.get('/balance', loyaltyController.getBalance);
router.get('/history', loyaltyController.getHistory);

module.exports = router;

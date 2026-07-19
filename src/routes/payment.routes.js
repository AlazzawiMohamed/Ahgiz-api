const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/payment.controller');
const { authenticate } = require('../middleware/auth');
const validate = require('../middleware/validate');
const paymentSchema = require('../schemas/payment.schema');

router.use(authenticate);

// ── AsiaHawala (manual transfer + reference) ────────────────────────────────
router.post('/asiahawala/initiate',   validate(paymentSchema.asiahawalaInitiate), paymentController.asiahawalaInitiate);
router.post('/asiahawala/submit',     validate(paymentSchema.asiahawalaSubmit), paymentController.asiahawalaSubmit);
router.get('/asiahawala/status/:id',  paymentController.asiahawalaStatus);

// ── Generic pending status poll ─────────────────────────────────────────────
router.get('/pending/:booking_id',    paymentController.pendingStatus);

// ── ZainCash: blocked — needs ZAINCASH_MSISDN/SECRET/MERCHANT_ID env on Railway ──
// router.post('/zaincash/initiate', paymentController.zaincashInitiate);
// router.post('/zaincash/callback', paymentController.zaincashCallback); // HMAC, no JWT

module.exports = router;

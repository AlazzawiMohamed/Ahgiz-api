const express = require('express');
const router = express.Router();
const businessController = require('../controllers/business.controller');
const { authenticate, authorize } = require('../middleware/auth');
const upload = require('../middleware/upload');

// ── Public ────────────────────────────────────────────────────────────────────
router.get('/',                   businessController.getAll);
router.get('/popular',            businessController.getPopular); // before /:id
router.get('/feed', authenticate, businessController.getFeed);    // personalized, before /:id
router.get('/:id',                businessController.getById);
router.get('/:id/services',       businessController.getServices);
router.get('/:id/staff',          businessController.getStaff);
router.get('/:id/availability',   businessController.getAvailability);

// ── Protected (business owners / admin) — TODO: add create/update/logo ───────
// router.use(authenticate);

module.exports = router;

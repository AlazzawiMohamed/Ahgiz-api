const express = require('express');
const router = express.Router();
const ownerController  = require('../controllers/owner.controller');
const { authenticate, authorize } = require('../middleware/auth');
const requireBusiness  = require('../middleware/requireBusiness');

// All owner routes: must be authenticated, have role=business, and own a business
router.use(authenticate);
router.use(authorize('business'));
router.use(requireBusiness);

router.get('/dashboard',                  ownerController.getDashboard);
router.get('/bookings',                   ownerController.getBookings);
router.put('/bookings/:id/confirm',       ownerController.confirmBooking);
router.put('/bookings/:id/complete',      ownerController.completeBooking);
router.put('/bookings/:id/no-show',       ownerController.noShowBooking);
router.get('/staff',                      ownerController.getStaff);
router.put('/business',                   ownerController.updateBusiness);

module.exports = router;

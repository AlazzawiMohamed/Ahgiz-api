const express = require('express');
const router = express.Router();
const bookingController = require('../controllers/booking.controller');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate);

router.post('/',              bookingController.create);
router.get('/:id',            bookingController.getById);
router.put('/:id/cancel',     bookingController.cancel);

module.exports = router;

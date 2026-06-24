const express = require('express');
const router = express.Router();
const bookingController = require('../controllers/booking.controller');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate);

router.post('/',              bookingController.create);
router.get('/my',             bookingController.getMy);   // must precede /:id
router.get('/:id',            bookingController.getById);
router.post('/:id/confirm',   bookingController.confirm);
router.put('/:id/cancel',         bookingController.cancel);
router.put('/:id/cancel-request', bookingController.cancelRequest);

module.exports = router;

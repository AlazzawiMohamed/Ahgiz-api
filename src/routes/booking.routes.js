const express = require('express');
const router = express.Router();
const bookingController = require('../controllers/booking.controller');
const { authenticate, authorize } = require('../middleware/auth');
const validate = require('../middleware/validate');
const bookingSchema = require('../schemas/booking.schema');

router.use(authenticate);

router.post('/',              validate(bookingSchema.create), bookingController.create);
router.get('/my',             bookingController.getMy);   // must precede /:id
router.get('/:id',            bookingController.getById);
router.post('/:id/confirm',   bookingController.confirm);
router.put('/:id/cancel',         validate(bookingSchema.cancel), bookingController.cancel);
router.put('/:id/cancel-request', bookingController.cancelRequest);
router.put('/:id/hide',           bookingController.hide);

module.exports = router;

const express = require('express');
const router = express.Router();
const reviewController = require('../controllers/review.controller');
const { authenticate } = require('../middleware/auth');
const validate = require('../middleware/validate');
const reviewSchema = require('../schemas/review.schema');

router.get('/business/:id', reviewController.getByBusiness);
router.post('/', authenticate, validate(reviewSchema.create), reviewController.create);

module.exports = router;

const express = require('express');
const router = express.Router();
const reviewController = require('../controllers/review.controller');
const { authenticate } = require('../middleware/auth');

router.get('/business/:id', reviewController.getByBusiness);
router.post('/', authenticate, reviewController.create);

module.exports = router;

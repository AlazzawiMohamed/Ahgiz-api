const express = require('express');
const router = express.Router();
const bannerController = require('../controllers/banner.controller');

// Public — banners are shown on home/booking screens before/after auth
router.get('/', bannerController.getActive);

module.exports = router;

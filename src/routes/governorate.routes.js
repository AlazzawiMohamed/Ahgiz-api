const express = require('express');
const router = express.Router();
const governorateController = require('../controllers/governorate.controller');

router.get('/', governorateController.getAll);

module.exports = router;

const express = require('express');
const router = express.Router();
const favoriteController = require('../controllers/favorite.controller');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

router.get('/',                   favoriteController.getMine);
router.post('/:business_id',      favoriteController.add);
router.delete('/:business_id',    favoriteController.remove);

module.exports = router;

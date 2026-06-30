const express = require('express');
const router = express.Router();
const userController = require('../controllers/user.controller');
const { authenticate } = require('../middleware/auth');
const upload = require('../middleware/upload');

router.use(authenticate);

router.get('/profile',         userController.getProfile);
router.put('/profile',         userController.updateProfile);
router.put('/profile/avatar',  upload.single('avatar'), userController.updateAvatar);
router.post('/consent',        userController.recordConsent);
router.post('/push-token',     userController.savePushToken);
router.post('/delete-account', userController.deleteAccount);
router.get('/bookings',        userController.getMyBookings);

module.exports = router;

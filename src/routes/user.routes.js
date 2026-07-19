const express = require('express');
const router = express.Router();
const userController = require('../controllers/user.controller');
const { authenticate } = require('../middleware/auth');
const upload = require('../middleware/upload');
const validate = require('../middleware/validate');
const userSchema = require('../schemas/user.schema');

router.use(authenticate);

router.get('/profile',         userController.getProfile);
router.put('/profile',         validate(userSchema.updateProfile), userController.updateProfile);
router.put('/profile/avatar',  upload.single('avatar'), userController.updateAvatar);
router.post('/consent',        userController.recordConsent);
router.post('/push-token',     validate(userSchema.pushToken), userController.savePushToken);
router.post('/delete-account', validate(userSchema.deleteAccount), userController.deleteAccount);
router.get('/bookings',        userController.getMyBookings);

module.exports = router;

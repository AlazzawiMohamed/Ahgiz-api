const express = require('express');
const router = express.Router();
const adminController = require('../controllers/admin.controller');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate);
router.use(authorize('admin'));

router.get('/dashboard',              adminController.getDashboard);
router.get('/users',                  adminController.getUsers);
router.get('/businesses',             adminController.getBusinesses);
router.put('/businesses/:id/approve', adminController.approveBusiness);
router.put('/businesses/:id/suspend', adminController.suspendBusiness);

module.exports = router;

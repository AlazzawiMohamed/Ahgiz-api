const express = require('express');
const router = express.Router();
const adminController = require('../controllers/admin.controller');
const { authenticate, authorize } = require('../middleware/auth');
const validate = require('../middleware/validate');
const adminSchema = require('../schemas/admin.schema');

// all admin endpoints are protected: valid token + role=admin
router.use(authenticate);
router.use(authorize('admin'));

// ── Dashboard (A02) ──
router.get('/dashboard',               adminController.getDashboard);
router.get('/dashboard/charts',        adminController.getDashboardCharts);

// ── Businesses (A03) ──
router.get('/businesses',              adminController.getBusinesses);
router.put('/businesses/:id/approve',  adminController.approveBusiness);
router.put('/businesses/:id/suspend',  validate(adminSchema.reasonRequired), adminController.suspendBusiness);
router.delete('/businesses/:id',       validate(adminSchema.deleteBusiness), adminController.deleteBusiness);

// ── Users (A04) ──
router.get('/users',                   adminController.getUsers);
router.put('/users/:id/suspend',       validate(adminSchema.reasonRequired), adminController.suspendUser);
router.delete('/users/:id',            adminController.deleteUser);

// ── Bookings (A06) ──
router.get('/bookings',                adminController.getBookings);
router.put('/bookings/:id/cancel',     validate(adminSchema.reasonRequired), adminController.cancelBooking);

// ── Categories & Plans (A05) ──
router.get('/categories',              adminController.getCategories);
router.post('/categories',             validate(adminSchema.createCategory), adminController.createCategory);
router.put('/categories/:id',          validate(adminSchema.updateCategory), adminController.updateCategory);
router.delete('/categories/:id',       adminController.deleteCategory);
router.get('/plans',                   adminController.getPlans);
router.post('/plans',                  validate(adminSchema.createPlan), adminController.createPlan);
router.put('/plans/:id',               validate(adminSchema.updatePlan), adminController.updatePlan);
router.delete('/plans/:id',            adminController.deletePlan);

// ── Ads (A07) ──
router.get('/ads',                     adminController.getAds);
router.post('/ads',                    validate(adminSchema.createAd), adminController.createAd);
router.put('/ads/:id',                 validate(adminSchema.updateAd), adminController.updateAd);
router.delete('/ads/:id',              adminController.deleteAd);
router.get('/ads/:id/stats',           adminController.getAdStats);

// ── Withdrawals (A08) ──
router.get('/withdrawals',             adminController.getWithdrawals);
router.put('/withdrawals/:id/approve', adminController.approveWithdrawal);
router.put('/withdrawals/:id/reject',  validate(adminSchema.reasonRequired), adminController.rejectWithdrawal);

// ── Reports / complaints ──
router.get('/reports',                 adminController.getReports);
router.put('/reports/:id/resolve',     validate(adminSchema.resolveReport), adminController.resolveReport);

// ── CSV exports (A09) — before /reports to avoid a conflict ──
router.get('/reports/export/:kind',    adminController.exportReport);

// ── Stats (A10) ──
router.get('/stats',                   adminController.getStats);

// ── Activity log (A11) ──
router.get('/activity',                adminController.getActivity);

// ── Settings (A12) ──
router.get('/settings',                adminController.getSettings);
router.put('/settings/:key',           validate(adminSchema.updateSetting), adminController.updateSetting);

module.exports = router;

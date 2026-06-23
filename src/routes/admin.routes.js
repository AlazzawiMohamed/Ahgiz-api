const express = require('express');
const router = express.Router();
const adminController = require('../controllers/admin.controller');
const { authenticate, authorize } = require('../middleware/auth');

// كل نقاط نهاية الأدمن محمية: توكن صالح + role=admin
router.use(authenticate);
router.use(authorize('admin'));

// ── Dashboard (A02) ──
router.get('/dashboard',               adminController.getDashboard);
router.get('/dashboard/charts',        adminController.getDashboardCharts);

// ── Businesses (A03) ──
router.get('/businesses',              adminController.getBusinesses);
router.put('/businesses/:id/approve',  adminController.approveBusiness);
router.put('/businesses/:id/suspend',  adminController.suspendBusiness);
router.delete('/businesses/:id',       adminController.deleteBusiness);

// ── Users (A04) ──
router.get('/users',                   adminController.getUsers);
router.put('/users/:id/suspend',       adminController.suspendUser);
router.delete('/users/:id',            adminController.deleteUser);

// ── Bookings (A06) ──
router.get('/bookings',                adminController.getBookings);
router.put('/bookings/:id/cancel',     adminController.cancelBooking);

// ── Categories & Plans (A05) ──
router.get('/categories',              adminController.getCategories);
router.post('/categories',             adminController.createCategory);
router.put('/categories/:id',          adminController.updateCategory);
router.delete('/categories/:id',       adminController.deleteCategory);
router.get('/plans',                   adminController.getPlans);
router.post('/plans',                  adminController.createPlan);
router.put('/plans/:id',               adminController.updatePlan);
router.delete('/plans/:id',            adminController.deletePlan);

// ── Ads (A07) ──
router.get('/ads',                     adminController.getAds);
router.post('/ads',                    adminController.createAd);
router.put('/ads/:id',                 adminController.updateAd);
router.delete('/ads/:id',              adminController.deleteAd);
router.get('/ads/:id/stats',           adminController.getAdStats);

// ── Withdrawals (A08) ──
router.get('/withdrawals',             adminController.getWithdrawals);
router.put('/withdrawals/:id/approve', adminController.approveWithdrawal);
router.put('/withdrawals/:id/reject',  adminController.rejectWithdrawal);

// ── Reports / complaints ──
router.get('/reports',                 adminController.getReports);
router.put('/reports/:id/resolve',     adminController.resolveReport);

// ── CSV exports (A09) — قبل /reports ليست بتعارض ──
router.get('/reports/export/:kind',    adminController.exportReport);

// ── Stats (A10) ──
router.get('/stats',                   adminController.getStats);

// ── Activity log (A11) ──
router.get('/activity',                adminController.getActivity);

// ── Settings (A12) ──
router.get('/settings',                adminController.getSettings);
router.put('/settings/:key',           adminController.updateSetting);

module.exports = router;

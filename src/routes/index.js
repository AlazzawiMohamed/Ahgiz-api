const express = require('express');
const router = express.Router();

router.use('/auth',        require('./auth.routes'));
router.use('/users',       require('./user.routes'));
router.use('/businesses',  require('./business.routes'));
router.use('/bookings',    require('./booking.routes'));
router.use('/services',    require('./service.routes'));
router.use('/payments',    require('./payment.routes'));
router.use('/banners',     require('./banner.routes'));
router.use('/categories',    require('./category.routes'));
router.use('/governorates',  require('./governorate.routes'));
router.use('/reviews',       require('./review.routes'));
router.use('/notifications', require('./notification.routes'));
router.use('/favorites',     require('./favorite.routes'));
router.use('/search',        require('./search.routes'));
router.use('/owner',         require('./owner.routes'));
router.use('/admin/auth',    require('./adminAuth.routes')); // عام — قبل /admin المحمي
router.use('/admin',         require('./admin.routes'));

router.get('/health', (req, res) => {
  res.json({
    status: 'success',
    message: 'احجز API يعمل بنجاح',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  });
});

module.exports = router;

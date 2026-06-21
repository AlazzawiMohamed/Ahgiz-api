const express = require('express');
const router = express.Router();
const notifController = require('../controllers/notification.controller');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate);

// read-all MUST be registered before /:id/read to avoid "read-all" matching as an id
router.put('/read-all',     notifController.readAll);
router.get('/',             notifController.getMine);
router.put('/:id/read',     notifController.readOne);
router.post('/send',        authorize('admin'), notifController.send);

module.exports = router;

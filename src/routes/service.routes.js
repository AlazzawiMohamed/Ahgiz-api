const express = require('express');
const router = express.Router();
const serviceController = require('../controllers/service.controller');
const { authenticate, authorize } = require('../middleware/auth');

router.get('/', serviceController.getAll);
router.get('/:id', serviceController.getById);
router.get('/:id/addons', serviceController.getAddons);

router.use(authenticate);

router.post('/', authorize('owner', 'admin'), serviceController.create);
router.put('/:id', authorize('owner', 'admin'), serviceController.update);
router.delete('/:id', authorize('owner', 'admin'), serviceController.remove);

module.exports = router;

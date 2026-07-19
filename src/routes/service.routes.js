const express = require('express');
const router = express.Router();
const serviceController = require('../controllers/service.controller');
const { authenticate, authorize } = require('../middleware/auth');
const validate = require('../middleware/validate');
const serviceSchema = require('../schemas/service.schema');

router.get('/', serviceController.getAll);
router.get('/:id', serviceController.getById);
router.get('/:id/addons', serviceController.getAddons);

router.use(authenticate);

router.post('/', authorize('business', 'admin'), validate(serviceSchema.create), serviceController.create);
router.put('/:id', authorize('business', 'admin'), validate(serviceSchema.update), serviceController.update);
router.delete('/:id', authorize('business', 'admin'), serviceController.remove);

module.exports = router;

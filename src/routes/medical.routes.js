const express = require('express');
const router = express.Router();
const medicalController = require('../controllers/medical.controller');
const { uploadMedical } = require('../middleware/upload');
const { authenticate } = require('../middleware/auth');

// multer wrapper: turn upload (size/type) errors into a clear 400.
const medicalFileUpload = (req, res, next) =>
  uploadMedical.single('file')(req, res, (err) => {
    if (!err) return next();
    err.statusCode = 400;
    if (err.code === 'LIMIT_FILE_SIZE') err.message = 'الحد الأقصى لحجم الملف 10MB';
    next(err);
  });

router.use(authenticate);

// Customer self-service medical files (C13.5)
router.post('/files/upload',          medicalFileUpload, medicalController.uploadMyFile);
router.get('/files/:fileId/signed-url', medicalController.getMyFileSignedUrl);
router.get('/files/:userId',          medicalController.listMyFiles);

module.exports = router;

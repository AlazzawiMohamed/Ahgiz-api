const multer = require('multer');
const path = require('path');

const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  const allowed = ['.jpg', '.jpeg', '.png', '.webp'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowed.includes(ext)) {
    cb(null, true);
  } else {
    // TODO(i18n): replace with i18n key
    cb(new Error('صيغة الملف غير مدعومة. يُسمح فقط بـ JPG, PNG, WEBP'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

// ── medical/legal file uploads ──────────────────────────────────────────────
// only PDF/JPG/PNG/WEBP allowed, SVG explicitly blocked, max 10MB.
const MEDICAL_EXT  = ['.pdf', '.jpg', '.jpeg', '.png', '.webp'];
const MEDICAL_MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

const medicalFileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  const mime = (file.mimetype || '').toLowerCase();
  // explicitly block SVG (defense in depth: may carry scripts)
  if (ext === '.svg' || mime === 'image/svg+xml') {
    // TODO(i18n): replace with i18n key
    return cb(new Error('ملفات SVG غير مسموح بها'), false);
  }
  if (MEDICAL_EXT.includes(ext) && MEDICAL_MIME.includes(mime)) {
    return cb(null, true);
  }
  // TODO(i18n): replace with i18n key
  cb(new Error('صيغة غير مدعومة. يُسمح فقط بـ PDF, JPG, PNG, WEBP'), false);
};

const uploadMedical = multer({
  storage,
  fileFilter: medicalFileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

module.exports = upload;
module.exports.uploadMedical = uploadMedical;
module.exports.MEDICAL_EXT = MEDICAL_EXT;
module.exports.MEDICAL_MIME = MEDICAL_MIME;

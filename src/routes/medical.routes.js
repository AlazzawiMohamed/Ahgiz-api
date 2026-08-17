const express = require('express');
const router = express.Router();
const medicalController = require('../controllers/medical.controller');
const { uploadMedical } = require('../middleware/upload');
const { authenticate, authorize } = require('../middleware/auth');
const requireBusiness = require('../middleware/requireBusiness');
const validate = require('../middleware/validate');
const validateParams = require('../middleware/validateParams');
const medicalSchema = require('../schemas/medical.schema');

// multer wrapper: turn upload (size/type) errors into a clear 400.
const medicalFileUpload = (req, res, next) =>
  uploadMedical.single('file')(req, res, (err) => {
    if (!err) return next();
    err.statusCode = 400;
    // TODO(i18n): replace with i18n key
    if (err.code === 'LIMIT_FILE_SIZE') err.message = 'الحد الأقصى لحجم الملف 25MB';
    next(err);
  });

router.use(authenticate);

// Customer self-service medical files (C13.5)
router.post('/files/upload',          medicalFileUpload, medicalController.uploadMyFile);
router.get('/files/me',               medicalController.listMyFiles); // identity from token
router.get('/files/:fileId/signed-url', medicalController.getMyFileSignedUrl);
router.get('/files/:userId',          medicalController.listMyFiles); // legacy — param must equal token id

// C13.5 files gate — biometric/PIN lock (identity from token)
router.get('/pin/status',             medicalController.getPinStatus);
router.post('/pin/set',               medicalController.setPin);      // initial enrollment only
router.post('/pin/change',            medicalController.changePin);   // requires current PIN
router.post('/pin/verify',            medicalController.verifyPin);
router.post('/pin/biometric-unlock',  medicalController.biometricUnlock); // reset counter after Face ID/Touch ID
router.post('/pin/disable',           medicalController.disablePin);
router.post('/pin/recover/send',      medicalController.recoverSend); // forgot-PIN: send OTP
router.post('/pin/recover/verify',    medicalController.recoverVerify); // forgot-PIN: verify + reset

// ─── Access grants (الوصول) — Phase 2 ────────────────────────────────────────
// Customer side (identity from token; ownership enforced in the controller).
router.post('/access/grant',          validate(medicalSchema.grantAccess), medicalController.grantAccess);
router.get('/access',                 medicalController.listAccess);
router.delete('/access/revoke/:id',   medicalController.revokeAccess);
// The owner's whole history (survives dismissed grants). Two segments vs three, so
// Express cannot confuse it with /access/log/:grantId below — registered first anyway
// so the literal path always wins if either route is ever reshaped.
router.get('/access/log',             medicalController.accessLogAll);
router.get('/access/log/:grantId',    medicalController.accessLog);
// Dismiss — permanently remove an INACTIVE grant from the customer's list (hard
// delete of the grant row). Registered AFTER /access/revoke/:id so the literal
// "revoke" segment always wins the match; the audit trail survives the delete
// via the grant_id ON DELETE SET NULL FK.
router.delete('/access/:id/dismiss',  validateParams(medicalSchema.dismissGrantParams), medicalController.dismissGrant);

// Business/doctor side (must be a business account with a linked business).
router.get('/access/granted-to-me',            authorize('business'), requireBusiness, medicalController.listGrantedPatients);
router.get('/access/patient/:patientId/files', authorize('business'), requireBusiness, medicalController.listPatientFiles);
// Real-time streamed access for granted third parties (re-validates the grant per request).
router.get('/files/:fileId/stream',            authorize('business'), requireBusiness, medicalController.streamFile);

module.exports = router;

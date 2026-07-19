const express = require('express');
const router = express.Router();
const ownerController  = require('../controllers/owner.controller');
const medicalController = require('../controllers/medical.controller');
const { uploadMedical } = require('../middleware/upload');
const { authenticate, authorize } = require('../middleware/auth');
const requireBusiness  = require('../middleware/requireBusiness');
const validate = require('../middleware/validate');
const ownerSchema = require('../schemas/owner.schema');

// غلاف multer: يحوّل أخطاء الرفع (الحجم/النوع) إلى 400 برسالة عربية واضحة.
const medicalFileUpload = (req, res, next) =>
  uploadMedical.single('file')(req, res, (err) => {
    if (!err) return next();
    err.statusCode = 400;
    if (err.code === 'LIMIT_FILE_SIZE') err.message = 'الحد الأقصى لحجم الملف 10MB';
    next(err);
  });

// All owner routes: must be authenticated, have role=business, and own a business
router.use(authenticate);
router.use(authorize('business'));
router.use(requireBusiness);

router.get('/dashboard',                  ownerController.getDashboard);

// Calendar (Sprint 4) — قبل /bookings العامة
router.get('/bookings/calendar',          ownerController.getCalendar);
router.get('/bookings/day-indicators',    ownerController.getDayIndicators);

router.get('/bookings',                   ownerController.getBookings);
router.put('/bookings/:id/confirm',       ownerController.confirmBooking);
router.put('/bookings/:id/complete',      ownerController.completeBooking);
router.put('/bookings/:id/no-show',       ownerController.noShowBooking);
router.put('/bookings/:id/cancel',        validate(ownerSchema.cancelBooking), ownerController.cancelBooking);
router.put('/bookings/:id/reschedule',    validate(ownerSchema.rescheduleBooking), ownerController.rescheduleBooking);

// Client notes (Sprint 4)
router.get('/clients/:customerId/notes',            ownerController.listClientNotes);
router.post('/clients/:customerId/notes',           validate(ownerSchema.createClientNote), ownerController.createClientNote);
router.put('/clients/:customerId/notes/:noteId',    validate(ownerSchema.updateClientNote), ownerController.updateClientNote);
router.delete('/clients/:customerId/notes/:noteId', ownerController.deleteClientNote);

// Medical/legal record (Sprint 4) — صاحب الحجز فقط
router.get('/bookings/:id/medical-record', medicalController.getRecord);
router.put('/bookings/:id/medical-record', validate(ownerSchema.upsertMedicalRecord), medicalController.upsertRecord);
router.post('/bookings/:id/medical-files', medicalFileUpload, validate(ownerSchema.uploadMedicalFile), medicalController.uploadFile);

// Reviews reply (Sprint 4)
router.put('/reviews/:id/reply',          validate(ownerSchema.replyReview), ownerController.replyReview);

router.get('/staff',                      ownerController.getStaff);
router.put('/business',                   validate(ownerSchema.updateBusiness), ownerController.updateBusiness);

module.exports = router;

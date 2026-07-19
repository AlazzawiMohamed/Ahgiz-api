const logger = require('../utils/logger');

const errorHandler = (err, req, res, next) => {
  logger.error(err.message, { stack: err.stack, path: req.path, method: req.method });

  const statusCode = err.statusCode || 500;
  // TODO(i18n): replace with i18n key
  const message = statusCode === 500 ? 'حدث خطأ داخلي في الخادم' : err.message;

  res.status(statusCode).json({
    status: 'error',
    message,
  });
};

const notFound = (req, res) => {
  res.status(404).json({
    status: 'error',
    // TODO(i18n): replace with i18n key
    message: `المسار ${req.originalUrl} غير موجود`,
  });
};

module.exports = { errorHandler, notFound };

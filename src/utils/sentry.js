// تكامل Sentry — اختياري وآمن في التطوير:
// لا يُفعَّل إلا عند توفّر الحزمة + SENTRY_DSN، وإلا يعمل كـ no-op.
let Sentry = null;
try {
  Sentry = require('@sentry/node');
} catch (e) {
  Sentry = null; // الحزمة غير مثبّتة — تجاهل بصمت
}

const logger = require('./logger');

const enabled = () => Boolean(Sentry && process.env.SENTRY_DSN);

const init = () => {
  if (!enabled()) {
    if (!Sentry)               logger.debug('Sentry: الحزمة غير مثبّتة — معطّل');
    else if (!process.env.SENTRY_DSN) logger.debug('Sentry: لا يوجد SENTRY_DSN — معطّل');
    return false;
  }
  Sentry.init({
    dsn:              process.env.SENTRY_DSN,
    environment:      process.env.NODE_ENV || 'development',
    tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || '0.1'),
  });
  logger.info(`Sentry مُفعَّل — البيئة: ${process.env.NODE_ENV} | tracesSampleRate=${parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || '0.1')}`);
  return true;
};

// middleware لالتقاط أخطاء Express قبل errorHandler العام (متوافق مع كل الإصدارات)
const captureErrors = () => (err, req, res, next) => {
  if (enabled()) {
    try { Sentry.captureException(err); } catch (e) { /* ignore */ }
  }
  next(err);
};

module.exports = { init, captureErrors, enabled, Sentry };

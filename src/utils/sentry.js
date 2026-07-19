// Sentry integration — optional and safe in development:
// only enabled when the package + SENTRY_DSN are present, otherwise it is a no-op.
let Sentry = null;
try {
  Sentry = require('@sentry/node');
} catch (e) {
  Sentry = null; // package not installed — ignore silently
}

const logger = require('./logger');

const enabled = () => Boolean(Sentry && process.env.SENTRY_DSN);

const init = () => {
  if (!enabled()) {
    if (!Sentry)               logger.debug('Sentry: package not installed — disabled');
    else if (!process.env.SENTRY_DSN) logger.debug('Sentry: no SENTRY_DSN — disabled');
    return false;
  }
  Sentry.init({
    dsn:              process.env.SENTRY_DSN,
    environment:      process.env.NODE_ENV || 'development',
    tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || '0.1'),
  });
  logger.info(`Sentry enabled — environment: ${process.env.NODE_ENV} | tracesSampleRate=${parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || '0.1')}`);
  return true;
};

// middleware to capture Express errors before the global errorHandler (compatible with all versions)
const captureErrors = () => (err, req, res, next) => {
  if (enabled()) {
    try { Sentry.captureException(err); } catch (e) { /* ignore */ }
  }
  next(err);
};

module.exports = { init, captureErrors, enabled, Sentry };

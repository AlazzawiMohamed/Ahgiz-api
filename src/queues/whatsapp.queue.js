// ahgiz-api/src/queues/whatsapp.queue.js
// WhatsApp message queue (Bull). Initialized in the worker only — process is not called from app.js.
const Bull = require('bull');
const { sendWhatsAppWithRetry } = require('../services/whatsapp.service');
const logger = require('../utils/logger');

const REDIS_URL = process.env.REDIS_URL;

// without REDIS_URL (local dev) we do not create the queue — we send directly.
const whatsappQueue = REDIS_URL ? new Bull('whatsapp', REDIS_URL) : null;

// send a message from anywhere in the code.
// in production: goes to the queue. Otherwise: direct send with retry.
async function queueWhatsApp(phone, message, userId = null) {
  if (process.env.NODE_ENV === 'production' && whatsappQueue) {
    await whatsappQueue.add(
      { phone, message, userId },
      { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true, removeOnFail: 100 }
    );
  } else {
    await sendWhatsAppWithRetry(phone, message, userId);
  }
}

// the processor + listeners — run in the worker only (when the queue exists).
if (whatsappQueue) {
  whatsappQueue.process(async (job) => {
    const { phone, message, userId } = job.data;
    return sendWhatsAppWithRetry(phone, message, userId);
  });

  whatsappQueue.on('completed', (job) => {
    logger.debug(`WhatsApp queue ✓ [${job.id}]`);
  });

  whatsappQueue.on('failed', (job, err) => {
    logger.error(`WhatsApp queue ✗ [${job.id}]: ${err.message}`);
  });

  logger.info('WhatsApp Bull queue ready');
}

module.exports = { queueWhatsApp, whatsappQueue };

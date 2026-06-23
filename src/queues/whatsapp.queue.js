// ahgiz-api/src/queues/whatsapp.queue.js
// طابور رسائل واتساب (Bull). يُهيّأ في worker فقط — لا يُستدعى process من app.js.
const Bull = require('bull');
const { sendWhatsAppWithRetry } = require('../services/whatsapp.service');
const logger = require('../utils/logger');

const REDIS_URL = process.env.REDIS_URL;

// بدون REDIS_URL (تطوير محلي) لا ننشئ الطابور — نرسل مباشرةً.
const whatsappQueue = REDIS_URL ? new Bull('whatsapp', REDIS_URL) : null;

// أرسل رسالة من أي مكان في الكود.
// في الإنتاج: تذهب للطابور. غير ذلك: إرسال مباشر بإعادة المحاولة.
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

// المعالج + المستمعون — يعملون في worker فقط (عند وجود الطابور).
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

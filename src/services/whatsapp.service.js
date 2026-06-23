const axios = require('axios');
const logger = require('../utils/logger');

// Normalize Iraqi phone: 07xxxxxxxx → 9647xxxxxxxx
const normalizeIraqiPhone = (phone) => {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('964')) return digits;
  if (digits.startsWith('0')) return `964${digits.slice(1)}`;
  if (digits.startsWith('7')) return `964${digits}`;
  return digits;
};

const validateIraqiPhone = (phone) => {
  const normalized = normalizeIraqiPhone(phone);
  // Iraqi mobile: 9647[7|8|9|3|5]xxxxxxx
  return /^9647[3578]\d{8}$/.test(normalized) ? normalized : null;
};

const sendWhatsAppOTP = async (phone, otp) => {
  const normalized = validateIraqiPhone(phone);
  if (!normalized) {
    throw Object.assign(new Error('رقم الهاتف العراقي غير صحيح'), { statusCode: 400 });
  }

  const message =
    `🔐 كودك لتطبيق احجز:\n\n` +
    `*${otp}*\n\n` +
    `⏱️ صالح لمدة ${process.env.OTP_EXPIRY_MINUTES || 5} دقائق\n` +
    `لا تشارك هذا الكود مع أحد.`;

  const { ULTRAMSG_INSTANCE_ID, ULTRAMSG_TOKEN } = process.env;
  if (!ULTRAMSG_INSTANCE_ID || !ULTRAMSG_TOKEN) {
    logger.info(`[DEV] WhatsApp OTP → ${normalized}: ${otp}`);
    return { success: true, dev: true, otp };
  }

  const { data } = await axios.post(
    `https://api.ultramsg.com/${ULTRAMSG_INSTANCE_ID}/messages/chat`,
    new URLSearchParams({ token: ULTRAMSG_TOKEN, to: normalized, body: message }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
  );

  if (!data?.sent) {
    logger.error('WhatsApp send failed', data);
    throw new Error('فشل إرسال رسالة واتساب');
  }

  return { success: true, messageId: data.id };
};

// ── Generic message sender (notifications, reminders, campaigns) ──────────────
const sendWhatsAppMessage = async (phone, message) => {
  const normalized = validateIraqiPhone(phone);
  if (!normalized) {
    throw Object.assign(new Error('رقم الهاتف العراقي غير صحيح'), { statusCode: 400 });
  }

  const { ULTRAMSG_INSTANCE_ID, ULTRAMSG_TOKEN } = process.env;
  if (!ULTRAMSG_INSTANCE_ID || !ULTRAMSG_TOKEN) {
    logger.info(`[DEV] WhatsApp → ${normalized}: ${message.slice(0, 60)}`);
    return { success: true, dev: true };
  }

  const { data } = await axios.post(
    `https://api.ultramsg.com/${ULTRAMSG_INSTANCE_ID}/messages/chat`,
    new URLSearchParams({ token: ULTRAMSG_TOKEN, to: normalized, body: message }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
  );

  if (!data?.sent) {
    logger.error('WhatsApp send failed', data);
    throw new Error('فشل إرسال رسالة واتساب');
  }

  return { success: true, messageId: data.id };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const RETRY_ATTEMPTS = parseInt(process.env.WHATSAPP_RETRY_ATTEMPTS || '3', 10);

// إرسال مع إعادة محاولة (يستخدمه Bull queue processor). لا يُعيد المحاولة على رقم خاطئ.
const sendWhatsAppWithRetry = async (phone, message, userId = null, attempts = RETRY_ATTEMPTS) => {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await sendWhatsAppMessage(phone, message);
    } catch (err) {
      lastErr = err;
      if (err.statusCode === 400) throw err; // رقم غير صالح — لا فائدة من الإعادة
      logger.warn(`WhatsApp retry ${i}/${attempts} for ${userId || phone}: ${err.message}`);
      if (i < attempts) await sleep(1000 * i);
    }
  }
  throw lastErr;
};

module.exports = {
  sendWhatsAppOTP,
  sendWhatsAppMessage,
  sendWhatsAppWithRetry,
  normalizeIraqiPhone,
  validateIraqiPhone,
};

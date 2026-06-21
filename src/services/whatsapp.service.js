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

  if (process.env.NODE_ENV !== 'production') {
    logger.info(`[DEV] WhatsApp OTP → ${normalized}: ${otp}`);
    return { success: true, dev: true };
  }

  const { ULTRAMSG_INSTANCE_ID, ULTRAMSG_TOKEN } = process.env;
  if (!ULTRAMSG_INSTANCE_ID || !ULTRAMSG_TOKEN) {
    throw new Error('إعدادات WhatsApp غير مكتملة');
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

module.exports = { sendWhatsAppOTP, normalizeIraqiPhone, validateIraqiPhone };

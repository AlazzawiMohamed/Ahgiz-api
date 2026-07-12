const axios = require('axios');
const crypto = require('crypto');
const logger = require('../utils/logger');
const { whatsappTransport } = require('../utils/config');

// الرمز الثابت في وضع التطوير. ليس سرّاً: تطبيق التطوير يعبّئه من ثابت في البناء،
// والخادم لا يُرجعه في أي استجابة ولا يمرّ عبر الشبكة إطلاقاً.
const DEV_OTP = '000000';

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

// لا نسجّل رقماً كاملاً أبداً — ولا نسجّل الرمز إطلاقاً في أي بيئة.
const maskPhone = (phone) => (phone ? `${String(phone).slice(0, 7)}****` : 'unknown');

const invalidPhoneError = () =>
  Object.assign(new Error('رقم الهاتف العراقي غير صحيح'), { statusCode: 400 });

// خطأ نقل مُعقَّم: لا يحمل الرمز ولا التوكن ولا كائن axios الأصلي
// (err.config.data يحوي نصّ الرسالة ومعه الرمز + ULTRAMSG_TOKEN — يجب ألّا يخرج من هذا الملف).
const transportError = () =>
  Object.assign(new Error('تعذّر إرسال رمز التحقق حالياً. حاول لاحقاً.'), { statusCode: 503 });

// يولّد الرمز حسب وسيلة النقل: ثابت معروف في التطوير، عشوائي في غير ذلك.
const generateOtp = () =>
  whatsappTransport() === 'console' ? DEV_OTP : String(crypto.randomInt(100000, 999999));

// الإرسال الفعلي. أي خطأ — مهما كان مصدره — يخرج من هنا كخطأ مُعقَّم فقط.
const postToUltraMsg = async (normalized, message) => {
  const { ULTRAMSG_INSTANCE_ID, ULTRAMSG_TOKEN } = process.env;

  try {
    const { data } = await axios.post(
      `https://api.ultramsg.com/${ULTRAMSG_INSTANCE_ID}/messages/chat`,
      new URLSearchParams({ token: ULTRAMSG_TOKEN, to: normalized, body: message }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
    );

    if (!data?.sent) {
      // حقول قياسية فقط — لا نسجّل الاستجابة الخام: قد تعيد نصّ الرسالة ومعه الرمز.
      logger.error('WhatsApp send rejected', {
        to: maskPhone(normalized),
        ultramsgError: typeof data?.error === 'string' ? data.error : 'unknown',
      });
      throw transportError();
    }

    return { success: true, messageId: data.id ?? null };
  } catch (err) {
    if (err.statusCode === 503) throw err; // خطؤنا المُعقَّم — مرّره كما هو

    logger.error('WhatsApp transport failure', {
      to: maskPhone(normalized),
      httpStatus: err.response?.status ?? null,
      code: err.code ?? null,
    });
    throw transportError();
  }
};

// إرسال رمز التحقق. لا يُرجع الرمز — ولا أي أثر له — في أي بيئة وعلى أي مسار.
const sendWhatsAppOTP = async (phone, otp) => {
  const normalized = validateIraqiPhone(phone);
  if (!normalized) throw invalidPhoneError();

  const transport = whatsappTransport();

  if (transport === 'disabled') {
    logger.error('OTP requested but WHATSAPP_TRANSPORT=disabled', { to: maskPhone(normalized) });
    throw transportError();
  }

  if (transport === 'console') {
    // لا نطبع الرمز: إنه DEV_OTP الثابت، ومعروف مسبقاً في بناء التطوير.
    logger.info(`[console] OTP → ${maskPhone(normalized)} — استخدم رمز التطوير الثابت`);
    return { success: true, transport: 'console' };
  }

  const message =
    `🔐 كودك لتطبيق احجز:\n\n` +
    `*${otp}*\n\n` +
    `⏱️ صالح لمدة ${process.env.OTP_EXPIRY_MINUTES || 5} دقائق\n` +
    `لا تشارك هذا الكود مع أحد.`;

  return postToUltraMsg(normalized, message);
};

// ── Generic message sender (notifications, reminders, campaigns) ──────────────
const sendWhatsAppMessage = async (phone, message) => {
  const normalized = validateIraqiPhone(phone);
  if (!normalized) throw invalidPhoneError();

  const transport = whatsappTransport();

  if (transport === 'disabled') {
    logger.warn('WhatsApp message skipped — transport=disabled', { to: maskPhone(normalized) });
    throw transportError();
  }

  if (transport === 'console') {
    logger.info(`[console] WhatsApp → ${maskPhone(normalized)}: ${message.slice(0, 60)}`);
    return { success: true, transport: 'console' };
  }

  return postToUltraMsg(normalized, message);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const RETRY_ATTEMPTS = parseInt(process.env.WHATSAPP_RETRY_ATTEMPTS || '3', 10);

// إرسال مع إعادة محاولة (يستخدمه Bull queue processor). لا يُعيد المحاولة على رقم خاطئ.
const sendWhatsAppWithRetry = async (phone, message, userId = null, attempts = RETRY_ATTEMPTS) => {
  if (whatsappTransport() === 'disabled') throw transportError(); // لا فائدة من الإعادة

  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await sendWhatsAppMessage(phone, message);
    } catch (err) {
      lastErr = err;
      if (err.statusCode === 400) throw err; // رقم غير صالح — لا فائدة من الإعادة
      logger.warn(`WhatsApp retry ${i}/${attempts} for ${userId || maskPhone(phone)}: ${err.message}`);
      if (i < attempts) await sleep(1000 * i);
    }
  }
  throw lastErr;
};

module.exports = {
  sendWhatsAppOTP,
  sendWhatsAppMessage,
  sendWhatsAppWithRetry,
  generateOtp,
  normalizeIraqiPhone,
  validateIraqiPhone,
  DEV_OTP,
};

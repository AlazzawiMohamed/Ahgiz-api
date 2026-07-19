const axios = require('axios');
const crypto = require('crypto');
const logger = require('../utils/logger');
const { whatsappTransport } = require('../utils/config');
const { normalizeIraqiPhone } = require('../utils/phone');
// Dev-only OTP channel. Safe to import: telegram.service does not require this file (no cycle),
// and this transport can never be selected in production (see the guard in utils/config.js).
const { sendMessage: sendTelegram } = require('./telegram.service');

// the fixed code in dev mode. Not a secret: the dev app fills it from a build-time constant,
// and the server never returns it in any response nor sends it over the network at all.
const DEV_OTP = '000000';

// we never log a full number — and never log the code in any environment.
const maskPhone = (phone) => (phone ? `${String(phone).slice(0, 7)}****` : 'unknown');

const invalidPhoneError = () =>
  // TODO(i18n): replace with i18n key
  Object.assign(new Error('رقم الهاتف العراقي غير صحيح'), { statusCode: 400 });

// sanitized transport error: carries neither the code nor the token nor the original axios object
// (err.config.data holds the message text with the code + ULTRAMSG_TOKEN — must not leave this file).
const transportError = () =>
  // TODO(i18n): replace with i18n key
  Object.assign(new Error('تعذّر إرسال رمز التحقق حالياً. حاول لاحقاً.'), { statusCode: 503 });

// generates the code per transport: a known constant in dev, random otherwise.
const generateOtp = () =>
  whatsappTransport() === 'console' ? DEV_OTP : String(crypto.randomInt(100000, 999999));

// the actual send. Any error — whatever its source — leaves here as a sanitized error only.
const postToUltraMsg = async (normalized, message) => {
  const { ULTRAMSG_INSTANCE_ID, ULTRAMSG_TOKEN } = process.env;

  try {
    const { data } = await axios.post(
      `https://api.ultramsg.com/${ULTRAMSG_INSTANCE_ID}/messages/chat`,
      new URLSearchParams({ token: ULTRAMSG_TOKEN, to: normalized, body: message }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
    );

    if (!data?.sent) {
      // standard fields only — we do not log the raw response: it may return the message text with the code.
      logger.error('WhatsApp send rejected', {
        to: maskPhone(normalized),
        ultramsgError: typeof data?.error === 'string' ? data.error : 'unknown',
      });
      throw transportError();
    }

    return { success: true, messageId: data.id ?? null };
  } catch (err) {
    if (err.statusCode === 503) throw err; // our sanitized error — pass it through as is

    logger.error('WhatsApp transport failure', {
      to: maskPhone(normalized),
      httpStatus: err.response?.status ?? null,
      code: err.code ?? null,
    });
    throw transportError();
  }
};

// send the verification code. Never returns the code — nor any trace of it — in any environment or path.
const sendWhatsAppOTP = async (phone, otp) => {
  const normalized = normalizeIraqiPhone(phone);
  if (!normalized) throw invalidPhoneError();

  const transport = whatsappTransport();

  if (transport === 'disabled') {
    logger.error('OTP requested but WHATSAPP_TRANSPORT=disabled', { to: maskPhone(normalized) });
    throw transportError();
  }

  if (transport === 'console') {
    // we do not print the code: it is the fixed DEV_OTP, already known in the dev build.
    logger.info(`[console] OTP → ${maskPhone(normalized)} — use the fixed dev code`);
    return { success: true, transport: 'console' };
  }

  if (transport === 'telegram-dev') {
    // Dev-only: deliver the real (random) code to the admin's own Telegram chat instead of
    // WhatsApp/UltraMsg, so login can be tested without a real device. The config validator
    // fatal()s if this transport is set outside development, so this never runs in production.
    try {
      await sendTelegram(`🔑 OTP for ${normalized}: ${otp}`);
      return { success: true, transport: 'telegram-dev' };
    } catch (err) {
      // Log only err.message (never the error object): an axios failure carries the message
      // text — and therefore the code — in err.config.data. err.message never does.
      logger.error('telegram-dev OTP send failed', { to: maskPhone(normalized), error: err.message });
      throw transportError();
    }
  }

  const message =
    // TODO(i18n): replace with i18n key
    `🔐 كودك لتطبيق احجز:\n\n` +
    `*${otp}*\n\n` +
    `⏱️ صالح لمدة ${process.env.OTP_EXPIRY_MINUTES || 5} دقائق\n` +
    `لا تشارك هذا الكود مع أحد.`;

  return postToUltraMsg(normalized, message);
};

// ── Generic message sender (notifications, reminders, campaigns) ──────────────
const sendWhatsAppMessage = async (phone, message) => {
  const normalized = normalizeIraqiPhone(phone);
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

  if (transport === 'telegram-dev') {
    // Route generic messages (notifications, reminders) to Telegram as well, so telegram-dev
    // never falls through to UltraMsg — otherwise a real WhatsApp message would be sent in dev.
    try {
      await sendTelegram(`💬 [dev] WhatsApp → ${normalized}:\n${message}`);
      return { success: true, transport: 'telegram-dev' };
    } catch (err) {
      logger.error('telegram-dev message send failed', { to: maskPhone(normalized), error: err.message });
      throw transportError();
    }
  }

  return postToUltraMsg(normalized, message);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const RETRY_ATTEMPTS = parseInt(process.env.WHATSAPP_RETRY_ATTEMPTS || '3', 10);

// send with retry (used by the Bull queue processor). Does not retry on an invalid number.
const sendWhatsAppWithRetry = async (phone, message, userId = null, attempts = RETRY_ATTEMPTS) => {
  if (whatsappTransport() === 'disabled') throw transportError(); // no point retrying

  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await sendWhatsAppMessage(phone, message);
    } catch (err) {
      lastErr = err;
      if (err.statusCode === 400) throw err; // invalid number — no point retrying
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
  DEV_OTP,
};

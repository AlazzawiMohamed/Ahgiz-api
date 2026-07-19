// ahgiz-api/src/services/email.service.js
// transactional email channel — limited to admin two-factor auth (2FA) and admin email verification.
// not a general notification system: do not call it from customer or business routes.
//
// provider: Resend via axios directly (no new dependencies — axios already exists,
// and in the same style as whatsapp.service.js).
const axios = require('axios');
const logger = require('../utils/logger');

const RESEND_URL = 'https://api.resend.com/emails';

// shared Resend domain (we do not own a verified domain yet — owner decision 2026-07-12).
// ⚠️ known limitation: onboarding@resend.dev only delivers to the Resend account owner own email.
// TODO(i18n): replace with i18n key
const FROM = process.env.RESEND_FROM || 'احجز <onboarding@resend.dev>';

// copying from a web page sometimes pastes hidden Unicode characters (e.g. U+2028) at the end of the key,
// invisible in any editor but sent with the header, so the provider rejects it with 401. trim() removes them.
const resendKey = () => String(process.env.RESEND_API_KEY || '').trim();

const emailConfigured = () => Boolean(resendKey());

// sanitized error: carries neither the code nor the key nor the original axios object
// (err.config holds Authorization: Bearer <RESEND_API_KEY> and the message text with the code).
const emailError = () =>
  // TODO(i18n): replace with i18n key
  Object.assign(new Error('تعذّر إرسال البريد حالياً'), { statusCode: 503 });

const maskEmail = (addr) => {
  const s = String(addr || '');
  const [user, domain] = s.split('@');
  if (!domain) return 'unknown';
  return `${user.slice(0, 2)}***@${domain}`;
};

const post = async (payload, to) => {
  if (!emailConfigured()) {
    logger.error('Email requested but RESEND_API_KEY is not set', { to: maskEmail(to) });
    throw emailError();
  }

  try {
    const { data } = await axios.post(RESEND_URL, payload, {
      headers: {
        Authorization: `Bearer ${resendKey()}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });
    return { success: true, messageId: data?.id ?? null };
  } catch (err) {
    // standard fields only — we do not log the raw response or the error object.
    logger.error('Email transport failure', {
      to: maskEmail(to),
      httpStatus: err.response?.status ?? null,
      resendError: typeof err.response?.data?.message === 'string' ? err.response.data.message : null,
      code: err.code ?? null,
    });
    throw emailError();
  }
};

// 2FA code — same code and same hashed session; this is a second delivery channel, not a second auth factor.
// the code is never written to any log, nor returned in any response.
const sendAdminOtpEmail = async (to, otp) => {
  const minutes = process.env.OTP_EXPIRY_MINUTES || 5;
  return post(
    {
      from: FROM,
      to: [to],
      // TODO(i18n): replace with i18n key
      subject: 'رمز الدخول للوحة تحكّم احجز',
      text:
        // TODO(i18n): replace with i18n key
        `رمز التحقق الخاص بك: ${otp}\n\n` +
        `صالح لمدة ${minutes} دقائق. لا تشاركه مع أحد.\n\n` +
        `أُرسل هذا لأن تسليم واتساب تعذّر. إن لم تكن أنت من طلبه، تجاهل الرسالة وغيّر كلمة مرورك فوراً.`,
    },
    to
  );
};

// admin email verification link — used once during setup.
const sendAdminVerificationEmail = async (to, link) =>
  post(
    {
      from: FROM,
      to: [to],
      // TODO(i18n): replace with i18n key
      subject: 'توثيق بريد الأدمن — احجز',
      text:
        // TODO(i18n): replace with i18n key
        `لتوثيق هذا البريد كقناة احتياطية لرمز الدخول، افتح الرابط:\n\n${link}\n\n` +
        `الرابط صالح لمدة ساعة واحدة ويُستخدم مرّة واحدة.\n` +
        `إن لم تطلب هذا، تجاهل الرسالة — لن يُفعَّل شيء.`,
    },
    to
  );

module.exports = {
  emailConfigured,
  sendAdminOtpEmail,
  sendAdminVerificationEmail,
};

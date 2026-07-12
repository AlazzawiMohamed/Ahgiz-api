// ahgiz-api/src/services/email.service.js
// قناة بريد معاملاتية — مقصورة على مصادقة الأدمن الثنائية (2FA) وتوثيق بريده.
// ليست نظام إشعارات عام: لا تستدعِها من مسارات الزبائن أو الأعمال.
//
// المزوّد: Resend عبر axios مباشرةً (لا تبعيّات جديدة — axios موجود أصلاً،
// وبنفس أسلوب whatsapp.service.js).
const axios = require('axios');
const logger = require('../utils/logger');

const RESEND_URL = 'https://api.resend.com/emails';

// نطاق Resend المشترك (لا نملك نطاقاً موثّقاً بعد — قرار المالك 2026-07-12).
// ⚠️ قيد معروف: onboarding@resend.dev لا يسلّم إلا إلى بريد صاحب حساب Resend نفسه.
const FROM = process.env.RESEND_FROM || 'احجز <onboarding@resend.dev>';

const emailConfigured = () => Boolean(process.env.RESEND_API_KEY);

// خطأ مُعقَّم: لا يحمل الرمز ولا المفتاح ولا كائن axios الأصلي
// (err.config يحوي Authorization: Bearer <RESEND_API_KEY> ونصّ الرسالة ومعه الرمز).
const emailError = () =>
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
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });
    return { success: true, messageId: data?.id ?? null };
  } catch (err) {
    // حقول قياسية فقط — لا نسجّل الاستجابة الخام ولا كائن الخطأ.
    logger.error('Email transport failure', {
      to: maskEmail(to),
      httpStatus: err.response?.status ?? null,
      resendError: typeof err.response?.data?.message === 'string' ? err.response.data.message : null,
      code: err.code ?? null,
    });
    throw emailError();
  }
};

// رمز 2FA — نفس الرمز ونفس الجلسة المُجزّأة؛ هذه قناة تسليم ثانية لا آلية مصادقة ثانية.
// لا يُسجَّل الرمز في أي سجلّ، ولا يُعاد في أي استجابة.
const sendAdminOtpEmail = async (to, otp) => {
  const minutes = process.env.OTP_EXPIRY_MINUTES || 5;
  return post(
    {
      from: FROM,
      to: [to],
      subject: 'رمز الدخول للوحة تحكّم احجز',
      text:
        `رمز التحقق الخاص بك: ${otp}\n\n` +
        `صالح لمدة ${minutes} دقائق. لا تشاركه مع أحد.\n\n` +
        `أُرسل هذا لأن تسليم واتساب تعذّر. إن لم تكن أنت من طلبه، تجاهل الرسالة وغيّر كلمة مرورك فوراً.`,
    },
    to
  );
};

// رابط توثيق بريد الأدمن — يُستخدم مرّة واحدة عند التهيئة.
const sendAdminVerificationEmail = async (to, link) =>
  post(
    {
      from: FROM,
      to: [to],
      subject: 'توثيق بريد الأدمن — احجز',
      text:
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

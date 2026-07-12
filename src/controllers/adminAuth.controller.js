const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { supabaseAdmin } = require('../utils/supabase');
const { success, error } = require('../utils/response');
const { sendWhatsAppOTP, generateOtp } = require('../services/whatsapp.service');
const { sendAdminOtpEmail, emailConfigured } = require('../services/email.service');
const logger = require('../utils/logger');

// ─── Helpers ─────────────────────────────────────────────────────────────────

// توكن أدمن: نفس نمط توكن الوصول العادي (يمر عبر authenticate دون تعديل)
// لكن بصلاحية 8 ساعات كما في admin_sessions.
const signAdminAccess = (payload) =>
  jwt.sign({ ...payload, type: 'access' }, process.env.JWT_SECRET, {
    expiresIn:  process.env.JWT_ADMIN_EXPIRY || '8h',
    algorithm:  'HS256',
    issuer:     process.env.JWT_ISSUER   || 'ahgiz.app',
    audience:   process.env.JWT_AUDIENCE || 'ahgiz-api',
  });

const clientMeta = (req) => ({
  ip_address:  req.ip || req.headers['x-forwarded-for']?.split(',')[0] || null,
  user_agent:  req.headers['user-agent'] || null,
});

// ─── POST /admin/auth/login ───────────────────────────────────────────────────
// { email, password } → يتحقق من بيانات الأدمن ثم يرسل OTP عبر واتساب
exports.login = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return error(res, 'البريد الإلكتروني وكلمة المرور مطلوبان', 400);
    }

    const { data: admin } = await supabaseAdmin
      .from('users')
      .select('id, full_name, email, phone, role, password_hash, is_active, is_banned, admin_email_verified_at')
      .eq('email', String(email).trim().toLowerCase())
      .eq('role', 'admin')
      .is('deleted_at', null)
      .single();

    // رسالة عامة لمنع تعداد الحسابات
    const invalid = () => error(res, 'بيانات الدخول غير صحيحة', 401);

    if (!admin || !admin.password_hash) return invalid();
    if (!admin.is_active || admin.is_banned) {
      return error(res, 'حساب الأدمن معطل', 403);
    }

    const ok = await bcrypt.compare(String(password), admin.password_hash);
    if (!ok) return invalid();

    if (!admin.phone) {
      return error(res, 'لا يوجد رقم هاتف مسجّل لاستلام رمز التحقق', 400);
    }

    // أبطل أي جلسات 2FA معلّقة سابقة لنفس الأدمن
    await supabaseAdmin
      .from('whatsapp_otp_sessions')
      .update({ status: 'expired' })
      .eq('user_id', admin.id)
      .eq('session_type', '2fa')
      .eq('status', 'pending');

    const otp = generateOtp();
    const otpHash = await bcrypt.hash(otp, 10);
    const expiresAt = new Date(
      Date.now() + parseInt(process.env.OTP_EXPIRY_MINUTES || '5') * 60 * 1000
    ).toISOString();

    const { data: session, error: dbErr } = await supabaseAdmin
      .from('whatsapp_otp_sessions')
      .insert({
        phone_number: admin.phone,
        otp_code:     otpHash,        // bcrypt hash
        session_type: '2fa',
        user_id:      admin.id,
        status:       'pending',
        expires_at:   expiresAt,
        ip_address:   clientMeta(req).ip_address,
      })
      .select('id')
      .single();

    if (dbErr) throw dbErr;

    // ── تسليم الرمز: واتساب أولاً، ثم البريد كقناة ثانية للرمز نفسه ──────────
    // البريد قناة تسليم لا آلية مصادقة: نفس الـ otp، نفس الجلسة المُجزّأة أعلاه،
    // ونفس مسار verify-2fa بلا تغيير. لا يُولَّد رمز ثانٍ ولا تُنشأ جلسة ثانية.
    let channel = null;

    try {
      await sendWhatsAppOTP(admin.phone, otp);
      channel = 'whatsapp';
    } catch (waErr) {
      // بريد غير موثّق = ليس قناة موثوقة (يمكن تغييره عبر PUT /users/me).
      // لا نرسل "على أمل" — نتخطّاه إلى الطبقة 3.
      if (admin.admin_email_verified_at && emailConfigured()) {
        try {
          await sendAdminOtpEmail(admin.email, otp);
          channel = 'email';
          logger.warn(`Admin 2FA fell back to email — WhatsApp failed (${admin.email})`);
        } catch (mailErr) {
          logger.error('Admin 2FA: both WhatsApp and email delivery failed');
        }
      } else {
        logger.error(
          `Admin 2FA: WhatsApp failed and email unavailable ` +
            `(verified=${Boolean(admin.admin_email_verified_at)}, configured=${emailConfigured()})`
        );
      }
    }

    // فشل كل القنوات ⇒ fail-closed. لا نترك الجلسة 'pending' وإلا تراكمت بلا فائدة.
    if (!channel) {
      await supabaseAdmin
        .from('whatsapp_otp_sessions')
        .update({ status: 'failed' })
        .eq('id', session.id);
      throw Object.assign(new Error('تعذّر إرسال رمز التحقق عبر أي قناة. راجع المسؤول.'), {
        statusCode: 503,
      });
    }

    logger.info(`Admin 2FA OTP sent via ${channel} → ${admin.email} (${admin.phone.slice(0, 7)}****)`);

    return success(res, {
      requires_2fa: true,
      challenge:    session.id,
      expiresIn:    parseInt(process.env.OTP_EXPIRY_MINUTES || '5') * 60,
      channel,   // أين وصل الرمز — ليس سرّاً، وتحتاجه الواجهة لعرض الرسالة الصحيحة
    }, channel === 'email'
        ? 'تعذّر واتساب — أُرسل رمز التحقق إلى بريدك'
        : 'تم إرسال رمز التحقق عبر واتساب');
  } catch (err) {
    next(err);
  }
};

// ─── POST /admin/auth/verify-2fa ──────────────────────────────────────────────
// { challenge, otp } → يتحقق من OTP، ينشئ جلسة أدمن ويصدر توكن أدمن
exports.verify2fa = async (req, res, next) => {
  try {
    const { challenge, otp } = req.body;
    if (!challenge || !otp) return error(res, 'المعرّف والرمز مطلوبان', 400);

    const { data: session } = await supabaseAdmin
      .from('whatsapp_otp_sessions')
      .select('*')
      .eq('id', challenge)
      .eq('session_type', '2fa')
      .eq('status', 'pending')
      .gt('expires_at', new Date().toISOString())
      .single();

    if (!session) {
      return error(res, 'الرمز منتهي أو غير موجود — أعد تسجيل الدخول', 400);
    }

    const maxAttempts = session.max_attempts || parseInt(process.env.OTP_MAX_ATTEMPTS || '3');

    if (session.attempts >= maxAttempts) {
      await supabaseAdmin
        .from('whatsapp_otp_sessions')
        .update({ status: 'failed' })
        .eq('id', session.id);
      return error(res, 'تجاوزت عدد المحاولات — أعد تسجيل الدخول', 429);
    }

    const valid = await bcrypt.compare(String(otp), session.otp_code);
    if (!valid) {
      const remaining = maxAttempts - (session.attempts + 1);
      await supabaseAdmin
        .from('whatsapp_otp_sessions')
        .update({ attempts: session.attempts + 1 })
        .eq('id', session.id);
      return error(res, `رمز خاطئ — متبقي ${Math.max(remaining, 0)} محاولة`, 401);
    }

    await supabaseAdmin
      .from('whatsapp_otp_sessions')
      .update({ status: 'verified', verified_at: new Date().toISOString() })
      .eq('id', session.id);

    const { data: admin } = await supabaseAdmin
      .from('users')
      .select('id, full_name, email, role, is_active, is_banned')
      .eq('id', session.user_id)
      .eq('role', 'admin')
      .single();

    if (!admin || !admin.is_active || admin.is_banned) {
      return error(res, 'حساب الأدمن غير متاح', 403);
    }

    const meta = clientMeta(req);
    const admin_token = signAdminAccess({ id: admin.id, role: 'admin', phone: null });

    // سجل جلسة الأدمن (تنتهي تلقائياً بعد 8 ساعات حسب الجدول)
    const { data: adminSession } = await supabaseAdmin
      .from('admin_sessions')
      .insert({
        admin_id:      admin.id,
        session_token: crypto.createHash('sha256').update(admin_token).digest('hex'),
        ip_address:    meta.ip_address,
        user_agent:    meta.user_agent,
        is_active:     true,
      })
      .select('id')
      .single();

    await supabaseAdmin
      .from('users')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', admin.id);

    await supabaseAdmin.from('admin_audit_log').insert({
      admin_id:    admin.id,
      session_id:  adminSession?.id || null,
      action:      'admin_login',
      target_type: 'user',
      target_id:   admin.id,
      ip_address:  meta.ip_address,
    });

    logger.info(`Admin logged in → ${admin.email}`);

    return success(res, {
      admin_token,
      admin: { id: admin.id, full_name: admin.full_name, email: admin.email },
    }, 'تم تسجيل الدخول بنجاح');
  } catch (err) {
    next(err);
  }
};

// ─── GET /admin/auth/verify-email?token=… ─────────────────────────────────────
// يوثّق بريد الأدمن مرّة واحدة. عام عمداً: امتلاك التوكن (32 بايت عشوائية أُرسلت
// إلى الصندوق فقط) هو نفسه إثبات التحكّم بالصندوق — وهو بالضبط ما نوثّقه.
// التوكن يُطلب عبر سكربت المالك (scripts/send-admin-email-verification.js) لأن
// الأدمن لا يستطيع تسجيل الدخول أصلاً قبل وجود قناة تسليم.
exports.verifyEmail = async (req, res, next) => {
  try {
    const { token } = req.query;
    if (!token) return error(res, 'التوكن مطلوب', 400);

    const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');

    const { data: admin } = await supabaseAdmin
      .from('users')
      .select('id, email, admin_email_verify_expires_at')
      .eq('admin_email_verify_token_hash', tokenHash)
      .eq('role', 'admin')
      .is('deleted_at', null)
      .maybeSingle();

    // رسالة واحدة عامة للتوكن الخاطئ والمنتهي — لا نكشف أيّهما.
    if (!admin || new Date(admin.admin_email_verify_expires_at) < new Date()) {
      return error(res, 'رابط التوثيق غير صالح أو منتهي', 400);
    }

    // استخدام واحد: نمسح التوكن مع ختم التوثيق في نفس الكتابة.
    const { error: dbErr } = await supabaseAdmin
      .from('users')
      .update({
        admin_email_verified_at:       new Date().toISOString(),
        admin_email_verify_token_hash: null,
        admin_email_verify_expires_at: null,
      })
      .eq('id', admin.id)
      .eq('admin_email_verify_token_hash', tokenHash); // حارس تزامن: أول استخدام فقط ينجح

    if (dbErr) throw dbErr;

    logger.info(`Admin email verified → ${admin.email}`);
    return success(res, { verified: true }, 'تم توثيق البريد. صار قناة احتياطية لرمز الدخول.');
  } catch (err) {
    next(err);
  }
};

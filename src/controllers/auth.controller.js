const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { supabaseAdmin } = require('../utils/supabase');
const { success, error } = require('../utils/response');
const { sendWhatsAppOTP, validateIraqiPhone } = require('../services/whatsapp.service');
const logger = require('../utils/logger');

// ─── Helpers ─────────────────────────────────────────────────────────────────

const signAccess = (payload) =>
  jwt.sign({ ...payload, type: 'access' }, process.env.JWT_SECRET, {
    expiresIn:  process.env.JWT_ACCESS_EXPIRY || '7d',
    algorithm:  'HS256',
    issuer:     process.env.JWT_ISSUER    || 'ahgiz.app',
    audience:   process.env.JWT_AUDIENCE  || 'ahgiz-api',
  });

// Opaque refresh token — stored hashed in refresh_tokens table (not JWT)
const generateRefreshToken = () => crypto.randomBytes(64).toString('hex');
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

const getClientMeta = (req) => ({
  ip_address: req.ip || req.headers['x-forwarded-for']?.split(',')[0] || null,
  device_info: req.headers['user-agent'] || null,
  device_id: req.headers['x-device-id'] || null,
  device_name: req.headers['x-device-name'] || null,
});

// ─── POST /auth/send-otp ──────────────────────────────────────────────────────

exports.sendOtp = async (req, res, next) => {
  try {
    const { phone } = req.body;
    if (!phone) return error(res, 'رقم الهاتف مطلوب', 400);

    const normalized = validateIraqiPhone(phone);
    if (!normalized) return error(res, 'رقم الهاتف العراقي غير صحيح (مثال: 07701234567)', 400);

    // Check blocked_until
    const { data: blocked } = await supabaseAdmin
      .from('whatsapp_otp_sessions')
      .select('blocked_until')
      .eq('phone_number', normalized)
      .not('blocked_until', 'is', null)
      .gt('blocked_until', new Date().toISOString())
      .order('blocked_until', { ascending: false })
      .limit(1)
      .single();

    if (blocked) {
      const waitSeconds = Math.ceil((new Date(blocked.blocked_until) - Date.now()) / 1000);
      return error(res, `محظور مؤقتاً. انتظر ${waitSeconds} ثانية`, 429);
    }

    // Rate limit: no resend within OTP_RATE_LIMIT_MINUTES
    const rateMins = parseInt(process.env.OTP_RATE_LIMIT_MINUTES || '2');
    const since = new Date(Date.now() - rateMins * 60 * 1000).toISOString();

    const { data: recent } = await supabaseAdmin
      .from('whatsapp_otp_sessions')
      .select('sent_at')
      .eq('phone_number', normalized)
      .eq('status', 'pending')
      .gte('sent_at', since)
      .order('sent_at', { ascending: false })
      .limit(1)
      .single();

    if (recent) {
      const nextAt = new Date(new Date(recent.sent_at).getTime() + rateMins * 60 * 1000);
      const waitSecs = Math.ceil((nextAt - Date.now()) / 1000);
      return error(res, `انتظر ${waitSecs} ثانية قبل إعادة الإرسال`, 429);
    }

    // Expire any existing pending sessions
    await supabaseAdmin
      .from('whatsapp_otp_sessions')
      .update({ status: 'expired' })
      .eq('phone_number', normalized)
      .eq('status', 'pending');

    // Find existing user (to set session_type and user_id)
    const { data: existingUser } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('phone', normalized)
      .is('deleted_at', null)
      .single();

    const otp = String(crypto.randomInt(100000, 999999));
    const otpHash = await bcrypt.hash(otp, 10);
    const expiresAt = new Date(
      Date.now() + parseInt(process.env.OTP_EXPIRY_MINUTES || '5') * 60 * 1000
    ).toISOString();
    const { ip_address } = getClientMeta(req);

    const { error: dbErr } = await supabaseAdmin
      .from('whatsapp_otp_sessions')
      .insert({
        phone_number: normalized,
        otp_code: otpHash,              // stored as bcrypt hash
        session_type: existingUser ? 'login' : 'register',
        user_id: existingUser?.id || null,
        status: 'pending',
        expires_at: expiresAt,
        ip_address,
      });

    if (dbErr) throw dbErr;

    const waResult = await sendWhatsAppOTP(normalized, otp);

    logger.info(`OTP sent → ${normalized.slice(0, 7)}**** (${existingUser ? 'login' : 'register'})`);

    return success(res, {
      phone: normalized,
      expiresIn: parseInt(process.env.OTP_EXPIRY_MINUTES || '5') * 60,
      isNewUser: !existingUser,
      ...(waResult?.dev ? { devOtp: waResult.otp } : {}),
    }, 'تم إرسال كود التحقق عبر واتساب');
  } catch (err) {
    next(err);
  }
};

// ─── POST /auth/verify-otp ────────────────────────────────────────────────────

exports.verifyOtp = async (req, res, next) => {
  try {
    const { phone, otp, full_name } = req.body;
    if (!phone || !otp) return error(res, 'رقم الهاتف والكود مطلوبان', 400);

    const normalized = validateIraqiPhone(phone);
    if (!normalized) return error(res, 'رقم الهاتف غير صحيح', 400);

    // Load latest pending, non-expired session
    const { data: session } = await supabaseAdmin
      .from('whatsapp_otp_sessions')
      .select('*')
      .eq('phone_number', normalized)
      .eq('status', 'pending')
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (!session) {
      return error(res, 'الكود منتهي أو غير موجود — أعد طلب كود جديد', 400);
    }

    const maxAttempts = session.max_attempts || parseInt(process.env.OTP_MAX_ATTEMPTS || '3');

    // Too many attempts → block phone for 15 minutes
    if (session.attempts >= maxAttempts) {
      const blockedUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      await supabaseAdmin
        .from('whatsapp_otp_sessions')
        .update({ status: 'failed', blocked_until: blockedUntil })
        .eq('id', session.id);
      return error(res, 'تجاوزت عدد المحاولات. محظور لمدة 15 دقيقة', 429);
    }

    const valid = await bcrypt.compare(String(otp), session.otp_code);

    if (!valid) {
      const newAttempts = session.attempts + 1;
      const remaining = maxAttempts - newAttempts;
      await supabaseAdmin
        .from('whatsapp_otp_sessions')
        .update({ attempts: newAttempts })
        .eq('id', session.id);
      return error(res, `كود خاطئ — متبقي ${remaining} محاولة`, 401);
    }

    // Mark session verified
    await supabaseAdmin
      .from('whatsapp_otp_sessions')
      .update({ status: 'verified', verified_at: new Date().toISOString() })
      .eq('id', session.id);

    // Find or create user
    let { data: user } = await supabaseAdmin
      .from('users')
      .select('id, full_name, phone, email, role, avatar_url, is_active, is_banned, ban_reason, profile_completed')
      .eq('phone', normalized)
      .is('deleted_at', null)
      .single();

    const isNew = !user;

    if (!user) {
      if (!full_name && session.session_type === 'register') {
        // First time — accept name now or let user complete profile later
      }
      const { data: created, error: createErr } = await supabaseAdmin
        .from('users')
        .insert({
          phone: normalized,
          full_name: full_name || null,
          role: 'customer',
          auth_provider: 'phone',
          is_active: true,
          is_banned: false,
        })
        .select('id, full_name, phone, email, role, avatar_url, is_active, is_banned, profile_completed')
        .single();

      if (createErr) throw createErr;
      user = created;
    }

    if (!user.is_active) return error(res, 'الحساب معطل. تواصل مع الدعم', 403);
    if (user.is_banned) return error(res, 'الحساب محظور. تواصل مع الدعم', 403);

    // Update last_seen_at
    await supabaseAdmin
      .from('users')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', user.id);

    // Issue tokens
    const accessToken = signAccess({ id: user.id, phone: user.phone, role: user.role });

    const rawRefresh = generateRefreshToken();
    const refreshHash = hashToken(rawRefresh);
    const meta = getClientMeta(req);

    const { error: rtErr } = await supabaseAdmin
      .from('refresh_tokens')
      .insert({
        user_id: user.id,
        token_hash: refreshHash,
        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        ip_address: meta.ip_address,
        device_info: meta.device_info,
        device_id: meta.device_id,
        device_name: meta.device_name,
      });

    if (rtErr) throw rtErr;

    logger.info(`Auth OK: user=${user.id} new=${isNew}`);

    return success(res, {
      user,
      accessToken,
      refreshToken: rawRefresh,
      isNew,
    }, isNew ? 'تم إنشاء حسابك بنجاح' : 'تم تسجيل الدخول بنجاح');
  } catch (err) {
    next(err);
  }
};

// ─── POST /auth/refresh ───────────────────────────────────────────────────────

exports.refresh = async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return error(res, 'refreshToken مطلوب', 400);

    const hash = hashToken(refreshToken);

    const { data: stored } = await supabaseAdmin
      .from('refresh_tokens')
      .select('id, user_id, revoked, expires_at')
      .eq('token_hash', hash)
      .single();

    if (!stored) return error(res, 'refresh token غير صالح', 401);
    if (stored.revoked) return error(res, 'refresh token ملغى — سجل دخولك مجدداً', 401);
    if (new Date(stored.expires_at) < new Date()) {
      return error(res, 'refresh token منتهي الصلاحية', 401);
    }

    const { data: user } = await supabaseAdmin
      .from('users')
      .select('id, phone, role, is_active, is_banned, min_iat')
      .eq('id', stored.user_id)
      .is('deleted_at', null)
      .single();

    if (!user || !user.is_active || user.is_banned) {
      return error(res, 'الحساب غير نشط', 401);
    }

    // Rotate: revoke old, issue new
    const rawRefresh = generateRefreshToken();
    const newHash = hashToken(rawRefresh);
    const meta = getClientMeta(req);

    await Promise.all([
      supabaseAdmin
        .from('refresh_tokens')
        .update({ revoked: true, revoked_at: new Date().toISOString(), revoke_reason: 'rotated' })
        .eq('id', stored.id),
      supabaseAdmin
        .from('refresh_tokens')
        .insert({
          user_id: user.id,
          token_hash: newHash,
          expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          ip_address: meta.ip_address,
          device_info: meta.device_info,
          device_id: meta.device_id,
          device_name: meta.device_name,
        }),
    ]);

    const accessToken = signAccess({ id: user.id, phone: user.phone, role: user.role });

    return success(res, { accessToken, refreshToken: rawRefresh }, 'تم تجديد الجلسة');
  } catch (err) {
    next(err);
  }
};

// ─── POST /auth/logout ────────────────────────────────────────────────────────

exports.logout = async (req, res, next) => {
  try {
    const { refreshToken } = req.body;

    if (refreshToken) {
      const hash = hashToken(refreshToken);
      await supabaseAdmin
        .from('refresh_tokens')
        .update({ revoked: true, revoked_at: new Date().toISOString(), revoke_reason: 'logout' })
        .eq('token_hash', hash)
        .eq('user_id', req.user.id);
    }

    logger.info(`Logout: user=${req.user.id}`);
    return success(res, null, 'تم تسجيل الخروج بنجاح');
  } catch (err) {
    next(err);
  }
};

// ─── GET /auth/me ─────────────────────────────────────────────────────────────

exports.getMe = async (req, res, next) => {
  try {
    const { data: user, error: dbErr } = await supabaseAdmin
      .from('users')
      .select('id, full_name, phone, email, role, avatar_url, is_active, profile_completed, province, created_at')
      .eq('id', req.user.id)
      .is('deleted_at', null)
      .single();

    if (dbErr || !user) return error(res, 'المستخدم غير موجود', 404);
    return success(res, user);
  } catch (err) {
    next(err);
  }
};

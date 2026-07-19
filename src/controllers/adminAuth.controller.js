const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { supabaseAdmin } = require('../utils/supabase');
const { success, error } = require('../utils/response');
const { sendWhatsAppOTP, generateOtp } = require('../services/whatsapp.service');
const { sendAdminOtpEmail, emailConfigured } = require('../services/email.service');
const { sendSecurityAlert } = require('../services/alert.service');
const { isAdminLoginLocked } = require('../services/lockdown.service');
const { ALERT_KEYBOARD } = require('../services/telegram.service');
const { clientMeta, clientIp, userAgent, forwardedChain } = require('../utils/request');
const logger = require('../utils/logger');

// Emergency lockdown gate. Guards BOTH steps of the admin login: blocking only /login would
// leave a 2FA challenge issued moments before the lockdown still redeemable for a fresh admin
// token afterwards. Break-glass is deliberately NOT gated — it stays as the way back in if
// Telegram is unreachable.
const LOCKED_BODY = {
  status:  'error',
  error:   'system_locked',
  message: 'System is locked — use Telegram bot to unlock',
};

const rejectIfLocked = async (res) => {
  if (!(await isAdminLoginLocked())) return false;
  res.status(423).json(LOCKED_BODY);
  return true;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Admin token: the same shape as a regular access token (it passes through `authenticate`
// unchanged), but with an 8-hour lifetime, matching admin_sessions.
const signAdminAccess = (payload) =>
  jwt.sign({ ...payload, type: 'access' }, process.env.JWT_SECRET, {
    expiresIn:  process.env.JWT_ADMIN_EXPIRY || '8h',
    algorithm:  'HS256',
    issuer:     process.env.JWT_ISSUER   || 'ahgiz.app',
    audience:   process.env.JWT_AUDIENCE || 'ahgiz-api',
  });

// clientMeta used to be defined here as `req.ip || x-forwarded-for`, which is wrong
// on both sides (the second branch is dead code, the first was the proxy's IP). It
// now lives in utils/request.js, alongside the trust proxy setting in app.js.
// See the comment there.

// ─── POST /admin/auth/login ───────────────────────────────────────────────────
// { email, password } → verifies the admin's credentials, then sends an OTP over WhatsApp
exports.login = async (req, res, next) => {
  try {
    if (await rejectIfLocked(res)) return;

    const { email, password } = req.body;
    if (!email || !password) {
      return error(res, 'Email and password are required', 400);
    }

    const { data: admin } = await supabaseAdmin
      .from('users')
      .select('id, full_name, email, phone, role, password_hash, is_active, is_banned, admin_email_verified_at')
      .eq('email', String(email).trim().toLowerCase())
      .eq('role', 'admin')
      .is('deleted_at', null)
      .single();

    // Generic message — prevents account enumeration
    const invalid = () => error(res, 'Invalid credentials', 401);

    if (!admin || !admin.password_hash) return invalid();
    if (!admin.is_active || admin.is_banned) {
      return error(res, 'Admin account is disabled', 403);
    }

    const ok = await bcrypt.compare(String(password), admin.password_hash);
    if (!ok) return invalid();

    if (!admin.phone) {
      return error(res, 'No phone number on file to receive the verification code', 400);
    }

    // Invalidate any previously pending 2FA sessions for this same admin
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

    // ── Code delivery: WhatsApp first, then email as a second channel for the same code ──
    // Email is a delivery channel, not an auth mechanism: the same otp, the same hashed
    // session created above, and the same verify-2fa path unchanged. No second code is
    // generated and no second session is created.
    let channel = null;

    try {
      await sendWhatsAppOTP(admin.phone, otp);
      channel = 'whatsapp';
    } catch (waErr) {
      // An unverified email is not a trusted channel (it can be changed via PUT /users/me).
      // We do not send on a hope — we skip past it to Layer 3.
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

    // Every channel failed ⇒ fail-closed. Do not leave the session 'pending', or they just
    // pile up for nothing.
    if (!channel) {
      await supabaseAdmin
        .from('whatsapp_otp_sessions')
        .update({ status: 'failed' })
        .eq('id', session.id);
      throw Object.assign(new Error('Could not deliver the verification code over any channel. Contact the administrator.'), {
        statusCode: 503,
      });
    }

    logger.info(`Admin 2FA OTP sent via ${channel} → ${admin.email} (${admin.phone.slice(0, 7)}****)`);

    return success(res, {
      requires_2fa: true,
      challenge:    session.id,
      expiresIn:    parseInt(process.env.OTP_EXPIRY_MINUTES || '5') * 60,
      channel,   // where the code landed — not a secret, and the frontend needs it to show the right message
    }, channel === 'email'
        ? 'WhatsApp unavailable — the verification code was sent to your email'
        : 'Verification code sent over WhatsApp');
  } catch (err) {
    next(err);
  }
};

// ─── POST /admin/auth/verify-2fa ──────────────────────────────────────────────
// { challenge, otp } → verifies the OTP, creates an admin session and issues an admin token
exports.verify2fa = async (req, res, next) => {
  try {
    if (await rejectIfLocked(res)) return;

    const { challenge, otp } = req.body;
    if (!challenge || !otp) return error(res, 'Challenge and code are required', 400);

    const { data: session } = await supabaseAdmin
      .from('whatsapp_otp_sessions')
      .select('*')
      .eq('id', challenge)
      .eq('session_type', '2fa')
      .eq('status', 'pending')
      .gt('expires_at', new Date().toISOString())
      .single();

    if (!session) {
      return error(res, 'Code expired or not found — sign in again', 400);
    }

    const maxAttempts = session.max_attempts || parseInt(process.env.OTP_MAX_ATTEMPTS || '3');

    if (session.attempts >= maxAttempts) {
      await supabaseAdmin
        .from('whatsapp_otp_sessions')
        .update({ status: 'failed' })
        .eq('id', session.id);
      return error(res, 'Too many attempts — sign in again', 429);
    }

    const valid = await bcrypt.compare(String(otp), session.otp_code);
    if (!valid) {
      const remaining = maxAttempts - (session.attempts + 1);
      await supabaseAdmin
        .from('whatsapp_otp_sessions')
        .update({ attempts: session.attempts + 1 })
        .eq('id', session.id);
      return error(res, `Invalid code — ${Math.max(remaining, 0)} attempt(s) remaining`, 401);
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
      return error(res, 'Admin account unavailable', 403);
    }

    const meta = clientMeta(req);
    const admin_token = signAdminAccess({
      id: admin.id, role: 'admin', phone: null, auth_method: 'password_2fa',
    });

    // Record the admin session (expires automatically after 8 hours, per the table)
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
      auth_method: 'password_2fa',   // distinguishes it from 'breakglass' in the log
    });

    logger.info(`Admin logged in → ${admin.email}`);

    return success(res, {
      admin_token,
      admin: { id: admin.id, full_name: admin.full_name, email: admin.email },
    }, 'Signed in successfully');
  } catch (err) {
    next(err);
  }
};

// ─── GET /admin/auth/verify-email?token=… ─────────────────────────────────────
// Verifies an admin's email exactly once. Public on purpose: holding the token (32 random
// bytes sent to that inbox and nowhere else) IS proof of control over the inbox — which is
// precisely what we are verifying. The token is issued through the owner's script
// (scripts/send-admin-email-verification.js), because an admin cannot sign in at all before
// a delivery channel exists.
exports.verifyEmail = async (req, res, next) => {
  try {
    const { token } = req.query;
    if (!token) return error(res, 'Token is required', 400);

    const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');

    const { data: admin } = await supabaseAdmin
      .from('users')
      .select('id, email, admin_email_verify_expires_at')
      .eq('admin_email_verify_token_hash', tokenHash)
      .eq('role', 'admin')
      .is('deleted_at', null)
      .maybeSingle();

    // One generic message for both a wrong and an expired token — we do not reveal which.
    if (!admin || new Date(admin.admin_email_verify_expires_at) < new Date()) {
      return error(res, 'Verification link is invalid or expired', 400);
    }

    // Single use: we clear the token and stamp the verification in the same write.
    const { error: dbErr } = await supabaseAdmin
      .from('users')
      .update({
        admin_email_verified_at:       new Date().toISOString(),
        admin_email_verify_token_hash: null,
        admin_email_verify_expires_at: null,
      })
      .eq('id', admin.id)
      .eq('admin_email_verify_token_hash', tokenHash); // concurrency guard: only the first use succeeds

    if (dbErr) throw dbErr;

    logger.info(`Admin email verified → ${admin.email}`);
    return success(res, { verified: true }, 'Email verified. It is now a fallback channel for the login code.');
  } catch (err) {
    next(err);
  }
};

// ─── POST /admin/auth/breakglass ──────────────────────────────────────────────
// Layer 3 — the last way in when Layers 1 and 2 (WhatsApp + email) are both down.
//
// Design contract:
//   • The code is usable EXACTLY ONCE, forever. The guarantee lives in the database
//     (UNIQUE on hash_fingerprint), not in application code => no race between two
//     concurrent requests.
//   • The fingerprint is sha256(ADMIN_BREAKGLASS_HASH) — a fingerprint of the
//     configured hash, not of the raw code. The raw code never touches disk, not
//     even hashed.
//   • A failed attempt does NOT burn the code (otherwise any stranger could destroy
//     the emergency exit with a single wrong guess) — but it is logged and alerted on.
//   • A successful attempt burns FIRST, then opens the session. If anything blows up
//     after the burn, the code stays burned — that is the safe direction to fail: a
//     wasted code is cheaper than a replayable one.
//   • The alert is awaited on every path, but never throws. See alert.service.
//
// Bypassing 2FA does not bypass account state: a disabled or banned admin stays
// locked out. Break-glass means "the code never reached me", not "my account was
// deliberately locked".
const BCRYPT_RE = /^\$2[aby]\$\d{2}\$/;

// Alert titles. The alert body is the one admin-facing surface in this codebase, so it
// carries all three languages; alert.service picks one per platform_settings
// .admin_alert_language (ar | en | ku, default ar). Each title owns its leading emoji.
const TITLE_SUCCESS = {
  ar: '🚨 كود الطوارئ — نجاح',
  en: '🚨 Emergency Code — Success',
  ku: '🚨 کۆدی فریاکەوتن — سەرکەوتوو',
};
const TITLE_FAILED = {
  ar: '🚨 كود الطوارئ — فشل',
  en: '🚨 Emergency Code — Failed',
  ku: '🚨 کۆدی فریاکەوتن — سەرنەکەوتوو',
};

exports.breakglass = async (req, res, next) => {
  const ip = clientIp(req);
  const ua = userAgent(req);

  // Unified alerter — never throws, never halts the path.
  // `title` and `fields` are the Telegram/Slack message body the owner reads directly, so
  // each carries all three languages; alert.service renders the one that
  // platform_settings.admin_alert_language selects.
  // `replyMarkup` attaches the Telegram lockdown buttons — see telegram.service.ALERT_KEYBOARD.
  const alert = (title, fields, replyMarkup = null) =>
    sendSecurityAlert({ title, ip, userAgent: ua, forwardedChain: forwardedChain(req), fields, replyMarkup });

  try {
    const { code } = req.body;
    if (!code) return error(res, 'Emergency code is required', 400);

    const configuredHash = String(process.env.ADMIN_BREAKGLASS_HASH || '').trim();
    const targetEmail    = String(process.env.ADMIN_BREAKGLASS_EMAIL || '').trim().toLowerCase();

    // Fail-closed: if the emergency path is not configured, it does not exist. We do
    // not even hint that it is there.
    // (ADMIN_BREAKGLASS_EMAIL names the session owner: admin_sessions.admin_id is NOT
    //  NULL, and the emergency code is not bound to any particular admin. "The only
    //  active admin" is a guess that breaks the moment a second admin exists — so we
    //  declare the owner instead of inferring them.)
    if (!BCRYPT_RE.test(configuredHash) || !targetEmail) {
      logger.error(
        'Breakglass attempted but not configured — ' +
          `hash=${configuredHash ? 'present/invalid-format' : 'missing'}, email=${targetEmail ? 'set' : 'missing'}`
      );
      return error(res, 'Invalid emergency code', 401);
    }

    const valid = await bcrypt.compare(String(code), configuredHash);

    if (!valid) {
      // Burn nothing — but do not pass in silence either.
      await supabaseAdmin.from('admin_audit_log').insert({
        admin_id:    null,
        action:      'admin_breakglass_failed',
        target_type: 'user',
        ip_address:  ip,
        auth_method: 'breakglass',
        after_data:  { user_agent: ua },
      });

      logger.error(`BREAKGLASS FAILED — wrong code from ${ip || 'unknown IP'}`);
      await alert(TITLE_FAILED, {
        ar: { '❌ النتيجة': 'رمز خاطئ — لم يُحرق الرمز، ولم تُفتح جلسة' },
        en: { '❌ Result': 'Wrong code — the code was not burned, and no session was opened' },
        ku: { '❌ ئەنجام': 'کۆدی هەڵە — کۆدەکە نەسووتێنرا و هیچ دانیشتنێک نەکرایەوە' },
      });

      return error(res, 'Invalid emergency code', 401);
    }

    // ── The code is correct from here on ────────────────────────────────────
    const { data: admin } = await supabaseAdmin
      .from('users')
      .select('id, full_name, email, role, is_active, is_banned')
      .eq('email', targetEmail)
      .eq('role', 'admin')
      .is('deleted_at', null)
      .maybeSingle();

    if (!admin || !admin.is_active || admin.is_banned) {
      logger.error(`BREAKGLASS — valid code but target admin unusable (${targetEmail})`);
      await alert(TITLE_FAILED, {
        ar: {
          'الأدمن المستهدف': targetEmail,
          'السبب':          !admin ? 'غير موجود' : 'معطّل أو محظور',
          '❌ النتيجة':      'رمز صحيح لكن حساب الأدمن غير صالح — لم يُحرق الرمز، ولم تُفتح جلسة',
        },
        en: {
          'Target admin': targetEmail,
          'Reason':       !admin ? 'Not found' : 'Disabled or banned',
          '❌ Result':     'Valid code but the admin account is unusable — the code was not burned, and no session was opened',
        },
        ku: {
          'ئەدمینی مەبەست': targetEmail,
          'هۆکار':          !admin ? 'نەدۆزرایەوە' : 'ناچالاک یان قەدەغەکراو',
          '❌ ئەنجام':       'کۆد ڕاستە بەڵام هەژماری ئەدمین نەگونجاوە — کۆدەکە نەسووتێنرا و هیچ دانیشتنێک نەکرایەوە',
        },
      });
      return error(res, 'Admin account unavailable', 403);
    }

    const fingerprint = crypto.createHash('sha256').update(configuredHash).digest('hex');

    // ── Burn first — the UNIQUE constraint is the arbiter, not a prior check (no race) ──
    const { error: burnErr } = await supabaseAdmin
      .from('admin_breakglass_uses')
      .insert({ hash_fingerprint: fingerprint, admin_id: admin.id, ip_address: ip, user_agent: ua });

    if (burnErr) {
      // 23505 = UNIQUE violation => the code is correct but was already spent.
      // A serious event: somebody holds the correct code and is trying to replay it.
      const alreadyUsed = burnErr.code === '23505';

      await supabaseAdmin.from('admin_audit_log').insert({
        admin_id:    admin.id,
        action:      alreadyUsed ? 'admin_breakglass_reuse_blocked' : 'admin_breakglass_burn_failed',
        target_type: 'user',
        target_id:   admin.id,
        ip_address:  ip,
        auth_method: 'breakglass',
        after_data:  { user_agent: ua, db_error: burnErr.code || null },
      });

      logger.error(`BREAKGLASS ${alreadyUsed ? 'REUSE BLOCKED' : 'BURN FAILED'} — ${burnErr.code}`);
      await alert(TITLE_FAILED, {
        ar: {
          'الأدمن المستهدف': admin.email,
          '❌ النتيجة': alreadyUsed
            ? '⛔ محاولة إعادة استخدام رمز طوارئ محروق — الرمز الصحيح بيد أحدهم. لم تُفتح جلسة'
            : 'تعذّر حرق رمز الطوارئ (خطأ قاعدة بيانات) — لم تُفتح جلسة',
          ...(alreadyUsed ? { 'إجراء مطلوب': 'دوّر ADMIN_BREAKGLASS_HASH فوراً' } : {}),
        },
        en: {
          'Target admin': admin.email,
          '❌ Result': alreadyUsed
            ? '⛔ Replay attempt on a burned emergency code — someone is holding the correct code. No session was opened'
            : 'Could not burn the emergency code (database error) — no session was opened',
          ...(alreadyUsed ? { 'Action required': 'Rotate ADMIN_BREAKGLASS_HASH immediately' } : {}),
        },
        ku: {
          'ئەدمینی مەبەست': admin.email,
          '❌ ئەنجام': alreadyUsed
            ? '⛔ هەوڵی بەکارهێنانەوەی کۆدێکی سووتاوی فریاکەوتن — کۆدی ڕاست لەلای کەسێکە. هیچ دانیشتنێک نەکرایەوە'
            : 'نەتوانرا کۆدی فریاکەوتن بسووتێنرێت (هەڵەی بنکەی دراوە) — هیچ دانیشتنێک نەکرایەوە',
          ...(alreadyUsed ? { 'کردەی پێویست': 'دەستبەجێ ADMIN_BREAKGLASS_HASH بگۆڕە' } : {}),
        },
      });

      return alreadyUsed
        ? error(res, 'Emergency code already used — it is single-use. Rotate the code.', 403)
        : error(res, 'Emergency login failed', 500);
    }

    // ── The code is burned now. Nothing after this line can bring it back. ──
    // auth_method travels inside the token: every action this admin takes for the
    // whole session is tagged 'breakglass' in admin_audit_log, not just the login row.
    const admin_token = signAdminAccess({
      id: admin.id, role: 'admin', phone: null, auth_method: 'breakglass',
    });

    const { data: adminSession, error: sessErr } = await supabaseAdmin
      .from('admin_sessions')
      .insert({
        admin_id:      admin.id,
        session_token: crypto.createHash('sha256').update(admin_token).digest('hex'),
        ip_address:    ip,
        user_agent:    ua,
        is_active:     true,
      })
      .select('id')
      .single();

    if (sessErr) {
      // The code burned and no session opened. Alert explicitly — otherwise the owner
      // would assume their code is still alive.
      logger.error('BREAKGLASS — code burned but session insert failed', { error: sessErr.message });
      await alert(TITLE_FAILED, {
        ar: {
          'الأدمن المستهدف': admin.email,
          'الخطأ':          sessErr.message,
          '❌ النتيجة':      '⚠️ احترق رمز الطوارئ دون فتح جلسة',
          'إجراء مطلوب':    'الرمز لم يعد صالحاً — هيّئ ADMIN_BREAKGLASS_HASH جديداً',
        },
        en: {
          'Target admin':    admin.email,
          'Error':           sessErr.message,
          '❌ Result':        '⚠️ The emergency code burned without opening a session',
          'Action required': 'The code is no longer valid — configure a new ADMIN_BREAKGLASS_HASH',
        },
        ku: {
          'ئەدمینی مەبەست': admin.email,
          'هەڵە':           sessErr.message,
          '❌ ئەنجام':       '⚠️ کۆدی فریاکەوتن سووتا بەبێ کردنەوەی دانیشتن',
          'کردەی پێویست':   'کۆدەکە چیتر کارا نییە — ADMIN_BREAKGLASS_HASH ی نوێ دابنێ',
        },
      });
      throw sessErr;
    }

    await supabaseAdmin
      .from('users')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', admin.id);

    await supabaseAdmin.from('admin_audit_log').insert({
      admin_id:    admin.id,
      session_id:  adminSession.id,
      action:      'admin_breakglass_login',
      target_type: 'user',
      target_id:   admin.id,
      ip_address:  ip,
      auth_method: 'breakglass',
      after_data:  { user_agent: ua, fingerprint },
    });

    logger.warn(`🚨 BREAKGLASS LOGIN SUCCEEDED → ${admin.email} from ${ip || 'unknown IP'}`);
    await alert(TITLE_SUCCESS, {
      ar: {
        'الأدمن':       `${admin.full_name} (${admin.email})`,
        '✅ النتيجة':    'حُرق الرمز — لن يعمل مرّة أخرى',
        'إجراء مطلوب':  'إن لم تكن أنت: غيّر كلمة المرور، وأنهِ الجلسات، ودوّر الرمز فوراً',
      },
      en: {
        'Admin':           `${admin.full_name} (${admin.email})`,
        '✅ Result':        'The code is burned — it will not work again',
        'Action required': 'If this was not you: change the password, end all sessions, and rotate the code immediately',
      },
      ku: {
        'ئەدمین':        `${admin.full_name} (${admin.email})`,
        '✅ ئەنجام':      'کۆدەکە سووتا — جارێکی تر کار ناکات',
        'کردەی پێویست':  'ئەگەر تۆ نەبووی: وشەی تێپەڕبوون بگۆڕە، هەموو دانیشتنەکان کۆتایی پێبهێنە، و کۆدەکە بگۆڕە',
      },
    }, ALERT_KEYBOARD);

    // Exactly the same response shape as verify-2fa — the frontend reuses the same
    // session-save path.
    return success(res, {
      admin_token,
      admin: { id: admin.id, full_name: admin.full_name, email: admin.email },
    }, 'Signed in with the emergency code — the code is now burned');
  } catch (err) {
    next(err);
  }
};

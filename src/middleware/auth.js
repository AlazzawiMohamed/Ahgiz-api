const jwt = require('jsonwebtoken');
const { supabaseAdmin } = require('../utils/supabase');
const { error } = require('../utils/response');

const authenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    // TODO(i18n): replace with i18n key
    return error(res, 'غير مصرح — أرسل: Authorization: Bearer <token>', 401);
  }

  const token = authHeader.split(' ')[1];

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: ['HS256'],
      issuer:     process.env.JWT_ISSUER    || 'ahgiz.app',
      audience:   process.env.JWT_AUDIENCE  || 'ahgiz-api',
    });
  } catch (err) {
    // TODO(i18n): replace with i18n key
    const msg = err.name === 'TokenExpiredError'
      ? 'انتهت صلاحية الجلسة — استخدم refreshToken'
      : 'التوكن غير صالح';
    return error(res, msg, 401);
  }

  if (decoded.type !== 'access') {
    // TODO(i18n): replace with i18n key
    return error(res, 'نوع التوكن خاطئ', 401);
  }

  const { data: user } = await supabaseAdmin
    .from('users')
    .select('id, phone, role, is_active, is_banned, min_iat, deleted_at')
    .eq('id', decoded.id)
    .single();

  // TODO(i18n): replace with i18n key
  if (!user || user.deleted_at) return error(res, 'المستخدم غير موجود', 401);
  // TODO(i18n): replace with i18n key
  if (!user.is_active)          return error(res, 'الحساب معطل', 401);
  // TODO(i18n): replace with i18n key
  if (user.is_banned)           return error(res, 'الحساب محظور', 403);

  // Invalidate tokens issued before min_iat (forced logout / password-change)
  if (user.min_iat && decoded.iat < new Date(user.min_iat).getTime() / 1000) {
    // TODO(i18n): replace with i18n key
    return error(res, 'الجلسة ملغاة — سجل دخولك مجدداً', 401);
  }

  // auth_method comes from the token, not the database: it is a property of the
  // SESSION, not of the user. Only admin tokens carry it ('password_2fa' |
  // 'breakglass'), so the tag reaches every admin_audit_log row — meaning actions
  // taken by an admin who entered via break-glass are visibly marked as such.
  // Regular user tokens do not carry it => undefined => NULL in the log.
  req.user = { id: user.id, phone: user.phone, role: user.role, auth_method: decoded.auth_method };
  next();
};

const authorize = (...roles) => (req, res, next) => {
  // TODO(i18n): replace with i18n key
  if (!req.user) return error(res, 'غير مصرح', 401);
  if (!roles.includes(req.user.role)) {
    // TODO(i18n): replace with i18n key
    return error(res, `الوصول مخصص لـ: ${roles.join(', ')}`, 403);
  }
  next();
};

// Attach user if token present but don't block if missing
const optionalAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return next();
  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET, {
      algorithms: ['HS256'],
      issuer:   process.env.JWT_ISSUER   || 'ahgiz.app',
      audience: process.env.JWT_AUDIENCE || 'ahgiz-api',
    });
    if (decoded.type === 'access') {
      req.user = { id: decoded.id, phone: decoded.phone, role: decoded.role };
    }
  } catch {
    // ignore
  }
  next();
};

module.exports = { authenticate, authorize, optionalAuth };

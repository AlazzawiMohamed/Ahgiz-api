const jwt = require('jsonwebtoken');
const { supabaseAdmin } = require('../utils/supabase');
const { error } = require('../utils/response');

const authenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return error(res, 'غير مصرح — أرسل: Authorization: Bearer <token>', 401);
  }

  const token = authHeader.split(' ')[1];

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    const msg = err.name === 'TokenExpiredError'
      ? 'انتهت صلاحية الجلسة — استخدم refreshToken'
      : 'التوكن غير صالح';
    return error(res, msg, 401);
  }

  if (decoded.type !== 'access') {
    return error(res, 'نوع التوكن خاطئ', 401);
  }

  const { data: user } = await supabaseAdmin
    .from('users')
    .select('id, phone, role, is_active, is_banned, min_iat, deleted_at')
    .eq('id', decoded.id)
    .single();

  if (!user || user.deleted_at) return error(res, 'المستخدم غير موجود', 401);
  if (!user.is_active)          return error(res, 'الحساب معطل', 401);
  if (user.is_banned)           return error(res, 'الحساب محظور', 403);

  // Invalidate tokens issued before min_iat (forced logout / password-change)
  if (user.min_iat && decoded.iat < new Date(user.min_iat).getTime() / 1000) {
    return error(res, 'الجلسة ملغاة — سجل دخولك مجدداً', 401);
  }

  req.user = { id: user.id, phone: user.phone, role: user.role };
  next();
};

const authorize = (...roles) => (req, res, next) => {
  if (!req.user) return error(res, 'غير مصرح', 401);
  if (!roles.includes(req.user.role)) {
    return error(res, `الوصول مخصص لـ: ${roles.join(', ')}`, 403);
  }
  next();
};

// Attach user if token present but don't block if missing
const optionalAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return next();
  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
    if (decoded.type === 'access') {
      req.user = { id: decoded.id, phone: decoded.phone, role: decoded.role };
    }
  } catch {
    // ignore
  }
  next();
};

module.exports = { authenticate, authorize, optionalAuth };

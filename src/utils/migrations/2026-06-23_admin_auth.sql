-- Sprint 5 — مصادقة الأدمن + إعدادات المنصة الأساسية
-- آمنة وإضافية فقط (idempotent). طبّقها على قاعدة بيانات Supabase.

-- ── كلمة مرور الأدمن (الدخول بالبريد + كلمة المرور ثم 2FA عبر واتساب) ──────────
-- التطبيق يعتمد phone-OTP، فلا يوجد عمود كلمة مرور — نضيفه للأدمن فقط.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_hash TEXT;

-- ── إعدادات المنصة المعروضة في A12 (لا تُنشأ إن كانت موجودة) ───────────────────
INSERT INTO platform_settings (key, value, description) VALUES
  ('booking_hold_minutes',          '8',       'مدة حجز الموعد المؤقت بالدقائق قبل انتهاء الصلاحية'),
  ('calendar_pending_color',        '#F97316', 'لون الحجوزات المعلّقة في التقويم (ثابت — لا يُعدَّل من الواجهة)'),
  ('calendar_realtime_enabled',     'true',    'تفعيل التحديث اللحظي لتقويم صاحب العمل'),
  ('calendar_poll_interval_seconds','300',     'فاصل التحديث الاحتياطي لتقويم صاحب العمل بالثواني')
ON CONFLICT (key) DO NOTHING;

-- ── (اختياري) فهرس على بريد الأدمن لتسريع الدخول ──────────────────────────────
CREATE INDEX IF NOT EXISTS idx_users_email_admin
  ON users (email) WHERE role = 'admin';

-- ─────────────────────────────────────────────────────────────────────────────
-- تهيئة كلمة مرور أدمن لمرة واحدة (شغّلها يدوياً من جذر ahgiz-api، استبدل القيم):
--
--   node -e "const b=require('bcrypt');const {supabaseAdmin}=require('./src/utils/supabase');\
--   b.hash(process.argv[1],10).then(h=>supabaseAdmin.from('users')\
--   .update({password_hash:h}).eq('email',process.argv[2]).eq('role','admin')\
--   .then(({error})=>{console.log(error||'تم تعيين كلمة مرور الأدمن');process.exit(0)}))" 'MyStrongPass!' 'admin@ahgiz.iq'
--
-- (يتطلب أن يكون المستخدم موجوداً بدور admin مع بريد وهاتف عراقي صالح لاستلام 2FA)

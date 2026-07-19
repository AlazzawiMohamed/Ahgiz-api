-- Sprint 5 — admin authentication + core platform settings
-- safe and additive only (idempotent). Apply it to the Supabase database.

-- ── admin password (login with email + password then 2FA via WhatsApp) ──────────
-- the app relies on phone-OTP, so there is no password column — we add it for admins only.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_hash TEXT;

-- ── platform settings shown in A12 (not created if they already exist) ───────────────────
INSERT INTO platform_settings (key, value, description) VALUES
  ('booking_hold_minutes',          '8',       'مدة حجز الموعد المؤقت بالدقائق قبل انتهاء الصلاحية'),
  ('calendar_pending_color',        '#F97316', 'لون الحجوزات المعلّقة في التقويم (ثابت — لا يُعدَّل من الواجهة)'),
  ('calendar_realtime_enabled',     'true',    'تفعيل التحديث اللحظي لتقويم صاحب العمل'),
  ('calendar_poll_interval_seconds','300',     'فاصل التحديث الاحتياطي لتقويم صاحب العمل بالثواني')
ON CONFLICT (key) DO NOTHING;

-- ── (optional) index on admin email to speed up login ──────────────────────────────
CREATE INDEX IF NOT EXISTS idx_users_email_admin
  ON users (email) WHERE role = 'admin';

-- ─────────────────────────────────────────────────────────────────────────────
-- one-time admin password setup (run it manually from the ahgiz-api root, replace the values):
--
--   node -e "const b=require('bcrypt');const {supabaseAdmin}=require('./src/utils/supabase');\
--   b.hash(process.argv[1],10).then(h=>supabaseAdmin.from('users')\
--   .update({password_hash:h}).eq('email',process.argv[2]).eq('role','admin')\
--   .then(({error})=>{console.log(error||'admin password set');process.exit(0)}))" 'MyStrongPass!' 'admin@ahgiz.iq'
--
-- (requires the user to exist with role admin and a valid email and Iraqi phone to receive 2FA)

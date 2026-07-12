-- 2026-07-12 — Layer 2: قناة بريد احتياطية لرمز الأدمن الثنائي (2FA)
--
-- السياق: بعد إغلاق ثغرة تسريب رمز OTP، صار تسجيل دخول الأدمن fail-closed:
-- إن تعذّر واتساب فلا سبيل للدخول. هذه الطبقة تضيف قناة تسليم ثانية للرمز نفسه
-- (وليست آلية مصادقة ثانية: نفس الرمز، نفس الجلسة المُجزّأة، نفس مسار verify-2fa).
--
-- ⚠️ يُطبَّق يدوياً عبر Supabase SQL Editor (راجع CLAUDE.md).

-- ─── 1) أعمدة توثيق بريد الأدمن ──────────────────────────────────────────────
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS admin_email_verified_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS admin_email_verify_token_hash  TEXT,
  ADD COLUMN IF NOT EXISTS admin_email_verify_expires_at  TIMESTAMPTZ;

COMMENT ON COLUMN public.users.admin_email_verified_at IS
  'بريد أدمن موثّق (أثبت التحكّم بالصندوق). NULL = غير موثّق ⇒ لا تُستخدم كقناة 2FA أبداً.';

-- ─── 2) أي تغيير للبريد يُبطل التوثيق فوراً ──────────────────────────────────
-- السبب الجذري: PUT /users/me (user.controller.js:69) يسمح للمستخدم — بما فيه الأدمن —
-- بتغيير users.email. بدون هذا، مَن يستولي على جلسة أدمن يغيّر البريد فيحوّل رموز
-- الـ2FA إلى صندوقه. الحارس في قاعدة البيانات وليس في التطبيق: كل الكتابات تمرّ عبر
-- service_role، فأي مسار مستقبلي (أو كتابة SQL مباشرة) يبقى مشمولاً.
CREATE OR REPLACE FUNCTION public.clear_admin_email_verification()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.email IS DISTINCT FROM OLD.email THEN
    NEW.admin_email_verified_at       := NULL;
    NEW.admin_email_verify_token_hash := NULL;
    NEW.admin_email_verify_expires_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_clear_admin_email_verification ON public.users;
CREATE TRIGGER trg_clear_admin_email_verification
  BEFORE UPDATE OF email ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.clear_admin_email_verification();

-- ─── 3) قاعدة الأمان الإلزامية (CLAUDE.md) — لا استثناء ──────────────────────
-- Supabase يمنح EXECUTE لـ PUBLIC افتراضياً على كل دالة جديدة.
-- (التريغر نفسه يعمل بصلاحيات مالك الجدول، فالسحب هنا لا يعطّله.)
REVOKE EXECUTE ON FUNCTION public.clear_admin_email_verification() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.clear_admin_email_verification() TO service_role;

-- ─── تحقّق ───────────────────────────────────────────────────────────────────
-- SELECT column_name FROM information_schema.columns
--  WHERE table_schema='public' AND table_name='users' AND column_name LIKE 'admin_email%';
-- SELECT tgname FROM pg_trigger WHERE tgname = 'trg_clear_admin_email_verification';

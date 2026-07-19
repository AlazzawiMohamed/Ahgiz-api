-- 2026-07-12 — Layer 2: fallback email channel for the admin two-factor (2FA) code
--
-- Context: after closing the OTP-code leak vulnerability, admin login became fail-closed:
-- if WhatsApp fails there is no way in. This layer adds a second delivery channel for the same code
-- (not a second authentication factor: same code, same hashed session, same verify-2fa path).
--
-- ⚠️ applied manually via the Supabase SQL Editor (see CLAUDE.md).

-- ─── 1) admin email verification columns ──────────────────────────────────────────────
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS admin_email_verified_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS admin_email_verify_token_hash  TEXT,
  ADD COLUMN IF NOT EXISTS admin_email_verify_expires_at  TIMESTAMPTZ;

COMMENT ON COLUMN public.users.admin_email_verified_at IS
  'Verified admin email (proved mailbox control). NULL = unverified => never used as a 2FA channel.';

-- ─── 2) any email change invalidates verification immediately ──────────────────────────────────
-- Root cause: PUT /users/me (user.controller.js:69) lets the user — including the admin —
-- change users.email. Without this, whoever hijacks an admin session changes the email and redirects the
-- 2FA codes to their own mailbox. The guard is in the database, not the app: all writes go through
-- service_role, so any future path (or direct SQL write) stays covered.
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

-- ─── 3) mandatory security rule (CLAUDE.md) — no exception ──────────────────────
-- Supabase grants EXECUTE to PUBLIC by default on every new function.
-- (the trigger itself runs with the table owner privileges, so this REVOKE does not disable it.)
REVOKE EXECUTE ON FUNCTION public.clear_admin_email_verification() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.clear_admin_email_verification() TO service_role;

-- ─── verification ───────────────────────────────────────────────────────────────────
-- SELECT column_name FROM information_schema.columns
--  WHERE table_schema='public' AND table_name='users' AND column_name LIKE 'admin_email%';
-- SELECT tgname FROM pg_trigger WHERE tgname = 'trg_clear_admin_email_verification';

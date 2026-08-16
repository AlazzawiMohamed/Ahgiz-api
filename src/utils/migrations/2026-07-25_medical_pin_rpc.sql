-- 2026-07-25_medical_pin_rpc.sql
-- C13.5 "My Files" biometric/PIN gate — server side (PIN fallback + lockout + recovery).
--
-- Setters (three, each proves what it should):
--   * set_files_pin    — INITIAL enrollment only (rejects if a PIN already exists)
--   * change_files_pin — change an existing PIN; requires the CURRENT pin, throttled
--                        through the same lockout state machine as unlock
--   * reset_files_pin  — recovery only; sets a brand-new PIN + clears the lock/counter,
--                        called by the API ONLY after a recovery OTP has been verified
-- Verifier:
--   * verify_files_pin — atomic verify + 3-tier cumulative lockout:
--        3 failures → 5 min | 6 → 30 min | 9 → PERMANENT (recovery is the only exit).
--        pin_failed_attempts is CUMULATIVE — reset to 0 by a correct PIN OR a successful
--        biometric unlock (see below), never by a lockout expiring. Permanent is derived
--        from pin_failed_attempts >= 9 (no new column).
-- Biometric reset:
--   * reset_pin_attempts_after_biometric — clears the counter + timed lock after a
--        successful Face ID / Touch ID unlock, but REFUSES when permanently locked (D2).
--
-- Hashing is in-DB via pgcrypto crypt()/gen_salt('bf',10) (bcrypt cost 10, mirrors
-- users.password_hash); the raw hash never leaves the database.
--
-- ⚠️ pgcrypto lives in the `extensions` schema on Supabase; every function pins
-- search_path = public, extensions, pg_catalog. The DO block at the end round-trips
-- crypt()/gen_salt() under that path and RAISEs if pgcrypto is unresolvable — a clean
-- apply proves verification is wired.
--
-- Security: functions trust ONLY the caller-supplied p_user_id (the API derives it from
-- the token, never the request body). Locked down with the mandatory REVOKE/GRANT below.
--
-- safe and idempotent. Apply it manually via the Supabase SQL Editor.

-- ── set / enroll the Files PIN (INITIAL enrollment only) ─────────────────────
CREATE OR REPLACE FUNCTION public.set_files_pin(p_user_id uuid, p_pin text)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $$
DECLARE
  v_existing text;
BEGIN
  IF p_pin !~ '^[0-9]{6}$' THEN
    RAISE EXCEPTION 'invalid_pin_format' USING ERRCODE = 'check_violation';
  END IF;

  SELECT pin_hash INTO v_existing FROM users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'user_not_found' USING ERRCODE = 'no_data_found';
  END IF;

  -- Enrollment ONLY. Changing a PIN must go through change_files_pin (proves the
  -- current PIN); a forgotten PIN must go through reset_files_pin (OTP recovery).
  -- This closes the bypass where the enroll endpoint could overwrite an existing PIN.
  IF v_existing IS NOT NULL THEN
    RAISE EXCEPTION 'pin_already_set' USING ERRCODE = 'unique_violation';
  END IF;

  UPDATE users
     SET pin_hash            = crypt(p_pin, gen_salt('bf', 10)),
         biometric_enabled   = true,
         pin_failed_attempts = 0,
         pin_locked_until    = NULL
   WHERE id = p_user_id;
END;
$$;

-- ── verify the Files PIN (atomic verify + 3-tier cumulative lockout) ─────────
-- Returns jsonb the API relays verbatim:
--   { "ok": true }
--   { "ok": false, "reason": "no_pin" }
--   { "ok": false, "reason": "invalid",   "attempts_left": <until next lockout>, "failed_attempts": <n> }
--   { "ok": false, "reason": "locked",    "attempts_left": 0, "locked_until": <ts>, "failed_attempts": <n> }
--   { "ok": false, "reason": "permanent", "failed_attempts": <n> }   ← 9+ failures, recovery only
CREATE OR REPLACE FUNCTION public.verify_files_pin(p_user_id uuid, p_pin text)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $$
DECLARE
  v_step      CONSTANT integer := 3;   -- escalate at every 3rd cumulative failure
  v_permanent CONSTANT integer := 9;   -- 3rd tier = permanent (recovery only)
  v_now          timestamptz := now();
  v_hash         text;
  v_attempts     integer;
  v_locked_until timestamptz;
  v_new_lock     timestamptz;
  v_lock_minutes integer;
BEGIN
  -- Row lock so concurrent attempts cannot race the failure counter (anti brute force).
  SELECT pin_hash, pin_failed_attempts, pin_locked_until
    INTO v_hash, v_attempts, v_locked_until
    FROM users
   WHERE id = p_user_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'user_not_found' USING ERRCODE = 'no_data_found';
  END IF;

  IF v_hash IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_pin');
  END IF;

  -- Permanent lock (9+ cumulative failures) — checked FIRST; only recovery clears it.
  IF v_attempts >= v_permanent THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'permanent', 'failed_attempts', v_attempts);
  END IF;

  -- Inside an active timed-lockout window → reject without checking the PIN.
  IF v_locked_until IS NOT NULL AND v_locked_until > v_now THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'locked',
      'attempts_left', 0, 'locked_until', v_locked_until,
      'failed_attempts', v_attempts);
  END IF;

  -- Cumulative: an expired lock does NOT reset the counter; only a correct PIN does.

  -- Correct PIN → clear counters and unlock.
  IF crypt(p_pin, v_hash) = v_hash THEN
    UPDATE users
       SET pin_failed_attempts = 0,
           pin_locked_until    = NULL
     WHERE id = p_user_id;
    RETURN jsonb_build_object('ok', true);
  END IF;

  -- Wrong PIN → count the failure (cumulative).
  v_attempts := v_attempts + 1;

  -- 9th failure → permanent lock (recovery only).
  IF v_attempts >= v_permanent THEN
    UPDATE users
       SET pin_failed_attempts = v_attempts,
           pin_locked_until    = NULL
     WHERE id = p_user_id;
    RETURN jsonb_build_object('ok', false, 'reason', 'permanent', 'failed_attempts', v_attempts);
  END IF;

  -- 3rd → 5 min, 6th → 30 min.
  IF v_attempts % v_step = 0 THEN
    v_lock_minutes := CASE v_attempts WHEN 3 THEN 5 WHEN 6 THEN 30 ELSE 30 END;
    v_new_lock := v_now + make_interval(mins => v_lock_minutes);
    UPDATE users
       SET pin_failed_attempts = v_attempts,
           pin_locked_until    = v_new_lock
     WHERE id = p_user_id;
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'locked',
      'attempts_left', 0, 'locked_until', v_new_lock,
      'failed_attempts', v_attempts);
  END IF;

  -- Between escalation points → record the failure and clear any expired lock.
  UPDATE users
     SET pin_failed_attempts = v_attempts,
         pin_locked_until    = NULL
   WHERE id = p_user_id;

  RETURN jsonb_build_object(
    'ok', false, 'reason', 'invalid',
    'attempts_left', v_step - (v_attempts % v_step),   -- failures remaining until the next lockout
    'failed_attempts', v_attempts);
END;
$$;

-- ── change the Files PIN (requires the CURRENT pin; throttled) ───────────────
-- Runs the current-PIN check through verify_files_pin's state machine so that
-- Settings → Change PIN cannot become an unthrottled brute-force oracle. Sets the
-- new PIN only if the current one verifies; otherwise relays the verdict unchanged.
CREATE OR REPLACE FUNCTION public.change_files_pin(p_user_id uuid, p_current_pin text, p_new_pin text)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $$
DECLARE
  v_verdict jsonb;
BEGIN
  IF p_new_pin !~ '^[0-9]{6}$' THEN
    RAISE EXCEPTION 'invalid_pin_format' USING ERRCODE = 'check_violation';
  END IF;

  -- Verify (and throttle) the current PIN. On success this already reset the counter.
  v_verdict := public.verify_files_pin(p_user_id, p_current_pin);
  IF (v_verdict->>'ok')::boolean IS NOT TRUE THEN
    RETURN v_verdict;  -- invalid / locked / permanent — PIN unchanged
  END IF;

  UPDATE users SET pin_hash = crypt(p_new_pin, gen_salt('bf', 10)) WHERE id = p_user_id;
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ── reset the Files PIN (recovery only) ─────────────────────────────────────
-- Sets a brand-new PIN and clears the lock/counter (incl. the permanent lock).
-- The API calls this ONLY after a recovery OTP has been verified; it never restores
-- the old PIN and never requires the current one (the OTP is the proof).
CREATE OR REPLACE FUNCTION public.reset_files_pin(p_user_id uuid, p_new_pin text)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $$
BEGIN
  IF p_new_pin !~ '^[0-9]{6}$' THEN
    RAISE EXCEPTION 'invalid_pin_format' USING ERRCODE = 'check_violation';
  END IF;

  UPDATE users
     SET pin_hash            = crypt(p_new_pin, gen_salt('bf', 10)),
         biometric_enabled   = true,
         pin_failed_attempts = 0,
         pin_locked_until    = NULL
   WHERE id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'user_not_found' USING ERRCODE = 'no_data_found';
  END IF;
END;
$$;

-- ── reset the failure counter after a successful biometric unlock ────────────
-- Face ID / Touch ID success is a legitimate identity proof, so it clears the PIN
-- failure counter + timed lock exactly like a correct PIN. This stops a biometric
-- user's occasional PIN mistypes from slowly accumulating to a lockout over time.
-- EXCEPTION: it does NOT clear a PERMANENT lock (9+ cumulative failures) — that
-- stays recovery-only (decision D2). Enforced here so a client bug can never make
-- biometrics bypass the permanent lock. Returns:
--   { "ok": true }                          — counter/lock cleared
--   { "ok": false, "reason": "permanent" }  — refused; recovery is the only exit
CREATE OR REPLACE FUNCTION public.reset_pin_attempts_after_biometric(p_user_id uuid)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $$
DECLARE
  v_permanent CONSTANT integer := 9;   -- kept in sync with verify_files_pin's v_permanent
  v_attempts  integer;
BEGIN
  SELECT pin_failed_attempts INTO v_attempts FROM users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'user_not_found' USING ERRCODE = 'no_data_found';
  END IF;

  -- Permanent lock is NOT bypassable by biometrics — recovery via phone code only.
  IF v_attempts >= v_permanent THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'permanent');
  END IF;

  UPDATE users
     SET pin_failed_attempts = 0,
         pin_locked_until    = NULL
   WHERE id = p_user_id;

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ── recovery OTP storage (dedicated — kept separate from login OTPs) ─────────
-- One row per recovery code request. Codes are bcrypt-hashed (never stored raw),
-- delivered via the existing WhatsApp/telegram-dev transport, and consumed on use.
CREATE TABLE IF NOT EXISTS public.files_pin_recovery_otps (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  otp_hash    text NOT NULL,                         -- bcrypt hash of the 6-digit code
  expires_at  timestamptz NOT NULL,
  attempts    integer NOT NULL DEFAULT 0,
  is_used     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS files_pin_recovery_user_idx
  ON public.files_pin_recovery_otps (user_id, is_used, expires_at DESC);

-- ── mandatory lockdown (CLAUDE.md security rule — exact arg-type signatures) ──
REVOKE EXECUTE ON FUNCTION public.set_files_pin(uuid, text)              FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.set_files_pin(uuid, text)              TO service_role;

REVOKE EXECUTE ON FUNCTION public.verify_files_pin(uuid, text)          FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.verify_files_pin(uuid, text)          TO service_role;

REVOKE EXECUTE ON FUNCTION public.change_files_pin(uuid, text, text)    FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.change_files_pin(uuid, text, text)    TO service_role;

REVOKE EXECUTE ON FUNCTION public.reset_files_pin(uuid, text)           FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.reset_files_pin(uuid, text)           TO service_role;

REVOKE EXECUTE ON FUNCTION public.reset_pin_attempts_after_biometric(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.reset_pin_attempts_after_biometric(uuid) TO service_role;

REVOKE ALL ON TABLE public.files_pin_recovery_otps FROM PUBLIC, anon, authenticated;
GRANT  SELECT, INSERT, UPDATE ON TABLE public.files_pin_recovery_otps TO service_role;
ALTER TABLE public.files_pin_recovery_otps ENABLE ROW LEVEL SECURITY;

-- ── fail-fast self-test: prove pgcrypto resolves under the functions' search_path ──
DO $$
DECLARE
  v_hash text;
BEGIN
  PERFORM set_config('search_path', 'public, extensions, pg_catalog', true);
  v_hash := crypt('123456', gen_salt('bf', 10));
  IF crypt('123456', v_hash) <> v_hash OR crypt('000000', v_hash) = v_hash THEN
    RAISE EXCEPTION 'pgcrypto crypt() self-test failed — verify the extensions schema / search_path';
  END IF;
END;
$$;

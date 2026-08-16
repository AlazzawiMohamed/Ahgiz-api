-- 2026-07-25_medical_biometric.sql
-- Adds the columns that back the C13.5 "My Files" biometric/PIN gate.
-- Face ID / Touch ID is verified on-device (expo-local-authentication); the
-- server only stores the PIN fallback (bcrypt, mirroring users.password_hash)
-- and the per-user lockout counters used by the PIN-verify RPC (added later).
--
-- safe and additive only (idempotent). Apply it manually via the Supabase SQL Editor.
-- No new function is created here, so the mandatory REVOKE/GRANT rule does not
-- apply to this file — it applies to the PIN-verify RPC migration (next phase).

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS biometric_enabled    BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pin_hash             TEXT,
  ADD COLUMN IF NOT EXISTS pin_failed_attempts  INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pin_locked_until     TIMESTAMPTZ;

COMMENT ON COLUMN users.biometric_enabled IS
  'C13.5 My Files gate: has the user enrolled the biometric/PIN lock on their files tab.';
COMMENT ON COLUMN users.pin_hash IS
  'C13.5 My Files gate: bcrypt hash (cost 10, mirrors password_hash) of the 6-digit PIN fallback. NULL until a PIN is set.';
COMMENT ON COLUMN users.pin_failed_attempts IS
  'C13.5 My Files gate: consecutive failed PIN attempts; reset to 0 on success. Drives the lockout in the PIN-verify RPC.';
COMMENT ON COLUMN users.pin_locked_until IS
  'C13.5 My Files gate: PIN entry is locked until this timestamp after too many failures. NULL = not locked.';

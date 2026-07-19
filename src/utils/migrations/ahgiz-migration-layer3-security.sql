-- 2026-07-13 — Layer 3: break-glass code + security alerts + permanent audit log
--
-- Context: Layer 1 (WhatsApp) and Layer 2 (email) are both delivery channels for
-- the same 2FA code. If both go down, admin login is impossible (deliberate
-- fail-closed — see config.js). This layer adds the last way in: an emergency
-- code that is usable EXACTLY ONCE, is burned on first success, and fires an
-- immediate alert on two independent channels.
--
-- Governing principle: the code opens the door, but it cannot do so silently.
-- Hence the log here is PERMANENT: no UPDATE, no DELETE, no TRUNCATE — not even
-- with a stolen service_role key. Whoever holds the key can append, never erase.
--
-- Applies after: 2026-07-12_admin_email_verification.sql
-- Applied MANUALLY via the Supabase SQL Editor (see CLAUDE.md). Never automatic.
--
-- DEPLOY ORDER: apply this BEFORE `railway up`.
-- The new code writes the auth_method column on the existing verify-2fa path. If
-- the code ships first, PostgREST rejects the unknown column and the audit insert
-- fails silently (supabase-js does not throw) => a window of UNAUDITED admin
-- logins. Login itself keeps working, but the log loses those rows.

-- Everything in one transaction: the migration applies whole, or not at all.
-- A half-applied security layer is worse than none: a table created without its
-- append-only trigger is a log that looks protected while it is wide open.
-- (Every statement in this file is transactional in Postgres.)
BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- 0) Root-cause fix that predates this layer — an FK that makes a
--    "permanent log" impossible
-- ═══════════════════════════════════════════════════════════════════════════
-- admin_audit_log.session_id references admin_sessions(id) with no ON DELETE,
-- and cleanup_admin_sessions() (registered in cron_schedule) deletes expired
-- sessions:
--
--   DELETE FROM admin_sessions WHERE expires_at < NOW() - INTERVAL '7 days';
--
-- Any session that wrote a row into admin_audit_log (and every admin login does
-- — see verify2fa) becomes undeletable => the function fails with an FK
-- violation on every run. The function is not scheduled in jobs.js today, so the
-- bug is LATENT, not live — but it detonates the moment it is wired up, and
-- cron_schedule already registers it as something that ought to run.
--
-- The correct fix is to DROP the constraint, not ON DELETE SET NULL: SET NULL
-- issues an UPDATE against admin_audit_log, which the append-only trigger below
-- rejects => we would trade one broken cron for another. A permanent log must
-- not be tied to the lifetime of a prunable table: session_id stays as a bare
-- correlation value for forensics, surviving the session row itself.
ALTER TABLE public.admin_audit_log
  DROP CONSTRAINT IF EXISTS admin_audit_log_session_id_fkey;

COMMENT ON COLUMN public.admin_audit_log.session_id IS
  'Admin session id at the time of the event. Deliberately has NO foreign key: '
  'this log is permanent and must survive pruning of admin_sessions '
  '(cleanup_admin_sessions).';

-- ═══════════════════════════════════════════════════════════════════════════
-- 1) Authentication method on each log row — how did this admin get in?
-- ═══════════════════════════════════════════════════════════════════════════
-- 'password_2fa' = the normal path | 'breakglass' = the emergency code.
-- Without this column, an emergency login looks identical to any other login.
ALTER TABLE public.admin_audit_log
  ADD COLUMN IF NOT EXISTS auth_method TEXT;

COMMENT ON COLUMN public.admin_audit_log.auth_method IS
  'Authentication method: password_2fa | breakglass | NULL (rows predating Layer 3).';

CREATE INDEX IF NOT EXISTS idx_admin_audit_auth_method
  ON public.admin_audit_log(auth_method)
  WHERE auth_method IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2) Break-glass burn table — single use guaranteed by a database constraint
-- ═══════════════════════════════════════════════════════════════════════════
-- hash_fingerprint = sha256(ADMIN_BREAKGLASS_HASH) — a fingerprint of the bcrypt
-- hash itself, not of the raw code. The raw code never touches disk, not even
-- hashed.
--
-- UNIQUE is the burn mechanism: burning = INSERT. A second attempt collides with
-- the constraint and fails. This is atomic — there is no race between two
-- concurrent requests carrying the same code: exactly one INSERT wins, and the
-- other is rejected by the database rather than by application code.
--
-- Rotating the code = set a new ADMIN_BREAKGLASS_HASH => new fingerprint => a
-- fresh single use.
CREATE TABLE IF NOT EXISTS public.admin_breakglass_uses (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  hash_fingerprint TEXT NOT NULL UNIQUE,   -- sha256 hex of the configured bcrypt hash
  admin_id         UUID REFERENCES users(id),

  ip_address       TEXT,
  user_agent       TEXT,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.admin_breakglass_uses IS
'Break-glass burn ledger — one row per configured code, forever.
 UNIQUE(hash_fingerprint) is what guarantees single use (not application code).
 Append-only: no UPDATE, no DELETE, no TRUNCATE — otherwise a burned code could
 be "un-burned" and replayed. Rotate the code by changing ADMIN_BREAKGLASS_HASH.';

CREATE INDEX IF NOT EXISTS idx_breakglass_created ON public.admin_breakglass_uses(created_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- 3) Append-only — a log that cannot be erased
-- ═══════════════════════════════════════════════════════════════════════════
-- The real threat is a leaked service_role key. That key bypasses RLS, but it is
-- not the table owner in Supabase (postgres is) => it cannot ALTER TABLE ...
-- DISABLE TRIGGER, nor DROP TRIGGER. So the trigger is a genuine constraint on
-- the attacker, not decoration.
--
-- TRUNCATE does not fire row-level triggers at all — hence the separate
-- STATEMENT-level trigger. Omitting it would leave "wipe the whole log in one
-- command" wide open.
CREATE OR REPLACE FUNCTION public.forbid_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Table % is append-only — operation % is rejected', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT    = 'Permanent security log: cannot be updated, deleted or truncated.';
END;
$$;

COMMENT ON FUNCTION public.forbid_mutation() IS
  'Generic trigger that rejects UPDATE/DELETE/TRUNCATE — enforces append-only on security logs.';

-- ── admin_audit_log ──────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_admin_audit_append_only ON public.admin_audit_log;
CREATE TRIGGER trg_admin_audit_append_only
  BEFORE UPDATE OR DELETE ON public.admin_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.forbid_mutation();

DROP TRIGGER IF EXISTS trg_admin_audit_no_truncate ON public.admin_audit_log;
CREATE TRIGGER trg_admin_audit_no_truncate
  BEFORE TRUNCATE ON public.admin_audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();

-- ── admin_breakglass_uses ────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_breakglass_append_only ON public.admin_breakglass_uses;
CREATE TRIGGER trg_breakglass_append_only
  BEFORE UPDATE OR DELETE ON public.admin_breakglass_uses
  FOR EACH ROW EXECUTE FUNCTION public.forbid_mutation();

DROP TRIGGER IF EXISTS trg_breakglass_no_truncate ON public.admin_breakglass_uses;
CREATE TRIGGER trg_breakglass_no_truncate
  BEFORE TRUNCATE ON public.admin_breakglass_uses
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();

-- ═══════════════════════════════════════════════════════════════════════════
-- 4) The two alert channels (never both silenced) + the alert language
-- ═══════════════════════════════════════════════════════════════════════════
-- NOTE: the `description` values below are DATA, not code. They are rendered
-- verbatim in the Arabic admin settings page (GET /admin/settings) and every one
-- of the 16 sibling rows in platform_settings is already Arabic. The two channel
-- descriptions stay Arabic deliberately, to keep that page consistent.
--
-- admin_alert_language selects the language of the Telegram/Slack alert body
-- (see services/alert.service.js). Unrecognised or missing => 'ar'.
INSERT INTO public.platform_settings (key, value, description) VALUES
  ('security_alert_telegram_enabled', 'true', 'تنبيهات الأمان عبر تلغرام'),
  ('security_alert_slack_enabled',    'true', 'تنبيهات الأمان عبر سلاك'),
  ('admin_alert_language',            'ar',   'لغة رسائل التنبيه على Telegram/Slack: ar | en | ku')
ON CONFLICT (key) DO NOTHING;

-- Why enforce this in the database rather than the application?
-- PUT /admin/settings/:key (admin.controller.js) writes straight through
-- service_role. A guard in JS protects only that one path; a guard here protects
-- every path — the current one, any future one, and direct SQL. An attacker who
-- has taken over an admin session will try to silence the alerts first.
--
-- Deleting a row counts as disabling: removing it loses the channel, so DELETE is
-- rejected too.
CREATE OR REPLACE FUNCTION public.enforce_security_alert_channel()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_self_key  TEXT := COALESCE(NEW.key, OLD.key);
  v_other_key TEXT;
  v_self_on   BOOLEAN;
  v_other_on  BOOLEAN;
BEGIN
  IF v_self_key NOT IN ('security_alert_telegram_enabled', 'security_alert_slack_enabled') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Cannot delete the security alert channel setting (%)', v_self_key
      USING ERRCODE = 'insufficient_privilege',
            HINT    = 'Deleting it silently disables the channel. Set it to false instead, provided the other channel stays enabled.';
  END IF;

  v_other_key := CASE v_self_key
                   WHEN 'security_alert_telegram_enabled' THEN 'security_alert_slack_enabled'
                   ELSE 'security_alert_telegram_enabled'
                 END;

  v_self_on := lower(trim(COALESCE(NEW.value, ''))) IN ('true', 't', '1', 'yes', 'on');

  SELECT lower(trim(COALESCE(value, ''))) IN ('true', 't', '1', 'yes', 'on')
    INTO v_other_on
    FROM platform_settings
   WHERE key = v_other_key;

  -- Sibling missing = treated as disabled (fail-closed): we never allow disabling
  -- this channel on the assumption that an absent one is carrying the load.
  IF NOT v_self_on AND NOT COALESCE(v_other_on, FALSE) THEN
    RAISE EXCEPTION 'Cannot disable both security alert channels — at least one must stay enabled'
      USING ERRCODE = 'check_violation',
            HINT    = 'Enable the other channel first, then disable this one.';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.enforce_security_alert_channel() IS
  'Prevents disabling/deleting both security alert channels — the last surviving channel cannot be turned off.';

DROP TRIGGER IF EXISTS trg_enforce_security_alert_channel ON public.platform_settings;
CREATE TRIGGER trg_enforce_security_alert_channel
  BEFORE UPDATE OR DELETE ON public.platform_settings
  FOR EACH ROW EXECUTE FUNCTION public.enforce_security_alert_channel();

-- ═══════════════════════════════════════════════════════════════════════════
-- 5) Mandatory security rule (CLAUDE.md) — no exceptions, however harmless
--    the function looks
-- ═══════════════════════════════════════════════════════════════════════════
-- Supabase grants EXECUTE to PUBLIC by default on every new function — trigger
-- functions included. The trigger itself runs with the table owner's privileges,
-- so revoking here does not disable it.
REVOKE EXECUTE ON FUNCTION public.forbid_mutation() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.forbid_mutation() TO service_role;

REVOKE EXECUTE ON FUNCTION public.enforce_security_alert_channel() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.enforce_security_alert_channel() TO service_role;

-- The new table: readable and writable only through service_role (all API traffic
-- goes through it).
REVOKE ALL ON TABLE public.admin_breakglass_uses FROM PUBLIC, anon, authenticated;
GRANT  SELECT, INSERT ON TABLE public.admin_breakglass_uses TO service_role;

ALTER TABLE public.admin_breakglass_uses ENABLE ROW LEVEL SECURITY;
-- No policies: RLS enabled + zero policies = no access at all for anon/authenticated.
-- service_role bypasses RLS by definition, so the API path is unaffected.

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- Verification (run after applying)
-- ═══════════════════════════════════════════════════════════════════════════
-- 1) Constraint dropped:
-- SELECT conname FROM pg_constraint WHERE conname = 'admin_audit_log_session_id_fkey';
--    (zero rows = done)
--
-- 2) All six triggers exist:
-- SELECT tgname, tgrelid::regclass FROM pg_trigger
--  WHERE tgname LIKE 'trg_admin_audit%' OR tgname LIKE 'trg_breakglass%'
--     OR tgname = 'trg_enforce_security_alert_channel';
--
-- 3) The log really is unerasable (both statements must fail):
-- DELETE FROM admin_audit_log WHERE false;        -- raises insufficient_privilege
-- UPDATE admin_audit_log SET action = 'x' WHERE false;
--    Note: WHERE false touches no row, yet is still rejected. The row trigger only
--    fires for matching rows, so if nothing is raised the table is simply empty.
--    Re-run against a real row to confirm.
--
-- 4) Both channels cannot be disabled together:
-- UPDATE platform_settings SET value='false' WHERE key='security_alert_slack_enabled';    -- succeeds
-- UPDATE platform_settings SET value='false' WHERE key='security_alert_telegram_enabled'; -- rejected

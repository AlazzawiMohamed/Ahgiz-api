-- Emergency admin lockdown, toggled from the Telegram bot.
--
-- Seeds the single setting the API reads. Idempotent and additive: no table is created and
-- no function is added, so the REVOKE/GRANT rule in CLAUDE.md does not apply here.
--
-- The API fails OPEN when this row is missing (isAdminLoginLocked treats an unreadable or
-- absent value as UNLOCKED), so applying this migration is not a prerequisite for the API to
-- boot — it is what lets a lockdown persist. Apply it before the first use of the bot.
--
-- Deliberately NOT a DELETE of admin_sessions: lockdown ends sessions by setting
-- users.min_iat, which is what middleware/auth.js actually enforces. See lockdown.service.js.

INSERT INTO platform_settings (key, value, description) VALUES
  ('admin_login_locked', 'false', 'Emergency lock on admin login (/login and /verify-2fa return 423). Toggled from the Telegram bot.')
ON CONFLICT (key) DO NOTHING;

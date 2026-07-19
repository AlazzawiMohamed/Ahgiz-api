-- Sprint 4 — grant privileges on the medical/legal tables to PostgREST roles
-- ahgiz-migration-medlegal.sql created the tables and enabled RLS but did not grant table privileges,
-- so service_role got "permission denied". This file completes the grants. Safe and reversible (REVOKE).
-- apply it after ahgiz-migration-medlegal.sql.

-- service_role: bypasses RLS — used by the API server (supabaseAdmin).
GRANT SELECT, INSERT, UPDATE, DELETE
  ON medical_records, user_files, record_access_grants
  TO service_role;

-- authenticated: direct client access is governed by the RLS policies defined in the medical migration.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON medical_records, user_files, record_access_grants
  TO authenticated;

-- note: anon is never granted any privilege on the medical/legal data.

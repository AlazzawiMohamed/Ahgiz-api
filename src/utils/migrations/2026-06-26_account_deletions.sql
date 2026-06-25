-- 2026-06-26 — [FIX-12] account deletion requests with a 30-day grace period.
-- The account is frozen immediately (users.deleted_at = now → auth middleware blocks
-- login), and scheduled_at marks when it should be hard-deleted (a later job/cron).
-- reason: comma-joined reason codes; details: optional free text.

CREATE TABLE IF NOT EXISTS account_deletions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason       TEXT,
  details      TEXT,
  scheduled_at TIMESTAMPTZ NOT NULL,   -- when the hard delete should happen (+30d)
  deleted_at   TIMESTAMPTZ,            -- set when actually hard-deleted
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_account_deletions_scheduled
  ON account_deletions (scheduled_at) WHERE deleted_at IS NULL;

-- service_role is used by the API (supabaseAdmin); without a grant it gets
-- "permission denied for table account_deletions". Clients never touch this table.
GRANT SELECT, INSERT, UPDATE, DELETE ON account_deletions TO service_role;

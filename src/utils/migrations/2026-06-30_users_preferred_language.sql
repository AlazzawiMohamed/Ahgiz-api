-- 2026-06-30_users_preferred_language.sql
-- Adds users.preferred_language so the UI language syncs across a user's devices.
-- Applied manually via Supabase SQL Editor (project convention).

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS preferred_language TEXT NOT NULL DEFAULT 'ar'
    CHECK (preferred_language IN ('ar','en','ku'));

COMMENT ON COLUMN users.preferred_language IS
  'user''s preferred UI language — synced across devices (ar/en/ku)';

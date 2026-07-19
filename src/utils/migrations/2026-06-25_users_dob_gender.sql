-- 2026-06-25 — profile fields edited from the mobile account screen.
-- date_of_birth : YYYY-MM-DD (used for the birthday reward).
-- gender        : male | female | prefer_not_to_say.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS date_of_birth DATE,
  ADD COLUMN IF NOT EXISTS gender        TEXT
    CHECK (gender IN ('male', 'female', 'prefer_not_to_say'));

COMMENT ON COLUMN users.date_of_birth IS 'user''s date of birth (for the birthday reward)';
COMMENT ON COLUMN users.gender IS 'user''s gender: male | female | prefer_not_to_say';

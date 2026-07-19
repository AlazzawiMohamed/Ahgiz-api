-- Sprint 4 — additional columns for the business owner endpoints (gap endpoints)
-- safe and additive only (idempotent). Apply it to the Supabase database.

-- ── #5 calendar colors + rebooking reminder (used by Cron Job 11) ────────────────
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS calendar_booking_color  TEXT,
  ADD COLUMN IF NOT EXISTS calendar_break_color    TEXT,
  ADD COLUMN IF NOT EXISTS rebooking_reminder_days INTEGER DEFAULT 30;

-- (time_magnet already exists in the businesses table — no need to add it)

-- ── #6 business owner reply to a review ──────────────────────────────────────────────
ALTER TABLE reviews
  ADD COLUMN IF NOT EXISTS owner_reply    TEXT,
  ADD COLUMN IF NOT EXISTS owner_reply_at TIMESTAMPTZ;

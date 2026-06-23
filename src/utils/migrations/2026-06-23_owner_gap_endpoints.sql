-- Sprint 4 — أعمدة إضافية لنقاط نهاية صاحب العمل (gap endpoints)
-- آمنة وإضافية فقط (idempotent). طبّقها على قاعدة بيانات Supabase.

-- ── #5 ألوان التقويم + تذكير إعادة الحجز (يستخدمه Cron Job 11) ────────────────
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS calendar_booking_color  TEXT,
  ADD COLUMN IF NOT EXISTS calendar_break_color    TEXT,
  ADD COLUMN IF NOT EXISTS rebooking_reminder_days INTEGER DEFAULT 30;

-- (time_magnet موجود مسبقاً في جدول businesses — لا حاجة لإضافته)

-- ── #6 رد صاحب العمل على التقييم ──────────────────────────────────────────────
ALTER TABLE reviews
  ADD COLUMN IF NOT EXISTS owner_reply    TEXT,
  ADD COLUMN IF NOT EXISTS owner_reply_at TIMESTAMPTZ;

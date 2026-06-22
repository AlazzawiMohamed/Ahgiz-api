-- 2026-06-22 — persist selected add-ons on each booking as a JSONB snapshot.
-- Matches the design in ahgiz-migration-rebooking.sql (bookings.selected_addons).
-- Snapshot shape: [{"addon_id":"uuid","name":"...","price":5000,"duration_mins":10}]
-- Stored as a snapshot so the booking keeps the add-on price even if it changes later.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS selected_addons JSONB DEFAULT '[]'::JSONB;

COMMENT ON COLUMN bookings.selected_addons IS
  'Add-ons المختارة عند الحجز (snapshot). [{"addon_id","name","price","duration_mins"}]';

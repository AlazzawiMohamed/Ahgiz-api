-- 2026-07-09_add_bookings_cancelled_columns.sql
-- Adds bookings.cancelled_by + bookings.cancelled_at.
--
-- ROOT CAUSE of the total cancellation outage (all roles): both cancel
-- controllers — customer (booking.controller.js:340) and admin
-- (admin.controller.js:377) via direct .update() — AND the
-- cancel_booking_with_fee() RPC used by the owner path all WRITE these two
-- columns, but the columns were never created. PostgREST returned
--   "Could not find the 'cancelled_at' column of 'bookings' in the schema cache"
-- → 500 on every customer/admin cancel, and INTERNAL_ERROR inside the RPC
-- (owner path). Confirmed 2026-07-09 via information_schema + Railway logs.
--
-- Backup taken first (project rule):
--   ahgiz-backups/bookings_schema_20260709_213634_pre_cancelled_columns.txt
--
-- NOTE: column-add only (no NEW function) → the mandatory CLAUDE.md REVOKE/GRANT
-- rule does not apply to this file. The trailing NOTIFY refreshes PostgREST's
-- schema cache so the controllers' .update() sees the new columns — WITHOUT it
-- the exact 500 above persists even after the columns exist.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS cancelled_by text,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;

COMMENT ON COLUMN bookings.cancelled_by IS
  'who cancelled the booking (role): customer / business / admin. system is reserved for future automatic cancellation. NULL = not cancelled.';
COMMENT ON COLUMN bookings.cancelled_at IS
  'cancellation time — set in cancel_booking_with_fee() and the cancel controllers when moving the status to cancelled.';

-- Actor-role guard. Values written today: customer / business / admin
-- (controllers + cancel_booking_with_fee v_who). 'system' allowed for a future
-- automated cancel (no current writer). NULL allowed for non-cancelled bookings.
ALTER TABLE bookings
  ADD CONSTRAINT bookings_cancelled_by_check
  CHECK (cancelled_by IS NULL OR cancelled_by = ANY (ARRAY['customer','business','admin','system']::text[]));

-- Refresh PostgREST schema cache so PUT /bookings/:id/cancel .update() sees the columns.
NOTIFY pgrst, 'reload schema';

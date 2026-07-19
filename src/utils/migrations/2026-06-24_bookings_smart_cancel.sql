-- 2026-06-24 — smart-cancellation fields used by the mobile "My Bookings" screen.
-- free_cancellation_until : ISO timestamp; before it the customer may cancel for free.
-- cancellation_requested  : set TRUE when the customer requests cancellation after the
--                           free window (owner is notified via WhatsApp and approves manually).
-- is_reviewed             : TRUE once the customer has left a review for this booking.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS free_cancellation_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancellation_requested  BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_reviewed             BOOLEAN DEFAULT FALSE;

COMMENT ON COLUMN bookings.free_cancellation_until IS
  'before this time the customer can cancel for free (NULL = the 24-hour rule applies)';
COMMENT ON COLUMN bookings.cancellation_requested IS
  'TRUE when the customer requests cancellation after the free window ends (awaiting business owner approval)';
COMMENT ON COLUMN bookings.is_reviewed IS
  'TRUE after the customer leaves a review for this booking';

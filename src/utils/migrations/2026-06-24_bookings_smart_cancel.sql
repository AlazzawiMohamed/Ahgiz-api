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
  'قبل هذا الوقت يمكن للزبون الإلغاء مجاناً (NULL = تُطبّق قاعدة الـ24 ساعة)';
COMMENT ON COLUMN bookings.cancellation_requested IS
  'TRUE عند طلب الزبون الإلغاء بعد انتهاء المهلة المجانية (بانتظار موافقة صاحب العمل)';
COMMENT ON COLUMN bookings.is_reviewed IS
  'TRUE بعد أن يترك الزبون تقييماً لهذا الحجز';

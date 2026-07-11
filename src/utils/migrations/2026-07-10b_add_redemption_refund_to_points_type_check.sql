-- 2026-07-10b_add_redemption_refund_to_points_type_check.sql
-- Follow-up to 2026-07-10_fix_notifications_titlebody_systemic_and_cancel_points.sql.
--
-- That migration introduced the 'redemption_refund' points type (cancel_booking_with_fee
-- refunds a booking's redeemed points on cancellation) and added it to the 3 balance-
-- classification locations (view + grant_loyalty_points + redeem_points_on_booking),
-- but MISSED points_transactions_type_check. Result: cancelling ANY booking with
-- points_redeemed > 0 failed with:
--   new row for relation "points_transactions" violates check constraint
--   "points_transactions_type_check"
-- (caught by the STEP 5 DB points-reversal rollback test, 2026-07-10; cancels of
--  0-points bookings were unaffected, which is why the first e2e path looked fine.)
--
-- Fix: add 'redemption_refund' to the allowed points_transactions.type list.
-- (Column/constraint change only — no function, so no REVOKE/GRANT needed.)

BEGIN;

ALTER TABLE points_transactions DROP CONSTRAINT points_transactions_type_check;
ALTER TABLE points_transactions ADD CONSTRAINT points_transactions_type_check
  CHECK (type = ANY (ARRAY[
    'referral_reward','referral_welcome','visit_reward','redemption',
    'admin_grant','admin_deduct','admin_freeze','expiry',
    'redemption_refund'  -- added 2026-07-10 (loyalty-points refund on cancellation)
  ]::text[]));

COMMIT;

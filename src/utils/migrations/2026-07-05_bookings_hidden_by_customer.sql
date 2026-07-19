-- hide past bookings from the customer list without deleting data (soft-hide)
-- note: applied directly to the database on 2026-07-05 — this file is for documentation.
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS hidden_by_customer_at TIMESTAMPTZ DEFAULT NULL;

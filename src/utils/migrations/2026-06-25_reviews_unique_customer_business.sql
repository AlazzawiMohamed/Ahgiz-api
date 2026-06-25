-- 2026-06-25 — [FIX-06] reviews submission was failing for every customer.
-- create_review() upserts with `ON CONFLICT (customer_id, business_id)`, but the
-- reviews table had no matching unique constraint, so Postgres raised
-- "no unique or exclusion constraint matching the ON CONFLICT specification",
-- which the RPC swallowed as INTERNAL_ERROR. Add the constraint the RPC expects:
-- one review per customer per business (re-submitting updates the existing review).

ALTER TABLE reviews
  ADD CONSTRAINT reviews_customer_business_uniq UNIQUE (customer_id, business_id);

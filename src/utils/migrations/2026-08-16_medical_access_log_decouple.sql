-- Phase 2 follow-up — decouple medical_access_log from the record_access_grants
-- lifecycle, so a customer can permanently dismiss an inactive grant from their
-- access list WITHOUT destroying the audit trail of what that business already saw.
--
-- Before this migration:
--   grant_id is NOT NULL and its FK is ON DELETE CASCADE, so deleting a grant row
--   silently deletes every audit row attached to it. The RLS SELECT policy also
--   reaches the owner only by joining back to record_access_grants, so a deleted
--   grant would make surviving rows unreadable even if they existed.
--
-- After this migration:
--   Each log row carries its own owner_id / granted_to_business_id and a frozen copy
--   of the business display name at access time. grant_id becomes nullable with
--   ON DELETE SET NULL, so deleting a grant leaves the audit row fully intact, and
--   the RLS policy authorises on the row's own owner_id.
--
-- Scope note: this migration deliberately adds NO automatic hard-delete anywhere.
-- Cron Job 12 (expire_record_access_grants) remains soft-expiry only — it does
-- UPDATE record_access_grants SET revoked_at = NOW() and never DELETEs. Grant rows
-- are hard-deleted ONLY by the customer-triggered dismiss endpoint.
--
-- Apply in the Supabase SQL Editor (migrations are applied manually; a file existing
-- does NOT mean it is applied). Reversible — see the rollback block at the end.
--
-- DEPLOY ORDER (hard constraint): apply this migration BEFORE deploying the code.
-- The API's insert into medical_access_log is fail-closed (it throws on error), so
-- code that writes the three new columns against the old schema would make file
-- streaming and file listing return 500 until the migration lands.

-- ── 1. Denormalised, lifecycle-independent columns ───────────────────────────
-- ON DELETE SET NULL on both FKs: an audit row must outlive the user or business it
-- references. business_name_at_access is an intentional denormalisation — it is the
-- name AS SHOWN TO THE CUSTOMER at access time, and must not change if the business
-- later renames itself or is deleted outright.
ALTER TABLE public.medical_access_log
  ADD COLUMN IF NOT EXISTS owner_id                UUID REFERENCES public.users(id)      ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS granted_to_business_id  UUID REFERENCES public.businesses(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS business_name_at_access TEXT;

-- ── 2. grant_id must become nullable ─────────────────────────────────────────
-- REQUIRED for step 4 to function: an FK of ON DELETE SET NULL against a NOT NULL
-- column raises a not-null violation at delete time, which would make the dismiss
-- endpoint fail on every call while looking correct in review.
ALTER TABLE public.medical_access_log
  ALTER COLUMN grant_id DROP NOT NULL;

-- ── 3. Defensive backfill ────────────────────────────────────────────────────
-- The table is EMPTY in production as of 2026-08-16 (verified read-only), so this is
-- expected to affect 0 rows and exists only so the migration is safe to apply against
-- an environment that already has data. Guarded by owner_id IS NULL, so re-running it
-- is a no-op. Note: the table is FORCE ROW LEVEL SECURITY with no UPDATE policy, so
-- this statement only does useful work for a role that bypasses RLS (the SQL Editor's
-- postgres role does; service_role does). It is not a substitute for having applied
-- this migration before rows accumulate.
UPDATE public.medical_access_log mal
SET owner_id                = rag.owner_id,
    granted_to_business_id  = rag.granted_to_business_id,
    business_name_at_access = b.name
FROM public.record_access_grants rag
JOIN public.businesses b ON b.id = rag.granted_to_business_id
WHERE mal.grant_id = rag.id
  AND mal.owner_id IS NULL;

-- ── 4. Swap the grant_id FK from CASCADE to SET NULL ─────────────────────────
-- Constraint name confirmed against the live database on 2026-08-16.
ALTER TABLE public.medical_access_log
  DROP CONSTRAINT IF EXISTS medical_access_log_grant_id_fkey;

ALTER TABLE public.medical_access_log
  ADD CONSTRAINT medical_access_log_grant_id_fkey
  FOREIGN KEY (grant_id) REFERENCES public.record_access_grants(id) ON DELETE SET NULL;

-- ── 5. RLS: authorise on the row's own owner_id ──────────────────────────────
-- This is what keeps a customer's history readable after the grant row is gone. The
-- old policy joined back to record_access_grants, which no longer resolves once the
-- grant is dismissed. NULL owner_id never matches auth.uid(), so orphaned rows are
-- invisible rather than public — fail-closed.
DROP POLICY IF EXISTS "medical_access_log_owner_view" ON public.medical_access_log;
CREATE POLICY "medical_access_log_owner_view"
  ON public.medical_access_log FOR SELECT
  USING (owner_id = auth.uid());

-- ── 6. Widen the action vocabulary ───────────────────────────────────────────
-- 'list_files' = the business enumerated the patient's file list (no specific file).
-- Constraint name confirmed against the live database on 2026-08-16.
ALTER TABLE public.medical_access_log
  DROP CONSTRAINT IF EXISTS medical_access_log_action_check;
ALTER TABLE public.medical_access_log
  ADD CONSTRAINT medical_access_log_action_check
  CHECK (action IN ('view', 'download', 'list_files'));

-- ── 7. Index supporting the new owner-scoped access path ─────────────────────
-- The existing index is on (grant_id, accessed_at DESC), which no longer covers the
-- primary read path now that authorisation and history are keyed on owner_id.
CREATE INDEX IF NOT EXISTS idx_medical_access_log_owner
  ON public.medical_access_log (owner_id, accessed_at DESC);

-- Table-level privileges are unchanged: service_role keeps SELECT + INSERT only
-- (append-only audit), authenticated keeps SELECT. New columns inherit them.

-- ── 8. Date-range index for future archival scans ───────────────────────────
-- Separate from idx_medical_access_log_grant (grant_id, accessed_at DESC) and
-- idx_medical_access_log_owner (owner_id, accessed_at DESC): archival sweeps filter
-- on accessed_at ALONE, which neither composite index serves as a leading column.
CREATE INDEX IF NOT EXISTS idx_medical_access_log_accessed_at
  ON public.medical_access_log (accessed_at);

-- ── 9. Archive table ────────────────────────────────────────────────────────
-- Created here, AFTER sections 1-2 and 6-8, so LIKE copies the FINAL shape (all nine
-- columns, nullable grant_id, the widened action CHECK, the indexes) instead of the
-- pre-migration six-column shape. Nothing is retyped by hand, so the two tables cannot
-- drift at creation time.
--
-- What LIKE ... INCLUDING ALL does NOT copy, by design:
--   * FOREIGN KEYS — never copied by LIKE. This is exactly right for an archive: an
--     archived row must outlive the grant, user, business, or file it references.
--   * RLS POLICIES and GRANTS — not copied, so both are declared explicitly below.
CREATE TABLE IF NOT EXISTS public.medical_access_log_archive (
  LIKE public.medical_access_log INCLUDING ALL
);

ALTER TABLE public.medical_access_log_archive ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.medical_access_log_archive FORCE ROW LEVEL SECURITY;

-- Same owner-visibility rule as the live table: a customer's history reads the same
-- whether a row is still hot or has been archived. DROP first so the migration stays
-- re-runnable, matching the pattern used for the live table's policy above.
DROP POLICY IF EXISTS "medical_access_log_archive_owner_view" ON public.medical_access_log_archive;
CREATE POLICY "medical_access_log_archive_owner_view"
  ON public.medical_access_log_archive FOR SELECT
  USING (owner_id = auth.uid());

-- Same append-only privilege posture as the live table (the GRANT gotcha applies here
-- too — a table created with FORCE RLS gets no PostgREST role grants automatically).
REVOKE ALL ON TABLE public.medical_access_log_archive FROM PUBLIC, anon, authenticated;
GRANT  SELECT, INSERT ON TABLE public.medical_access_log_archive TO service_role;
GRANT  SELECT          ON TABLE public.medical_access_log_archive TO authenticated;

-- ── 10. Archive function — written, deliberately NOT scheduled ──────────────
-- Manual invocation only: no cron entry (Cron Job 12 stays soft-expiry only), no
-- trigger, and no call site in application code. It exists so a future retention
-- decision has a tested mechanism ready, not because retention is being enabled now.
--
-- SECURITY DEFINER is what makes this work at all: service_role holds only
-- SELECT + INSERT on medical_access_log (append-only), so the DELETE below succeeds
-- only because the function runs as its owner. That is a deliberate, narrow hole in
-- the append-only guarantee, and it is contained: rows are MOVED, never destroyed —
-- the archive table itself grants service_role no DELETE, and the owner can still
-- read the moved rows through the archive's RLS policy above.
--
-- The DELETE and INSERT share the function's implicit transaction (a plpgsql body is
-- atomic), so a failure in either half rolls back both and no row can exist in
-- neither table or in both.
CREATE OR REPLACE FUNCTION public.archive_old_medical_access_logs(retention_interval INTERVAL)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  moved_count INTEGER;
BEGIN
  -- Retention floor — see section 11 below for the rationale. Checked FIRST, before
  -- any row is touched, so a rejected call is a pure no-op.
  IF retention_interval < INTERVAL '30 days' THEN
    RAISE EXCEPTION 'retention_interval must be at least 30 days, got %', retention_interval;
  END IF;

  WITH moved_rows AS (
    DELETE FROM medical_access_log
    WHERE accessed_at < NOW() - retention_interval
    RETURNING *
  )
  INSERT INTO medical_access_log_archive
  SELECT * FROM moved_rows;

  -- ROW_COUNT here is the INSERT's, i.e. the number of rows actually archived.
  GET DIAGNOSTICS moved_count = ROW_COUNT;
  RETURN moved_count;
END;
$fn$;

-- MANDATORY security rule (see CLAUDE.md): every new public function must be revoked
-- from PUBLIC/anon/authenticated and granted only to service_role. Without the
-- explicit service_role GRANT the REVOKE would also strip its inherited EXECUTE.
REVOKE EXECUTE ON FUNCTION public.archive_old_medical_access_logs(INTERVAL) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.archive_old_medical_access_logs(INTERVAL) TO service_role;

-- ── 11. Retention floor (enforced inside the function in section 10) ────────
-- archive_old_medical_access_logs refuses any interval shorter than 30 days.
-- Rationale: the function is EXECUTE-able by service_role — i.e. by the API process
-- itself — so without a floor, a bug or a leaked service key could call it with
-- INTERVAL '0 seconds' and drain the entire hot audit table in a single statement.
-- The floor bounds the blast radius to rows that are already at least a month old.
-- Rows are still only MOVED (the archive grants no DELETE), but emptying the live
-- table is itself a meaningful event and should not be one call away.
-- Raising the floor later is a safe, no-downtime CREATE OR REPLACE.

-- ── fail-fast self-test: prove the whole object graph after apply ────────────
DO $$
DECLARE
  v_fk_count INTEGER;
  v_deltype  "char";
BEGIN
  -- 7.1 the three new columns exist
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='medical_access_log'
                   AND column_name='owner_id') THEN
    RAISE EXCEPTION 'owner_id column was not created';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='medical_access_log'
                   AND column_name='granted_to_business_id') THEN
    RAISE EXCEPTION 'granted_to_business_id column was not created';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='medical_access_log'
                   AND column_name='business_name_at_access') THEN
    RAISE EXCEPTION 'business_name_at_access column was not created';
  END IF;

  -- 7.2 grant_id is nullable — without this the SET NULL FK cannot fire
  IF EXISTS (SELECT 1 FROM pg_attribute
             WHERE attrelid='public.medical_access_log'::regclass
               AND attname='grant_id' AND attnotnull) THEN
    RAISE EXCEPTION 'grant_id is still NOT NULL — dismiss would fail with a not-null violation';
  END IF;

  -- 7.3 EXACTLY ONE FK on grant_id, and it is ON DELETE SET NULL ('n').
  -- Counting matters: a DROP ... IF EXISTS that matched nothing (renamed constraint)
  -- would leave the old CASCADE FK in place alongside the new one, and dismissing a
  -- grant would still destroy the audit rows this migration exists to preserve.
  SELECT COUNT(*), MIN(confdeltype) INTO v_fk_count, v_deltype
  FROM pg_constraint
  WHERE conrelid='public.medical_access_log'::regclass
    AND contype='f'
    AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
                        WHERE attrelid='public.medical_access_log'::regclass
                          AND attname='grant_id')];
  IF v_fk_count <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 FK on grant_id, found %', v_fk_count;
  END IF;
  IF v_deltype <> 'n' THEN
    RAISE EXCEPTION 'grant_id FK delete action is %, expected n (SET NULL)', v_deltype;
  END IF;

  -- 7.4 the RLS policy exists AND authorises via owner_id (not the grant join)
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='medical_access_log'
                   AND policyname='medical_access_log_owner_view'
                   AND qual LIKE '%owner_id%') THEN
    RAISE EXCEPTION 'medical_access_log_owner_view is missing or does not reference owner_id';
  END IF;

  -- 7.5 the action CHECK admits list_files
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid='public.medical_access_log'::regclass
                   AND conname='medical_access_log_action_check'
                   AND pg_get_constraintdef(oid) LIKE '%list_files%') THEN
    RAISE EXCEPTION 'action CHECK does not include list_files';
  END IF;

  -- 7.6 the owner-scoped index exists
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                 WHERE schemaname='public' AND tablename='medical_access_log'
                   AND indexname='idx_medical_access_log_owner') THEN
    RAISE EXCEPTION 'idx_medical_access_log_owner is missing';
  END IF;

  -- 7.7 the archival date-range index exists
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                 WHERE schemaname='public' AND tablename='medical_access_log'
                   AND indexname='idx_medical_access_log_accessed_at') THEN
    RAISE EXCEPTION 'idx_medical_access_log_accessed_at is missing';
  END IF;

  -- 7.8 the archive table exists with RLS both ENABLED and FORCED
  IF to_regclass('public.medical_access_log_archive') IS NULL THEN
    RAISE EXCEPTION 'medical_access_log_archive table was not created';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class
                 WHERE oid='public.medical_access_log_archive'::regclass
                   AND relrowsecurity AND relforcerowsecurity) THEN
    RAISE EXCEPTION 'medical_access_log_archive is missing ENABLE/FORCE ROW LEVEL SECURITY';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='medical_access_log_archive'
                   AND policyname='medical_access_log_archive_owner_view'
                   AND qual LIKE '%owner_id%') THEN
    RAISE EXCEPTION 'medical_access_log_archive_owner_view is missing or does not use owner_id';
  END IF;

  -- 7.9 the two tables must stay column-compatible: the archive function moves rows
  -- with INSERT ... SELECT *, which breaks the moment either side gains a column.
  IF (SELECT COUNT(*) FROM information_schema.columns
      WHERE table_schema='public' AND table_name='medical_access_log')
     <> (SELECT COUNT(*) FROM information_schema.columns
         WHERE table_schema='public' AND table_name='medical_access_log_archive') THEN
    RAISE EXCEPTION 'medical_access_log and medical_access_log_archive have diverged in column count';
  END IF;

  -- 7.10 the archive function exists and obeys the mandatory REVOKE/GRANT rule.
  -- anon/authenticated are checked rather than PUBLIC directly: a leftover PUBLIC
  -- grant would be inherited by both, so this catches that case too.
  IF to_regprocedure('public.archive_old_medical_access_logs(interval)') IS NULL THEN
    RAISE EXCEPTION 'archive_old_medical_access_logs(interval) was not created';
  END IF;
  IF NOT has_function_privilege('service_role',
        'public.archive_old_medical_access_logs(interval)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role is missing EXECUTE on archive_old_medical_access_logs';
  END IF;
  IF has_function_privilege('anon',
        'public.archive_old_medical_access_logs(interval)', 'EXECUTE')
     OR has_function_privilege('authenticated',
        'public.archive_old_medical_access_logs(interval)', 'EXECUTE') THEN
    RAISE EXCEPTION 'archive_old_medical_access_logs is executable by anon/authenticated — the REVOKE did not take';
  END IF;

  -- 7.11 the 30-day retention floor is present in the function body.
  -- Deliberately a STATIC inspection rather than actually invoking the function with
  -- a short interval: in the exact failure case this check exists to catch (the guard
  -- missing), an invocation would not raise — it would succeed and archive every row
  -- older than the test interval. A self-test whose failure mode is destructive is
  -- worse than no self-test, and rolling that back reliably would depend on the SQL
  -- Editor wrapping the whole migration in one transaction, which is not guaranteed.
  -- Matching the guard expression (not just the '30 days' literal) so that finding the
  -- string in a comment alone cannot satisfy the check.
  IF pg_get_functiondef('public.archive_old_medical_access_logs(interval)'::regprocedure)
       NOT LIKE '%retention_interval < INTERVAL ''30 days''%' THEN
    RAISE EXCEPTION 'archive_old_medical_access_logs is missing the 30-day retention floor';
  END IF;
END;
$$;

-- ── ROLLBACK (run manually to undo this migration) ───────────────────────────
-- Restores the original CASCADE FK and grant-join RLS policy. NOTE: reinstating
-- NOT NULL on grant_id fails if any row has a NULL grant_id (i.e. if a grant was
-- already dismissed); delete those orphaned audit rows first if you truly intend it.
--
-- Reverse order. WARNING: dropping the archive table destroys any rows already moved
-- into it — check that it is empty before running that line.
--
-- DROP FUNCTION IF EXISTS public.archive_old_medical_access_logs(INTERVAL);
-- DROP POLICY IF EXISTS "medical_access_log_archive_owner_view" ON public.medical_access_log_archive;
-- DROP TABLE IF EXISTS public.medical_access_log_archive;
-- DROP INDEX IF EXISTS public.idx_medical_access_log_accessed_at;
-- DROP INDEX IF EXISTS public.idx_medical_access_log_owner;
-- ALTER TABLE public.medical_access_log DROP CONSTRAINT IF EXISTS medical_access_log_action_check;
-- ALTER TABLE public.medical_access_log
--   ADD CONSTRAINT medical_access_log_action_check CHECK (action IN ('view', 'download'));
-- DROP POLICY IF EXISTS "medical_access_log_owner_view" ON public.medical_access_log;
-- CREATE POLICY "medical_access_log_owner_view"
--   ON public.medical_access_log FOR SELECT
--   USING (EXISTS (SELECT 1 FROM public.record_access_grants rag
--                  WHERE rag.id = medical_access_log.grant_id AND rag.owner_id = auth.uid()));
-- ALTER TABLE public.medical_access_log DROP CONSTRAINT IF EXISTS medical_access_log_grant_id_fkey;
-- ALTER TABLE public.medical_access_log
--   ADD CONSTRAINT medical_access_log_grant_id_fkey
--   FOREIGN KEY (grant_id) REFERENCES public.record_access_grants(id) ON DELETE CASCADE;
-- ALTER TABLE public.medical_access_log ALTER COLUMN grant_id SET NOT NULL;
-- ALTER TABLE public.medical_access_log
--   DROP COLUMN IF EXISTS business_name_at_access,
--   DROP COLUMN IF EXISTS granted_to_business_id,
--   DROP COLUMN IF EXISTS owner_id;

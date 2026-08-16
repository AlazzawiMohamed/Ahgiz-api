-- Phase 2 — medical/legal "Access" (الوصول) audit trail.
-- Creates public.medical_access_log: one row per third-party (granted) access to a
-- patient's file via GET /medical/files/:fileId/stream. Rows are written ONLY by the
-- Node.js service role (never the client), and are readable by the file owner so the
-- customer can review who opened their files, when, and whether it was a view or a
-- download. Append-only: service_role gets SELECT + INSERT, no UPDATE/DELETE.
--
-- Depends on the existing record_access_grants and user_files tables (unchanged here).
-- Safe and reversible — see the rollback block at the end. Apply in the Supabase SQL
-- Editor (migrations are applied manually; a file existing does NOT mean it is applied).

-- id default uses gen_random_uuid() (pg core, no search_path dependency) rather than
-- uuid_generate_v4(), which requires the extensions schema to be on the SQL Editor's
-- search_path and would fail the whole migration at apply time if it is not.
CREATE TABLE IF NOT EXISTS public.medical_access_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id      UUID NOT NULL REFERENCES public.record_access_grants(id) ON DELETE CASCADE,
  accessed_by   UUID NOT NULL REFERENCES public.users(id),
  -- NULL = general grant access with no specific file. ON DELETE SET NULL keeps the
  -- audit row intact if the underlying file is later deleted by its owner.
  file_id       UUID REFERENCES public.user_files(id) ON DELETE SET NULL,
  action        TEXT NOT NULL CHECK (action IN ('view', 'download')),
  accessed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Owner's audit-trail query (GET /medical/access/log/:grantId) reads by grant, newest first.
CREATE INDEX IF NOT EXISTS idx_medical_access_log_grant
  ON public.medical_access_log (grant_id, accessed_at DESC);

ALTER TABLE public.medical_access_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.medical_access_log FORCE ROW LEVEL SECURITY;

-- The file owner (patient) may read the access log for their own grants. The API reads
-- via the service role and re-checks ownership in Node; this policy is defense-in-depth
-- for any direct authenticated (PostgREST) access. No INSERT/UPDATE/DELETE policy exists,
-- so the client can never write or alter the audit trail.
DROP POLICY IF EXISTS "medical_access_log_owner_view" ON public.medical_access_log;
CREATE POLICY "medical_access_log_owner_view"
  ON public.medical_access_log FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.record_access_grants rag
      WHERE rag.id = medical_access_log.grant_id
        AND rag.owner_id = auth.uid()
    )
  );

-- Table privileges (the GRANT gotcha): a table created via the SQL Editor with
-- FORCE ROW LEVEL SECURITY is NOT granted to the PostgREST roles automatically, so the
-- API's service_role would get "permission denied for table" on its first insert. Grant
-- explicitly. service_role: SELECT + INSERT only (append-only audit — no UPDATE/DELETE).
-- authenticated: SELECT only, so the owner_view policy above is actually reachable.
REVOKE ALL ON TABLE public.medical_access_log FROM PUBLIC, anon, authenticated;
GRANT  SELECT, INSERT ON TABLE public.medical_access_log TO service_role;
GRANT  SELECT          ON TABLE public.medical_access_log TO authenticated;

-- ── fail-fast self-test: prove the object graph is in place after apply ──
DO $$
BEGIN
  IF to_regclass('public.medical_access_log') IS NULL THEN
    RAISE EXCEPTION 'medical_access_log table was not created';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'medical_access_log'
      AND policyname = 'medical_access_log_owner_view'
  ) THEN
    RAISE EXCEPTION 'medical_access_log_owner_view policy is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'medical_access_log'
      AND grantee = 'service_role' AND privilege_type = 'INSERT'
  ) THEN
    RAISE EXCEPTION 'service_role is missing INSERT on medical_access_log (the API would break)';
  END IF;
END;
$$;

-- ── ROLLBACK (run manually to undo this migration) ───────────────────────────
-- DROP POLICY IF EXISTS "medical_access_log_owner_view" ON public.medical_access_log;
-- DROP TABLE IF EXISTS public.medical_access_log;   -- also drops idx_medical_access_log_grant

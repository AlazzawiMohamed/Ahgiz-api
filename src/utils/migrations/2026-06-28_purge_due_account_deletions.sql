-- 2026-06-28 — permanently purge accounts whose 30-day deletion grace has passed.
-- Driven by the account_deletions mechanism (FIX-12): a row is "due" when
-- scheduled_at <= now and it hasn't been processed yet (deleted_at IS NULL).
--
-- Like hard_delete_expired_users, this scrubs PII irreversibly but KEEPS the users
-- row, because bookings/reviews/points_transactions/etc. reference users(id) without
-- ON DELETE CASCADE — a literal row delete would violate those FKs. After scrubbing,
-- the original phone no longer matches, so the account can't be restored on login and
-- the person effectively starts fresh.

CREATE OR REPLACE FUNCTION public.purge_due_account_deletions()
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  r       RECORD;
  v_count INTEGER := 0;
BEGIN
  FOR r IN
    SELECT ad.id AS deletion_id, u.id AS user_id, u.phone AS phone
    FROM account_deletions ad
    JOIN users u ON u.id = ad.user_id
    WHERE ad.deleted_at IS NULL          -- not yet purged
      AND ad.scheduled_at <= NOW()       -- grace period elapsed
      AND u.deleted_at IS NOT NULL       -- still soft-deleted (not restored on login)
    FOR UPDATE OF ad SKIP LOCKED
  LOOP
    -- Irreversibly scrub PII; keep the row for referential integrity.
    UPDATE users SET
      phone      = 'deleted_' || LEFT(r.user_id::TEXT, 8),
      full_name  = 'Deleted User',
      email      = NULL,
      avatar_url = NULL,
      is_active  = FALSE,
      updated_at = NOW()
    WHERE id = r.user_id;

    -- Remove auth/session/notification artifacts.
    DELETE FROM push_tokens           WHERE user_id = r.user_id;
    DELETE FROM refresh_tokens        WHERE user_id = r.user_id;
    DELETE FROM whatsapp_otp_sessions WHERE user_id = r.user_id;

    -- Mark the deletion request as executed (audit + idempotency).
    UPDATE account_deletions SET deleted_at = NOW() WHERE id = r.deletion_id;

    INSERT INTO activity_logs (user_id, action, target_type, target_id, details)
    VALUES (r.user_id, 'account_purged', 'users', r.user_id,
      jsonb_build_object('original_phone_prefix', LEFT(r.phone, 4), 'via', 'account_deletions'));

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;

EXCEPTION WHEN OTHERS THEN
  PERFORM log_and_raise('purge_due_account_deletions',
    jsonb_build_object('error', SQLERRM));
  RETURN 0;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.purge_due_account_deletions() TO service_role;

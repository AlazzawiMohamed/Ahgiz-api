-- 2026-06-29 — fix hard_delete_expired_users: it inserted into activity_logs with
-- non-existent columns (entity_type/entity_id), so every run threw and was swallowed
-- by the EXCEPTION handler (returning 0) — the 90-day purge never actually ran.
-- activity_logs real columns: user_id, action, target_type, target_id, details.
-- Only the INSERT is corrected; all other logic is unchanged.

CREATE OR REPLACE FUNCTION public.hard_delete_expired_users()
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_user   RECORD;
  v_count  INTEGER := 0;
BEGIN
  -- المستخدمون الذين مضى على حذفهم أكثر من 90 يوم
  FOR v_user IN
    SELECT id, phone FROM users
    WHERE deleted_at IS NOT NULL
      AND deleted_at < NOW() - INTERVAL '90 days'
      AND is_active = FALSE
    FOR UPDATE SKIP LOCKED
  LOOP
    -- إخفاء PII فقط (لا حذف الصف كاملاً — نحتفظ بـ id للـ FKs)
    UPDATE users SET
      phone         = 'deleted_' || LEFT(id::TEXT, 8),
      full_name     = 'Deleted User',
      email         = NULL,
      avatar_url    = NULL,
      updated_at    = NOW()
    WHERE id = v_user.id;

    -- إلغاء push tokens
    DELETE FROM push_tokens WHERE user_id = v_user.id;

    -- حذف OTP sessions
    DELETE FROM whatsapp_otp_sessions WHERE user_id = v_user.id;

    INSERT INTO activity_logs (user_id, action, target_type, target_id, details)
    VALUES (v_user.id, 'account_hard_deleted', 'users', v_user.id,
      jsonb_build_object('original_phone_prefix', LEFT(v_user.phone, 4)));

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;

EXCEPTION WHEN OTHERS THEN
  PERFORM log_and_raise('hard_delete_expired_users',
    jsonb_build_object('error', SQLERRM));
  RETURN 0;
END;
$function$;

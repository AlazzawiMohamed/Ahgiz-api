-- 2026-07-10_fix_notifications_titlebody_systemic_and_cancel_points.sql
-- ============================================================================
-- SYSTEMIC FIX (draft — DO NOT APPLY until reviewed).
--
-- ROOT CAUSE: the `notifications` table was migrated (title/body → single
-- `message` column; a `type` CHECK constraint was added), but ~21 writer
-- functions were never updated. Each therefore had up to TWO blockers:
--   (1) inserts non-existent columns `title`/`body`  → "column ... does not exist"
--   (2) uses a notification `type` not in notifications_type_check → CHECK violation
-- Only create_asiahawala_booking_payment (+ its 1 type) was fixed on 2026-06-22.
--
-- This migration:
--   Part 1: adds the 16 in-use notification types to notifications_type_check.
--   Part 2: rewrites all 21 writer functions to use `message` (fold title+body
--           with a newline), preserving every other line verbatim. Plus, for
--           cancel_booking_with_fee only: fixes the notify_waitlist_on_availability
--           argument order and adds loyalty-points reversal.
--   Part 3: adds the new 'redemption_refund' points type to all 3 balance-
--           classification locations (view + grant + redeem), positive side.
--   REVOKE/GRANT re-applied on every touched function (per CLAUDE.md).
--
-- Backups: ahgiz-backups/notifications_titlebody_functions_20260709_220602_pre_fix.sql
--          ahgiz-backups/points_balance_locations_20260710_084835_pre_redemption_refund.sql
--
-- Deferred (logged separately, NOT here): calculate_balance_after() sign bug;
--   notification-type taxonomy consolidation.
-- ============================================================================

BEGIN;

-- ── Part 1: expand notifications_type_check (21 existing + 16 in-use) ────────
ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type = ANY (ARRAY[
  -- existing (21)
  'booking_confirmed','booking_reminder_24h','booking_reminder_2h','booking_cancelled',
  'waitlist_available','rebooking_reminder','review_request','receipt','meeting_link',
  'new_booking','booking_cancelled_by_customer','daily_summary','no_show_alert',
  'attendance_confirmation_required','grace_period_started','reschedule_requested',
  'reschedule_approved','reschedule_rejected','account_recovery_approved',
  'account_recovery_rejected','asiahawala_payment_instructions',
  -- added 2026-07-10 (16 types already emitted by existing functions)
  'asiahawala_payment_expired','asiahawala_payment_rejected','asiahawala_refund_needed',
  'booking_payment_confirmed','new_booking_confirmed','no_show_fee',
  'notification_system_alert','payment_confirmed','payment_expired','payment_fraud_alert',
  'refund_completed','refund_failed_admin','refund_initiated',
  'security_alert','security_config_alert','security_critical'
]::text[]));

-- ── Part 2: the 21 notification-writer functions (title/body → message) ──────

-- (1) apply_no_show_fee ------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apply_no_show_fee(p_booking_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_booking  RECORD;
  v_service  RECORD;
  v_fee      INTEGER;
BEGIN
  SELECT b.*, s.no_show_fee_enabled, s.no_show_fee_amount
  INTO v_booking
  FROM bookings b
  JOIN services s ON s.id = b.service_id
  WHERE b.id = p_booking_id AND b.status = 'no_show';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', FALSE, 'code', 'NOT_FOUND');
  END IF;

  IF NOT v_booking.no_show_fee_enabled OR v_booking.no_show_fee_amount = 0 THEN
    RETURN jsonb_build_object('success', TRUE, 'fee', 0, 'message', 'لا رسوم غياب لهذه الخدمة');
  END IF;

  v_fee := v_booking.no_show_fee_amount;

  INSERT INTO no_shows (booking_id, customer_id, business_id, booking_date,
    no_show_fee_charged, no_show_fee_amount)
  VALUES (p_booking_id, v_booking.customer_id, v_booking.business_id,
    v_booking.booking_date, TRUE, v_fee)
  ON CONFLICT (booking_id) DO UPDATE SET
    no_show_fee_charged = TRUE,
    no_show_fee_amount  = v_fee;

  -- notify customer  [FIXED: title/body → message]
  INSERT INTO notifications (user_id, type, message, booking_id)
  VALUES (v_booking.customer_id, 'no_show_fee',
    'رسوم غياب مُطبَّقة' || E'\n' ||
    'تم تطبيق رسوم غياب: ' || v_fee || ' دينار لحجزك الذي لم تحضره.',
    p_booking_id);

  RETURN jsonb_build_object('success', TRUE, 'fee_charged', v_fee);

EXCEPTION WHEN OTHERS THEN
  PERFORM log_and_raise('apply_no_show_fee',
    jsonb_build_object('booking_id', p_booking_id, 'error', SQLERRM));
  RETURN jsonb_build_object('success', FALSE, 'code', 'INTERNAL_ERROR');
END;
$function$;
REVOKE EXECUTE ON FUNCTION apply_no_show_fee(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION apply_no_show_fee(uuid) TO service_role;

-- (2) approve_reschedule -----------------------------------------------------
CREATE OR REPLACE FUNCTION public.approve_reschedule(p_request_id uuid, p_approver_id uuid)
 RETURNS TABLE(success boolean, new_booking_id uuid, message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_request     RECORD;
  v_booking     RECORD;
  v_owner_id    UUID;
  v_new_id      UUID;
BEGIN
  SELECT * INTO v_request FROM reschedule_requests
  WHERE id = p_request_id AND status = 'pending_approval';
  IF v_request IS NULL THEN
    RETURN QUERY SELECT FALSE, NULL::UUID, 'الطلب غير موجود أو تم معالجته'::TEXT;
    RETURN;
  END IF;

  SELECT * INTO v_booking FROM bookings WHERE id = v_request.original_booking_id;

  SELECT b.owner_id INTO v_owner_id
  FROM businesses b WHERE b.id = v_booking.business_id;

  IF p_approver_id != v_owner_id
     AND p_approver_id != v_booking.customer_id
     AND NOT current_app_is_admin() THEN
    RETURN QUERY SELECT FALSE, NULL::UUID,
      'غير مصرّح: فقط صاحب العمل أو الزبون يمكنه الموافقة'::TEXT;
    RETURN;
  END IF;

  UPDATE bookings SET
    booking_date = v_request.new_date,
    start_time   = v_request.new_start_time,
    end_time     = v_request.new_end_time,
    staff_id     = COALESCE(v_request.new_staff_id, staff_id),
    updated_at   = NOW()
  WHERE id = v_request.original_booking_id
  RETURNING id INTO v_new_id;

  UPDATE reschedule_requests SET
    status = 'completed', responded_at = NOW(),
    new_booking_id = v_new_id, updated_at = NOW()
  WHERE id = p_request_id;

  -- [FIXED: title/body → message]
  INSERT INTO notifications (user_id, type, message, booking_id)
  VALUES (v_booking.customer_id, 'reschedule_approved',
    '✅ تمت الموافقة على إعادة الجدولة' || E'\n' ||
    'تم تحديث موعدك إلى ' || TO_CHAR(v_request.new_date, 'DD/MM/YYYY') ||
    ' الساعة ' || TO_CHAR(v_request.new_start_time, 'HH24:MI'),
    v_new_id);

  RETURN QUERY SELECT TRUE, v_new_id, 'تم تطبيق إعادة الجدولة بنجاح'::TEXT;

EXCEPTION WHEN OTHERS THEN
  PERFORM log_and_raise('approve_reschedule',
    jsonb_build_object('request_id', p_request_id, 'error', SQLERRM));
  RETURN QUERY SELECT FALSE, NULL::UUID, 'حدث خطأ داخلي'::TEXT;
END;
$function$;
REVOKE EXECUTE ON FUNCTION approve_reschedule(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION approve_reschedule(uuid, uuid) TO service_role;

-- (3) audit_jwt_algorithm_change  [TRIGGER on platform_settings] -------------
CREATE OR REPLACE FUNCTION public.audit_jwt_algorithm_change()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.key = 'jwt_algorithm' AND OLD.value != NEW.value THEN
    INSERT INTO security_access_log (table_name, action, details)
    VALUES ('platform_settings', 'jwt_algorithm_changed',
      jsonb_build_object(
        'old_algorithm', OLD.value,
        'new_algorithm', NEW.value,
        'changed_at',    NOW()
      ));

    -- immediate notification to all admins  [FIXED: title/body → message]
    INSERT INTO notifications (user_id, type, message, channel, priority)
    SELECT id, 'security_critical',
      '🚨 تغيير خوارزمية JWT' || E'\n' ||
      'تم تغيير jwt_algorithm من ' || OLD.value || ' إلى ' || NEW.value ||
      '. إذا لم تكن أنت، غيّر الـ secret فوراً.',
      'push', 'urgent'
    FROM users WHERE role = 'admin';
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE EXECUTE ON FUNCTION audit_jwt_algorithm_change() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION audit_jwt_algorithm_change() TO service_role;

-- (4) cancel_booking_with_fee  [title/body→message ×2 + notify_waitlist args + points reversal]
CREATE OR REPLACE FUNCTION public.cancel_booking_with_fee(p_booking_id uuid, p_cancelled_by uuid, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_booking       RECORD;
  v_fee           INTEGER;
  v_is_owner      BOOLEAN;
  v_is_admin      BOOLEAN;
  v_who           TEXT;
  v_refund_result JSONB;
  v_message       TEXT;
  v_refund_amount INTEGER;
BEGIN
  SELECT * INTO v_booking FROM bookings WHERE id = p_booking_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', FALSE, 'code', 'NOT_FOUND',
      'message', 'الحجز غير موجود');
  END IF;

  IF v_booking.status NOT IN ('pending', 'confirmed') THEN
    RETURN jsonb_build_object(
      'success', FALSE, 'code', 'INVALID_STATUS',
      'message', 'لا يمكن إلغاء حجز بحالة: ' || v_booking.status
    );
  END IF;

  v_is_owner := EXISTS (
    SELECT 1 FROM businesses WHERE id = v_booking.business_id AND owner_id = p_cancelled_by
  );
  v_is_admin := EXISTS (
    SELECT 1 FROM users WHERE id = p_cancelled_by AND role = 'admin'
  );
  v_who := CASE
    WHEN v_is_admin THEN 'admin'
    WHEN v_is_owner THEN 'business'
    ELSE 'customer'
  END;

  v_fee := CASE
    WHEN v_who = 'customer' THEN calculate_cancellation_fee(p_booking_id)
    ELSE 0
  END;

  UPDATE bookings SET
    status                  = 'cancelled',
    cancelled_by            = v_who,
    cancel_reason           = p_reason,
    cancelled_at            = NOW(),
    cancellation_fee_amount = v_fee,
    updated_at              = NOW()
  WHERE id = p_booking_id;

  -- ── reverse loyalty points ─────────────────────────────────────────────
  -- (a) refund the redeemed (spent) points on the booking → new dedicated earn type
  --     redemption_refund (added to the positive side in all three balance locations).
  --     balance_after is set by trigger trg_calculate_balance_after (BEFORE INSERT).
  IF COALESCE(v_booking.points_redeemed, 0) > 0 THEN
    INSERT INTO points_transactions
      (customer_id, booking_id, type, points, points_category, expires_at, note)
    VALUES (v_booking.customer_id, p_booking_id, 'redemption_refund',
      v_booking.points_redeemed, 'general', NOW() + INTERVAL '6 months',
      'استرجاع نقاط مستردَّة عند إلغاء الحجز #' || LEFT(p_booking_id::TEXT, 8));
  END IF;
  -- (b) "completed then cancelled" edge: claw back any loyalty points granted on this booking (safety net).
  --     Not reachable via this path currently (the pending/confirmed guard), but
  --     explicitly required as a guarantee. admin_deduct is an existing spend type (subtracted in every balance formula).
  INSERT INTO points_transactions
    (customer_id, booking_id, type, points, points_category, note)
  SELECT customer_id, p_booking_id, 'admin_deduct', points, 'general',
    'سحب نقاط مُنِحت على حجز أُلغي #' || LEFT(p_booking_id::TEXT, 8)
  FROM points_transactions
  WHERE booking_id = p_booking_id
    AND type IN ('visit_reward', 'referral_reward', 'referral_welcome');

  v_message := CASE
    WHEN v_fee > 0 THEN 'تم الإلغاء — رسوم: ' || v_fee || ' دينار'
    ELSE 'تم الإلغاء بنجاح'
  END;

  -- automatic ZainCash refund
  IF v_booking.payment_method = 'zaincash'
     AND COALESCE(v_booking.payment_status, 'unpaid') = 'paid' THEN
    v_refund_amount := GREATEST(0, v_booking.price - v_fee);
    IF v_refund_amount > 0 THEN
      v_refund_result := initiate_zaincash_refund(
        p_booking_id, v_refund_amount, p_cancelled_by
      );
      v_message := v_message || CASE
        WHEN (v_refund_result->>'success')::BOOLEAN
        THEN ' — سيُعاد ' || v_refund_amount || ' دينار عبر ZainCash'
        ELSE ' — سيُعالَج الاسترداد يدوياً'
      END;
    END IF;

  -- admin notification for AsiaHawala refund (always manual)  [FIXED: title/body → message]
  ELSIF v_booking.payment_method = 'asiahawala'
        AND COALESCE(v_booking.payment_status, 'unpaid') = 'paid' THEN
    INSERT INTO notifications (user_id, type, message, booking_id, channel)
    SELECT u.id, 'asiahawala_refund_needed',
      '⚠️ استرداد AsiaHawala مطلوب' || E'\n' ||
      'حجز مُلغى بـ AsiaHawala — استرداد يدوي مطلوب: ' || p_booking_id,
      p_booking_id, 'in_app'
    FROM users u WHERE u.role = 'admin' LIMIT 1;
    v_message := v_message || ' — سيُعالَج الاسترداد يدوياً عبر AsiaHawala';
  END IF;

  -- notify the other party  [FIXED: title/body → message]
  INSERT INTO notifications (user_id, type, message, booking_id)
  VALUES (
    CASE WHEN v_who = 'customer' THEN
      (SELECT owner_id FROM businesses WHERE id = v_booking.business_id)
    ELSE v_booking.customer_id END,
    'booking_cancelled',
    'تم إلغاء الحجز' || E'\n' || v_message,
    p_booking_id
  );

  -- waitlist  [FIXED: correct arg order (business_id, date, time, service_id, staff_id)]
  PERFORM notify_waitlist_on_availability(
    v_booking.business_id, v_booking.booking_date, v_booking.start_time,
    v_booking.service_id, v_booking.staff_id
  );

  RETURN jsonb_build_object(
    'success', TRUE, 'message', v_message,
    'cancellation_fee', v_fee, 'cancelled_by', v_who
  );

EXCEPTION WHEN OTHERS THEN
  PERFORM log_and_raise('cancel_booking_with_fee',
    jsonb_build_object('booking_id', p_booking_id, 'error', SQLERRM));
  RETURN jsonb_build_object('success', FALSE, 'code', 'INTERNAL_ERROR',
    'message', 'حدث خطأ — يرجى المحاولة مرة أخرى');
END;
$function$;
REVOKE EXECUTE ON FUNCTION cancel_booking_with_fee(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION cancel_booking_with_fee(uuid, uuid, text) TO service_role;

-- (5) check_admin_session_ip -------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_admin_session_ip(p_admin_id uuid, p_ip text, p_session_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE v_known BOOLEAN;
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM admin_sessions
    WHERE admin_id  = p_admin_id
      AND ip_address = p_ip
      AND expires_at > NOW() - INTERVAL '90 days'
      AND id != p_session_id
  ) INTO v_known;

  IF NOT v_known THEN
    UPDATE admin_sessions SET known_ip = FALSE WHERE id = p_session_id;

    INSERT INTO security_access_log (attempted_user, action, details, ip_address)
    VALUES (p_admin_id, 'admin_login_new_ip',
      jsonb_build_object('ip', p_ip, 'session_id', p_session_id), p_ip);

    -- [FIXED: title/body → message]
    INSERT INTO notifications (user_id, type, message)
    VALUES (p_admin_id, 'security_alert',
      '⚠️ دخول من IP جديد' || E'\n' ||
      'دخول لحسابك من: ' || p_ip || ' — إذا لم تكن أنت، أبطل جلساتك فوراً');
  END IF;

  UPDATE admin_sessions SET last_active = NOW() WHERE id = p_session_id;
  RETURN v_known;

EXCEPTION WHEN OTHERS THEN
  PERFORM log_and_raise('check_admin_session_ip',
    jsonb_build_object('admin_id', p_admin_id));
  RETURN TRUE;
END;
$function$;
REVOKE EXECUTE ON FUNCTION check_admin_session_ip(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION check_admin_session_ip(uuid, text, uuid) TO service_role;

-- (6) check_jwt_config -------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_jwt_config()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_algorithm TEXT;
  v_issues    JSONB := '[]'::JSONB;
  v_issue     TEXT;
BEGIN
  SELECT value INTO v_algorithm
  FROM platform_settings WHERE key = 'jwt_algorithm';

  IF v_algorithm IS NULL THEN
    v_issues := v_issues || '["jwt_algorithm غير مُعيَّن في platform_settings"]'::JSONB;
  ELSIF v_algorithm NOT IN ('HS256','HS384','HS512','RS256','RS384','RS512','ES256','ES384','ES512') THEN
    v_issues := v_issues || jsonb_build_array('algorithm غير مدعوم: ' || v_algorithm);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'min_iat'
  ) THEN
    v_issues := v_issues || '["users.min_iat مفقود — JWT rotation لن يعمل"]'::JSONB;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'rotate_user_jwt'
  ) THEN
    v_issues := v_issues || '["rotate_user_jwt() مفقودة — لا يمكن إلغاء tokens"]'::JSONB;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'refresh_tokens' AND column_name = 'token_hash'
  ) THEN
    v_issues := v_issues || '["refresh_tokens.token_hash مفقود — tokens مخزونة كـ plaintext"]'::JSONB;
  END IF;

  IF jsonb_array_length(v_issues) > 0 THEN
    INSERT INTO security_access_log (table_name, action, details)
    VALUES ('platform_settings', 'jwt_config_issues_detected',
      jsonb_build_object('issues', v_issues, 'algorithm', v_algorithm));

    -- notify admin  [FIXED: title/body → message]
    INSERT INTO notifications (user_id, type, message, channel, priority)
    SELECT id, 'security_config_alert',
      '⚠️ JWT Configuration Issues' || E'\n' ||
      'يرجى مراجعة إعدادات JWT — ' || jsonb_array_length(v_issues) || ' مشاكل مكتشفة',
      'in_app', 'urgent'
    FROM users WHERE role = 'admin' LIMIT 1;

    RETURN jsonb_build_object('valid', FALSE, 'issues', v_issues);
  END IF;

  RETURN jsonb_build_object(
    'valid',     TRUE,
    'algorithm', v_algorithm,
    'message',   'JWT config سليم — ATK-03 محمي'
  );

EXCEPTION WHEN OTHERS THEN
  PERFORM log_and_raise('check_jwt_config',
    jsonb_build_object('error', SQLERRM));
  RETURN jsonb_build_object('valid', FALSE, 'error', 'internal_error');
END;
$function$;
REVOKE EXECUTE ON FUNCTION check_jwt_config() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION check_jwt_config() TO service_role;

-- (7) confirm_asiahawala_payment  [title/body → message ×2] ------------------
CREATE OR REPLACE FUNCTION public.confirm_asiahawala_payment(p_transaction_id uuid, p_admin_id uuid, p_hawala_ref text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_transaction RECORD;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM users WHERE id = p_admin_id AND role = 'admin'
  ) THEN
    RETURN jsonb_build_object('success', FALSE, 'code', 'UNAUTHORIZED');
  END IF;

  SELECT * INTO v_transaction
  FROM asiahawala_transactions
  WHERE id = p_transaction_id
    AND status = 'pending_confirmation'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', FALSE, 'code', 'NOT_FOUND_OR_PROCESSED',
      'message', 'المعاملة غير موجودة أو تمت معالجتها مسبقاً');
  END IF;

  UPDATE asiahawala_transactions SET
    status           = 'confirmed',
    confirmed_by     = p_admin_id,
    confirmed_at     = NOW(),
    hawala_reference = COALESCE(p_hawala_ref, hawala_reference),
    updated_at       = NOW()
  WHERE id = p_transaction_id;

  IF v_transaction.booking_id IS NOT NULL THEN
    UPDATE bookings SET
      status         = 'confirmed',
      payment_status = 'paid',
      updated_at     = NOW()
    WHERE id = v_transaction.booking_id;

    -- [FIXED: title/body → message]
    INSERT INTO notifications (user_id, type, message, booking_id, channel)
    VALUES (
      v_transaction.user_id,
      'booking_payment_confirmed',
      'تم تأكيد حجزك' || E'\n' ||
      'تم استلام حوالتك وتأكيد حجزك بنجاح. نراك قريباً!',
      v_transaction.booking_id,
      'whatsapp'
    );

    -- [FIXED: title/body → message]
    INSERT INTO notifications (user_id, type, message, booking_id, channel)
    SELECT b.owner_id, 'new_booking_confirmed',
      'حجز جديد مؤكد' || E'\n' || 'تم تأكيد حجز عبر AsiaHawala',
      v_transaction.booking_id, 'push'
    FROM bookings bk
    JOIN businesses b ON b.id = bk.business_id
    WHERE bk.id = v_transaction.booking_id;
  END IF;

  INSERT INTO activity_logs (user_id, action, entity_type, entity_id, details)
  VALUES (p_admin_id, 'asiahawala_confirmed',
    'asiahawala_transactions', p_transaction_id,
    jsonb_build_object(
      'amount', v_transaction.amount,
      'hawala_ref', p_hawala_ref,
      'booking_id', v_transaction.booking_id
    ));

  RETURN jsonb_build_object(
    'success', TRUE,
    'booking_confirmed', (v_transaction.booking_id IS NOT NULL),
    'amount', v_transaction.amount,
    'message', 'تم تأكيد الحوالة والحجز بنجاح'
  );

EXCEPTION WHEN OTHERS THEN
  PERFORM log_and_raise('confirm_asiahawala_payment',
    jsonb_build_object('transaction_id', p_transaction_id, 'error', SQLERRM));
  RETURN jsonb_build_object('success', FALSE, 'code', 'INTERNAL_ERROR');
END;
$function$;
REVOKE EXECUTE ON FUNCTION confirm_asiahawala_payment(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION confirm_asiahawala_payment(uuid, uuid, text) TO service_role;

-- (8) detect_token_device_mismatch -------------------------------------------
CREATE OR REPLACE FUNCTION public.detect_token_device_mismatch(p_token_id uuid, p_device_id text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_token  RECORD;
  v_is_mismatch BOOLEAN := FALSE;
BEGIN
  SELECT * INTO v_token FROM refresh_tokens WHERE id = p_token_id;
  IF v_token IS NULL THEN RETURN FALSE; END IF;

  IF v_token.device_id IS NULL THEN RETURN FALSE; END IF;

  IF v_token.device_id != p_device_id THEN
    v_is_mismatch := TRUE;

    INSERT INTO security_access_log (attempted_user, action, details)
    VALUES (v_token.user_id, 'token_device_mismatch',
      jsonb_build_object(
        'token_id',         p_token_id,
        'expected_device',  v_token.device_id,
        'actual_device',    p_device_id,
        'device_name',      v_token.device_name
      ));

    -- notify user  [FIXED: title/body → message]
    INSERT INTO notifications (user_id, type, message, channel, priority)
    VALUES (v_token.user_id, 'security_alert',
      '⚠️ تسجيل دخول من جهاز جديد' || E'\n' ||
      'تم استخدام حسابك من جهاز مختلف. إذا لم تكن أنت، غيّر كلمة المرور فوراً.',
      'push', 'urgent');

    UPDATE refresh_tokens SET
      revoked       = TRUE,
      revoked_at    = NOW(),
      revoke_reason = 'device_mismatch_detected'
    WHERE id = p_token_id;
  END IF;

  RETURN v_is_mismatch;

EXCEPTION WHEN OTHERS THEN
  PERFORM log_and_raise('detect_token_device_mismatch',
    jsonb_build_object('token_id', p_token_id, 'error', SQLERRM));
  RETURN FALSE;
END;
$function$;
REVOKE EXECUTE ON FUNCTION detect_token_device_mismatch(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION detect_token_device_mismatch(uuid, text) TO service_role;

-- (9) expire_pending_asiahawala ----------------------------------------------
CREATE OR REPLACE FUNCTION public.expire_pending_asiahawala()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_expiry_hours INTEGER;
  v_count        INTEGER := 0;
  v_rec          RECORD;
BEGIN
  SELECT COALESCE(value::INTEGER, 24)
  INTO v_expiry_hours
  FROM platform_settings
  WHERE key = 'asiahawala_payment_expiry_hours';

  FOR v_rec IN
    SELECT id, booking_id, user_id, amount
    FROM asiahawala_transactions
    WHERE status = 'pending_confirmation'
      AND created_at < NOW() - (v_expiry_hours || ' hours')::INTERVAL
    FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE asiahawala_transactions SET
      status           = 'rejected',
      rejection_reason = 'انتهت المهلة — لم تُرسَل الحوالة خلال ' || v_expiry_hours || ' ساعة',
      updated_at       = NOW()
    WHERE id = v_rec.id;

    IF v_rec.booking_id IS NOT NULL THEN
      UPDATE bookings SET
        payment_status            = 'unpaid',
        payment_method            = 'cash',
        asiahawala_transaction_id = NULL,
        updated_at                = NOW()
      WHERE id = v_rec.booking_id AND status = 'pending';
    END IF;

    -- [FIXED: title/body → message]
    INSERT INTO notifications (user_id, type, message, booking_id, channel)
    VALUES (
      v_rec.user_id,
      'asiahawala_payment_expired',
      'انتهت مهلة الدفع' || E'\n' ||
      'انتهت مهلة إرسال حوالتك (' || v_expiry_hours || ' ساعة). ' ||
      'يمكنك تجديد الطلب أو اختيار طريقة دفع أخرى.',
      v_rec.booking_id,
      'push'
    );

    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object('success', TRUE, 'expired_count', v_count);

EXCEPTION WHEN OTHERS THEN
  PERFORM log_and_raise('expire_pending_asiahawala', NULL);
  RETURN jsonb_build_object('success', FALSE, 'error', SQLERRM);
END;
$function$;
REVOKE EXECUTE ON FUNCTION expire_pending_asiahawala() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION expire_pending_asiahawala() TO service_role;

-- (10) expire_pending_zaincash_transactions ----------------------------------
CREATE OR REPLACE FUNCTION public.expire_pending_zaincash_transactions()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_count INTEGER := 0;
  v_rec   RECORD;
BEGIN
  FOR v_rec IN
    SELECT id, booking_id, payer_id, amount
    FROM zaincash_transactions
    WHERE status = 'pending' AND expires_at < NOW()
    FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE zaincash_transactions SET status = 'expired', updated_at = NOW()
    WHERE id = v_rec.id;

    IF v_rec.booking_id IS NOT NULL THEN
      UPDATE bookings SET
        payment_status = 'unpaid', payment_method = 'cash', updated_at = NOW()
      WHERE id = v_rec.booking_id AND payment_status = 'pending';

      -- [FIXED: title/body → message]
      INSERT INTO notifications (user_id, type, message, booking_id, channel)
      VALUES (v_rec.payer_id, 'payment_expired',
        'انتهت مهلة الدفع' || E'\n' ||
        'انتهت مهلة دفعك عبر ZainCash. يمكنك تجديد الطلب أو اختيار طريقة دفع أخرى.',
        v_rec.booking_id, 'push');
    END IF;

    INSERT INTO activity_logs (action, target_type, details)
    VALUES ('zaincash_payment_expired', 'zaincash_transaction',
      jsonb_build_object('transaction_id', v_rec.id, 'booking_id', v_rec.booking_id));

    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;

EXCEPTION WHEN OTHERS THEN
  PERFORM log_and_raise('expire_pending_zaincash_transactions',
    jsonb_build_object('error', SQLERRM));
  RETURN 0;
END;
$function$;
REVOKE EXECUTE ON FUNCTION expire_pending_zaincash_transactions() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION expire_pending_zaincash_transactions() TO service_role;

-- (11) initiate_zaincash_refund ----------------------------------------------
CREATE OR REPLACE FUNCTION public.initiate_zaincash_refund(p_booking_id uuid, p_refund_amount integer, p_initiated_by uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_booking       RECORD;
  v_refund_tx_id  UUID;
BEGIN
  SELECT b.*, zt.id AS zc_tx_id, zt.amount AS zc_amount,
         zt.zaincash_msisdn, zt.zaincash_transaction_id AS zc_ref
  INTO v_booking
  FROM bookings b
  JOIN zaincash_transactions zt ON zt.id = b.zaincash_transaction_id
  WHERE b.id = p_booking_id
    AND zt.status = 'completed'
    AND zt.transaction_type = 'payment';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', FALSE, 'code', 'NO_ZAINCASH_PAYMENT');
  END IF;

  IF p_refund_amount > v_booking.zc_amount THEN
    RETURN jsonb_build_object('success', FALSE, 'code', 'REFUND_EXCEEDS_PAYMENT');
  END IF;

  IF EXISTS (
    SELECT 1 FROM zaincash_transactions
    WHERE booking_id = p_booking_id AND transaction_type = 'refund'
      AND status IN ('pending', 'completed')
  ) THEN
    RETURN jsonb_build_object('success', FALSE, 'code', 'REFUND_ALREADY_INITIATED');
  END IF;

  INSERT INTO zaincash_transactions (
    booking_id, transaction_type, payer_id, payee_id, business_id,
    amount, zaincash_msisdn, zaincash_service_type, status, expires_at
  ) VALUES (
    p_booking_id, 'refund', v_booking.customer_id, p_initiated_by,
    v_booking.business_id, p_refund_amount, v_booking.zaincash_msisdn,
    'CancellationRefund', 'pending', NOW() + INTERVAL '24 hours'
  )
  RETURNING id INTO v_refund_tx_id;

  UPDATE bookings SET
    refund_status = 'pending', refund_amount = p_refund_amount,
    refund_initiated_at = NOW()
  WHERE id = p_booking_id;

  -- [FIXED: title/body → message]
  INSERT INTO notifications (user_id, type, message, booking_id, channel)
  VALUES (v_booking.customer_id, 'refund_initiated',
    'جارٍ استرداد المبلغ' || E'\n' ||
    'سيصل ' || p_refund_amount || ' دينار إلى ZainCash خلال 24 ساعة',
    p_booking_id, 'whatsapp');

  RETURN jsonb_build_object(
    'success', TRUE, 'refund_transaction_id', v_refund_tx_id,
    'refund_amount', p_refund_amount
  );

EXCEPTION WHEN OTHERS THEN
  PERFORM log_and_raise('initiate_zaincash_refund',
    jsonb_build_object('booking_id', p_booking_id));
  RETURN jsonb_build_object('success', FALSE, 'code', 'INTERNAL_ERROR');
END;
$function$;
REVOKE EXECUTE ON FUNCTION initiate_zaincash_refund(uuid, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION initiate_zaincash_refund(uuid, integer, uuid) TO service_role;

-- (12) mark_zaincash_refund_completed ----------------------------------------
CREATE OR REPLACE FUNCTION public.mark_zaincash_refund_completed(p_booking_id uuid, p_zaincash_refund_id text, p_refunded_amount integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_booking RECORD;
BEGIN
  SELECT * INTO v_booking
  FROM bookings WHERE id = p_booking_id AND refund_status = 'pending';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', FALSE, 'code', 'NO_PENDING_REFUND');
  END IF;

  UPDATE bookings SET
    refund_status = 'completed', payment_status = 'refunded',
    refund_amount = p_refunded_amount, updated_at = NOW()
  WHERE id = p_booking_id;

  UPDATE zaincash_transactions SET
    status = 'completed', zaincash_transaction_id = p_zaincash_refund_id,
    completed_at = NOW()
  WHERE booking_id = p_booking_id AND transaction_type = 'refund' AND status = 'pending';

  -- [FIXED: title/body → message]
  INSERT INTO notifications (user_id, type, message, booking_id, channel)
  VALUES (v_booking.customer_id, 'refund_completed',
    'تم استرداد المبلغ' || E'\n' ||
    'تم إرجاع ' || p_refunded_amount || ' دينار إلى ZainCash بنجاح',
    p_booking_id, 'whatsapp');

  INSERT INTO activity_logs (business_id, user_id, action, entity_type, entity_id, details)
  VALUES (v_booking.business_id, v_booking.customer_id, 'refund_completed',
    'bookings', p_booking_id,
    jsonb_build_object('zaincash_refund_id', p_zaincash_refund_id,
                       'refunded_amount', p_refunded_amount));

  RETURN jsonb_build_object('success', TRUE, 'refunded_amount', p_refunded_amount);

EXCEPTION WHEN OTHERS THEN
  PERFORM log_and_raise('mark_zaincash_refund_completed',
    jsonb_build_object('booking_id', p_booking_id));
  RETURN jsonb_build_object('success', FALSE, 'code', 'INTERNAL_ERROR');
END;
$function$;
REVOKE EXECUTE ON FUNCTION mark_zaincash_refund_completed(uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION mark_zaincash_refund_completed(uuid, text, integer) TO service_role;

-- (13) mark_zaincash_refund_failed -------------------------------------------
CREATE OR REPLACE FUNCTION public.mark_zaincash_refund_failed(p_booking_id uuid, p_error_msg text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  UPDATE bookings SET refund_status = 'failed', updated_at = NOW()
  WHERE id = p_booking_id AND refund_status = 'pending';

  -- [FIXED: title/body → message]
  INSERT INTO notifications (user_id, type, message, booking_id, channel)
  SELECT u.id, 'refund_failed_admin',
    '⚠️ فشل استرداد ZainCash' || E'\n' ||
    'فشل استرداد حجز ' || p_booking_id || ': ' ||
    COALESCE(p_error_msg, 'سبب غير معروف') || ' — يحتاج تدخل يدوي',
    p_booking_id, 'in_app'
  FROM users u WHERE u.role = 'admin' LIMIT 1;

  INSERT INTO security_access_log (table_name, action, details)
  VALUES ('zaincash_transactions', 'refund_failed',
    jsonb_build_object('booking_id', p_booking_id, 'error', p_error_msg));

EXCEPTION WHEN OTHERS THEN
  BEGIN
    INSERT INTO security_access_log (table_name, action, details)
    VALUES ('zaincash_transactions', 'refund_failed_exception',
      jsonb_build_object('booking_id', p_booking_id, 'exception', SQLERRM));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
END;
$function$;
REVOKE EXECUTE ON FUNCTION mark_zaincash_refund_failed(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION mark_zaincash_refund_failed(uuid, text) TO service_role;

-- (14) notify_favorites_on_availability --------------------------------------
CREATE OR REPLACE FUNCTION public.notify_favorites_on_availability(p_business_id uuid, p_date date, p_start_time time without time zone)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_count       INTEGER := 0;
  v_fav         RECORD;
  v_slot_time   TIMESTAMPTZ;
BEGIN
  v_slot_time := (p_date::TEXT || ' ' || p_start_time::TEXT)::TIMESTAMPTZ;

  IF v_slot_time < NOW() THEN
    RETURN 0;
  END IF;

  IF v_slot_time > NOW() + INTERVAL '30 days' THEN
    RETURN 0;
  END IF;

  FOR v_fav IN
    SELECT f.customer_id
    FROM favorites f
    WHERE f.business_id = p_business_id
      AND f.notify_available = TRUE
  LOOP
    -- [FIXED: title/body → message]
    INSERT INTO notifications (
      user_id, type, message,
      status, channel, priority, scheduled_at
    ) VALUES (
      v_fav.customer_id,
      'waitlist_available',
      'موعد متاح! ⚡' || E'\n' ||
      'محلك المفضل عنده موعد في ' ||
        TO_CHAR(p_date, 'DD/MM') ||
        ' الساعة ' ||
        TO_CHAR(p_start_time, 'HH12:MI AM'),
      'pending', 'push', 'high', NOW()
    );

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$function$;
REVOKE EXECUTE ON FUNCTION notify_favorites_on_availability(uuid, date, time without time zone) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION notify_favorites_on_availability(uuid, date, time without time zone) TO service_role;

-- (15) notify_waitlist_on_availability ---------------------------------------
CREATE OR REPLACE FUNCTION public.notify_waitlist_on_availability(p_business_id uuid, p_date date, p_start_time time without time zone, p_service_id uuid DEFAULT NULL::uuid, p_staff_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_count             INTEGER := 0;
  v_entry             RECORD;
  v_response_hours    INTEGER;
BEGIN
  SELECT COALESCE(value::INTEGER, 2) INTO v_response_hours
  FROM platform_settings WHERE key = 'waitlist_response_hours';

  FOR v_entry IN
    SELECT w.*
    FROM waitlist w
    WHERE w.business_id = p_business_id
      AND w.status = 'waiting'
      AND (w.preferred_date IS NULL OR w.preferred_date = p_date)
      AND (w.preferred_time IS NULL OR w.preferred_time = p_start_time)
      AND (p_service_id IS NULL OR w.service_id = p_service_id)
      AND (p_staff_id IS NULL OR w.staff_id = p_staff_id)
      AND w.expires_at > NOW()
    ORDER BY w.created_at ASC
    LIMIT 1
  LOOP
    UPDATE waitlist SET
      status            = 'notified',
      notified_at       = NOW(),
      response_deadline = NOW() + (v_response_hours || ' hours')::INTERVAL,
      updated_at        = NOW()
    WHERE id = v_entry.id;

    -- [FIXED: title/body → message]
    INSERT INTO notifications (user_id, type, message)
    VALUES (
      v_entry.customer_id,
      'waitlist_available',
      '🎉 الموعد الذي تنتظره متاح!' || E'\n' ||
      'لديك ' || v_response_hours || ' ساعات لتأكيد حجزك — احجز الآن قبل أن ينتهي العرض'
    );

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$function$;
REVOKE EXECUTE ON FUNCTION notify_waitlist_on_availability(uuid, date, time without time zone, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION notify_waitlist_on_availability(uuid, date, time without time zone, uuid, uuid) TO service_role;

-- (16) process_booking_end ---------------------------------------------------
CREATE OR REPLACE FUNCTION public.process_booking_end(p_booking_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_booking     RECORD;
  v_grace_hours INTEGER;
  v_grace_exp   TIMESTAMPTZ;
BEGIN
  SELECT * INTO v_booking FROM bookings WHERE id = p_booking_id;
  IF v_booking IS NULL                   THEN RETURN 'booking_not_found'; END IF;
  IF v_booking.attendance_confirmed      THEN RETURN 'already_confirmed'; END IF;
  IF v_booking.status IN ('cancelled','no_show') THEN RETURN 'already_resolved'; END IF;
  IF EXISTS (SELECT 1 FROM attendance_grace_periods WHERE booking_id = p_booking_id)
    THEN RETURN 'grace_period_exists'; END IF;

  SELECT COALESCE(value::INTEGER, 2) INTO v_grace_hours
  FROM platform_settings WHERE key = 'attendance_grace_hours';
  v_grace_exp := NOW() + (v_grace_hours || ' hours')::INTERVAL;

  INSERT INTO attendance_grace_periods
    (booking_id, business_id, customer_id, booking_end_time, grace_expires_at)
  VALUES (p_booking_id, v_booking.business_id, v_booking.customer_id, NOW(), v_grace_exp);

  -- [FIXED: title/body → message]
  INSERT INTO notifications (user_id, type, message, booking_id)
  SELECT owner_id, 'attendance_confirmation_required',
    'تأكيد حضور مطلوب' || E'\n' ||
    'يرجى تأكيد حضور الزبون خلال ' || v_grace_hours || ' ساعات', p_booking_id
  FROM businesses WHERE id = v_booking.business_id;

  RETURN 'grace_period_started';

EXCEPTION WHEN OTHERS THEN
  PERFORM log_and_raise('process_booking_end',
    jsonb_build_object('booking_id', p_booking_id, 'error', SQLERRM));
  RETURN 'error';
END;
$function$;
REVOKE EXECUTE ON FUNCTION process_booking_end(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION process_booking_end(uuid) TO service_role;

-- (17) process_expired_grace_periods -----------------------------------------
CREATE OR REPLACE FUNCTION public.process_expired_grace_periods()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_grace    RECORD;
  v_count    INTEGER := 0;
  v_deadline INTEGER;
BEGIN
  SELECT COALESCE(value::INTEGER, 48) INTO v_deadline
  FROM platform_settings WHERE key = 'attendance_review_deadline_hours';

  FOR v_grace IN
    SELECT * FROM attendance_grace_periods
    WHERE grace_status = 'waiting' AND grace_expires_at < NOW()
    FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE attendance_grace_periods
    SET grace_status = 'expired', updated_at = NOW()
    WHERE id = v_grace.id;

    INSERT INTO pending_attendance_reviews
      (booking_id, grace_period_id, business_id, customer_id, review_reason, review_deadline)
    VALUES (v_grace.booking_id, v_grace.id, v_grace.business_id, v_grace.customer_id,
      'grace_expired_no_response', NOW() + (v_deadline || ' hours')::INTERVAL);

    -- [FIXED: title/body → message]
    INSERT INTO notifications (user_id, type, message, booking_id)
    SELECT u.id, 'no_show_alert',
      'حالة غياب تحتاج مراجعة' || E'\n' ||
      'انتهت مهلة تأكيد الحضور بدون رد — يرجى المراجعة', v_grace.booking_id
    FROM users u WHERE u.role = 'admin' LIMIT 1;

    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;

EXCEPTION WHEN OTHERS THEN
  PERFORM log_and_raise('process_expired_grace_periods',
    jsonb_build_object('error', SQLERRM));
  RETURN 0;
END;
$function$;
REVOKE EXECUTE ON FUNCTION process_expired_grace_periods() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION process_expired_grace_periods() TO service_role;

-- (18) process_pending_notifications -----------------------------------------
CREATE OR REPLACE FUNCTION public.process_pending_notifications()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_pending_count    INTEGER;
  v_oldest_minutes   INTEGER;
  v_threshold        INTEGER;
  v_already_alerted  BOOLEAN;
BEGIN
  SELECT
    COUNT(*),
    COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(scheduled_at))) / 60, 0)::INTEGER
  INTO v_pending_count, v_oldest_minutes
  FROM notifications
  WHERE status = 'pending'
    AND scheduled_at <= NOW()
    AND type != 'notification_system_alert';

  SELECT COALESCE(value::INTEGER, 50)
  INTO v_threshold
  FROM platform_settings
  WHERE key = 'notification_pending_alert_threshold';

  SELECT EXISTS(
    SELECT 1 FROM notifications
    WHERE type = 'notification_system_alert'
      AND created_at > NOW() - INTERVAL '10 minutes'
  ) INTO v_already_alerted;

  IF (v_pending_count > v_threshold OR v_oldest_minutes > 30)
     AND NOT v_already_alerted THEN
    -- [FIXED: title/body → message]
    INSERT INTO notifications (user_id, type, message, channel)
    SELECT u.id,
      'notification_system_alert',
      '⚠️ نظام الإشعارات: تراكم' || E'\n' ||
      v_pending_count || ' إشعار معلّق (أقدمها منذ ' || v_oldest_minutes ||
      ' دقيقة). تحقق من Node.js Cron!',
      'in_app'
    FROM users u WHERE u.role = 'admin' LIMIT 1;
  END IF;

  RETURN jsonb_build_object(
    'pending_count',   v_pending_count,
    'oldest_minutes',  v_oldest_minutes,
    'alert_sent',      ((v_pending_count > v_threshold OR v_oldest_minutes > 30)
                        AND NOT v_already_alerted)
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('error', SQLERRM);
END;
$function$;
REVOKE EXECUTE ON FUNCTION process_pending_notifications() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION process_pending_notifications() TO service_role;

-- (19) process_zaincash_callback  [title/body → message ×2] ------------------
CREATE OR REPLACE FUNCTION public.process_zaincash_callback(p_order_id text, p_zc_tx_id text, p_zc_status text, p_zc_token text, p_raw_payload jsonb, p_ip_address text DEFAULT NULL::text, p_paid_amount integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_transaction RECORD;
  v_booking_id  UUID;
  v_cb_id       UUID;
BEGIN
  INSERT INTO zaincash_callbacks (transaction_id, raw_payload, ip_address, is_verified)
  SELECT zt.id, p_raw_payload, p_ip_address, TRUE
  FROM zaincash_transactions zt
  WHERE zt.zaincash_order_id = p_order_id
  LIMIT 1
  RETURNING id INTO v_cb_id;

  SELECT * INTO v_transaction
  FROM zaincash_transactions
  WHERE zaincash_order_id = p_order_id AND status = 'pending'
  FOR UPDATE SKIP LOCKED;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', FALSE, 'code', 'DUPLICATE_OR_NOT_FOUND');
  END IF;

  IF p_paid_amount IS NOT NULL AND v_transaction.expected_amount IS NOT NULL THEN
    IF p_paid_amount < v_transaction.expected_amount THEN
      INSERT INTO security_access_log (table_name, action, details)
      VALUES ('zaincash_transactions', 'payment_amount_mismatch',
        jsonb_build_object(
          'order_id',       p_order_id,
          'expected',       v_transaction.expected_amount,
          'paid',           p_paid_amount,
          'difference',     v_transaction.expected_amount - p_paid_amount,
          'ip',             p_ip_address
        ));

      -- [FIXED: title/body → message]
      INSERT INTO notifications (user_id, type, message, channel)
      SELECT id, 'payment_fraud_alert',
        '🚨 تحذير: دفع ناقص' || E'\n' ||
        'طلب ZainCash #' || p_order_id || ' — مدفوع: ' || p_paid_amount ||
        ' | متوقع: ' || v_transaction.expected_amount,
        'in_app'
      FROM users WHERE role = 'admin' LIMIT 1;

      UPDATE zaincash_transactions SET
        status = 'failed', updated_at = NOW()
      WHERE id = v_transaction.id;

      RETURN jsonb_build_object(
        'success', FALSE, 'code', 'AMOUNT_MISMATCH',
        'expected', v_transaction.expected_amount,
        'paid',     p_paid_amount
      );
    END IF;
  END IF;

  UPDATE zaincash_transactions SET
    status                  = CASE WHEN p_zc_status = 'success' THEN 'completed' ELSE 'failed' END,
    zaincash_transaction_id = p_zc_tx_id,
    zaincash_token          = p_zc_token,
    zaincash_status         = p_zc_status,
    callback_received_at    = NOW(),
    updated_at              = NOW()
  WHERE id = v_transaction.id;

  IF p_zc_status != 'success' THEN
    RETURN jsonb_build_object('success', FALSE, 'code', 'PAYMENT_FAILED');
  END IF;

  UPDATE bookings SET
    payment_status = 'paid',
    payment_method = 'zaincash',
    updated_at     = NOW()
  WHERE id = v_transaction.booking_id
  RETURNING id INTO v_booking_id;

  IF v_booking_id IS NOT NULL THEN
    -- [FIXED: title/body → message]
    INSERT INTO notifications (user_id, type, message, booking_id)
    VALUES (v_transaction.payer_id, 'payment_confirmed',
      '✅ تم تأكيد الدفع' || E'\n' ||
      'تم استلام دفعتك عبر ZainCash. حجزك مؤكد!',
      v_booking_id);
  END IF;

  RETURN jsonb_build_object('success', TRUE, 'booking_id', v_booking_id);

EXCEPTION WHEN OTHERS THEN
  PERFORM log_and_raise('process_zaincash_callback',
    jsonb_build_object('order_id', p_order_id, 'error', SQLERRM));
  RETURN jsonb_build_object('success', FALSE, 'code', 'INTERNAL_ERROR');
END;
$function$;
REVOKE EXECUTE ON FUNCTION process_zaincash_callback(text, text, text, text, jsonb, text, integer) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION process_zaincash_callback(text, text, text, text, jsonb, text, integer) TO service_role;

-- (20) reject_asiahawala_payment ---------------------------------------------
CREATE OR REPLACE FUNCTION public.reject_asiahawala_payment(p_transaction_id uuid, p_admin_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_transaction RECORD;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM users WHERE id = p_admin_id AND role = 'admin'
  ) THEN
    RETURN jsonb_build_object('success', FALSE, 'code', 'UNAUTHORIZED');
  END IF;

  SELECT * INTO v_transaction
  FROM asiahawala_transactions
  WHERE id = p_transaction_id
    AND status = 'pending_confirmation'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', FALSE, 'code', 'NOT_FOUND_OR_PROCESSED',
      'message', 'المعاملة غير موجودة أو تمت معالجتها مسبقاً');
  END IF;

  UPDATE asiahawala_transactions SET
    status           = 'rejected',
    confirmed_by     = p_admin_id,
    confirmed_at     = NOW(),
    rejection_reason = p_reason,
    updated_at       = NOW()
  WHERE id = p_transaction_id;

  IF v_transaction.booking_id IS NOT NULL THEN
    UPDATE bookings SET
      payment_status            = 'unpaid',
      payment_method            = 'cash',
      asiahawala_transaction_id = NULL,
      updated_at                = NOW()
    WHERE id = v_transaction.booking_id
      AND status = 'pending';

    -- [FIXED: title/body → message]
    INSERT INTO notifications (user_id, type, message, booking_id, channel)
    VALUES (
      v_transaction.user_id,
      'asiahawala_payment_rejected',
      'لم يتم تأكيد الحوالة' || E'\n' ||
      'لم يتم التحقق من حوالتك. ' ||
      COALESCE('السبب: ' || p_reason || '. ', '') ||
      'يرجى المحاولة مجدداً أو اختيار طريقة دفع أخرى.',
      v_transaction.booking_id,
      'whatsapp'
    );
  END IF;

  INSERT INTO activity_logs (user_id, action, entity_type, entity_id, details)
  VALUES (p_admin_id, 'asiahawala_rejected',
    'asiahawala_transactions', p_transaction_id,
    jsonb_build_object('reason', p_reason, 'booking_id', v_transaction.booking_id));

  RETURN jsonb_build_object(
    'success', TRUE,
    'message', 'تم رفض الحوالة وإعادة الحجز لحالة الانتظار'
  );

EXCEPTION WHEN OTHERS THEN
  PERFORM log_and_raise('reject_asiahawala_payment',
    jsonb_build_object('transaction_id', p_transaction_id, 'error', SQLERRM));
  RETURN jsonb_build_object('success', FALSE, 'code', 'INTERNAL_ERROR');
END;
$function$;
REVOKE EXECUTE ON FUNCTION reject_asiahawala_payment(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION reject_asiahawala_payment(uuid, uuid, text) TO service_role;

-- (21) send_business_daily_summaries -----------------------------------------
CREATE OR REPLACE FUNCTION public.send_business_daily_summaries()
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_count   INTEGER := 0;
  v_biz     RECORD;
  v_today   DATE := CURRENT_DATE;
  v_bookings INTEGER;
  v_revenue  INTEGER;
BEGIN
  FOR v_biz IN
    SELECT b.id, b.owner_id, b.name FROM businesses b WHERE b.is_active = TRUE
  LOOP
    BEGIN
      SELECT COUNT(*), COALESCE(SUM(s.price), 0)
      INTO v_bookings, v_revenue
      FROM bookings bk
      LEFT JOIN services s ON s.id = bk.service_id
      WHERE bk.business_id = v_biz.id
        AND bk.booking_date = v_today - 1
        AND bk.status = 'completed';

      -- [FIXED: title/body → message]
      INSERT INTO notifications (user_id, type, message)
      VALUES (v_biz.owner_id, 'daily_summary',
        'ملخص يوم أمس — ' || v_biz.name || E'\n' ||
        'الحجوزات: ' || v_bookings || ' | الإيرادات: ' || v_revenue || ' دينار');

      v_count := v_count + 1;
    EXCEPTION WHEN OTHERS THEN
      PERFORM log_and_raise('send_daily_summary_loop',
        jsonb_build_object('business_id', v_biz.id));
    END;
  END LOOP;

  RETURN v_count;

EXCEPTION WHEN OTHERS THEN
  PERFORM log_and_raise('send_business_daily_summaries', NULL);
  RETURN 0;
END;
$function$;
REVOKE EXECUTE ON FUNCTION send_business_daily_summaries() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION send_business_daily_summaries() TO service_role;

-- ── Part 3: add 'redemption_refund' to the 3 balance-classification locations ─
-- (positive/earn side — refunded redeemed points must count toward balance)

-- 3a) customer_points_balance view (3 CASE expressions: balance, expiring_soon, next_expiry_at)
CREATE OR REPLACE VIEW customer_points_balance AS
 SELECT customer_id,
    GREATEST(0::bigint, COALESCE(sum(
        CASE
            WHEN (type = ANY (ARRAY['visit_reward'::text, 'referral_reward'::text, 'referral_welcome'::text, 'admin_grant'::text, 'redemption_refund'::text])) AND (expires_at IS NULL OR expires_at > now()) THEN points
            WHEN type = ANY (ARRAY['redemption'::text, 'admin_deduct'::text, 'expiry'::text]) THEN - points
            ELSE 0
        END), 0::bigint))::integer AS balance,
    GREATEST(0::bigint, COALESCE(sum(
        CASE
            WHEN (type = ANY (ARRAY['visit_reward'::text, 'referral_reward'::text, 'referral_welcome'::text, 'admin_grant'::text, 'redemption_refund'::text])) AND expires_at > now() AND expires_at <= (now() + '30 days'::interval) THEN points
            ELSE 0
        END), 0::bigint))::integer AS expiring_soon,
    min(
        CASE
            WHEN (type = ANY (ARRAY['visit_reward'::text, 'referral_reward'::text, 'referral_welcome'::text, 'admin_grant'::text, 'redemption_refund'::text])) AND expires_at > now() THEN expires_at
            ELSE NULL::timestamp with time zone
        END) AS next_expiry_at
   FROM points_transactions
  GROUP BY customer_id;

-- 3b) grant_loyalty_points (inline balance formula — positive list)
CREATE OR REPLACE FUNCTION public.grant_loyalty_points(p_business_id uuid, p_customer_id uuid, p_booking_id uuid, p_rule_type text)
 RETURNS TABLE(success boolean, points_given integer, message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_rule      RECORD;
  v_balance   RECORD;
  v_is_first  BOOLEAN;
  v_tx_type   TEXT;
  v_new_bal   INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM bookings
    WHERE id          = p_booking_id
      AND business_id = p_business_id
      AND customer_id = p_customer_id
  ) THEN
    RETURN QUERY SELECT FALSE, 0,
      'الحجز لا ينتمي لهذا المحل أو الزبون'::TEXT;
    RETURN;
  END IF;

  SELECT * INTO v_rule FROM loyalty_rules
  WHERE business_id = p_business_id
    AND rule_type   = p_rule_type
    AND is_active   = TRUE;

  IF v_rule IS NULL OR v_rule.points_amount = 0 THEN
    RETURN QUERY SELECT FALSE, 0, 'لا توجد قاعدة مفعّلة'::TEXT;
    RETURN;
  END IF;

  IF p_rule_type = 'first_booking' THEN
    SELECT NOT EXISTS (
      SELECT 1 FROM bookings
      WHERE customer_id = p_customer_id AND business_id = p_business_id
        AND status = 'completed' AND id != p_booking_id
    ) INTO v_is_first;
    IF NOT v_is_first THEN
      RETURN QUERY SELECT FALSE, 0, 'ليس أول حجز'::TEXT;
      RETURN;
    END IF;
  END IF;

  SELECT * INTO v_balance FROM business_loyalty_balance
  WHERE business_id = p_business_id FOR UPDATE;

  IF v_balance IS NULL OR v_balance.balance < v_rule.points_amount THEN
    RETURN QUERY SELECT FALSE, 0, 'رصيد النقاط غير كافٍ'::TEXT;
    RETURN;
  END IF;

  UPDATE business_loyalty_balance SET
    balance           = balance - v_rule.points_amount,
    total_distributed = total_distributed + v_rule.points_amount,
    updated_at        = NOW()
  WHERE business_id = p_business_id;

  v_tx_type := CASE p_rule_type
    WHEN 'per_visit'     THEN 'visit_reward'
    WHEN 'first_booking' THEN 'visit_reward'
    WHEN 'referral'      THEN 'referral_reward'
    ELSE 'admin_grant' END;

  -- [redemption_refund added to positive list]
  SELECT GREATEST(0, COALESCE(SUM(
    CASE WHEN type IN ('visit_reward','referral_reward','referral_welcome','admin_grant','redemption_refund')
              AND (expires_at IS NULL OR expires_at > NOW()) THEN points
         WHEN type IN ('redemption','admin_deduct','expiry') THEN -points
         ELSE 0 END
  ), 0))::INTEGER + v_rule.points_amount
  INTO v_new_bal FROM points_transactions WHERE customer_id = p_customer_id;

  INSERT INTO points_transactions (
    customer_id, merchant_id, booking_id, type, points,
    points_category, expires_at, balance_after, note
  ) VALUES (
    p_customer_id, p_business_id, p_booking_id, v_tx_type, v_rule.points_amount,
    'merchant', NOW() + INTERVAL '6 months', v_new_bal,
    'نقاط ولاء: ' || p_rule_type
  );

  RETURN QUERY SELECT TRUE, v_rule.points_amount,
    'تم منح ' || v_rule.points_amount || ' نقطة'::TEXT;

EXCEPTION WHEN OTHERS THEN
  PERFORM log_and_raise('grant_loyalty_points',
    jsonb_build_object('business_id', p_business_id,
                       'customer_id', p_customer_id, 'error', SQLERRM));
  RETURN QUERY SELECT FALSE, 0, 'حدث خطأ داخلي'::TEXT;
END;
$function$;
REVOKE EXECUTE ON FUNCTION grant_loyalty_points(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION grant_loyalty_points(uuid, uuid, uuid, text) TO service_role;

-- 3c) redeem_points_on_booking (inline balance formula — positive list)
CREATE OR REPLACE FUNCTION public.redeem_points_on_booking(p_customer_id uuid, p_booking_id uuid, p_points_to_use integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_booking          RECORD;
  v_customer_balance INTEGER;
  v_point_value      INTEGER;
  v_min_points       INTEGER;
  v_max_percent      INTEGER;
  v_discount_iqd     INTEGER;
  v_max_discount     INTEGER;
  v_final_points     INTEGER;
BEGIN
  SELECT * INTO v_booking
  FROM bookings
  WHERE id = p_booking_id AND customer_id = p_customer_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', FALSE, 'code', 'NOT_FOUND');
  END IF;

  IF v_booking.status NOT IN ('pending', 'confirmed') THEN
    RETURN jsonb_build_object('success', FALSE, 'code', 'INVALID_STATUS',
      'message', 'لا يمكن تطبيق النقاط على هذا الحجز');
  END IF;

  IF COALESCE(v_booking.points_redeemed, 0) > 0 THEN
    RETURN jsonb_build_object(
      'success', FALSE,
      'code', 'ALREADY_REDEEMED',
      'message', 'تم استرداد النقاط على هذا الحجز مسبقاً',
      'points_already_redeemed', v_booking.points_redeemed
    );
  END IF;

  SELECT COALESCE(value::INTEGER, 10)  INTO v_point_value
  FROM platform_settings WHERE key = 'point_value_iqd';
  SELECT COALESCE(value::INTEGER, 100) INTO v_min_points
  FROM platform_settings WHERE key = 'min_points_redemption';
  SELECT COALESCE(value::INTEGER, 50)  INTO v_max_percent
  FROM platform_settings WHERE key = 'max_redemption_percent';

  IF p_points_to_use < v_min_points THEN
    RETURN jsonb_build_object('success', FALSE, 'code', 'BELOW_MINIMUM',
      'message', 'الحد الأدنى ' || v_min_points || ' نقطة');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_customer_id::TEXT));

  -- [redemption_refund added to positive list]
  SELECT GREATEST(0, COALESCE(SUM(
    CASE
      WHEN type IN ('visit_reward','referral_reward','referral_welcome','admin_grant','redemption_refund')
           AND (expires_at IS NULL OR expires_at > NOW())
        THEN points
      WHEN type IN ('redemption','admin_deduct','expiry')
        THEN -points
      ELSE 0
    END
  ), 0))::INTEGER
  INTO v_customer_balance
  FROM points_transactions
  WHERE customer_id = p_customer_id;

  IF v_customer_balance < p_points_to_use THEN
    RETURN jsonb_build_object('success', FALSE, 'code', 'INSUFFICIENT_POINTS',
      'message', 'رصيدك ' || v_customer_balance || ' نقطة',
      'available_balance', v_customer_balance);
  END IF;

  v_discount_iqd := p_points_to_use * v_point_value;
  v_max_discount := (v_booking.price * v_max_percent / 100)::INTEGER;

  IF v_discount_iqd > v_max_discount THEN
    v_final_points := v_max_discount / v_point_value;
    v_discount_iqd := v_max_discount;
  ELSE
    v_final_points := p_points_to_use;
  END IF;

  INSERT INTO points_transactions (
    customer_id, booking_id, type, points,
    points_category, balance_after, note
  ) VALUES (
    p_customer_id, p_booking_id, 'redemption', v_final_points,
    'general',
    v_customer_balance - v_final_points,
    'استرداد نقاط على حجز #' || LEFT(p_booking_id::TEXT, 8)
  );

  UPDATE bookings SET
    discount_amount = COALESCE(discount_amount, 0) + v_discount_iqd,
    points_redeemed = COALESCE(points_redeemed, 0) + v_final_points,
    updated_at      = NOW()
  WHERE id = p_booking_id;

  RETURN jsonb_build_object(
    'success', TRUE,
    'points_used',       v_final_points,
    'discount_iqd',      v_discount_iqd,
    'remaining_balance', v_customer_balance - v_final_points,
    'message', 'تم خصم ' || v_discount_iqd || ' دينار من سعر الحجز'
  );

EXCEPTION WHEN OTHERS THEN
  PERFORM log_and_raise('redeem_points_on_booking',
    jsonb_build_object('customer_id', p_customer_id,
                       'booking_id', p_booking_id, 'error', SQLERRM));
  RETURN jsonb_build_object('success', FALSE, 'code', 'INTERNAL_ERROR');
END;
$function$;
REVOKE EXECUTE ON FUNCTION redeem_points_on_booking(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION redeem_points_on_booking(uuid, uuid, integer) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

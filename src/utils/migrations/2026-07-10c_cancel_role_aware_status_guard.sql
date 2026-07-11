-- 2026-07-10c_cancel_role_aware_status_guard.sql
-- Role-aware cancellation status guard in cancel_booking_with_fee.
--
-- ONLY CHANGE vs the 2026-07-10 version: the actor role (v_who) is now computed
-- BEFORE the status guard, and the guard is role-aware:
--   customer        → 'pending' / 'confirmed'  (unchanged)
--   admin / business → also 'no_show'
--   'completed' / 'cancelled' → blocked for EVERYONE (hard safety boundary:
--     reversing a completed/paid booking risks incorrect refunds / points /
--     accounting; use a purpose-built "correct attendance" flow instead).
--
-- Everything else (fee calc, points reversal, notifications, waitlist, exception
-- handling) is byte-for-byte identical to the 2026-07-10 version.
--
-- Callers traced (all safe): cancel_booking_safe (unused wrapper, passthrough);
--   owner.controller (gains no_show per decision; fetchBookingForOwner doesn't
--   filter by status); booking.controller/admin.controller after STEP 3.
--
-- Backup: ahgiz-backups/cancel_booking_with_fee_20260710_233427_pre_roleaware_status.sql

BEGIN;

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

  -- تحديد من يُلغي — يُحسب قبل حارس الحالة (الحارس صار مدرِكاً للدور)
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

  -- حارس الحالة المدرِك للدور:
  --   الزبون: pending/confirmed فقط
  --   الأدمن/المالك: pending/confirmed/no_show
  --   completed/cancelled: محجوب للجميع (حد أمان صلب — لا عكس لحجز مكتمل/مدفوع)
  IF v_booking.status NOT IN ('pending', 'confirmed', 'no_show')
     OR (v_booking.status = 'no_show' AND v_who = 'customer') THEN
    RETURN jsonb_build_object(
      'success', FALSE, 'code', 'INVALID_STATUS',
      'message', 'لا يمكن إلغاء حجز بحالة: ' || v_booking.status
    );
  END IF;

  -- رسوم الإلغاء — على الزبون فقط (غير متأثّر بالتغيير)
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

  -- ── عكس نقاط الولاء ─────────────────────────────────────────────
  IF COALESCE(v_booking.points_redeemed, 0) > 0 THEN
    INSERT INTO points_transactions
      (customer_id, booking_id, type, points, points_category, expires_at, note)
    VALUES (v_booking.customer_id, p_booking_id, 'redemption_refund',
      v_booking.points_redeemed, 'general', NOW() + INTERVAL '6 months',
      'استرجاع نقاط مستردَّة عند إلغاء الحجز #' || LEFT(p_booking_id::TEXT, 8));
  END IF;
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

  -- استرداد ZainCash تلقائياً
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

  INSERT INTO notifications (user_id, type, message, booking_id)
  VALUES (
    CASE WHEN v_who = 'customer' THEN
      (SELECT owner_id FROM businesses WHERE id = v_booking.business_id)
    ELSE v_booking.customer_id END,
    'booking_cancelled',
    'تم إلغاء الحجز' || E'\n' || v_message,
    p_booking_id
  );

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

COMMIT;

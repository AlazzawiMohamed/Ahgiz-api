-- 2026-06-22 — Fix create_asiahawala_booking_payment notification INSERT.
-- Bug: the RPC inserted notifications(title, body) — columns that don't exist
-- (real column is `message`) and used a type not allowed by notifications_type_check,
-- so every call hit the EXCEPTION block and returned INTERNAL_ERROR.
-- Fix: (1) allow the new notification type, (2) insert using the real schema.

-- (1) Allow the asiahawala instructions notification type
ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type = ANY (ARRAY[
  'booking_confirmed','booking_reminder_24h','booking_reminder_2h','booking_cancelled',
  'waitlist_available','rebooking_reminder','review_request','receipt','meeting_link',
  'new_booking','booking_cancelled_by_customer','daily_summary','no_show_alert',
  'attendance_confirmation_required','grace_period_started','reschedule_requested',
  'reschedule_approved','reschedule_rejected','account_recovery_approved',
  'account_recovery_rejected','asiahawala_payment_instructions'
]));

-- (2) Recreate the RPC with a corrected notification INSERT (logic unchanged)
CREATE OR REPLACE FUNCTION public.create_asiahawala_booking_payment(p_booking_id uuid, p_customer_id uuid, p_amount integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_booking        RECORD;
  v_customer_phone TEXT;
  v_transaction_id UUID;
  v_platform_phone TEXT;
  v_expiry_hours   INTEGER;
  v_expires_at     TIMESTAMPTZ;
  v_enabled        TEXT;
BEGIN
  SELECT COALESCE(value, 'true') INTO v_enabled
  FROM platform_settings WHERE key = 'asiahawala_enabled';

  IF v_enabled = 'false' THEN
    RETURN jsonb_build_object('success', FALSE, 'code', 'PAYMENT_DISABLED',
      'message', 'طريقة دفع AsiaHawala غير متاحة حالياً');
  END IF;

  SELECT * INTO v_booking FROM bookings WHERE id = p_booking_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', FALSE, 'code', 'NOT_FOUND');
  END IF;

  IF v_booking.customer_id != p_customer_id THEN
    RETURN jsonb_build_object('success', FALSE, 'code', 'UNAUTHORIZED');
  END IF;

  IF v_booking.status != 'pending' THEN
    RETURN jsonb_build_object('success', FALSE, 'code', 'INVALID_STATUS',
      'message', 'الحجز ليس في حالة انتظار');
  END IF;

  SELECT COALESCE(phone, 'غير محدد') INTO v_customer_phone
  FROM users WHERE id = p_customer_id;

  IF v_customer_phone = 'غير محدد' THEN
    PERFORM log_and_raise('create_asiahawala_booking_payment_no_phone',
      jsonb_build_object('customer_id', p_customer_id, 'booking_id', p_booking_id));
  END IF;

  IF EXISTS (
    SELECT 1 FROM asiahawala_transactions
    WHERE booking_id = p_booking_id AND status = 'pending_confirmation'
  ) THEN
    RETURN jsonb_build_object('success', FALSE, 'code', 'DUPLICATE_PAYMENT',
      'message', 'يوجد طلب حوالة معلق لهذا الحجز');
  END IF;

  SELECT COALESCE(value, '0771XXXXXXX') INTO v_platform_phone
  FROM platform_settings WHERE key = 'asiahawala_receiver_phone';

  SELECT COALESCE(value::INTEGER, 24) INTO v_expiry_hours
  FROM platform_settings WHERE key = 'asiahawala_payment_expiry_hours';

  v_expires_at := NOW() + (v_expiry_hours || ' hours')::INTERVAL;

  INSERT INTO asiahawala_transactions (
    booking_id, business_id, user_id, transaction_type,
    amount, fees, sender_phone, receiver_phone,
    status, description, metadata
  ) VALUES (
    p_booking_id, v_booking.business_id, p_customer_id, 'booking_payment',
    p_amount, 0, v_customer_phone, v_platform_phone,
    'pending_confirmation',
    'دفع حجز #' || LEFT(p_booking_id::TEXT, 8),
    jsonb_build_object('expires_at', v_expires_at,
      'booking_date', v_booking.booking_date, 'booking_start', v_booking.start_time)
  )
  RETURNING id INTO v_transaction_id;

  UPDATE bookings SET
    asiahawala_transaction_id = v_transaction_id,
    payment_method            = 'asiahawala',
    payment_status            = 'pending',
    updated_at                = NOW()
  WHERE id = p_booking_id;

  -- FIXED: notifications uses `message` (no title/body); type now allowed
  INSERT INTO notifications (user_id, booking_id, type, channel, message, status, scheduled_at)
  VALUES (
    p_customer_id, p_booking_id, 'asiahawala_payment_instructions', 'whatsapp',
    'تعليمات دفع AsiaHawala: أرسل ' || p_amount || ' دينار إلى ' || v_platform_phone ||
    '. المرجع: ' || LEFT(v_transaction_id::TEXT, 8) || '. المهلة: ' || v_expiry_hours || ' ساعة.',
    'pending', NOW()
  );

  RETURN jsonb_build_object(
    'success', TRUE,
    'transaction_id', v_transaction_id,
    'receiver_phone', v_platform_phone,
    'amount', p_amount,
    'expires_at', v_expires_at,
    'reference', LEFT(v_transaction_id::TEXT, 8),
    'instructions', 'أرسل ' || p_amount || ' دينار إلى ' || v_platform_phone
  );

EXCEPTION WHEN OTHERS THEN
  PERFORM log_and_raise('create_asiahawala_booking_payment',
    jsonb_build_object('booking_id', p_booking_id, 'error', SQLERRM));
  RETURN jsonb_build_object('success', FALSE, 'code', 'INTERNAL_ERROR');
END;
$function$;

NOTIFY pgrst, 'reload schema';

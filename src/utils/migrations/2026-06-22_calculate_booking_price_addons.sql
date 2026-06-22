-- 2026-06-22 — calculate_booking_price: support optional add-ons.
-- final_price now = base service price + urgent surcharge + sum of valid add-ons.
-- Add-ons are services flagged is_addon=true belonging to the SAME business, active.
-- Adds p_selected_addons uuid[] (default '{}') and an addons_total return column.

DROP FUNCTION IF EXISTS public.calculate_booking_price(uuid, date);

CREATE OR REPLACE FUNCTION public.calculate_booking_price(
  p_service_id uuid,
  p_booking_date date,
  p_selected_addons uuid[] DEFAULT '{}'
)
 RETURNS TABLE(base_price integer, urgent_surcharge integer, addons_total integer, final_price integer, is_urgent boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_service RECORD;
  v_surcharge INTEGER;
  v_addons INTEGER;
BEGIN
  SELECT price, urgent_surcharge_pct, business_id
    INTO v_service FROM services WHERE id = p_service_id;
  IF NOT FOUND THEN RETURN; END IF;

  v_surcharge := 0;
  IF p_booking_date = CURRENT_DATE AND v_service.urgent_surcharge_pct > 0 THEN
    v_surcharge := ROUND(v_service.price * v_service.urgent_surcharge_pct / 100)::INTEGER;
  END IF;

  -- Sum valid add-ons: same business, flagged is_addon, active
  SELECT COALESCE(SUM(price), 0)::INTEGER INTO v_addons
  FROM services
  WHERE id = ANY(p_selected_addons)
    AND business_id = v_service.business_id
    AND is_addon = true
    AND is_active = true;

  RETURN QUERY SELECT
    v_service.price::INTEGER,
    v_surcharge,
    v_addons,
    (v_service.price + v_surcharge + v_addons)::INTEGER,
    (p_booking_date = CURRENT_DATE AND v_surcharge > 0);

EXCEPTION WHEN OTHERS THEN
  PERFORM log_and_raise('calculate_booking_price',
    jsonb_build_object('service_id', p_service_id, 'error', SQLERRM));
  RETURN;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.calculate_booking_price(uuid, date, uuid[]) TO PUBLIC;

NOTIFY pgrst, 'reload schema';

-- 2026-06-26 — [FIX-19] demo data: 3 medical clinics + 3 law offices.
-- Spread across Baghdad / Erbil / Basra so province + category filters have data
-- and the medical/legal categories aren't empty on Home & Search.
-- Idempotent: owners/businesses upsert by id; child rows are wiped + reinserted.

BEGIN;

-- ── Owners (role=business; display only, not meant to log in) ─────────────────
INSERT INTO users (id, role, full_name, phone, is_active) VALUES
  ('d0000001-0000-0000-0000-000000000001','business','د. أحمد الراوي',     '07700000001', true),
  ('d0000002-0000-0000-0000-000000000002','business','د. شيرين عبدالله',   '07700000002', true),
  ('d0000003-0000-0000-0000-000000000003','business','د. مصطفى العلي',     '07700000003', true),
  ('d0000004-0000-0000-0000-000000000004','business','المحامي عمر الجبوري', '07700000004', true),
  ('d0000005-0000-0000-0000-000000000005','business','المحامية لمى حسن',    '07700000005', true),
  ('d0000006-0000-0000-0000-000000000006','business','المحامي كاروان أحمد', '07700000006', true)
ON CONFLICT (id) DO NOTHING;

-- ── Businesses ───────────────────────────────────────────────────────────────
-- category ids: medical 6e4f8f4c-..., legal f19164ab-...
INSERT INTO businesses (
  id, owner_id, category_id, name, description, specialty, phone, whatsapp,
  address, province, logo_url, is_active, is_verified, is_featured, is_frozen,
  approval_status, current_plan_code, rating_avg, rating_count, setup_completed
) VALUES
  -- Medical
  ('b0000001-0000-0000-0000-000000000001','d0000001-0000-0000-0000-000000000001','6e4f8f4c-2a1f-4516-9323-618576f72b71',
   'عيادة الشفاء التخصصية','عيادة باطنية وجلدية في قلب بغداد بأحدث الأجهزة وكادر متخصص.','باطنية وجلدية',
   '07700000001','07700000001','شارع الكندي، الحارثية، بغداد','baghdad',
   'https://ui-avatars.com/api/?name=Shifa+Clinic&background=0D8ABC&color=fff&size=256',
   true,true,true,false,'approved','pro',4.70,86,true),
  ('b0000002-0000-0000-0000-000000000002','d0000002-0000-0000-0000-000000000002','6e4f8f4c-2a1f-4516-9323-618576f72b71',
   'مركز هاوكاري الطبي','مركز أسنان وتجميل في أربيل يقدم خدمات شاملة بإشراف اختصاصيين.','أسنان وتجميل',
   '07700000002','07700000002','شارع ٦٠ متري، أربيل','erbil',
   'https://ui-avatars.com/api/?name=Hawkari+Medical&background=16A085&color=fff&size=256',
   true,true,false,false,'approved','pro',4.90,124,true),
  ('b0000003-0000-0000-0000-000000000003','d0000003-0000-0000-0000-000000000003','6e4f8f4c-2a1f-4516-9323-618576f72b71',
   'عيادة النخبة للأطفال','عيادة طب أطفال في البصرة مع متابعة دورية ولقاحات.','طب أطفال',
   '07700000003','07700000003','شارع الاستقلال، البصرة','basra',
   'https://ui-avatars.com/api/?name=Nukhba+Pediatrics&background=C0392B&color=fff&size=256',
   true,true,false,false,'approved','free',4.50,52,true),
  -- Legal
  ('c0000001-0000-0000-0000-000000000001','d0000004-0000-0000-0000-000000000004','f19164ab-d629-48ac-8c8f-28d251db1596',
   'مكتب العدالة للمحاماة','مكتب محاماة متخصص بالقضايا المدنية والتجارية في بغداد.','مدني وتجاري',
   '07700000004','07700000004','شارع المتنبي، بغداد','baghdad',
   'https://ui-avatars.com/api/?name=Adala+Law&background=34495E&color=fff&size=256',
   true,true,true,false,'approved','pro',4.60,73,true),
  ('c0000002-0000-0000-0000-000000000002','d0000005-0000-0000-0000-000000000005','f19164ab-d629-48ac-8c8f-28d251db1596',
   'مكتب الحقوق للاستشارات','استشارات قانونية وأحوال شخصية في أربيل بسرية تامة.','أحوال شخصية',
   '07700000005','07700000005','شارع گولان، أربيل','erbil',
   'https://ui-avatars.com/api/?name=Huquq+Legal&background=8E44AD&color=fff&size=256',
   true,true,false,false,'approved','free',4.40,41,true),
  ('c0000003-0000-0000-0000-000000000003','d0000006-0000-0000-0000-000000000006','f19164ab-d629-48ac-8c8f-28d251db1596',
   'مكتب البصرة للمحاماة','محاماة عقارية وقضايا عمالية في البصرة بخبرة طويلة.','عقاري وعمالي',
   '07700000006','07700000006','شارع الكورنيش، البصرة','basra',
   'https://ui-avatars.com/api/?name=Basra+Law&background=D35400&color=fff&size=256',
   true,true,false,false,'approved','free',4.30,38,true)
ON CONFLICT (id) DO UPDATE SET
  name=EXCLUDED.name, description=EXCLUDED.description, specialty=EXCLUDED.specialty,
  province=EXCLUDED.province, logo_url=EXCLUDED.logo_url, category_id=EXCLUDED.category_id,
  is_active=true, approval_status='approved', is_frozen=false,
  rating_avg=EXCLUDED.rating_avg, rating_count=EXCLUDED.rating_count;

-- Refresh child rows for these 6 businesses (so re-running stays consistent)
DELETE FROM services      WHERE business_id IN ('b0000001-0000-0000-0000-000000000001','b0000002-0000-0000-0000-000000000002','b0000003-0000-0000-0000-000000000003','c0000001-0000-0000-0000-000000000001','c0000002-0000-0000-0000-000000000002','c0000003-0000-0000-0000-000000000003');
DELETE FROM staff         WHERE business_id IN ('b0000001-0000-0000-0000-000000000001','b0000002-0000-0000-0000-000000000002','b0000003-0000-0000-0000-000000000003','c0000001-0000-0000-0000-000000000001','c0000002-0000-0000-0000-000000000002','c0000003-0000-0000-0000-000000000003');
DELETE FROM working_hours WHERE business_id IN ('b0000001-0000-0000-0000-000000000001','b0000002-0000-0000-0000-000000000002','b0000003-0000-0000-0000-000000000003','c0000001-0000-0000-0000-000000000001','c0000002-0000-0000-0000-000000000002','c0000003-0000-0000-0000-000000000003');

-- ── Services (2–3 per business) ──────────────────────────────────────────────
INSERT INTO services (id, business_id, name, duration, price, is_active, is_addon, sort_order)
VALUES
  (gen_random_uuid(),'b0000001-0000-0000-0000-000000000001','استشارة باطنية',30,25000,true,false,1),
  (gen_random_uuid(),'b0000001-0000-0000-0000-000000000001','فحص جلدية',20,20000,true,false,2),
  (gen_random_uuid(),'b0000002-0000-0000-0000-000000000002','تنظيف أسنان',45,40000,true,false,1),
  (gen_random_uuid(),'b0000002-0000-0000-0000-000000000002','تبييض أسنان',60,120000,true,false,2),
  (gen_random_uuid(),'b0000002-0000-0000-0000-000000000002','حشوة تجميلية',40,35000,true,false,3),
  (gen_random_uuid(),'b0000003-0000-0000-0000-000000000003','فحص طفل دوري',30,20000,true,false,1),
  (gen_random_uuid(),'b0000003-0000-0000-0000-000000000003','لقاح',15,15000,true,false,2),
  (gen_random_uuid(),'c0000001-0000-0000-0000-000000000001','استشارة قانونية',30,30000,true,false,1),
  (gen_random_uuid(),'c0000001-0000-0000-0000-000000000001','صياغة عقد',60,75000,true,false,2),
  (gen_random_uuid(),'c0000002-0000-0000-0000-000000000002','استشارة أحوال شخصية',30,30000,true,false,1),
  (gen_random_uuid(),'c0000002-0000-0000-0000-000000000002','توكيل قضية',45,90000,true,false,2),
  (gen_random_uuid(),'c0000003-0000-0000-0000-000000000003','استشارة عقارية',30,30000,true,false,1),
  (gen_random_uuid(),'c0000003-0000-0000-0000-000000000003','متابعة قضية عمالية',60,80000,true,false,2);

-- ── Staff (1–2 per business) ─────────────────────────────────────────────────
INSERT INTO staff (id, business_id, name, bio, is_active, sort_order, rating_avg, rating_count)
VALUES
  (gen_random_uuid(),'b0000001-0000-0000-0000-000000000001','د. أحمد الراوي','اختصاص باطنية، خبرة 12 سنة',true,1,4.7,60),
  (gen_random_uuid(),'b0000001-0000-0000-0000-000000000001','د. سارة منير','اختصاص جلدية',true,2,4.6,26),
  (gen_random_uuid(),'b0000002-0000-0000-0000-000000000002','د. شيرين عبدالله','اختصاص أسنان تجميلي',true,1,4.9,124),
  (gen_random_uuid(),'b0000003-0000-0000-0000-000000000003','د. مصطفى العلي','اختصاص طب أطفال',true,1,4.5,52),
  (gen_random_uuid(),'c0000001-0000-0000-0000-000000000001','المحامي عمر الجبوري','قانون مدني وتجاري',true,1,4.6,73),
  (gen_random_uuid(),'c0000002-0000-0000-0000-000000000002','المحامية لمى حسن','أحوال شخصية',true,1,4.4,41),
  (gen_random_uuid(),'c0000003-0000-0000-0000-000000000003','المحامي كاروان أحمد','عقاري وعمالي',true,1,4.3,38);

-- ── Working hours: Sat–Thu open, Friday(5) closed ───────────────────────────
-- day_of_week: 0=Sun … 5=Fri … 6=Sat
INSERT INTO working_hours (id, business_id, day_of_week, is_open, open_time, close_time, start_time, end_time, is_closed, is_active)
SELECT gen_random_uuid(), b.id, d.dow,
       d.dow <> 5,
       CASE WHEN d.dow = 5 THEN NULL ELSE t.open END,
       CASE WHEN d.dow = 5 THEN NULL ELSE t.close END,
       CASE WHEN d.dow = 5 THEN NULL ELSE t.open END,
       CASE WHEN d.dow = 5 THEN NULL ELSE t.close END,
       d.dow = 5,
       true
FROM (VALUES
  ('b0000001-0000-0000-0000-000000000001'::uuid,'09:00'::time,'17:00'::time),
  ('b0000002-0000-0000-0000-000000000002'::uuid,'09:00','17:00'),
  ('b0000003-0000-0000-0000-000000000003'::uuid,'09:00','17:00'),
  ('c0000001-0000-0000-0000-000000000001'::uuid,'10:00','18:00'),
  ('c0000002-0000-0000-0000-000000000002'::uuid,'10:00','18:00'),
  ('c0000003-0000-0000-0000-000000000003'::uuid,'10:00','18:00')
) AS b(id, open, close)
CROSS JOIN (VALUES (0),(1),(2),(3),(4),(5),(6)) AS d(dow)
CROSS JOIN LATERAL (SELECT b.open AS open, b.close AS close) AS t;

COMMIT;

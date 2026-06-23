-- Sprint 4 — منح صلاحيات الجداول الطبية/القانونية لأدوار PostgREST
-- ahgiz-migration-medlegal.sql أنشأ الجداول وفعّل RLS لكنه لم يمنح صلاحيات الجدول،
-- فكان service_role يحصل على "permission denied". هذا الملف يكمل المنح. آمن وقابل للعكس (REVOKE).
-- طبّقه بعد ahgiz-migration-medlegal.sql.

-- service_role: يتجاوز RLS — يستخدمه خادم الـ API (supabaseAdmin).
GRANT SELECT, INSERT, UPDATE, DELETE
  ON medical_records, user_files, record_access_grants
  TO service_role;

-- authenticated: الوصول المباشر من العميل محكوم بسياسات RLS المعرّفة في migration الطبي.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON medical_records, user_files, record_access_grants
  TO authenticated;

-- ملاحظة: لا تُمنح anon أي صلاحية على البيانات الطبية/القانونية إطلاقاً.

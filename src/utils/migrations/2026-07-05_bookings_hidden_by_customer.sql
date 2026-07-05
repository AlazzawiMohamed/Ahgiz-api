-- إخفاء الحجوزات السابقة من قائمة العميل دون حذف البيانات (soft-hide)
-- ملاحظة: طُبّق مباشرة على قاعدة البيانات في 2026-07-05 — هذا الملف للتوثيق.
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS hidden_by_customer_at TIMESTAMPTZ DEFAULT NULL;

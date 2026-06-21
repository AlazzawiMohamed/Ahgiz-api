# احجز API — توثيق الـ Endpoints

**Base URL:** `https://your-domain.railway.app/api/v1`  
**Authentication:** `Authorization: Bearer <access_token>`  
**Response Format:** `{ "status": "success"|"error", "data": ..., "message": "..." }`

---

## المصادقة — Auth

### `POST /auth/send-otp`
إرسال رمز OTP عبر واتساب.  
**Body:** `{ "phone": "07XXXXXXXXX" }`  
**Returns:** `{ message: "..." }` — 200  
**Errors:** 400 (رقم غير صالح), 429 (rate limit)

### `POST /auth/verify-otp`
التحقق من OTP وإصدار tokens.  
**Body:** `{ "phone": "07XXXXXXXXX", "otp": "123456" }`  
**Returns:** `{ access_token, refresh_token, user }` — 200  
**Errors:** 400 (OTP خاطئ/منتهي), 429 (محظور مؤقتاً)

### `POST /auth/refresh`
تجديد access token باستخدام refresh token.  
**Body:** `{ "refresh_token": "..." }`  
**Returns:** `{ access_token, refresh_token }` — 200  
**Errors:** 401 (token منتهي/ملغي)

### `POST /auth/logout`
🔒 تسجيل الخروج وإلغاء refresh token.  
**Body:** `{ "refresh_token": "..." }`  
**Returns:** 200

### `GET /auth/me`
🔒 بيانات المستخدم الحالي.  
**Returns:** `{ id, full_name, phone, role, avatar_url }` — 200

---

## المستخدم — Users

> جميع routes تحتاج JWT.

### `GET /users/profile`
🔒 الملف الشخصي.  
**Returns:** `{ id, full_name, phone, email, role, province, avatar_url }` — 200

### `PUT /users/profile`
🔒 تحديث الملف الشخصي.  
**Body:** `{ full_name?, email?, province? }`  
**Returns:** updated user — 200  
**Errors:** 400 (لا توجد حقول صالحة)

### `PUT /users/profile/avatar`
🔒 تحديث الصورة الشخصية (multipart/form-data).  
**Body:** `avatar` (file)  
**Returns:** `{ id, avatar_url }` — 200

### `GET /users/bookings`
🔒 حجوزاتي مع pagination.  
**Query:** `status?, page?, limit?`  
**Returns:** `{ bookings[], total, page, limit }` — 200

---

## الفئات والمحافظات — Catalogue

### `GET /categories`
قائمة الفئات النشطة.  
**Returns:** `[{ id, slug, name_ar, name_en, icon_url, businesses_count }]` — 200

### `GET /governorates`
قائمة المحافظات العراقية.  
**Returns:** `[{ id, slug, name_ar, name_en, latitude, longitude }]` — 200

---

## المحلات — Businesses

### `GET /businesses`
قائمة المحلات المعتمدة مع فلترة.  
**Query:** `q?, category? (slug), province?, rating_min?, plan?, page?, limit?`  
**Returns:** `{ businesses[], total, page, limit }` — 200

### `GET /businesses/:id`
تفاصيل محل واحد.  
**Returns:** `{ id, name, description, phone, rating_avg, categories, working_hours[] }` — 200  
**Errors:** 404

### `GET /businesses/:id/services`
خدمات المحل.  
**Returns:** `[{ id, name, duration, price, buffer_minutes }]` — 200

### `GET /businesses/:id/staff`
موظفو المحل.  
**Returns:** `[{ id, name, photo_url, bio, rating_avg }]` — 200

### `GET /businesses/:id/availability`
المواعيد المتاحة ليوم محدد.  
**Query:** `date (YYYY-MM-DD) *, service_id *, staff_id?, slot_interval? (default: 30)`  
**Returns:** `{ date, service_id, staff_id, duration, slots[], total }` — 200  
**Errors:** 400 (date/service_id مطلوب), 404 (خدمة غير موجودة)

---

## الحجوزات — Bookings

### `POST /bookings`
🔒 إنشاء حجز جديد.  
**Body:**
```json
{
  "business_id": "uuid",
  "service_id": "uuid",
  "booking_date": "YYYY-MM-DD",
  "start_time": "HH:MM:SS",
  "staff_id": "uuid (optional)",
  "payment_method": "cash|points|zaincash|asiahawala",
  "booking_type": "in_person|online",
  "customer_note": "string (optional)"
}
```
**Returns:** booking object — 201  
**Errors:** 400 (validation), 404 (خدمة غير موجودة), 409 (تعارض وقت)

### `GET /bookings/:id`
🔒 تفاصيل حجز.  
**Returns:** booking with services, businesses, staff — 200  
**Errors:** 403 (ليس حجزك), 404

### `PUT /bookings/:id/cancel`
🔒 إلغاء حجز.  
**Body:** `{ reason?: string }`  
**Returns:** updated booking — 200  
**Errors:** 400 (لا يمكن إلغاء), 403, 404

---

## التقييمات — Reviews

### `GET /reviews/business/:id`
تقييمات محل (عام).  
**Query:** `page?, limit?`  
**Returns:** `{ reviews[], total, page, limit }` — 200

### `POST /reviews`
🔒 إضافة تقييم (يتطلب حجز مكتمل).  
**Body:**
```json
{
  "booking_id": "uuid",
  "business_rating": 1-5,
  "business_comment": "string (optional)",
  "staff_id": "uuid (optional)",
  "staff_rating": 1-5 (optional)
}
```
**Returns:** `{ review_id }` — 201  
**Errors:** 400 (validation), 404 (لا يوجد حجز مكتمل)

---

## الإشعارات — Notifications

### `POST /notifications/send`
🔒👑 (admin فقط) إرسال إشعار لمستخدم.  
**Body:**
```json
{
  "user_id": "uuid",
  "type": "booking_confirmed|review_request|...",
  "message": "string",
  "channel": "in_app|whatsapp|push|both (default: in_app)",
  "priority": "critical|high|normal|low (default: normal)",
  "booking_id": "uuid (optional)",
  "scheduled_at": "ISO timestamp (optional)"
}
```
**Returns:** notification — 201

### `GET /notifications`
🔒 إشعاراتي (in_app + both فقط).  
**Query:** `unread? (true/false), page?, limit?`  
**Returns:** `{ notifications[], unread_count, total, page, limit }` — 200

### `PUT /notifications/read-all`
🔒 تحديد كل الإشعارات كمقروءة.  
**Returns:** `{ updated: count }` — 200

### `PUT /notifications/:id/read`
🔒 تحديد إشعار واحد كمقروء (idempotent).  
**Returns:** `{ id, read_at }` — 200  
**Errors:** 403, 404

---

## المفضلة — Favorites

### `GET /favorites`
🔒 قائمة المفضلة مع بيانات المحل.  
**Query:** `page?, limit?`  
**Returns:** `{ favorites[], total, page, limit }` — 200

### `POST /favorites/:business_id`
🔒 إضافة محل للمفضلة.  
**Returns:** `{ id, business_id }` — 201  
**Errors:** 404 (محل غير موجود), 409 (مضاف مسبقاً)

### `DELETE /favorites/:business_id`
🔒 حذف محل من المفضلة.  
**Returns:** 200  
**Errors:** 404 (غير موجود في المفضلة)

---

## البحث — Search

### `GET /search`
بحث في المحلات (عام — يتطلب فلتر واحد على الأقل).  
**Query:** `q?, province?, category? (slug), rating_min?, page?, limit?`  
**Returns:** `{ query, results[], total, page, limit }` — 200  
**Errors:** 400 (لا فلتر), 404 (category غير موجودة)

---

## لوحة صاحب المحل — Owner Panel

> جميع routes: `role=business` + امتلاك محل  
> للمالك بأكثر من محل: أضف `?business_id=uuid`

### `GET /owner/dashboard`
🔒💼 إحصائيات اليوم.  
**Returns:**
```json
{
  "business": { "id", "name" },
  "today": { "date", "total", "pending", "confirmed", "completed", "cancelled", "no_show", "revenue" },
  "today_bookings": [...],
  "upcoming": [...],
  "staff_count": 3,
  "pending_total": 5
}
```

### `GET /owner/bookings`
🔒💼 حجوزات المحل مع بيانات العميل.  
**Query:** `date?, status?, staff_id?, page?, limit?`  
**Returns:** `{ bookings[], total, page, limit }` — 200

### `PUT /owner/bookings/:id/confirm`
🔒💼 تأكيد حجز (pending → confirmed).  
**Errors:** 400 (الحجز ليس pending), 404

### `PUT /owner/bookings/:id/complete`
🔒💼 إتمام حجز (confirmed → completed).  
**Errors:** 400 (الحجز ليس confirmed), 404

### `PUT /owner/bookings/:id/no-show`
🔒💼 تسجيل غياب (pending|confirmed → no_show).  
**Errors:** 400 (الحجز مكتمل/ملغي), 404

### `GET /owner/staff`
🔒💼 إدارة الموظفين (كل الحالات).  
**Returns:** `[{ id, name, is_active, sort_order, rating_avg }]` — 200

### `PUT /owner/business`
🔒💼 تحديث بيانات المحل.  
**Body (أي من هذه الحقول):**  
`name, description, bio, specialty, phone, whatsapp, address, province, maps_url,`  
`instagram_url, tiktok_url, facebook_url, booking_confirmation (auto|manual),`  
`cancellation_hours, min_booking_gap, prep_time_minutes, no_last_minute,`  
`last_minute_hours, overtime_allowed, waitlist_enabled`  
**Errors:** 400 (لا حقول صالحة / booking_confirmation غير صالح)

---

## لوحة الأدمن — Admin Panel

> جميع routes: `role=admin`

### `GET /admin/dashboard`
🔒👑 إحصائيات المنصة.  
**Returns:**
```json
{
  "stats": {
    "total_users", "active_businesses", "pending_approvals",
    "total_bookings", "today_bookings", "total_revenue"
  },
  "recent_users": [...],
  "pending_businesses": [...]
}
```

### `GET /admin/users`
🔒👑 قائمة المستخدمين.  
**Query:** `role?, is_active?, is_banned?, q?, page?, limit?`  
**Returns:** `{ users[], total, page, limit }` — 200

### `GET /admin/businesses`
🔒👑 كل المحلات (بما فيها غير المعتمدة).  
**Query:** `approval_status?, is_active?, q?, page?, limit?`  
**Returns:** `{ businesses[], total, page, limit }` — 200  
**Business fields:** `id, name, approval_status, is_active, is_frozen, owner, categories`

### `PUT /admin/businesses/:id/approve`
🔒👑 الموافقة على محل.  
**Returns:** `{ id, name, approval_status, is_active, approved_at }` — 200  
**Errors:** 400 (موافق مسبقاً), 404

### `PUT /admin/businesses/:id/suspend`
🔒👑 تعليق محل.  
**Body:** `{ reason: string }`  
**Returns:** `{ id, name, approval_status, is_frozen, freeze_reason }` — 200  
**Errors:** 400 (معلق مسبقاً / reason مطلوب), 404

---

## نظام الأخطاء — Error Codes

| HTTP | المعنى |
|------|---------|
| 400  | بيانات غير صالحة أو مفقودة |
| 401  | يجب تسجيل الدخول |
| 403  | لا تملك الصلاحية |
| 404  | المورد غير موجود |
| 409  | تعارض (تكرار أو تعارض وقت) |
| 429  | طلبات كثيرة جداً (100/15min في production) |
| 500  | خطأ داخلي في الخادم |

---

## القيود — Rate Limits

| البيئة | الحد |
|--------|------|
| Production | 100 طلب / 15 دقيقة |
| Development | 1000 طلب / 15 دقيقة |
| OTP endpoint | 10 طلبات / ساعة لكل رقم |

---

## Booking Status Flow

```
pending ──[owner confirm]──► confirmed ──[owner complete]──► completed
   │                              │
   └──[cancel]──► cancelled       └──[no-show]──► no_show
   └──[no-show]──► no_show
```

## Notification Types

`booking_confirmed` · `booking_reminder_24h` · `booking_reminder_2h` · `booking_cancelled` ·  
`waitlist_available` · `rebooking_reminder` · `review_request` · `receipt` · `meeting_link` ·  
`new_booking` · `booking_cancelled_by_customer` · `daily_summary` · `no_show_alert` ·  
`attendance_confirmation_required` · `grace_period_started` · `reschedule_requested` ·  
`reschedule_approved` · `reschedule_rejected` · `account_recovery_approved` · `account_recovery_rejected`

---

*🔒 = يتطلب JWT · 💼 = يتطلب role=business · 👑 = يتطلب role=admin*

# ahgiz-api — Knowledge Index

**Last verified:** 2026-07-20

> A truthful mirror of the CURRENT repo — where everything is, and the traps that
> reading code won't reveal. Update this file (and the date above) in the same commit
> whenever a file is added/moved/renamed/deleted or a documented convention changes.
> Run `scripts/verify-index.sh` before committing. History and live status live in the
> Claude project memory, not here.

## What this repo is

Node/Express REST API for the احجز booking app (customer + business owner). Data lives in
Supabase (Postgres + Storage); the API is the only writer, always via the service-role
key. Deployed on Railway as two processes — `web` (the API) and `worker` (cron + queue).
The mobile app and the admin panel are its only clients.

## Paths & commands that actually work

- **Run locally:** `npm run dev` (nodemon) or `npm start`. Two processes exist (see
  `Procfile`): web = `src/app.js`, worker = `src/worker.js`.
- **Deploy:** `railway up --service divine-creativity`. This ships the **entire working
  tree** (including uncommitted files), not just committed changes. A GitHub remote
  exists (`AlazzawiMohamed/Ahgiz-api`) but is **not** the deploy path — do not rely on
  auto-deploy.
- **Migrations:** applied **manually** in the Supabase SQL Editor. A file in
  `src/utils/migrations/` existing does **not** mean it was applied.
- **New `public` DB function:** its migration MUST end with the `REVOKE`/`GRANT` pair —
  see `CLAUDE.md` (non-negotiable; anon exposure otherwise).
- **FAILED — don't retry:** a direct `psql` / `DATABASE_URL` connection no longer
  authenticates. Do DB work through PostgREST (supabase-js) with the service-role key.
  *(operational knowledge — from project memory)*
- **Layer-3 migration ordering:** apply `src/utils/migrations/ahgiz-migration-layer3-security.sql`
  **before** the `railway up` that ships the code reading its new columns.

## Where content actually comes from

| Content | Source |
|---|---|
| API response messages (user-visible) | **Hardcoded** in controllers (currently Arabic; ~25 files carry `TODO(i18n)` markers). No locale system yet. |
| Categories, plans, businesses, services, ads/banners | **Supabase DB tables.** Categories carry `name_ar` / `name_en` / `name_ku` columns. |
| Provinces / governorates | **`governorates` DB table** (`slug` is the canonical stored value). |
| WhatsApp/OTP message text | Built in `src/services/whatsapp.service.js`. |
| Security-alert channel on/off + language | **`platform_settings` DB rows** (`security_alert_telegram_enabled`, `security_alert_slack_enabled`, `admin_alert_language`). |
| Secrets / config | `.env` — Supabase, `DATABASE_URL`, `REDIS_URL`, UltraMsg (WhatsApp), Telegram, Resend (email). Production also sets `TELEGRAM_WEBHOOK_SECRET`, `TRUST_PROXY_HOPS`, `CORS_ORIGIN`. |

## Reference implementations (copy these)

- **Protected route:** `src/routes/booking.routes.js` (`authenticate` + `validate`),
  or `src/routes/owner.routes.js` (adds `authorize('business')` + `requireBusiness`).
- **Request schema:** shared blocks in `src/schemas/common.js`; a create+cancel pair in
  `src/schemas/booking.schema.js`.
- **Cron job (single RPC):** add an entry to the `RPC_JOBS` array in `src/cron/jobs.js`.
- **Security alert (Telegram + Slack):** `src/services/alert.service.js`.
- **Uniform JSON response:** `src/utils/response.js`.
- **Phone normalization (single source of truth):** `src/utils/phone.js`.

## ⚠️ Known traps

- **`src/routes/owner.routes.js` mixes concerns** — imports **both**
  `src/controllers/owner.controller.js` and `src/controllers/medical.controller.js`, and
  one router covers owner bookings + calendar + client notes + medical records/files +
  review replies + staff + business update. Owner medical/business validation lives in
  `src/schemas/owner.schema.js`, not in a medical or business schema.
- **`src/controllers/auth.controller.js` serves two audiences** — customer AND
  business-owner onboarding share one OTP flow (branches on `session_type`). Admin auth
  is separate (`src/controllers/adminAuth.controller.js`, which itself bundles login +
  email verification + 2FA + break-glass).
- **Business & Medical are split domains** — customer browse = `business.*`; owner
  management = `owner.*`. `/medical/*` = `src/controllers/medical.controller.js`; owner
  per-booking records = `src/routes/owner.routes.js` → `src/controllers/medical.controller.js`.
- **Seed UUIDs are shape-valid but NOT RFC-compliant** — a strict `z.string().uuid()`
  rejects them and broke booking creation; `src/schemas/common.js` uses a shape-only
  regex on purpose.
- **Rate limiters depend on `trust proxy`** in `src/app.js`. A wrong hop count collapses
  every per-IP limiter into one shared bucket (a stranger can lock others out).
- **Cron & queue run in the worker only** — nothing in `src/cron/` or `src/queues/`
  executes from `src/app.js`.

---

## THE MAP

### Domains → route · controller · schema (all under `/api/v1`, except telegram)

Mount order is in `src/routes/index.js`; `/admin/auth` is registered before `/admin`.

| Domain | URL prefix | Route | Controller | Schema |
|---|---|---|---|---|
| Auth | `/auth` | `src/routes/auth.routes.js` | `src/controllers/auth.controller.js` | `src/schemas/auth.schema.js` |
| User | `/users` | `src/routes/user.routes.js` | `src/controllers/user.controller.js` | `src/schemas/user.schema.js` |
| Business (browse) | `/businesses` | `src/routes/business.routes.js` | `src/controllers/business.controller.js` | none |
| Booking | `/bookings` | `src/routes/booking.routes.js` | `src/controllers/booking.controller.js` | `src/schemas/booking.schema.js` |
| Service | `/services` | `src/routes/service.routes.js` | `src/controllers/service.controller.js` | `src/schemas/service.schema.js` |
| Payment | `/payments` | `src/routes/payment.routes.js` | `src/controllers/payment.controller.js` | `src/schemas/payment.schema.js` |
| Banner | `/banners` | `src/routes/banner.routes.js` | `src/controllers/banner.controller.js` | none |
| Category | `/categories` | `src/routes/category.routes.js` | `src/controllers/category.controller.js` | none |
| Governorate | `/governorates` | `src/routes/governorate.routes.js` | `src/controllers/governorate.controller.js` | none |
| Review | `/reviews` | `src/routes/review.routes.js` | `src/controllers/review.controller.js` | `src/schemas/review.schema.js` |
| Notification | `/notifications` | `src/routes/notification.routes.js` | `src/controllers/notification.controller.js` | `src/schemas/notification.schema.js` |
| Favorite | `/favorites` | `src/routes/favorite.routes.js` | `src/controllers/favorite.controller.js` | none |
| Loyalty | `/loyalty` | `src/routes/loyalty.routes.js` | `src/controllers/loyalty.controller.js` | none |
| Referral | `/referral` | `src/routes/referral.routes.js` | `src/controllers/referral.controller.js` | none |
| Waitlist | `/waitlist` | `src/routes/waitlist.routes.js` | `src/controllers/waitlist.controller.js` | `src/schemas/waitlist.schema.js` |
| Medical (shared) | `/medical` | `src/routes/medical.routes.js` | `src/controllers/medical.controller.js` | none *(owner writes → `src/schemas/owner.schema.js`)* |
| Search | `/search` | `src/routes/search.routes.js` | `src/controllers/search.controller.js` | none |
| Owner (mgmt) | `/owner` | `src/routes/owner.routes.js` | `src/controllers/owner.controller.js` + `src/controllers/medical.controller.js` | `src/schemas/owner.schema.js` |
| Admin auth | `/admin/auth` | `src/routes/adminAuth.routes.js` | `src/controllers/adminAuth.controller.js` | none |
| Admin panel | `/admin` | `src/routes/admin.routes.js` | `src/controllers/admin.controller.js` | `src/schemas/admin.schema.js` |
| Telegram webhook | `/telegram` *(root)* | `src/routes/telegram.routes.js` | `src/controllers/telegram.controller.js` | none |

### Services (`src/services/`)

| File | Purpose |
|---|---|
| `src/services/availability.service.js` | Compute bookable time slots |
| `src/services/whatsapp.service.js` | Send WhatsApp/OTP via UltraMsg |
| `src/services/email.service.js` | Admin emails via Resend |
| `src/services/telegram.service.js` | Telegram bot API + webhook secret |
| `src/services/alert.service.js` | Security alerts (Telegram + Slack) |
| `src/services/lockdown.service.js` | Admin-login lockdown state |
| `src/services/cron.service.js` | Cron helper |

### Middleware (`src/middleware/`)

| File | Purpose |
|---|---|
| `src/middleware/auth.js` | `authenticate` / `authorize` / `optionalAuth` |
| `src/middleware/validate.js` | Zod body-validation factory |
| `src/middleware/rateLimiter.js` | All rate limiters (global, OTP, admin login/2FA, break-glass) |
| `src/middleware/requireBusiness.js` | Require caller owns a business |
| `src/middleware/upload.js` | Multer upload (incl. medical files) |
| `src/middleware/errorHandler.js` | 404 + global error handler |

### Utils (`src/utils/`)

| File | Purpose |
|---|---|
| `src/utils/phone.js` | Iraqi phone normalization (single source of truth) |
| `src/utils/request.js` | Client IP / user-agent / forwarded-chain helpers |
| `src/utils/response.js` | Uniform success/error envelope |
| `src/utils/config.js` | Boot-time env validation + transport selection |
| `src/utils/supabase.js` | Supabase clients (anon + service-role) |
| `src/utils/logger.js` | Winston logger |
| `src/utils/sentry.js` | Optional Sentry wiring |
| `src/utils/schema.sql` | Reference schema dump (not a migration) |

### Layer-3 security

| Concern | Where |
|---|---|
| Break-glass | `src/routes/adminAuth.routes.js` → `src/controllers/adminAuth.controller.js` |
| Lockdown | `src/services/lockdown.service.js` (toggled from `src/controllers/telegram.controller.js`) |
| Alerts | `src/services/alert.service.js` |
| Rate limiting | `src/middleware/rateLimiter.js` |
| Telegram bot | `src/services/telegram.service.js` + `src/routes/telegram.routes.js` |
| Append-only audit log | `src/utils/migrations/ahgiz-migration-layer3-security.sql` |

### Cron, queue, migrations

- **Cron:** `src/cron/jobs.js` — 13 scheduled jobs (11 single-RPC in the `RPC_JOBS`
  array + `rebooking_reminder` + `purge_due_account_deletions`). Worker-only.
- **Queue:** `src/queues/whatsapp.queue.js` — Bull queue; enqueues in production, sends
  directly without `REDIS_URL`. Worker-only.
- **Migrations:** `src/utils/migrations/` (applied manually — see above).
- **Entry points:** `src/app.js` (web), `src/worker.js` (worker), `index.js` (start shim).

---

## Pointers

- Endpoint request/response shapes: `API-DOCS.md` (same domains as the map above).
- Sibling indexes: the `INDEX.md` files in **ahgiz-mobile** and **ahgiz-admin**.
- Live project state, decisions, and history: the **Claude project memory** (not here).

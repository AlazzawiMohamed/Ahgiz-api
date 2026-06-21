-- ============================================================
-- احجز — Supabase Schema
-- Run this in: Supabase Dashboard → SQL Editor
-- ============================================================

-- Enable UUID extension
create extension if not exists "pgcrypto";

-- ─── Users ───────────────────────────────────────────────────
create table if not exists users (
  id          uuid primary key default gen_random_uuid(),
  phone       text unique not null,
  name        text,
  email       text,
  role        text not null default 'customer'
                check (role in ('customer', 'owner', 'admin')),
  avatar_url  text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists users_phone_idx on users (phone);

-- Auto-update updated_at
create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists users_updated_at on users;
create trigger users_updated_at
  before update on users
  for each row execute function update_updated_at();

-- ─── WhatsApp OTP Sessions ────────────────────────────────────
create table if not exists whatsapp_otp_sessions (
  id           uuid primary key default gen_random_uuid(),
  phone        text not null,
  otp_hash     text not null,
  expires_at   timestamptz not null,
  attempts     int not null default 0,
  is_used      boolean not null default false,
  verified_at  timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists otp_phone_active_idx
  on whatsapp_otp_sessions (phone, is_used, expires_at desc);

-- Auto-cleanup: delete sessions older than 24 hours
-- (Run as a cron job in Supabase or via node-cron)
-- delete from whatsapp_otp_sessions where created_at < now() - interval '24 hours';

-- ─── Businesses ───────────────────────────────────────────────
create table if not exists businesses (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid references users(id) on delete set null,
  name           text not null,
  category       text not null,
  city           text not null,
  address        text,
  phone          text,
  description    text,
  logo_url       text,
  working_hours  jsonb,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists businesses_category_city_idx on businesses (category, city);
create index if not exists businesses_owner_idx on businesses (owner_id);

drop trigger if exists businesses_updated_at on businesses;
create trigger businesses_updated_at
  before update on businesses
  for each row execute function update_updated_at();

-- ─── Services ─────────────────────────────────────────────────
create table if not exists services (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references businesses(id) on delete cascade,
  name         text not null,
  description  text,
  price        numeric(10,2) not null,
  duration     int not null,  -- minutes
  category     text,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);

create index if not exists services_business_idx on services (business_id, is_active);

-- ─── Bookings ─────────────────────────────────────────────────
create table if not exists bookings (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id),
  business_id   uuid not null references businesses(id),
  service_id    uuid not null references services(id),
  booking_date  date not null,
  booking_time  time not null,
  status        text not null default 'pending'
                  check (status in ('pending','confirmed','completed','cancelled')),
  notes         text,
  cancelled_at  timestamptz,
  completed_at  timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists bookings_user_idx on bookings (user_id, status);
create index if not exists bookings_business_slot_idx on bookings (business_id, booking_date, booking_time);

-- ─── Row Level Security ───────────────────────────────────────
alter table users enable row level security;
alter table whatsapp_otp_sessions enable row level security;
alter table businesses enable row level security;
alter table services enable row level security;
alter table bookings enable row level security;

-- Service role bypasses RLS (used by our API server)
-- No extra policies needed for service_role key

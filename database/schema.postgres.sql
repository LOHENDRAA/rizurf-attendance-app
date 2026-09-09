-- ============================================================================
-- Rizurf Attendance App - database (PostgreSQL, self-hosted / VPS)
-- Target: PostgreSQL 14 or newer.
--
--   createdb rizurf_attendance
--   psql -d rizurf_attendance -v ON_ERROR_STOP=1 -f database/schema.postgres.sql
--
-- Then run the GRANTS block at the bottom to create the least-privilege role
-- the app connects as.
-- ============================================================================
--
-- This service owns attendance and leave, nothing else.
--
--   * INTERNS are owned by the Intern Database service (INTERN_DB_URL). This
--     app references an intern by the id that service issues and reads details
--     from its API (SS-13). `intern_id` columns are bare uuids, not FKs.
--
--   * LOGIN is the Rizurf gateway's (SS-24). No password column. `app_identities`
--     is an auto-synced projection of the gateway identity plus this app's role.
--
-- Differences from the Supabase build: no `storage.buckets` (files go on disk /
-- object store; the table holds the path), and no row-level security (access is
-- the DB role the app connects as - see GRANTS).
-- ============================================================================

create extension if not exists "pgcrypto";


-- ############################################################################
-- SECTION 1 - APP IDENTITIES (gateway sign-in -> intern id)
-- ############################################################################
--
-- UPSERT on every verified sign-in, keyed by the token's `sub`:
--
--   insert into app_identities (gateway_sub, email_address, full_name, gateway_role)
--   values ($sub, $email, $name, $role)
--   on conflict (gateway_sub) do update
--     set email_address = excluded.email_address,
--         full_name     = excluded.full_name,
--         gateway_role  = excluded.gateway_role,
--         last_seen_at  = now();
--
-- Then, if intern_id is null, resolve it against the Intern Database by email
-- (GET {INTERN_DB_URL}/api/interns, Bearer client_credentials token,
-- scope intern:read) and write it back.
-- ============================================================================
create table if not exists public.app_identities (
  id                 uuid primary key default gen_random_uuid(),

  gateway_sub        text not null unique,
  email_address      text not null,
  full_name          text,

  -- Gateway console role (admin / platform / developer / viewer). A hint only;
  -- never gate a feature on it. Use `app_role`.
  gateway_role       text,

  -- Intern Database id. Not a foreign key - that service owns the record.
  intern_id          uuid,
  intern_synced_at   timestamptz,

  app_role           text not null default 'intern'
                       check (app_role in ('intern', 'supervisor', 'admin')),

  created_at         timestamptz not null default now(),
  last_seen_at       timestamptz not null default now()
);

create index if not exists app_identities_email_idx
  on public.app_identities (lower(email_address));

create unique index if not exists app_identities_intern_key
  on public.app_identities (intern_id)
  where intern_id is not null;


-- ############################################################################
-- SECTION 2 - ATTENDANCE RECORDS
-- ############################################################################
create table if not exists public.attendance_records (
  id                    uuid primary key default gen_random_uuid(),

  -- Intern Database id. Bare uuid, resolved via that service's API (SS-13).
  intern_id             uuid not null,

  attendance_date       date not null,

  clock_in              timestamptz,
  clock_out             timestamptz,

  clock_in_mode         text check (clock_in_mode in ('Office', 'Hybrid')),
  clock_out_mode        text check (clock_out_mode in ('Office', 'Hybrid')),

  clock_in_latitude     numeric(10, 7),
  clock_in_longitude    numeric(10, 7),
  clock_out_latitude    numeric(10, 7),
  clock_out_longitude   numeric(10, 7),

  clock_in_qr           text,
  clock_out_qr          text,

  status                text check (status in ('On time', 'Late', 'Excused (MC)')),

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint attendance_one_per_intern_per_day unique (intern_id, attendance_date),
  constraint attendance_clock_order_check
    check (clock_out is null or clock_in is null or clock_out >= clock_in)
);

create index if not exists attendance_date_idx
  on public.attendance_records (attendance_date desc);

create index if not exists attendance_intern_idx
  on public.attendance_records (intern_id, attendance_date desc);


-- ############################################################################
-- SECTION 3 - LEAVE REQUESTS
-- ############################################################################
create table if not exists public.leave_requests (
  id                uuid primary key default gen_random_uuid(),

  intern_id         uuid not null,

  leave_date        date not null,
  category          text not null
                      check (category in ('Medical Leave/MC', 'Emergency Leave', 'University Event')),

  -- File name shown in the UI; the object lives on disk / object store and
  -- `attachment_path` holds its path or key. Keep these private - an MC is
  -- sensitive; do not serve the directory publicly.
  attachment_name   text,
  attachment_path   text,

  notes             text,

  status            text not null default 'Pending'
                      check (status in ('Pending', 'Approved', 'Rejected')),

  reviewed_by       text references public.app_identities (gateway_sub) on delete set null,
  reviewed_at       timestamptz,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists leave_intern_date_idx
  on public.leave_requests (intern_id, leave_date desc);

create index if not exists leave_status_idx
  on public.leave_requests (status);


-- ############################################################################
-- SECTION 4 - TRIGGERS + READ MODEL
-- ############################################################################

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists attendance_set_updated_at on public.attendance_records;
create trigger attendance_set_updated_at
  before update on public.attendance_records
  for each row execute function public.set_updated_at();

drop trigger if exists leave_set_updated_at on public.leave_requests;
create trigger leave_set_updated_at
  before update on public.leave_requests
  for each row execute function public.set_updated_at();

-- Approved Medical Leave/MC on the same day overrides the stored status.
-- Intern name / ref_number are merged in by the app from the Intern Database
-- API, not joined here.
create or replace view public.attendance_feed as
select
  a.*,
  (mc.id is not null)                                            as mc_excused,
  case when mc.id is not null then 'Excused (MC)' else a.status end as effective_status
from public.attendance_records a
left join public.leave_requests mc
  on  mc.intern_id  = a.intern_id
  and mc.leave_date = a.attendance_date
  and mc.category   = 'Medical Leave/MC'
  and mc.status     = 'Approved';


-- No seed data. Every intern comes from the Intern Database service; attendance
-- and leave rows are created by the app as interns clock in and file requests.


-- ############################################################################
-- GRANTS - the least-privilege role the app connects as
-- ############################################################################
--   create role rizurf_app with login password 'change-me-in-env';
--   grant connect on database rizurf_attendance to rizurf_app;
--   grant usage on schema public to rizurf_app;
--   grant select, insert, update, delete on all tables in schema public to rizurf_app;
--   grant usage, select on all sequences in schema public to rizurf_app;
--   alter default privileges in schema public
--     grant select, insert, update, delete on tables to rizurf_app;
--   alter default privileges in schema public
--     grant usage, select on sequences to rizurf_app;
-- ############################################################################

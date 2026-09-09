-- ============================================================================
-- Rizurf Attendance App - database (Supabase / Postgres)
-- Run in the Supabase Dashboard -> SQL Editor.
--
-- `schema.postgres.sql` is the same schema for the self-hosted VPS; move across
-- with  pg_dump --no-owner --no-privileges | psql  then apply that file's
-- GRANTS block. The only differences are the RLS lines (here) and, there, a
-- least-privilege role instead.
-- ============================================================================
--
-- This service owns attendance and leave, nothing else.
--
--   * INTERNS are owned by the Intern Database service
--     (INTERN_DB_URL). This app never stores intern records - it references an
--     intern by the id that service issues and reads names / details from its
--     API (SS-13). `intern_id` columns below are bare uuids, not foreign keys.
--
--   * LOGIN is the Rizurf gateway's (SS-24). No password column, no sign-in
--     screen. `app_identities` is an auto-synced projection of the gateway
--     identity, plus this app's own role for that person.
-- ============================================================================

create extension if not exists "pgcrypto";


-- ############################################################################
-- SECTION 1 - APP IDENTITIES (gateway sign-in -> intern id)
-- ############################################################################
--
-- The server UPSERTs this on every sign-in from the *verified* identity token
-- (never from a header or the request origin - SS-25):
--
--   insert into app_identities (gateway_sub, email_address, full_name, gateway_role)
--   values ($sub, $email, $name, $role)
--   on conflict (gateway_sub) do update
--     set email_address = excluded.email_address,
--         full_name     = excluded.full_name,
--         gateway_role  = excluded.gateway_role,
--         last_seen_at  = now();
--
-- Then, if `intern_id` is still null, the server resolves it against the Intern
-- Database by email and writes it back:
--
--   GET {INTERN_DB_URL}/api/interns?limit=...&offset=...
--     Authorization: Bearer <client_credentials token, scope intern:read>
--   -> match email_address, then
--      update app_identities set intern_id = <that id>, intern_synced_at = now()
--       where gateway_sub = $sub;
--
-- A gateway user with no matching intern (a supervisor, say) keeps intern_id
-- null.
-- ============================================================================
create table if not exists public.app_identities (
  id                 uuid primary key default gen_random_uuid(),

  gateway_sub        text not null unique,
  email_address      text not null,
  full_name          text,

  -- Gateway *console* role (admin / platform / developer / viewer). A hint
  -- only; never gate a feature on it. Use `app_role`.
  gateway_role       text,

  -- The intern id issued by the Intern Database service. Not a foreign key -
  -- that service owns the record. Null until the email match succeeds.
  intern_id          uuid,
  intern_synced_at   timestamptz,

  -- THIS app's authorization for this person (SS-24: a local role table keyed
  -- to the gateway identity, not the gateway role).
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

  -- Intern Database id. Bare uuid, resolved to a name through that service's
  -- API (SS-13). No foreign key.
  intern_id             uuid not null,

  attendance_date       date not null,

  clock_in              timestamptz,
  clock_out             timestamptz,

  -- Per-punch method. A different axis from the intern's overall arrangement
  -- in the Intern Database ('On-site' / 'Remote' / 'Hybrid').
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

  -- File name shown in the UI; the object itself goes in the private
  -- `leave-attachments` bucket (Section 5), keyed by
  -- <leave_request_id>/<original-name>.
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

-- The read model the app renders. An approved Medical Leave/MC on the same day
-- overrides the stored status. Intern name / ref_number are merged in by the
-- app from the Intern Database API - not joined here.
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


-- ############################################################################
-- SECTION 5 - ROW LEVEL SECURITY + STORAGE
-- ############################################################################
-- RLS enabled, no policies: the server uses the service-role key (bypasses
-- RLS); the anon key reads nothing. Authorization is app_identities.app_role,
-- in the app, not the database.
-- ============================================================================
alter table public.app_identities     enable row level security;
alter table public.attendance_records enable row level security;
alter table public.leave_requests     enable row level security;

-- Leave attachments: PRIVATE. Read / written only via the service-role key,
-- keyed by <leave_request_id>/<original-name>.
insert into storage.buckets (id, name, public)
values ('leave-attachments', 'leave-attachments', false)
on conflict (id) do nothing;

-- No seed data. Every intern comes from the Intern Database service; attendance
-- and leave rows are created by the app as interns clock in and file requests.

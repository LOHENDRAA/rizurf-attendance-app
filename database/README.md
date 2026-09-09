# Database

One schema: [`schema.mysql.sql`](schema.mysql.sql) — MySQL 8.0.16+ (or
MariaDB 10.5+), on the VPS.

## Setup

```bash
mysql -h <DB_HOST> -P <DB_PORT> -u root -p < database/schema.mysql.sql
```

Then create the least-privilege user the app connects as (the `CREATE USER` /
`GRANT` block is at the bottom of the file) and put its details in the app
environment (see `.env.example`; never commit `.env`):

```
DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD
DB_TIME_ZONE=+08:00

GATEWAY_URL=https://web-omega-two-47.vercel.app
PUBLIC_URL=https://<this app's own address>
SESSION_SECRET   (openssl rand -hex 32)

INTERN_DB_URL / INTERN_DB_AUDIENCE / INTERN_DB_CLIENT_ID / INTERN_DB_CLIENT_SECRET
```

## What it holds

- `app_identities` — a projection of each gateway sign-in (`gateway_sub`,
  email, name, `role`) and the `intern_id` resolved for that person.
- `attendance_records` — one row per intern per day.
- `leave_requests` — MC / leave submissions.
- `attendance_feed` (view) — the read model the app renders (adds the
  approved-MC → "Excused (MC)" override).

## What it does NOT hold

- **Interns.** They belong to the Intern Database service (`INTERN_DB_URL`).
  This app stores an intern's id (`intern_id`, `CHAR(36)`, no foreign key) and
  reads names / details from that service's API live — see
  [`AUTH-MODEL.md`](AUTH-MODEL.md) and `api/config.php`.
- **Logins.** No password column exists by design (SS-24).

## Files

Leave attachments (MC slips) go on disk / object store;
`leave_requests.attachment_path` holds the key — keep that directory private.

# Database

| File | Engine | Status |
|---|---|---|
| `schema.supabase.sql` | Postgres (Supabase) | **Deployed now.** attendance + leave + gateway identity. |
| `schema.postgres.sql` | PostgreSQL 14+ (self-hosted / VPS) | Same schema, Postgres VPS. |
| `schema.mysql.sql` | MySQL 8.0.16+ / MariaDB 10.5+ (VPS) | Same model in MySQL form. |
| `schema.sql` | MySQL (XAMPP) | Original legacy schema, reference only. |

All three current files are the same model. Differences:
- **Supabase** — RLS enabled (no policies), `leave-attachments` Storage bucket.
- **Postgres VPS** — no RLS, `GRANTS` block for a least-privilege role, files on
  disk.
- **MySQL VPS** — `BIGINT` auto-increment PKs instead of uuid (`intern_id` stays
  `CHAR(36)`), `ENUM`s instead of `CHECK`-in lists, native `ON UPDATE
  CURRENT_TIMESTAMP` instead of the `set_updated_at()` trigger.

`api/config.php` reads the engine from the `DATABASE_URL_DIRECT` scheme
(`postgresql://` or `mysql://`), so switching is an env change, not a code
change.

## Supabase setup (do this now)

1. Create a Supabase project.
2. **SQL Editor** -> paste `schema.supabase.sql` -> run.
3. Confirm the `leave-attachments` bucket (private) under **Storage**.
4. App server environment (see `.env.example`; never commit `.env`):

   ```
   DATABASE_URL=postgres://...:6543/postgres          # runtime (transaction pooler)
   DATABASE_URL_DIRECT=postgres://...:5432/postgres   # migrations / PHP-FPM
   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY

   GATEWAY_URL=https://web-omega-two-47.vercel.app
   PUBLIC_URL=https://<this app's own address>

   INTERN_DB_URL=https://intern-database.vercel.app
   INTERN_DB_CLIENT_ID / INTERN_DB_CLIENT_SECRET      # gateway API client
   ```

5. Delete the **DEV SEED** section in the schema for a clean deployment.

## What this database holds

- `app_identities` - a projection of each gateway sign-in, plus this app's own
  role (`intern` / `supervisor` / `admin`) for that person, and the `intern_id`
  it resolved for them.
- `attendance_records` - one row per intern per day.
- `leave_requests` - MC / leave submissions.
- `attendance_feed` (view) - the read model the app renders (adds the
  approved-MC -> "Excused (MC)" override).

## What it does NOT hold

- **Interns.** They belong to the Intern Database service (`INTERN_DB_URL`).
  This app references an intern by the id that service issues (`intern_id`
  columns are bare uuids, no foreign key) and reads names / details from its API
  live - see [`AUTH-MODEL.md`](AUTH-MODEL.md) and `api/config.php`.
- **Logins.** Authentication is the Rizurf gateway's. No password column exists
  anywhere in this schema by design (SS-24).

## Self-hosted VPS - Postgres (`schema.postgres.sql`)

```bash
createdb rizurf_attendance
psql -d rizurf_attendance -v ON_ERROR_STOP=1 -f database/schema.postgres.sql
```

Then run the `GRANTS` block for the least-privilege `rizurf_app` role, and set
`DATABASE_URL_DIRECT=postgresql://rizurf_app:...@127.0.0.1:5432/rizurf_attendance`.

## Self-hosted VPS - MySQL (`schema.mysql.sql`)

```bash
mysql -u root -p < database/schema.mysql.sql
```

Then run the `CREATE USER` / `GRANT` block at the bottom of the file and set
`DATABASE_URL_DIRECT=mysql://rizurf_app:...@127.0.0.1:3306/rizurf_attendance`.
Run MySQL (or the OS) at `+08:00`, or leave `DB_TIME_ZONE` at its `+08:00`
default so `clock_in` / `clock_out` read back as Asia/Kuala_Lumpur.

Leave attachments (both VPS variants) go on disk / object store;
`leave_requests.attachment_path` holds the key.

## Original legacy schema (`schema.sql`)

The first MySQL build (keyed by `employee_id`, no interns / identities). XAMPP:
start Apache + MySQL, phpMyAdmin, **Import** `schema.sql`. Superseded by
`schema.mysql.sql`.

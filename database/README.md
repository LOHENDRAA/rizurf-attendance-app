# Database

| File | Engine | Status |
|---|---|---|
| `schema.supabase.sql` | Postgres (Supabase) | **Run this now.** attendance + leave + gateway identity. |
| `schema.postgres.sql` | PostgreSQL 14+ (self-hosted / VPS) | Same schema for the VPS move. |
| `schema.sql` | MySQL (XAMPP) | Legacy, reference only. |

The Supabase and VPS files are the same schema; the only differences are the
RLS lines (Supabase) vs. a least-privilege role (`GRANTS` block in the VPS
file), and the leave-attachment store (Supabase Storage vs. a disk path).

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

## Self-hosted VPS (`schema.postgres.sql`)

```bash
createdb rizurf_attendance
psql -d rizurf_attendance -v ON_ERROR_STOP=1 -f database/schema.postgres.sql
```

Then run the `GRANTS` block to create the least-privilege `rizurf_app` role.
Leave attachments go on disk / object store; `leave_requests.attachment_path`
holds the key.

## Legacy MySQL (`schema.sql`)

XAMPP: start Apache + MySQL, open phpMyAdmin, **Import** `schema.sql`.

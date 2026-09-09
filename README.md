# Rizurf Attendance App

A Rizurf micro app: a React (Vite) PWA for interns to clock in/out (office QR +
GPS) and file MC / leave requests, with a PHP API behind it.

- **Frontend** — `src/`, built by Vite to `dist/`.
- **API** — `api/`, a small front-controller service:
  - `GET /health`, `GET /openapi.json` — public, for the Rizurf gateway
  - `GET|POST /api/attendance`, `GET|POST /api/leave` — bearer-token protected
- **Database** — Postgres (Supabase now, VPS later). See [`database/README.md`](database/README.md).
- **Interns** — not stored here; resolved live from the Intern Database service.
- **Login** — the Rizurf gateway's; no passwords here. See
  [`database/AUTH-MODEL.md`](database/AUTH-MODEL.md) and `MICROAPP_AUTH.md`.

## Local dev

```bash
cp .env.example .env      # fill in the values
npm install
npm run dev               # frontend, http://localhost:5173

# API (needs PHP 8.1+ with pdo_pgsql, curl, openssl):
php -S 127.0.0.1:8000 router.php
curl http://127.0.0.1:8000/health
```

`DEV_ALLOW_NO_AUTH=true` in `.env` lets `/api/*` run without a gateway token so
the SPA works before the sign-in flow is built. It **must be `false`/unset** on
any deployment registered with the gateway.

## Deploy (Vercel)

`vercel.json` runs the frontend build and serves `api/index.php` via the
`vercel-php` runtime; every non-static path is rewritten to it.

Set these in **Vercel → Project → Settings → Environment Variables** (same keys
as `.env.example`, real values):

```
DATABASE_URL_DIRECT   SUPABASE_URL   SUPABASE_SERVICE_ROLE_KEY
GATEWAY_URL           PUBLIC_URL (= https://<your-vercel-domain>)   SERVICE_ID   APP_VERSION
INTERN_DB_URL   INTERN_DB_AUDIENCE   INTERN_DB_CLIENT_ID   INTERN_DB_CLIENT_SECRET
SESSION_SECRET
# DEV_ALLOW_NO_AUTH  -> leave unset / false
```

Then in the gateway hub: **Connect a service** → paste the deployment URL. It
reads `/health` and `/openapi.json` and runs conformance.

> If `vercel-php` on your plan lacks `pdo_pgsql`, `/health` will report
> `database: false` (status `degraded`) and `/api/*` won't reach the DB —
> registration still works (the gateway only reads the two public docs), but
> switch the data layer to the Supabase REST API or host the PHP on the VPS to
> make the API functional.

## Legacy

`index.php`, `.htaccess`, `database/schema.sql` are the original XAMPP/MySQL
setup, kept for reference.

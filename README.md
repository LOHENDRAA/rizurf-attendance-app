# Rizurf Attendance App

A Rizurf micro app: a React (Vite) PWA for interns to clock in/out (office QR +
GPS) and file MC / leave requests, with a PHP API behind it.

- **Frontend** — `src/`, built by Vite to `dist/`.
- **API** — `api/`, a front-controller service:
  - `GET /health`, `GET /openapi.json` — public, for the Rizurf gateway
  - `GET|POST /api/attendance`, `GET|POST /api/leave`, `GET /api/me` — need a
    gateway token or the app session cookie
- **Database** — MySQL 8 on the VPS. See [`database/README.md`](database/README.md).
- **Interns** — not stored here; resolved live from the Intern Database service.
- **Login** — the Rizurf gateway's; no login screen, no passwords. An
  unauthenticated visitor is bounced to the gateway and comes straight back
  signed in. See [`database/AUTH-MODEL.md`](database/AUTH-MODEL.md) and
  `MICROAPP_AUTH.md`.

## Local dev

```bash
cp .env.example .env       # fill in the values
npm install
npm run build              # the PHP front controller serves the built SPA

# API + gated SPA (needs PHP 8.1+ with pdo_mysql, curl, openssl):
php -S 127.0.0.1:8000 router.php
curl http://127.0.0.1:8000/health
```

`DEV_ALLOW_NO_AUTH=true` in `.env` lets pages and `/api/*` run without a gateway
session so you can work locally. It **must be `false`/unset** on any deployment
registered with the gateway.

## Deploy (Vercel)

`vercel.json` builds the frontend, moves the SPA shell out of static serving
(so `/` is gated by PHP), and routes every non-static path to `api/index.php`
via the `vercel-php` runtime.

Set these in **Vercel → Project → Settings → Environment Variables** (same keys
as `.env.example`, real values); leave `DEV_ALLOW_NO_AUTH` unset:

```
DB_HOST   DB_PORT   DB_NAME   DB_USER   DB_PASSWORD   DB_TIME_ZONE
GATEWAY_URL   PUBLIC_URL (= https://<your-vercel-domain>)   SERVICE_ID   APP_VERSION
SESSION_SECRET   SESSION_TTL_SECONDS
INTERN_DB_URL   INTERN_DB_AUDIENCE   INTERN_DB_CLIENT_ID   INTERN_DB_CLIENT_SECRET
OFFICE_QR   OFFICE_LATITUDE   OFFICE_LONGITUDE   OFFICE_RADIUS_METERS   OFFICE_ADDRESS
```

Then in the gateway hub: **Connect a service** → paste the deployment URL. It
reads `/health` and `/openapi.json` and runs conformance.

> The VPS MySQL host must accept connections from Vercel's egress IPs. If
> `vercel-php` cannot reach it, `/health` reports `database: false` — the
> gateway still registers the service (it only reads the two public docs), but
> `/api/*` won't work until the DB is reachable.

## Legacy

`index.php` and `.htaccess` are from the original XAMPP setup, kept for
reference.

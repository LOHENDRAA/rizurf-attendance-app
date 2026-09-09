# Login and intern linking

This app has **no login of its own** - no user table with passwords, no sign-in
screen. That is a hard rule for a Rizurf microapp (SS-24). It has exactly one
identity table, `app_identities`, and every row in it is written by the server
from a token the gateway signed.

## 1. Sign-in (the gateway does this) - no login screen

There is no login page in this app. `api/index.php`:

1. A visitor with no session hits any page -> 302 to
   `${GATEWAY_URL}/oauth/authorize?redirect_uri=${PUBLIC_URL}/`.
2. They are already signed in at the gateway (they opened this app from it), so
   the gateway 302s straight back to `${PUBLIC_URL}/?code=...`. The only thing
   they see is a fast redirect bounce.
3. `handleGatewayCallback()` exchanges the code at `${GATEWAY_URL}/oauth/token`
   (server-to-server, no client secret), verifies the returned identity token's
   RS256 signature against `${GATEWAY_URL}/.well-known/jwks.json` plus
   `iss`/`aud`/`exp`/`token_use` (`api/gateway.php` `verifyGatewayToken`), then
   `issueAppSession()` sets a short-lived HMAC-signed `HttpOnly` cookie and it
   redirects to the clean `/` (code out of history).
4. Every later request: `validateAppSession()` checks the cookie, then
   `gatewaySessionIsLive()` asks `${GATEWAY_URL}/oauth/introspect` - no cache -
   so a gateway sign-out or suspension locks this app within one request.
   Network error there fails open; the 15-minute cookie TTL is the backstop.

The verified token carries `sub`, `email`, `name`, `role`. There is no
sign-out button - the gateway is the only place anyone signs in or out.

## 2. Auto-sync into `app_identities`

On every authenticated request the server upserts the identity by `gateway_sub`:

```sql
insert into app_identities (gateway_sub, email_address, full_name, role)
values ($sub, $email, $name, $role)
on conflict (gateway_sub) do update
  set email_address = excluded.email_address,
      full_name     = excluded.full_name,
      role          = excluded.role,
      last_seen_at  = now();
```

"Whatever email or id the gateway signs in with auto-syncs to this app" -
that's this upsert. Nothing is typed in by hand.

## Roles

The gateway role - `admin` / `hr` / `supervisor` / `user` - comes verified in
the identity token and is read **live from the session on every request**
(`MICROAPP_AUTH.md` S2), used directly:

- `user` - an intern using the app for themselves (their own attendance + leave)
- `supervisor` - sees their team's view; reviews leave requests
- `hr` / `admin` - full access

There is **no local role table** - the doc is explicit that a parallel system
is the wrong reach when the four gateway roles already cover it. The `role`
column on `app_identities` is only a synced snapshot so admin-side screens can
list "the supervisors" without calling the gateway; it is never the source of
an authorization decision.

## 3. Link to an intern (Intern Database service)

This app stores **no intern records** (SS-13). Right after the upsert, if
`intern_id is null`, the server resolves it against the Intern Database API and
writes it back:

```
# scoped service token, cached ~1h (SS-26):
POST {GATEWAY_URL}/oauth/token
  Authorization: Basic base64(INTERN_DB_CLIENT_ID:INTERN_DB_CLIENT_SECRET)
  { "grant_type": "client_credentials",
    "audience": "intern-database", "scope": "intern:read" }
-> { "access_token": "...", "expires_in": 3600 }

# page /api/interns, match email_address:
GET {INTERN_DB_URL}/api/interns?limit=100&offset=0
  Authorization: Bearer <access_token>
```

```sql
update app_identities
   set intern_id = $matched_id, intern_synced_at = now()
 where gateway_sub = $sub;
```

`api/config.php` implements this: `internDbToken()`, `internDirectory()`,
`internIdByEmail()`, and `currentInternId()`.

A gateway user with no matching intern (e.g. a supervisor) keeps `intern_id =
null`; the attendance and leave screens are hidden for them.

## 4. From then on

`attendance_records` and `leave_requests` are keyed by `intern_id` - a bare
uuid, the id the Intern Database issued, with no foreign key here. The server
reads `app_identities` for the current `gateway_sub`, takes its `intern_id`, and
scopes every query to that. Where the UI needs an intern's name or `ref_number`
it comes from the Intern Database API (`internDirectory()`), merged into the
response - never stored.

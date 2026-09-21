<?php

declare(strict_types=1);

// ============================================================================
// Shared config + helpers for the attendance API.
//
// Database: MySQL on the VPS (DB_* env vars).
// Interns: resolved live from the Intern Database service - this app stores no
//          intern records (SS-13).
// All settings come from the environment (.env at the repo root), never
// hardcoded here (SS-20).
// ============================================================================

require_once __DIR__ . '/http.php';

// PHP's date() zone, from APP_TIMEZONE (Vercel reserves the name TZ and forces
// it to ":UTC"). Anything empty or unrecognised falls back to the app's home
// zone rather than silently running in UTC.
(static function (): void {
    $tz = ltrim((string) env('APP_TIMEZONE', ''), ':');
    if ($tz === '' || !in_array($tz, timezone_identifiers_list(), true)) {
        $tz = 'Asia/Kuala_Lumpur';
    }
    date_default_timezone_set($tz);
})();

/** Kept equal to /health's version and openapi info.version (SS-2). */
function appVersion(): string
{
    return env('APP_VERSION', '1.0.0');
}

/**
 * Read .env (repo root) once into the process environment. Real env vars win,
 * so a host that injects them needs no file.
 */
function loadEnv(): void
{
    static $loaded = false;
    if ($loaded) {
        return;
    }
    $loaded = true;

    $file = __DIR__ . '/../.env';
    if (!is_file($file)) {
        return;
    }
    foreach (file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
        $line = trim($line);
        if ($line === '' || $line[0] === '#' || !str_contains($line, '=')) {
            continue;
        }
        [$key, $value] = explode('=', $line, 2);
        $key = trim($key);
        $value = trim($value);
        if (strlen($value) >= 2 && ($value[0] === '"' || $value[0] === "'") && $value[-1] === $value[0]) {
            $value = substr($value, 1, -1);
        }
        if (getenv($key) === false) {
            putenv("$key=$value");
            $_ENV[$key] = $value;
        }
    }
}

function env(string $key, ?string $default = null): ?string
{
    loadEnv();
    $value = getenv($key);
    return $value === false ? $default : $value;
}

/** A required env var is missing. The var name is safe to surface (SS-5). */
class ConfigException extends RuntimeException
{
}

function envOrFail(string $key): string
{
    $value = env($key);
    if ($value === null || $value === '') {
        // Throw (not exit) so /health's checks can catch it and report a
        // dependency as down instead of aborting the whole response.
        throw new ConfigException("Missing required environment variable: $key");
    }
    return $value;
}

/**
 * The browser-facing shape ({success, message, ...}) for the SPA's own
 * endpoints. Router-level failures (401/404/405/500) use sendError()'s SS-5
 * envelope instead; this is only the handler business responses.
 */
function respond(array $payload, int $status = 200): never
{
    http_response_code($status);
    baseHeaders();
    echo json_encode($payload, JSON_UNESCAPED_SLASHES);
    exit;
}

// ----------------------------------------------------------------------------
// Database
// ----------------------------------------------------------------------------

/**
 * One PDO connection to the MySQL database (VPS), from the discrete DB_* env
 * vars. The session time zone is pinned so TIMESTAMP columns (clock_in /
 * clock_out) store and read back as Asia/Kuala_Lumpur.
 */
function database(): PDO
{
    static $pdo = null;
    if ($pdo !== null) {
        return $pdo;
    }

    $host = envOrFail('DB_HOST');
    $port = (int) env('DB_PORT', '3306');
    $name = envOrFail('DB_NAME');
    $user = envOrFail('DB_USER');
    $password = envOrFail('DB_PASSWORD');

    $pdo = new PDO(
        "mysql:host=$host;port=$port;dbname=$name;charset=utf8mb4",
        $user,
        $password,
        [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            // The real cost here isn't query time (a few ms) -- it's the TCP+TLS
            // handshake to a remote VPS host, paid on every request since this
            // runs as short-lived serverless functions. A persistent connection
            // lets a warm function container reuse the same MySQL socket across
            // invocations instead of re-handshaking every time.
            PDO::ATTR_PERSISTENT => true,
        ],
    );
    $pdo->exec('SET time_zone = ' . $pdo->quote(env('DB_TIME_ZONE', '+08:00')));
    return $pdo;
}

// ----------------------------------------------------------------------------
// Intern Database service (SS-26 - program-to-program via client_credentials)
// ----------------------------------------------------------------------------

/** The Intern Database (or the gateway leg to it) could not be reached /
 *  authenticated. `$detail` is safe to surface - upstream status + error code,
 *  never a secret. */
class InternDbException extends RuntimeException
{
    public function __construct(public string $detail)
    {
        parent::__construct($detail);
    }
}

/**
 * A scoped access token for the Intern Database, cached in-process until it
 * expires. Fetched from the gateway with the API client secret (SS-26).
 */
function internDbToken(): string
{
    static $token = null;
    static $expiresAt = 0;
    if ($token !== null && time() < $expiresAt - 30) {
        return $token;
    }

    $gateway = rtrim(envOrFail('GATEWAY_URL'), '/');
    $clientId = envOrFail('INTERN_DB_CLIENT_ID');
    $clientSecret = envOrFail('INTERN_DB_CLIENT_SECRET');
    $audience = env('INTERN_DB_AUDIENCE', 'intern-database');

    [$status, $body] = httpJson('POST', "$gateway/oauth/token", [
        'Authorization: Basic ' . base64_encode("$clientId:$clientSecret"),
        'Content-Type: application/json',
    ], ['grant_type' => 'client_credentials', 'audience' => $audience, 'scope' => 'intern:read']);

    if ($status !== 200 || !isset($body['access_token'])) {
        $code = '';
        if (is_array($body)) {
            $raw = $body['error'] ?? $body['message'] ?? $body['error_description'] ?? '';
            if (is_array($raw)) {
                $raw = $raw['code'] ?? $raw['message'] ?? '';
            }
            $code = is_string($raw) ? $raw : '';
        }
        $hint = $code !== '' ? " ($code)" : '';
        error_log("[attendance-api] intern-db token: gateway /oauth/token -> $status$hint");
        throw new InternDbException("gateway /oauth/token returned $status$hint");
    }

    $token = $body['access_token'];
    $expiresAt = time() + (int) ($body['expires_in'] ?? 3600);
    return $token;
}

/** GET a path on the Intern Database API with the service token. */
function internDbGet(string $path): array
{
    $base = rtrim(envOrFail('INTERN_DB_URL'), '/');
    [$status, $body] = httpJson('GET', $base . $path, [
        'Authorization: Bearer ' . internDbToken(),
        'Accept: application/json',
    ]);
    if ($status !== 200) {
        error_log("[attendance-api] intern-db GET $path -> $status");
        throw new InternDbException("Intern Database GET $path returned $status");
    }
    return $body;
}

/**
 * A fixed local roster, used instead of a real Intern Database call -- only
 * when BOTH DEV_ALLOW_NO_AUTH and DEV_MOCK_INTERNS are explicitly set, so it
 * can never activate on the registered deployment. Exists purely so this app
 * (and anything built against it, like the device-link check) can be run and
 * tested end-to-end with no live infrastructure -- no VPS DB reachable from
 * here, no Intern Database credentials. Shaped to match what the real
 * service returns (see src/App.jsx's use of intern.first_name etc).
 */
function mockInternDirectory(): array
{
    $interns = [
        ['id' => '11111111-1111-4111-8111-111111111111', 'ref_number' => 'INT-0007', 'first_name' => 'Alex', 'last_name' => 'Morgan', 'email_address' => 'alex.morgan@example.com', 'department_id' => 'DEP-0001', 'mode' => 'Hybrid', 'allowance' => 'RM50/day', 'internship_start_date' => '2026-08-03', 'internship_end_date' => '2026-11-27', 'photo_url' => 'https://i.pravatar.cc/150?img=12'],
        ['id' => '22222222-2222-4222-8222-222222222222', 'ref_number' => 'INT-0008', 'first_name' => 'Jordan', 'last_name' => 'Lee', 'email_address' => 'jordan.lee@example.com', 'department_id' => 'DEP-0002', 'mode' => 'On-site', 'allowance' => 'RM50/day', 'internship_start_date' => '2026-08-03', 'internship_end_date' => '2026-11-27'],
    ];
    return array_combine(array_column($interns, 'id'), $interns);
}

/** Every intern, one API round of pages, indexed by id. Cached per request. */
function internDirectory(): array
{
    static $byId = null;
    if ($byId !== null) {
        return $byId;
    }

    if (filter_var(env('DEV_ALLOW_NO_AUTH', ''), FILTER_VALIDATE_BOOL)
        && filter_var(env('DEV_MOCK_INTERNS', ''), FILTER_VALIDATE_BOOL)) {
        return $byId = mockInternDirectory();
    }

    $byId = [];
    $offset = 0;
    $limit = 100;
    do {
        $page = internDbGet("/api/interns?limit=$limit&offset=$offset");
        foreach ($page['data'] ?? [] as $intern) {
            $byId[$intern['id']] = $intern;
        }
        $total = (int) ($page['pagination']['total'] ?? count($byId));
        $offset += $limit;
    } while ($offset < $total);
    return $byId;
}

function internIdByRef(string $ref): ?string
{
    foreach (internDirectory() as $id => $intern) {
        if (($intern['ref_number'] ?? null) === $ref) {
            return $id;
        }
    }
    return null;
}

function internIdByEmail(string $email): ?string
{
    $needle = strtolower(trim($email));
    foreach (internDirectory() as $id => $intern) {
        if (strtolower((string) ($intern['email_address'] ?? '')) === $needle) {
            return $id;
        }
    }
    return null;
}

// ----------------------------------------------------------------------------
// Department Management service (department-api) - resolves department_id
// (e.g. "DEP-0001", from the Intern Database) to a human-readable name. A
// separate service from the Intern Database, per its own openapi.json:
// "Resolve names/details via that service's GET /api/departments". Purely
// best-effort: this service being down (or the department id being unknown)
// must never break a page that's just trying to show someone's department --
// callers get null back and fall back to the raw code themselves.
// ----------------------------------------------------------------------------

/** A fixed local roster, mirroring mockInternDirectory() -- same dev-only gate. */
function mockDepartmentDirectory(): array
{
    return ['DEP-0001' => 'Marketing', 'DEP-0002' => 'Operations'];
}

function departmentApiToken(): string
{
    static $token = null;
    static $expiresAt = 0;
    if ($token !== null && time() < $expiresAt - 30) {
        return $token;
    }
    $gateway = rtrim(envOrFail('GATEWAY_URL'), '/');
    $clientId = envOrFail('INTERN_DB_CLIENT_ID');
    $clientSecret = envOrFail('INTERN_DB_CLIENT_SECRET');
    $audience = env('DEPARTMENT_API_AUDIENCE', 'department-api');

    // A short timeout -- this whole lookup is best-effort (departmentName()
    // falls back to the raw code), so it must never make the page people are
    // waiting on noticeably slower just because this one dependency is down.
    [$status, $body] = httpJson('POST', "$gateway/oauth/token", [
        'Authorization: Basic ' . base64_encode("$clientId:$clientSecret"),
        'Content-Type: application/json',
    ], ['grant_type' => 'client_credentials', 'audience' => $audience], 4);

    if ($status !== 200 || !isset($body['access_token'])) {
        throw new RuntimeException("gateway /oauth/token for department-api returned $status");
    }
    $token = $body['access_token'];
    $expiresAt = time() + (int) ($body['expires_in'] ?? 3600);
    return $token;
}

/**
 * department_id -> name, e.g. "DEP-0001" -> "Marketing". Empty on any
 * failure -- never thrown, this is always a best-effort lookup.
 *
 * Cached to a temp file, not just this process, for a while either way: a
 * working result rarely changes, and department-api being down must not
 * cost every single page load its own multi-second wait on a dependency
 * that's currently unreachable (mirrors health.php's cachedCheck()).
 */
function departmentDirectory(): array
{
    static $byId = null;
    if ($byId !== null) {
        return $byId;
    }

    if (filter_var(env('DEV_ALLOW_NO_AUTH', ''), FILTER_VALIDATE_BOOL)
        && filter_var(env('DEV_MOCK_INTERNS', ''), FILTER_VALIDATE_BOOL)) {
        return $byId = mockDepartmentDirectory();
    }

    $cacheFile = sys_get_temp_dir() . '/attendance_department_directory.json';
    if (is_file($cacheFile)) {
        $cached = json_decode((string) file_get_contents($cacheFile), true);
        if (is_array($cached) && ($cached['at'] ?? 0) > time() - (int) ($cached['ttl'] ?? 0)) {
            return $byId = $cached['data'];
        }
    }

    $byId = [];
    $ttl = 60; // unreachable -- don't retry on every request for a minute
    try {
        $base = rtrim(env('DEPARTMENT_API_URL', 'https://department-zeta.vercel.app'), '/');
        [$status, $body] = httpJson('GET', "$base/api/departments", [
            'Authorization: Bearer ' . departmentApiToken(),
            'Accept: application/json',
        ], null, 4);
        // The service returns a bare JSON array, not {"data": [...]}.
        $list = is_array($body) ? (array_is_list($body) ? $body : ($body['data'] ?? null)) : null;
        if ($status === 200 && is_array($list)) {
            foreach ($list as $department) {
                if (isset($department['id'])) {
                    $byId[$department['id']] = (string) ($department['name'] ?? $department['id']);
                }
            }
            $ttl = 600; // working: re-check every 10 minutes, not every request
        }
    } catch (Throwable $e) {
        error_log('[attendance-api] department directory unavailable: ' . $e->getMessage());
    }
    @file_put_contents($cacheFile, json_encode(['data' => $byId, 'at' => time(), 'ttl' => $ttl]));
    return $byId;
}

/** Falls back to the raw code (or null) if the name can't be resolved --
 *  the department service being down is never a reason to show nothing. */
function departmentName(?string $departmentId): ?string
{
    if ($departmentId === null || $departmentId === '') {
        return null;
    }
    return departmentDirectory()[$departmentId] ?? $departmentId;
}

// ----------------------------------------------------------------------------
// Who is this request for?
//
// THE SEAM. Resolution depends on how the caller authenticated ($GLOBALS['auth']
// set by index.php):
//   - token   : a machine caller (client_credentials). It has no single intern,
//               so it MUST pass ?intern_id= or ?intern_ref=.
//   - session : a signed-in human. Uses app_identities.intern_id for their
//               gateway_sub (the row is kept fresh by upsertAppIdentity()).
//   - dev     : DEV_ALLOW_NO_AUTH. Uses DEV_GATEWAY_SUB or DEV_INTERN_REF.
// Every query downstream is already keyed by the id this returns.
// ----------------------------------------------------------------------------
/**
 * Soft resolution: ['id' => ?string, 'reason' => ?string, 'detail' => ?string].
 * reason: null on success, 'no_intern' (no matching intern record),
 * 'needs_ref' (a service caller must pass one), or 'lookup_failed' (the Intern
 * Database could not be reached / authenticated - 'detail' says how).
 */
function resolveInternId(PDO $pdo): array
{
    $auth = $GLOBALS['auth'] ?? ['kind' => 'dev'];

    try {
        if ($auth['kind'] === 'token') {
            $explicit = trim((string) ($_GET['intern_id'] ?? ''));
            if ($explicit !== '' && preg_match('/^[0-9a-f-]{36}$/i', $explicit)) {
                return ['id' => $explicit, 'reason' => null];
            }
            $ref = trim((string) ($_GET['intern_ref'] ?? ''));
            if ($ref !== '') {
                $id = internIdByRef($ref);
                return $id ? ['id' => $id, 'reason' => null] : ['id' => null, 'reason' => 'no_intern'];
            }
            return ['id' => null, 'reason' => 'needs_ref'];
        }

        if ($auth['kind'] === 'session') {
            return internIdForGatewaySub($pdo, (string) ($auth['session']['sub'] ?? ''));
        }

        // dev
        $gatewaySub = env('DEV_GATEWAY_SUB');
        if ($gatewaySub !== null && $gatewaySub !== '') {
            return internIdForGatewaySub($pdo, $gatewaySub);
        }
        $id = internIdByRef((string) env('DEV_INTERN_REF', 'INT-0007'));
        return $id ? ['id' => $id, 'reason' => null] : ['id' => null, 'reason' => 'no_intern'];
    } catch (InternDbException $e) {
        return ['id' => null, 'reason' => 'lookup_failed', 'detail' => $e->detail];
    }
}

/**
 * Strict resolution for the write paths - the person MUST be a linked intern.
 * Ends the response with a clear error otherwise (409 / 502, never a bare 500).
 */
function currentInternId(PDO $pdo): string
{
    $resolved = resolveInternId($pdo);
    if ($resolved['id'] !== null) {
        return $resolved['id'];
    }
    if (($resolved['reason'] ?? null) === 'lookup_failed') {
        respond(['success' => false, 'linked' => false,
            'message' => 'The Intern Database is unavailable right now - try again shortly.'], 502);
    }
    respond(['success' => false, 'linked' => false, 'message' => ($resolved['reason'] ?? '') === 'needs_ref'
        ? 'A service caller must pass intern_id or intern_ref.'
        : 'Your Rizurf account is not linked to an intern record.'], 409);
}

// ----------------------------------------------------------------------------
// Admin -- gated on the gateway's own role claim (MICROAPP_AUTH.md S2), read
// live from the current request's verified session, never from the
// app_identities.role snapshot column (that's a cache for admin-side
// queries, not an authorization source -- SS-24 already applies this
// distinction elsewhere in this file).
// ----------------------------------------------------------------------------

function currentRole(): ?string
{
    $auth = $GLOBALS['auth'] ?? ['kind' => 'dev'];
    if ($auth['kind'] === 'session') {
        return $auth['session']['role'] ?? null;
    }
    // Local dev only: DEV_ROLE lets the admin panel be tested without a real
    // gateway session. Unset/anything else -- including on the registered
    // deployment, where DEV_ALLOW_NO_AUTH itself is off -- means no admin.
    if ($auth['kind'] === 'dev') {
        return env('DEV_ROLE') ?: null;
    }
    return null;
}

/** Ends the response with a 403 for anyone whose current role isn't admin. */
function requireAdmin(): void
{
    if (currentRole() !== 'admin') {
        respond(['success' => false, 'message' => 'Admin access required.'], 403);
    }
}

/**
 * Every intern's attendance for one date, newest-by-name -- the admin "all
 * attendance" view. Names come from the Intern Database directory, not this
 * app's own storage (SS-13 still applies: this app has no intern records
 * of its own).
 */
function allAttendanceForAdmin(PDO $pdo, string $date): array
{
    $statement = $pdo->prepare('SELECT * FROM attendance_feed WHERE attendance_date = ?');
    $statement->execute([$date]);
    $directory = internDirectory();

    $records = array_map(static function (array $row) use ($directory): array {
        $record = formatRecord($row);
        $intern = $directory[$row['intern_id']] ?? null;
        $record['internId'] = $row['intern_id'];
        $record['internName'] = $intern ? trim($intern['first_name'] . ' ' . $intern['last_name']) : 'Unknown intern';
        $record['refNumber'] = $intern['ref_number'] ?? null;
        return $record;
    }, $statement->fetchAll());

    usort($records, static fn (array $a, array $b): int => strcasecmp($a['internName'], $b['internName']));
    return $records;
}

/**
 * The intern id for a gateway identity, from app_identities. If not linked yet,
 * resolve it from the Intern Database by email and write it back ("whatever
 * email the gateway signs in with auto-syncs to this app"). Returns the soft
 * ['id', 'reason'] shape - a person who is simply not an intern is not an error.
 */
function internIdForGatewaySub(PDO $pdo, string $gatewaySub): array
{
    $statement = $pdo->prepare('SELECT intern_id, email_address FROM app_identities WHERE gateway_sub = ?');
    $statement->execute([$gatewaySub]);
    $row = $statement->fetch();
    if (!$row) {
        // upsertAppIdentity() runs before this on every authed request, so a
        // missing row means the sign-in path is broken, not a normal state.
        return ['id' => null, 'reason' => 'no_intern'];
    }
    if ($row['intern_id']) {
        return ['id' => (string) $row['intern_id'], 'reason' => null];
    }
    $internId = internIdByEmail((string) $row['email_address']);
    if (!$internId) {
        return ['id' => null, 'reason' => 'no_intern'];
    }
    $pdo->prepare('UPDATE app_identities SET intern_id = ?, intern_synced_at = now() WHERE gateway_sub = ?')
        ->execute([$internId, $gatewaySub]);
    return ['id' => $internId, 'reason' => null];
}

/** The full Intern Database record for the current person, or null if their
 *  account is not linked to one. */
function currentInternRecord(PDO $pdo): ?array
{
    ['id' => $id] = resolveInternId($pdo);
    if ($id === null) {
        return null;
    }
    return internDirectory()[$id] ?? null;
}

/**
 * The sign-in upsert (AUTH-MODEL.md S2). Called on every authenticated request
 * from the *verified* identity claims - never from a header. Keeps
 * email/name/role and last_seen_at fresh; the intern link is filled lazily by
 * internIdForGatewaySub().
 */
function upsertAppIdentity(PDO $pdo, array $claims): void
{
    $pdo->prepare(
        'INSERT INTO app_identities (gateway_sub, email_address, full_name, role)
         VALUES (:sub, :email, :name, :role)
         ON DUPLICATE KEY UPDATE
           email_address = VALUES(email_address),
           full_name     = VALUES(full_name),
           role          = VALUES(role),
           last_seen_at  = now()'
    )->execute([
        ':sub' => $claims['sub'] ?? '',
        ':email' => $claims['email'] ?? '',
        ':name' => $claims['name'] ?? null,
        ':role' => $claims['role'] ?? null,
    ]);
}

// ----------------------------------------------------------------------------
// Office / attendance rules
// ----------------------------------------------------------------------------

function officeLatitude(): float
{
    return (float) env('OFFICE_LATITUDE', '3.0862205788137413');
}

function officeLongitude(): float
{
    return (float) env('OFFICE_LONGITUDE', '101.69002156884324');
}

function officeRadiusMeters(): float
{
    return (float) env('OFFICE_RADIUS_METERS', '100');
}

/**
 * The office QR's current value -- from office_settings if it's ever been
 * set (regenerateOfficeQr() writes there), falling back to the OFFICE_QR
 * env var otherwise (first run, before any admin has regenerated it, or the
 * table being briefly unreachable). Cached per-request only; callers that
 * just regenerated the QR in this same request should use the value
 * regenerateOfficeQr() itself returned, not call this again.
 */
function officeQr(): string
{
    static $token = null;
    if ($token !== null) {
        return $token;
    }
    try {
        $row = database()->query('SELECT qr_token FROM office_settings WHERE id = 1')->fetch();
        if ($row) {
            return $token = $row['qr_token'];
        }
    } catch (Throwable $e) {
        error_log('[attendance-api] officeQr: ' . $e->getMessage());
    }
    return $token = env('OFFICE_QR', 'Rizurf_Attandance');
}

/**
 * Admin's "regenerate QR" -- a fresh random token, persisted so it survives
 * across requests (unlike the env var, which would need a redeploy to
 * change). $updatedBy is who did it, purely for the audit trail.
 */
function regenerateOfficeQr(PDO $pdo, ?string $updatedBy): string
{
    $newToken = 'RZ-' . strtoupper(bin2hex(random_bytes(6)));
    $pdo->prepare(
        'INSERT INTO office_settings (id, qr_token, qr_updated_by) VALUES (1, ?, ?)
         ON DUPLICATE KEY UPDATE qr_token = VALUES(qr_token), qr_updated_at = NOW(), qr_updated_by = VALUES(qr_updated_by)'
    )->execute([$newToken, $updatedBy]);
    return $newToken;
}

function distanceInMeters(float $latitude, float $longitude): float
{
    $earthRadius = 6371000;
    $latitudeDelta = deg2rad($latitude - officeLatitude());
    $longitudeDelta = deg2rad($longitude - officeLongitude());
    $a = sin($latitudeDelta / 2) ** 2
        + cos(deg2rad(officeLatitude())) * cos(deg2rad($latitude)) * sin($longitudeDelta / 2) ** 2;
    return $earthRadius * 2 * atan2(sqrt($a), sqrt(1 - $a));
}

// ----------------------------------------------------------------------------
// Attendance read model
// ----------------------------------------------------------------------------

/** Shape an `attendance_feed` row into what the React app expects. */
function formatRecord(array $record): array
{
    return [
        'id' => (string) $record['id'],
        'date' => date('D, M d', strtotime($record['attendance_date'])),
        'clockIn' => $record['clock_in'] ? date('h:i A', strtotime($record['clock_in'])) : '',
        'clockOut' => $record['clock_out'] ? date('h:i A', strtotime($record['clock_out'])) : '',
        'mode' => $record['clock_in_mode'] ?? 'Hybrid',
        'clockOutMode' => $record['clock_out_mode'],
        'status' => $record['effective_status'] ?? $record['status'] ?? 'On time',
    ];
}

function currentRecords(PDO $pdo, string $internId): array
{
    $statement = $pdo->prepare(
        'SELECT * FROM attendance_feed WHERE intern_id = ? ORDER BY attendance_date DESC LIMIT 30'
    );
    $statement->execute([$internId]);
    return array_map('formatRecord', $statement->fetchAll());
}

function todayRecord(PDO $pdo, string $internId): ?array
{
    $statement = $pdo->prepare(
        'SELECT * FROM attendance_feed WHERE intern_id = ? AND attendance_date = ? LIMIT 1'
    );
    $statement->execute([$internId, date('Y-m-d')]);
    $record = $statement->fetch();
    return $record ? formatRecord($record) : null;
}

// ----------------------------------------------------------------------------
// Device linking -- an intern's own device is what actually stops one intern
// clocking another in (buddy punching). The gateway proves *who is signed
// in*; this proves *the device they're clocking in from hasn't already been
// used for someone else*. Deliberately no password/PIN of any kind -- there
// is nothing here for one intern to hand to another.
// ----------------------------------------------------------------------------

const DEVICE_COOKIE = 'rizurf_device_id';

/**
 * The device id lives in a server-issued HttpOnly cookie, never client-side
 * storage -- a value JavaScript can read, it can also reset with one console
 * line (localStorage.clear()), which would defeat the whole check. An
 * HttpOnly cookie is only ever set here, by PHP; the browser just attaches
 * it automatically and a page script cannot touch it.
 */
function resolveDeviceId(): string
{
    $deviceId = $_COOKIE[DEVICE_COOKIE] ?? '';
    if (preg_match('/^[a-f0-9]{32}$/', $deviceId)) {
        return $deviceId;
    }
    $deviceId = bin2hex(random_bytes(16));
    setcookie(DEVICE_COOKIE, $deviceId, [
        'expires' => time() + 60 * 60 * 24 * 365 * 3,
        'path' => '/',
        'httponly' => true,
        'samesite' => 'Lax',
        'secure' => str_starts_with(rtrim((string) env('PUBLIC_URL', ''), '/'), 'https://'),
    ]);
    return $deviceId;
}

/**
 * Whichever intern first clocks in from a device claims it; any other
 * intern's clock-in from that same device is refused from then on,
 * regardless of how they authenticated with the gateway. A new phone is
 * simply a new, unclaimed device -- nothing is bound to hardware, only to
 * "has this device cookie already been used for someone else," so there is
 * no re-linking step when someone's hardware changes. Ends the response
 * with a 409 if the device belongs to a different intern.
 */
function enforceDeviceOwnership(PDO $pdo, string $internId): void
{
    $deviceId = resolveDeviceId();

    $statement = $pdo->prepare('SELECT intern_id FROM device_links WHERE device_id = ?');
    $statement->execute([$deviceId]);
    $ownerId = $statement->fetchColumn();

    if ($ownerId === false) {
        $pdo->prepare('INSERT INTO device_links (device_id, intern_id, user_agent) VALUES (?, ?, ?)')
            ->execute([$deviceId, $internId, $_SERVER['HTTP_USER_AGENT'] ?? null]);
        return;
    }

    if ((string) $ownerId !== $internId) {
        respond(['success' => false, 'message' => 'This device is already linked to a different intern. Use your own device to clock in.'], 409);
    }

    $pdo->prepare('UPDATE device_links SET last_used_at = NOW() WHERE device_id = ?')->execute([$deviceId]);
}

/**
 * A short, human "Chrome on Windows" / "Safari on iPhone" label from a
 * User-Agent string, purely for display in the linked-devices list -- never
 * used for any security decision. Deliberately simple pattern matching, not
 * a full UA parser: good enough to tell devices apart in a short list, not
 * meant to be precise about versions or edge cases.
 */
function deviceFriendlyLabel(?string $userAgent): string
{
    $ua = (string) $userAgent;
    if ($ua === '') {
        return 'Unknown device';
    }

    $os = match (true) {
        (bool) preg_match('/iPhone/i', $ua) => 'iPhone',
        (bool) preg_match('/iPad/i', $ua) => 'iPad',
        (bool) preg_match('/Android/i', $ua) => 'Android',
        (bool) preg_match('/Windows/i', $ua) => 'Windows',
        (bool) preg_match('/Macintosh|Mac OS X/i', $ua) => 'Mac',
        (bool) preg_match('/Linux/i', $ua) => 'Linux',
        default => null,
    };
    $browser = match (true) {
        (bool) preg_match('/EdgA?\//i', $ua) => 'Edge',
        (bool) preg_match('/OPR\/|Opera/i', $ua) => 'Opera',
        (bool) preg_match('/CriOS|Chrome/i', $ua) => 'Chrome',
        (bool) preg_match('/FxiOS|Firefox/i', $ua) => 'Firefox',
        (bool) preg_match('/Safari/i', $ua) => 'Safari',
        default => null,
    };

    if ($browser && $os) {
        return "$browser on $os";
    }
    return $browser ?? $os ?? 'Unknown device';
}

/**
 * "Today at 03:47 PM" / "Yesterday at ..." / "Sep 12 at ...". $timestamp is a
 * DATETIME string already in the app's own local time (the DB session is
 * pinned to DB_TIME_ZONE) -- same technique formatRecord() uses for
 * clock_in/clock_out, not left to the browser's own timezone to guess.
 */
function friendlyLastUsed(string $timestamp): string
{
    $then = strtotime($timestamp);
    if ($then >= strtotime('today')) {
        return 'Today at ' . date('h:i A', $then);
    }
    if ($then >= strtotime('yesterday')) {
        return 'Yesterday at ' . date('h:i A', $then);
    }
    return date('M j', $then) . ' at ' . date('h:i A', $then);
}

/**
 * Every device linked to this intern (across however many phones/laptops
 * they've clocked in from), newest-used first -- the "Linked devices" list.
 */
function internDeviceLinks(PDO $pdo, string $internId): array
{
    $currentDeviceId = $_COOKIE[DEVICE_COOKIE] ?? '';
    $statement = $pdo->prepare(
        'SELECT device_id, user_agent, last_used_at FROM device_links WHERE intern_id = ? ORDER BY last_used_at DESC'
    );
    $statement->execute([$internId]);
    return array_map(static fn (array $row): array => [
        'id' => $row['device_id'],
        'label' => deviceFriendlyLabel($row['user_agent']),
        'lastUsedAt' => friendlyLastUsed($row['last_used_at']),
        'isCurrent' => $row['device_id'] === $currentDeviceId,
    ], $statement->fetchAll());
}

/**
 * Unlink one specific device by id -- from the list, not necessarily the
 * device making the request, mirroring "log out" from another device's
 * session list. Ownership-checked (WHERE ... AND intern_id = ?), so this can
 * only ever remove a device that's actually yours; it cannot be used to
 * bump someone else off their own device. Returns whether a row actually
 * existed to remove.
 */
function releaseDeviceLinkById(PDO $pdo, string $internId, string $deviceId): bool
{
    $statement = $pdo->prepare('DELETE FROM device_links WHERE device_id = ? AND intern_id = ?');
    $statement->execute([$deviceId, $internId]);
    return $statement->rowCount() > 0;
}

// ----------------------------------------------------------------------------
// Tiny JSON HTTP client (used for the gateway + Intern Database).
// Returns [status, decoded body|raw].
// ----------------------------------------------------------------------------
function httpJson(string $method, string $url, array $headers = [], ?array $jsonBody = null, int $timeoutSeconds = 20): array
{
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_TIMEOUT => $timeoutSeconds,
        CURLOPT_CONNECTTIMEOUT => min(10, $timeoutSeconds),
    ]);
    if ($jsonBody !== null) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($jsonBody));
    }
    $raw = curl_exec($ch);
    if ($raw === false) {
        $err = curl_error($ch);
        curl_close($ch);
        throw new RuntimeException("Upstream request failed: $err");
    }
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    $decoded = json_decode((string) $raw, true);
    return [$status, is_array($decoded) ? $decoded : $raw];
}

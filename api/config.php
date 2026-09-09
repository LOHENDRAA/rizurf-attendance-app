<?php

declare(strict_types=1);

// ============================================================================
// Shared config + helpers for the attendance API.
//
// Database: PostgreSQL (Supabase today, self-hosted on the VPS later).
// Interns: resolved live from the Intern Database service - this app stores no
//          intern records (SS-13).
// All settings come from the environment (.env at the repo root), never
// hardcoded here (SS-20).
// ============================================================================

require_once __DIR__ . '/http.php';

date_default_timezone_set(env('TZ', 'Asia/Kuala_Lumpur'));

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

function envOrFail(string $key): string
{
    $value = env($key);
    if ($value === null || $value === '') {
        respond(['success' => false, 'message' => "Server misconfigured: $key is not set."], 500);
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
 * One PDO connection to Postgres, from DATABASE_URL_DIRECT (session-mode /
 * direct string on :5432 - right for a long-lived PHP-FPM process).
 */
function database(): PDO
{
    static $pdo = null;
    if ($pdo !== null) {
        return $pdo;
    }

    $url = envOrFail('DATABASE_URL_DIRECT');
    $parts = parse_url($url);
    if ($parts === false || !isset($parts['host'])) {
        respond(['success' => false, 'message' => 'DATABASE_URL_DIRECT is not a valid connection string.'], 500);
    }

    $host = $parts['host'];
    $port = $parts['port'] ?? 5432;
    $dbname = isset($parts['path']) ? ltrim($parts['path'], '/') : 'postgres';
    $user = isset($parts['user']) ? rawurldecode($parts['user']) : 'postgres';
    $password = isset($parts['pass']) ? rawurldecode($parts['pass']) : '';

    $dsn = "pgsql:host=$host;port=$port;dbname=$dbname;sslmode=require";
    $pdo = new PDO($dsn, $user, $password, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    return $pdo;
}

// ----------------------------------------------------------------------------
// Intern Database service (SS-26 - program-to-program via client_credentials)
// ----------------------------------------------------------------------------

/**
 * A scoped access token for the Intern Database, cached in-process until it
 * expires (roughly an hour). Fetched from the gateway with the API client
 * secret from the environment.
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
        respond(['success' => false, 'message' => 'Could not authenticate with the Intern Database service.'], 502);
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
        respond(['success' => false, 'message' => "Intern Database returned $status for $path."], 502);
    }
    return $body;
}

/** Every intern, one API round of pages, indexed by id. Cached per request. */
function internDirectory(): array
{
    static $byId = null;
    if ($byId !== null) {
        return $byId;
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
// Who is this request for?
//
// THE SEAM. Resolution depends on how the caller authenticated ($GLOBALS['auth']
// set by index.php):
//   - token   : a machine caller (client_credentials). It has no single intern,
//               so it MUST pass ?intern_id= or ?intern_ref=.
//   - session : a signed-in human. Uses app_identities.intern_id for their
//               gateway_sub (NOT BUILT YET - validateAppSession() returns null).
//   - dev     : DEV_ALLOW_NO_AUTH. Uses DEV_GATEWAY_SUB or DEV_INTERN_REF.
// Every query downstream is already keyed by the id this returns.
// ----------------------------------------------------------------------------
function currentInternId(PDO $pdo): string
{
    $auth = $GLOBALS['auth'] ?? ['kind' => 'dev'];

    if ($auth['kind'] === 'token') {
        $explicit = trim((string) ($_GET['intern_id'] ?? ''));
        if ($explicit !== '') {
            if (!preg_match('/^[0-9a-f-]{36}$/i', $explicit)) {
                respond(['success' => false, 'message' => 'intern_id must be a uuid.'], 422);
            }
            return $explicit;
        }
        $ref = trim((string) ($_GET['intern_ref'] ?? ''));
        if ($ref !== '') {
            $internId = internIdByRef($ref);
            if (!$internId) {
                respond(['success' => false, 'message' => "No intern with ref_number \"$ref\"."], 422);
            }
            return $internId;
        }
        respond(['success' => false, 'message' => 'A service caller must pass intern_id or intern_ref.'], 422);
    }

    if ($auth['kind'] === 'session') {
        $sub = (string) ($auth['session']['gateway_sub'] ?? '');
        return internIdForGatewaySub($pdo, $sub);
    }

    $gatewaySub = env('DEV_GATEWAY_SUB');
    if ($gatewaySub !== null && $gatewaySub !== '') {
        return internIdForGatewaySub($pdo, $gatewaySub);
    }

    $ref = env('DEV_INTERN_REF', 'INT-0007');
    $internId = internIdByRef($ref);
    if (!$internId) {
        respond(['success' => false, 'message' => "No intern in the Intern Database with ref_number \"$ref\". Set DEV_INTERN_REF."], 500);
    }
    return $internId;
}

/**
 * The intern id for a gateway identity, from app_identities. If it is not
 * linked yet, resolve it from the Intern Database by email and write it back
 * ("whatever email the gateway signs in with auto-syncs to this app").
 */
function internIdForGatewaySub(PDO $pdo, string $gatewaySub): string
{
    $statement = $pdo->prepare('SELECT intern_id, email_address FROM app_identities WHERE gateway_sub = ?');
    $statement->execute([$gatewaySub]);
    $row = $statement->fetch();
    if (!$row) {
        respond(['success' => false, 'message' => "No app_identities row for \"$gatewaySub\"."], 500);
    }
    if ($row['intern_id']) {
        return (string) $row['intern_id'];
    }
    $internId = internIdByEmail((string) $row['email_address']);
    if (!$internId) {
        respond(['success' => false, 'message' => "No intern in the Intern Database with email {$row['email_address']}."], 500);
    }
    $pdo->prepare('UPDATE app_identities SET intern_id = ?, intern_synced_at = now() WHERE gateway_sub = ?')
        ->execute([$internId, $gatewaySub]);
    return $internId;
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

function officeQr(): string
{
    return env('OFFICE_QR', 'Rizurf_Attandance');
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
// Tiny JSON HTTP client (used for the gateway + Intern Database).
// Returns [status, decoded body|raw].
// ----------------------------------------------------------------------------
function httpJson(string $method, string $url, array $headers = [], ?array $jsonBody = null): array
{
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_TIMEOUT => 20,
        CURLOPT_CONNECTTIMEOUT => 10,
    ]);
    if ($jsonBody !== null) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($jsonBody));
    }
    $raw = curl_exec($ch);
    if ($raw === false) {
        $err = curl_error($ch);
        curl_close($ch);
        respond(['success' => false, 'message' => "Upstream request failed: $err"], 502);
    }
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    $decoded = json_decode((string) $raw, true);
    return [$status, is_array($decoded) ? $decoded : $raw];
}

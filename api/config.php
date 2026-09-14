<?php

/**
 * Loads KEY=VALUE pairs from a .env file into getenv()/$_ENV. No external
 * library -- this project doesn't have Composer set up, and this is the
 * entire feature set a small local app needs. Values already set in the
 * real environment are never overridden by the file.
 */
function loadEnv(string $path): void
{
    if (!is_readable($path)) {
        throw new RuntimeException("Missing .env file at $path -- copy .env.example to .env and fill in your values.");
    }
    foreach (file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
        $line = trim($line);
        if ($line === '' || str_starts_with($line, '#')) {
            continue;
        }
        [$key, $value] = array_pad(explode('=', $line, 2), 2, '');
        $key = trim($key);
        $value = trim($value);
        if (strlen($value) >= 2 && (
            ($value[0] === '"' && $value[-1] === '"') ||
            ($value[0] === "'" && $value[-1] === "'")
        )) {
            $value = substr($value, 1, -1);
        }
        if ($key !== '' && getenv($key) === false) {
            putenv("$key=$value");
            $_ENV[$key] = $value;
        }
    }
}

function env(string $key, $default = null)
{
    $value = getenv($key);
    return $value === false ? $default : $value;
}

loadEnv(dirname(__DIR__) . '/.env');

// PHP's own default (whatever the host happens to be configured with -- this
// XAMPP install's is Europe/Berlin) has nothing to do with where the office
// actually is. Every date()/strtotime() call in this app -- attendance
// timestamps, the on-time/late cutoff, reminder schedules -- must agree
// with the office's real clock, not the server host's.
date_default_timezone_set(env('APP_TIMEZONE', 'Asia/Kuala_Lumpur'));

// -- Loaded from .env -- see .env.example for the template ------------------
define('DB_HOST', env('DB_HOST', '127.0.0.1'));
define('DB_NAME', env('DB_NAME', 'qr_system'));
define('DB_USER', env('DB_USER', 'root'));
define('DB_PASS', env('DB_PASS', ''));

define('OFFICE_QR', env('OFFICE_QR', ''));
define('OFFICE_LATITUDE', (float) env('OFFICE_LATITUDE', 0));
define('OFFICE_LONGITUDE', (float) env('OFFICE_LONGITUDE', 0));
define('OFFICE_RADIUS_METERS', (int) env('OFFICE_RADIUS_METERS', 100));

// Web Push (VAPID) -- lets the server send real browser/OS notifications,
// even when the app isn't open. VAPID_SUBJECT should be a mailto: address
// or a URL identifying who's sending the push, per the Web Push spec.
define('VAPID_PUBLIC_KEY', env('VAPID_PUBLIC_KEY', ''));
define('VAPID_PRIVATE_KEY', env('VAPID_PRIVATE_KEY', ''));
define('VAPID_SUBJECT', env('VAPID_SUBJECT', 'mailto:admin@example.com'));

// Used only by send-reminders.php -- when to nudge about clocking in, and
// how many minutes before shift end to nudge about clocking out.
define('REMINDER_CLOCK_IN_DEADLINE', env('REMINDER_CLOCK_IN_DEADLINE', '09:10'));
define('REMINDER_SHIFT_END', env('REMINDER_SHIFT_END', '18:00'));
define('REMINDER_LEAD_MINUTES', (int) env('REMINDER_LEAD_MINUTES', 15));
// ----------------------------------------------------------------------------

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: http://localhost:5173');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

function respond(array $data, int $code = 200): void
{
    http_response_code($code);
    echo json_encode($data);
    exit;
}

function database(): PDO
{
    $dsn = 'mysql:host=' . DB_HOST . ';dbname=' . DB_NAME . ';charset=utf8mb4';
    $pdo = new PDO($dsn, DB_USER, DB_PASS, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    return $pdo;
}

/**
 * Haversine distance in metres from the configured office location.
 */
function distanceInMeters(float $latitude, float $longitude): float
{
    $earthRadius = 6371000; // metres
    $latFrom = deg2rad(OFFICE_LATITUDE);
    $latTo = deg2rad($latitude);
    $latDelta = deg2rad($latitude - OFFICE_LATITUDE);
    $lngDelta = deg2rad($longitude - OFFICE_LONGITUDE);

    $a = sin($latDelta / 2) ** 2 + cos($latFrom) * cos($latTo) * sin($lngDelta / 2) ** 2;
    $c = 2 * atan2(sqrt($a), sqrt(1 - $a));

    return $earthRadius * $c;
}

/**
 * Recent attendance records for one employee, most recent first.
 */
function currentRecords(PDO $pdo, string $employeeId, int $limit = 30): array
{
    $statement = $pdo->prepare(
        'SELECT * FROM attendance_records WHERE employee_id = ? ORDER BY attendance_date DESC LIMIT ?'
    );
    $statement->bindValue(1, $employeeId);
    $statement->bindValue(2, $limit, PDO::PARAM_INT);
    $statement->execute();

    return array_map('formatRecord', $statement->fetchAll());
}

/**
 * Resolves the employee an incoming request claims to be, from either
 * $_GET['employeeId'] (GET requests) or a decoded JSON body's 'employeeId'
 * (POST requests). There's no password here -- the employee list is just a
 * "who are you" picker on the client -- so this only checks the id is a real
 * employee, never an identity claim beyond that. Ends the request with a 401
 * if missing or unknown.
 */
function resolveEmployee(PDO $pdo, ?string $employeeId): array
{
    $employeeId = trim((string) $employeeId);
    if ($employeeId === '') {
        respond(['success' => false, 'message' => 'Choose who you are before continuing.'], 401);
    }
    $statement = $pdo->prepare('SELECT * FROM employees WHERE id = ?');
    $statement->execute([$employeeId]);
    $employee = $statement->fetch();
    if (!$employee) {
        respond(['success' => false, 'message' => 'Unknown employee. Pick your name again.'], 401);
    }
    return $employee;
}

/**
 * The device id lives in a server-issued, HttpOnly cookie -- not client-side
 * localStorage -- specifically so JavaScript can never read or forge it.
 * A value the client controlled could be reset with one console line
 * (localStorage.setItem(...)) to make a device look "new" on every clock-in,
 * defeating enforceDeviceOwnership() entirely. An HttpOnly cookie is only
 * ever set here, by PHP; the browser just attaches it automatically.
 */
function resolveDeviceId(): string
{
    $deviceId = $_COOKIE['rizurf_device_id'] ?? '';
    if (!preg_match('/^[a-f0-9]{32}$/', $deviceId)) {
        $deviceId = bin2hex(random_bytes(16));
        setcookie('rizurf_device_id', $deviceId, [
            'expires' => time() + 60 * 60 * 24 * 365 * 3,
            'path' => '/',
            'secure' => !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off',
            'httponly' => true,
            'samesite' => 'Lax',
        ]);
    }
    return $deviceId;
}

/**
 * The actual anti-buddy-punching check: a device "claims" whichever
 * employee first clocks in from it, and is refused for any other employee
 * afterward -- regardless of which employee they picked. No password can
 * work around this, because it was never about a password; it's about
 * "has this specific device cookie already been used to clock someone
 * else in." Ends the request with a 409 if the device belongs to someone
 * else.
 */
function enforceDeviceOwnership(PDO $pdo, string $employeeId): void
{
    $deviceId = resolveDeviceId();

    $statement = $pdo->prepare('SELECT employee_id FROM device_registrations WHERE device_id = ?');
    $statement->execute([$deviceId]);
    $ownerId = $statement->fetchColumn();

    if ($ownerId === false) {
        $pdo->prepare('INSERT INTO device_registrations (device_id, employee_id) VALUES (?, ?)')
            ->execute([$deviceId, $employeeId]);
        return;
    }

    if ((string) $ownerId !== (string) $employeeId) {
        respond(['success' => false, 'message' => 'This phone is already linked to a different employee. Use your own phone to clock in.'], 409);
    }

    $pdo->prepare('UPDATE device_registrations SET last_used_at = NOW() WHERE device_id = ?')->execute([$deviceId]);
}

/**
 * Shape a raw attendance_records row for the frontend.
 */
function formatRecord(array $record): array
{
    return [
        'id' => (int) $record['id'],
        'date' => $record['attendance_date'],
        'clockIn' => $record['clock_in'],
        'clockInMode' => $record['clock_in_mode'],
        'clockOut' => $record['clock_out'],
        'clockOutMode' => $record['clock_out_mode'],
        'status' => $record['status'],
    ];
}

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
// timestamps, the on-time/late cutoff, reminder schedules, the lunch break
// window -- must agree with the office's real clock, not the server host's.
date_default_timezone_set(env('APP_TIMEZONE', 'Asia/Kuala_Lumpur'));

// -- Loaded from .env -- see .env.example for the template ------------------
define('DB_HOST', env('DB_HOST', '127.0.0.1'));
define('DB_NAME', env('DB_NAME', 'qr_system'));
define('DB_USER', env('DB_USER', 'root'));
define('DB_PASS', env('DB_PASS', ''));

// This is a single-employee demo app (no login system implemented yet),
// so the "current" employee is read from .env. Replace with real values.
define('EMPLOYEE_ID', (int) env('EMPLOYEE_ID', 1));
define('EMPLOYEE_NAME', env('EMPLOYEE_NAME', 'Alex'));

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

// The lunch break can only be started within this window. Ending it isn't
// time-restricted -- a break started right at LUNCH_BREAK_END is expected to
// run past it, which is exactly what break_overtime_seconds tracks.
define('LUNCH_BREAK_START', env('LUNCH_BREAK_START', '13:00'));
define('LUNCH_BREAK_END', env('LUNCH_BREAK_END', '14:00'));
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
 * Recent attendance records for the current employee, most recent first.
 */
function currentRecords(PDO $pdo, int $limit = 30): array
{
    $statement = $pdo->prepare(
        'SELECT * FROM attendance_records WHERE employee_id = ? ORDER BY attendance_date DESC LIMIT ?'
    );
    $statement->bindValue(1, EMPLOYEE_ID, PDO::PARAM_INT);
    $statement->bindValue(2, $limit, PDO::PARAM_INT);
    $statement->execute();

    return array_map('formatRecord', $statement->fetchAll());
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
        'breakSeconds' => (int) ($record['break_seconds'] ?? 0),
        'breakOvertimeSeconds' => (int) ($record['break_overtime_seconds'] ?? 0),
        'breakActive' => !empty($record['break_started_at']),
        // Needed client-side to tick a live "on break" timer -- breakSeconds
        // above only reflects completed breaks, not the one in progress.
        'breakStartedAt' => $record['break_started_at'],
    ];
}

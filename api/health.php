<?php

declare(strict_types=1);

require_once __DIR__ . '/config.php';

// ============================================================================
// GET /health (RIZURF_API_TEMPLATE.md SS-2). Public, JSON, answers fast.
//   status: ok        - service and every dependency reachable
//           degraded  - service up, a dependency is not
//           down      - the database is unreachable (can't do its job)
// Upstream checks are cached briefly so /health stays under a second.
// ============================================================================

function healthDocument(): array
{
    $checks = [
        'database' => checkDatabase(),
        'gateway' => cachedCheck('gateway', fn () => pingOk(rtrim((string) env('GATEWAY_URL', ''), '/') . '/.well-known/jwks.json')),
        'intern_database' => cachedCheck('intern_database', fn () => pingOk(rtrim((string) env('INTERN_DB_URL', ''), '/') . '/health')),
    ];

    if (!$checks['database']) {
        $status = 'down';
    } elseif (in_array(false, $checks, true)) {
        $status = 'degraded';
    } else {
        $status = 'ok';
    }

    return [
        'status' => $status,
        'service' => env('SERVICE_ID', 'attendance-api'),
        'version' => appVersion(),
        'checks' => $checks,
    ];
}

function checkDatabase(): bool
{
    try {
        return database()->query('SELECT 1')->fetchColumn() !== false;
    } catch (Throwable) {
        return false;
    }
}

/** GET a URL with a tight timeout; true only on a 2xx/3xx. */
function pingOk(string $url): bool
{
    if ($url === '' || !str_starts_with($url, 'http')) {
        return false;
    }
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_NOBODY => true,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT_MS => 1500,
        CURLOPT_CONNECTTIMEOUT_MS => 1200,
    ]);
    curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    return $status >= 200 && $status < 400;
}

/** Memoise an upstream check for 30s in a temp file so cold hits stay cheap. */
function cachedCheck(string $key, callable $probe): bool
{
    $file = sys_get_temp_dir() . "/attendance_health_$key.json";
    $now = time();
    if (is_file($file)) {
        $cached = json_decode((string) file_get_contents($file), true);
        if (is_array($cached) && ($cached['at'] ?? 0) > $now - 30) {
            return (bool) $cached['ok'];
        }
    }
    $ok = (bool) $probe();
    @file_put_contents($file, json_encode(['ok' => $ok, 'at' => $now]));
    return $ok;
}

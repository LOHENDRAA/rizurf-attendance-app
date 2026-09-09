<?php

declare(strict_types=1);

// A JSON API must never render a PHP notice/warning into the response body
// (it did, on Vercel: TZ=:UTC -> Notice -> "headers already sent" cascade ->
// invalid JSON). Log everything, display nothing.
error_reporting(E_ALL);
ini_set('display_errors', '0');
ini_set('log_errors', '1');

// ============================================================================
// Shared HTTP helpers used by the front controller (index.php) and handlers.
//
//  - X-Correlation-ID reused when sent, minted when not, echoed on EVERY
//    response including errors (SS-4).
//  - Every non-2xx from the router goes through sendError(): the SS-5 envelope,
//    never framework HTML.
//  - Cache-Control: no-store on everything (MICROAPP_AUTH.md S7).
// ============================================================================

const CORRELATION_HEADER = 'X-Correlation-ID';

function correlationId(): string
{
    static $cid = null;
    if ($cid !== null) {
        return $cid;
    }
    $headers = function_exists('getallheaders') ? getallheaders() : [];
    $supplied = $headers['X-Correlation-ID'] ?? $headers['x-correlation-id']
        ?? ($_SERVER['HTTP_X_CORRELATION_ID'] ?? '');
    $supplied = is_string($supplied) ? trim($supplied) : '';
    if ($supplied !== '' && strlen($supplied) <= 200) {
        return $cid = $supplied;
    }
    // RFC 4122 v4
    $b = random_bytes(16);
    $b[6] = chr((ord($b[6]) & 0x0f) | 0x40);
    $b[8] = chr((ord($b[8]) & 0x3f) | 0x80);
    return $cid = vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($b), 4));
}

function baseHeaders(): void
{
    header('Content-Type: application/json; charset=utf-8');
    header(CORRELATION_HEADER . ': ' . correlationId());
    header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
    header('Pragma: no-cache');
    header('Expires: 0');
}

function sendJson(int $status, array $payload): never
{
    http_response_code($status);
    baseHeaders();
    echo json_encode($payload, JSON_UNESCAPED_SLASHES);
    exit;
}

/**
 * The one error path (SS-5). `message` must be safe to show a developer - no
 * SQL, stack traces or connection strings.
 */
function sendError(int $status, string $code, string $message, mixed $details = null): never
{
    http_response_code($status);
    baseHeaders();
    echo json_encode([
        'error' => [
            'code' => $code,
            'message' => $message,
            'correlation_id' => correlationId(),
            'details' => $details,
        ],
    ], JSON_UNESCAPED_SLASHES);
    exit;
}

function jsonInput(): array
{
    $raw = file_get_contents('php://input') ?: '';
    $decoded = json_decode($raw, true);
    return is_array($decoded) ? $decoded : [];
}

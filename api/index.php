<?php

declare(strict_types=1);

// ============================================================================
// Front controller. Every request the platform sees goes through here:
//   - X-Correlation-ID on every response (SS-4)
//   - SS-5 error envelope for unrouted paths, wrong methods, auth failures -
//     never framework HTML
//   - /health and /openapi.json are the only public paths (SS-8)
//   - everything else needs a verified gateway token (SS-6/SS-25); a token
//     without the operation's scope is 403, not 401 (SS-7)
// ============================================================================

require_once __DIR__ . '/http.php';
require_once __DIR__ . '/config.php';
require_once __DIR__ . '/gateway.php';
require_once __DIR__ . '/openapi.php';
require_once __DIR__ . '/health.php';

correlationId(); // mint/capture up front so every exit path echoes the same id

set_exception_handler(static function (Throwable $e): void {
    error_log('[attendance-api] ' . $e);
    sendError(500, 'INTERNAL_ERROR', 'Unexpected error.');
});

$path = rtrim(parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/', '/') ?: '/';
$method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');

$routes = [
    '/health' => ['GET'],
    '/openapi.json' => ['GET'],
    '/api/attendance' => ['GET', 'POST'],
    '/api/leave' => ['GET', 'POST'],
];
const PUBLIC_PATHS = ['/health', '/openapi.json'];

// SS-5 - unknown path. Envelope, not HTML.
if (!isset($routes[$path])) {
    sendError(404, 'RESOURCE_NOT_FOUND', "No route for $path.");
}

// SS-5 - path exists, method does not. Checked before auth.
if (!in_array($method, $routes[$path], true)) {
    header('Allow: ' . implode(', ', $routes[$path]));
    sendError(405, 'METHOD_NOT_ALLOWED', "$method is not allowed on $path.");
}

// SS-6 - authenticate anything not public.
$auth = ['kind' => 'public'];
if (!in_array($path, PUBLIC_PATHS, true)) {
    $auth = authenticate();
    if ($auth === null) {
        sendError(401, 'UNAUTHORIZED', 'A valid bearer token is required.');
    }
    // SS-7 - a machine caller's token must carry the operation's scope.
    if ($auth['kind'] === 'token') {
        $required = requiredScopes($path, $method);
        $granted = array_values(array_filter(explode(' ', trim((string) ($auth['claims']['scope'] ?? '')))));
        $missing = array_values(array_diff($required, $granted));
        if ($missing) {
            sendError(403, 'FORBIDDEN', 'Token is missing scope: ' . implode(', ', $missing),
                ['required' => $required, 'granted' => $granted]);
        }
    }
}
$GLOBALS['auth'] = $auth;

// Dispatch.
if ($path === '/health') {
    // SS-2: MUST be 200; the `status` field carries ok / degraded / down.
    sendJson(200, healthDocument());
}
if ($path === '/openapi.json') {
    sendJson(200, openapiDocument());
}
if ($path === '/api/attendance') {
    require __DIR__ . '/attendance.php';
    exit;
}
if ($path === '/api/leave') {
    require __DIR__ . '/leave.php';
    exit;
}

sendError(500, 'INTERNAL_ERROR', 'Route matched but no handler ran.');

// ----------------------------------------------------------------------------

/**
 * A verified gateway access token, or the app's own session, or - only when
 * DEV_ALLOW_NO_AUTH is set (local dev; MUST be unset on the deployment
 * registered with the gateway) - an unauthenticated pass. null => 401.
 */
function authenticate(): ?array
{
    $header = $_SERVER['HTTP_AUTHORIZATION']
        ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION']
        ?? '';
    if ($header === '' && function_exists('getallheaders')) {
        foreach (getallheaders() as $name => $value) {
            if (strcasecmp($name, 'Authorization') === 0) {
                $header = $value;
                break;
            }
        }
    }
    if (preg_match('/^Bearer\s+(\S+)$/i', (string) $header, $match)) {
        try {
            return ['kind' => 'token', 'claims' => verifyGatewayToken($match[1], 'access')];
        } catch (Throwable) {
            return null; // -> 401
        }
    }

    $session = validateAppSession();
    if ($session !== null) {
        return ['kind' => 'session', 'session' => $session];
    }

    if (filter_var(env('DEV_ALLOW_NO_AUTH', ''), FILTER_VALIDATE_BOOL)) {
        return ['kind' => 'dev'];
    }
    return null;
}

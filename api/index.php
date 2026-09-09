<?php

declare(strict_types=1);

// ============================================================================
// Front controller - every request the platform sees goes through here.
//
//   /health, /openapi.json   public JSON (SS-2/SS-3, SS-8)
//   /api/*                   JSON; needs a verified gateway token, the signed
//                            app-session cookie, or DEV_ALLOW_NO_AUTH
//   everything else          the app itself: a signed-in human is served the
//                            SPA shell; anyone else is bounced to the gateway
//                            to sign in and comes straight back (no login
//                            screen of our own - MICROAPP_AUTH.md S4)
//
// X-Correlation-ID on every response (SS-4); SS-5 error envelope for unrouted
// paths / wrong methods / auth failures; Cache-Control: no-store throughout.
// ============================================================================

require_once __DIR__ . '/http.php';
require_once __DIR__ . '/config.php';
require_once __DIR__ . '/gateway.php';
require_once __DIR__ . '/openapi.php';
require_once __DIR__ . '/health.php';

correlationId();

set_exception_handler(static function (Throwable $e): void {
    error_log('[attendance-api] ' . $e);
    sendError(500, 'INTERNAL_ERROR', 'Unexpected error.');
});

const DIST_DIR = __DIR__ . '/../dist';

$path = rtrim(parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/', '/') ?: '/';
$method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');

$routes = [
    '/health' => ['GET'],
    '/openapi.json' => ['GET'],
    '/api/attendance' => ['GET', 'POST'],
    '/api/leave' => ['GET', 'POST'],
    '/api/me' => ['GET'],
];
const PUBLIC_PATHS = ['/health', '/openapi.json'];

// --- 1. The gateway sends the signed-in visitor back here with a one-time code.
if ($path === '/' && isset($_GET['code']) && is_string($_GET['code'])) {
    handleGatewayCallback((string) $_GET['code']);
}

// --- 2. API + docs. Tolerate a legacy ".php" suffix on /api/* paths.
$apiPath = str_ends_with($path, '.php') ? substr($path, 0, -4) : $path;

if (isset($routes[$apiPath])) {
    if (!in_array($method, $routes[$apiPath], true)) {
        header('Allow: ' . implode(', ', $routes[$apiPath]));
        sendError(405, 'METHOD_NOT_ALLOWED', "$method is not allowed on $apiPath.");
    }

    $auth = ['kind' => 'public'];
    if (!in_array($apiPath, PUBLIC_PATHS, true)) {
        $auth = authenticate();
        if ($auth === null) {
            sendError(401, 'UNAUTHORIZED', 'A valid bearer token or app session is required.');
        }
        if ($auth['kind'] === 'token') {
            $required = requiredScopes($apiPath, $method);
            $granted = array_values(array_filter(explode(' ', trim((string) ($auth['claims']['scope'] ?? '')))));
            $missing = array_values(array_diff($required, $granted));
            if ($missing) {
                sendError(403, 'FORBIDDEN', 'Token is missing scope: ' . implode(', ', $missing),
                    ['required' => $required, 'granted' => $granted]);
            }
        }
        if ($auth['kind'] === 'session') {
            // MICROAPP_AUTH.md S5 - the gateway session must still be live, checked
            // every request, no cache. And keep the local identity row fresh (S2).
            if (!gatewaySessionIsLive($auth['session'])) {
                clearAppSession();
                sendError(401, 'UNAUTHORIZED', 'The gateway session has ended.');
            }
            try {
                upsertAppIdentity(database(), $auth['session']);
            } catch (Throwable $e) {
                error_log('[attendance-api] identity upsert: ' . $e);
            }
        }
    }
    $GLOBALS['auth'] = $auth;

    if ($apiPath === '/health') {
        sendJson(200, healthDocument());
    }
    if ($apiPath === '/openapi.json') {
        sendJson(200, openapiDocument());
    }
    if ($apiPath === '/api/me') {
        sendJson(200, currentIdentity());
    }
    if ($apiPath === '/api/attendance') {
        require __DIR__ . '/attendance.php';
        exit;
    }
    if ($apiPath === '/api/leave') {
        require __DIR__ . '/leave.php';
        exit;
    }
}

// --- 3. A built static asset (JS/CSS/icons). No auth - not sensitive, and the
// page that references them is gated anyway. On Vercel these are usually served
// from the filesystem before reaching PHP; this is the fallback.
$candidate = realpath(DIST_DIR . $path);
$distRoot = realpath(DIST_DIR);
if ($path !== '/' && $candidate && $distRoot && str_starts_with($candidate, $distRoot) && is_file($candidate)) {
    serveStaticFile($candidate);
}

// --- 4. A page request. Gate it, then serve the SPA shell.
requirePageSession();
serveAppShell();

// ============================================================================

/** Exchange the code, verify identity, start our own session, land clean. */
function handleGatewayCallback(string $code): never
{
    try {
        $claims = exchangeCodeForIdentity($code);
    } catch (Throwable $e) {
        error_log('[attendance-api] callback: ' . $e);
        redirect(gatewayAuthorizeUrl()); // start over
    }

    issueAppSession($claims);
    try {
        upsertAppIdentity(database(), $claims);
    } catch (Throwable $e) {
        error_log('[attendance-api] callback upsert: ' . $e);
    }

    // Clean URL - the code must not sit in browser history (S4).
    redirect(rtrim((string) envOrFail('PUBLIC_URL'), '/') . '/');
}

/** Session or dev pass for a page. Never returns null - it redirects instead. */
function requirePageSession(): array
{
    if (filter_var(env('DEV_ALLOW_NO_AUTH', ''), FILTER_VALIDATE_BOOL)) {
        return ['kind' => 'dev'];
    }
    $session = validateAppSession();
    if ($session !== null && gatewaySessionIsLive($session)) {
        try {
            upsertAppIdentity(database(), $session);
        } catch (Throwable $e) {
            error_log('[attendance-api] page upsert: ' . $e);
        }
        $GLOBALS['auth'] = ['kind' => 'session', 'session' => $session];
        return $GLOBALS['auth'];
    }
    clearAppSession();
    redirect(gatewayAuthorizeUrl());
}

/**
 * A verified gateway access token, the signed app-session cookie, or - only
 * with DEV_ALLOW_NO_AUTH (local dev; unset on the registered deploy) - an
 * unauthenticated pass. null => 401.
 */
function authenticate(): ?array
{
    $header = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
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
            return null;
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

/** GET /api/me - who the current request is, for the SPA to render. */
function currentIdentity(): array
{
    $auth = $GLOBALS['auth'] ?? ['kind' => 'dev'];
    $session = $auth['session'] ?? [];
    $internId = null;
    try {
        $internId = currentInternId(database());
    } catch (Throwable) {
        // A supervisor / hr user with no intern record - fine.
    }
    return [
        'sub' => $session['sub'] ?? null,
        'email' => $session['email'] ?? null,
        'name' => $session['name'] ?? null,
        'role' => $session['role'] ?? null,
        'intern_id' => $internId,
        'dev' => $auth['kind'] === 'dev',
    ];
}

function redirect(string $url): never
{
    http_response_code(302);
    header('Location: ' . $url);
    header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
    header(CORRELATION_HEADER . ': ' . correlationId());
    exit;
}

function serveAppShell(): never
{
    // Production build moves the shell here (out of dist/ so it is not served
    // statically, ungated). Fall back to dist/index.html for a plain local build.
    $shell = is_file(__DIR__ . '/../app.shell.html')
        ? __DIR__ . '/../app.shell.html'
        : DIST_DIR . '/index.html';

    header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
    header(CORRELATION_HEADER . ': ' . correlationId());
    if (!is_file($shell)) {
        http_response_code(503);
        header('Content-Type: text/plain; charset=utf-8');
        echo "Frontend not built. Run: npm run build";
        exit;
    }
    http_response_code(200);
    header('Content-Type: text/html; charset=utf-8');
    readfile($shell);
    exit;
}

function serveStaticFile(string $file): never
{
    static $types = [
        'js' => 'text/javascript', 'mjs' => 'text/javascript', 'css' => 'text/css',
        'html' => 'text/html', 'json' => 'application/json',
        'webmanifest' => 'application/manifest+json', 'svg' => 'image/svg+xml',
        'png' => 'image/png', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg',
        'gif' => 'image/gif', 'ico' => 'image/x-icon', 'webp' => 'image/webp',
        'woff' => 'font/woff', 'woff2' => 'font/woff2', 'ttf' => 'font/ttf',
        'map' => 'application/json', 'txt' => 'text/plain',
    ];
    $ext = strtolower(pathinfo($file, PATHINFO_EXTENSION));
    http_response_code(200);
    header('Content-Type: ' . ($types[$ext] ?? 'application/octet-stream'));
    header('Cache-Control: public, max-age=31536000, immutable');
    readfile($file);
    exit;
}

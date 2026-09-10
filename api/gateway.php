<?php

declare(strict_types=1);

require_once __DIR__ . '/config.php';

// ============================================================================
// Rizurf gateway token verification (RIZURF_API_TEMPLATE.md SS-25).
//
// Assume every request reached us directly, with no gateway in front. Decide
// who a caller is from the token they present, verified cryptographically
// against the gateway's published key - never from a header or how the request
// arrived. Nothing here trusts `x-authenticated-user` or similar.
// ============================================================================

function base64UrlDecode(string $input): string
{
    $remainder = strlen($input) % 4;
    if ($remainder) {
        $input .= str_repeat('=', 4 - $remainder);
    }
    return base64_decode(strtr($input, '-_', '+/')) ?: '';
}

/** DER length prefix. */
function derLength(int $length): string
{
    if ($length < 0x80) {
        return chr($length);
    }
    $bytes = '';
    while ($length > 0) {
        $bytes = chr($length & 0xff) . $bytes;
        $length >>= 8;
    }
    return chr(0x80 | strlen($bytes)) . $bytes;
}

/** Build a PEM SubjectPublicKeyInfo from a JWK's RSA modulus/exponent. */
function rsaJwkToPem(string $modulusB64Url, string $exponentB64Url): string
{
    $modulus = base64UrlDecode($modulusB64Url);
    $exponent = base64UrlDecode($exponentB64Url);
    // Prepend 0x00 when the high bit is set so the INTEGER stays positive.
    if ($modulus !== '' && (ord($modulus[0]) & 0x80)) {
        $modulus = "\x00" . $modulus;
    }
    if ($exponent !== '' && (ord($exponent[0]) & 0x80)) {
        $exponent = "\x00" . $exponent;
    }
    $encodeInt = static fn (string $value): string => "\x02" . derLength(strlen($value)) . $value;

    $rsaPublicKey = "\x30" . derLength(strlen($encodeInt($modulus) . $encodeInt($exponent)))
        . $encodeInt($modulus) . $encodeInt($exponent);
    $bitString = "\x03" . derLength(strlen($rsaPublicKey) + 1) . "\x00" . $rsaPublicKey;
    // AlgorithmIdentifier for rsaEncryption + NULL params.
    $algorithm = "\x30\x0d\x06\x09\x2a\x86\x48\x86\xf7\x0d\x01\x01\x01\x05\x00";
    $spki = "\x30" . derLength(strlen($algorithm . $bitString)) . $algorithm . $bitString;

    return "-----BEGIN PUBLIC KEY-----\n"
        . chunk_split(base64_encode($spki), 64, "\n")
        . "-----END PUBLIC KEY-----\n";
}

/** The gateway's JWKS, fetched once per process. */
function gatewayJwks(): array
{
    static $jwks = null;
    if ($jwks !== null) {
        return $jwks;
    }
    $gateway = rtrim(envOrFail('GATEWAY_URL'), '/');
    [$status, $body] = httpJson('GET', "$gateway/.well-known/jwks.json");
    if ($status !== 200 || !isset($body['keys']) || !is_array($body['keys'])) {
        throw new RuntimeException('Gateway JWKS unavailable.');
    }
    return $jwks = $body;
}

/**
 * Verify a gateway-issued token. Throws on ANYTHING wrong - an unverifiable
 * token is not a token. `$expectedUse` is "identity" on the sign-in leg,
 * "access" on the API. Checked so a human's sign-in assertion cannot be
 * replayed as a machine credential.
 */
function verifyGatewayToken(string $jwt, string $expectedUse): array
{
    $parts = explode('.', $jwt);
    if (count($parts) !== 3) {
        throw new RuntimeException('Malformed token.');
    }
    [$headerB64, $payloadB64, $signatureB64] = $parts;

    $header = json_decode(base64UrlDecode($headerB64), true);
    if (($header['alg'] ?? null) !== 'RS256') {
        throw new RuntimeException('Unexpected token algorithm.');
    }

    $jwk = null;
    foreach (gatewayJwks()['keys'] as $key) {
        if (($key['kid'] ?? null) === ($header['kid'] ?? null)) {
            $jwk = $key;
            break;
        }
    }
    if ($jwk === null || !isset($jwk['n'], $jwk['e'])) {
        throw new RuntimeException('Unknown signing key.');
    }

    $pem = rsaJwkToPem($jwk['n'], $jwk['e']);
    $verified = openssl_verify("$headerB64.$payloadB64", base64UrlDecode($signatureB64), $pem, OPENSSL_ALGO_SHA256);
    if ($verified !== 1) {
        throw new RuntimeException('Signature does not verify.');
    }

    $claims = json_decode(base64UrlDecode($payloadB64), true);
    if (!is_array($claims)) {
        throw new RuntimeException('Unreadable token claims.');
    }
    // Order per MICROAPP_AUTH.md S9: signature (above), token_use, iss, aud, exp
    // - failing closed on any of them.
    if (($claims['token_use'] ?? null) !== $expectedUse) {
        throw new RuntimeException("Expected a \"$expectedUse\" token.");
    }
    if (($claims['iss'] ?? null) !== rtrim(envOrFail('GATEWAY_URL'), '/')) {
        throw new RuntimeException('Token issuer is not this app\'s gateway.');
    }
    if (($claims['aud'] ?? null) !== env('SERVICE_ID', 'attendance-api')) {
        throw new RuntimeException('Token audience is not this service.');
    }
    if (!isset($claims['exp']) || (int) $claims['exp'] < time()) {
        throw new RuntimeException('Token has expired.');
    }
    return $claims;
}

// ============================================================================
// The sign-in flow (MICROAPP_AUTH.md S4-S8). There is no login screen: an
// unauthenticated visitor is bounced to the gateway, and - because they are
// already signed in there (they opened this app from the gateway) - the gateway
// bounces them straight back with a one-time code. The only thing they see is a
// fast redirect. This app never handles a password.
// ============================================================================

const SESSION_COOKIE = 'rz_attn_session';

/** {GATEWAY_URL}/oauth/authorize for the redirect. redirect_uri is our own
 *  configured PUBLIC_URL, never derived from the request (S8). */
function gatewayAuthorizeUrl(): string
{
    $gateway = rtrim(envOrFail('GATEWAY_URL'), '/');
    $redirect = rtrim(envOrFail('PUBLIC_URL'), '/') . '/';
    return "$gateway/oauth/authorize?redirect_uri=" . rawurlencode($redirect);
}

/** Exchange the one-time code (server-to-server, no client secret - S4) and
 *  return the verified identity claims. Throws on anything wrong. */
function exchangeCodeForIdentity(string $code): array
{
    $gateway = rtrim(envOrFail('GATEWAY_URL'), '/');
    $redirect = rtrim(envOrFail('PUBLIC_URL'), '/') . '/';
    [$status, $body] = httpJson('POST', "$gateway/oauth/token", ['Content-Type: application/json'], [
        'code' => $code,
        'redirect_uri' => $redirect,
    ]);
    if ($status !== 200 || !isset($body['token'])) {
        throw new RuntimeException('Code exchange failed.');
    }
    return verifyGatewayToken($body['token'], 'identity');
}

/** Ask the gateway whether the session behind this request is still alive
 *  (S5). No cache. Fails OPEN on a network error - the session's own expiry is
 *  the backstop for a gateway that stays down. */
function gatewaySessionIsLive(array $session): bool
{
    if (empty($session['sid'])) {
        // The identity token carried no `sid`, so introspection is impossible.
        // Fail OPEN and rely on the session TTL (S6) rather than bricking every
        // request into a redirect loop.
        error_log('[attendance-api] session has no sid - introspection skipped');
        return true;
    }
    $gateway = rtrim(envOrFail('GATEWAY_URL'), '/');
    try {
        [$status, $body] = httpJson('POST', "$gateway/oauth/introspect", ['Content-Type: application/json'], [
            'sid' => $session['sid'],
            'sub' => $session['sub'] ?? null,
        ]);
        if ($status !== 200) {
            return true; // fail open
        }
        return (bool) ($body['active'] ?? false);
    } catch (Throwable) {
        return true; // fail open
    }
}

function sessionHmac(string $payload): string
{
    return hash_hmac('sha256', $payload, envOrFail('SESSION_SECRET'), true);
}

/** Set the signed session cookie (S6): HMAC over the claims, HttpOnly,
 *  SameSite=Lax, Secure on https, short Max-Age. */
function issueAppSession(array $claims): void
{
    $ttl = (int) (env('SESSION_TTL_SECONDS', '900'));
    $data = [
        'sid' => $claims['sid'] ?? null,
        'sub' => $claims['sub'] ?? null,
        'email' => $claims['email'] ?? null,
        'name' => $claims['name'] ?? null,
        'role' => $claims['role'] ?? null,
        'exp' => time() + $ttl,
    ];
    $payload = rtrim(strtr(base64_encode(json_encode($data)), '+/', '-_'), '=');
    $sig = rtrim(strtr(base64_encode(sessionHmac($payload)), '+/', '-_'), '=');
    setcookie(SESSION_COOKIE, "$payload.$sig", [
        'expires' => time() + $ttl,
        'path' => '/',
        'httponly' => true,
        'samesite' => 'Lax',
        'secure' => str_starts_with(rtrim((string) env('PUBLIC_URL', ''), '/'), 'https://'),
    ]);
}

function clearAppSession(): void
{
    setcookie(SESSION_COOKIE, '', ['expires' => 1, 'path' => '/']);
}

/**
 * The app's own session (MICROAPP_AUTH.md S3/S6). Parse the cookie, verify the
 * HMAC in constant time, check expiry. Returns the claims or null - an expired
 * or tampered cookie is treated as absent.
 */
function validateAppSession(): ?array
{
    $raw = $_COOKIE[SESSION_COOKIE] ?? '';
    if (!is_string($raw) || substr_count($raw, '.') !== 1) {
        return null;
    }
    [$payload, $sig] = explode('.', $raw, 2);
    $expected = rtrim(strtr(base64_encode(sessionHmac($payload)), '+/', '-_'), '=');
    if (!hash_equals($expected, $sig)) {
        return null;
    }
    $data = json_decode(base64_decode(strtr($payload, '-_', '+/')) ?: '', true);
    if (!is_array($data) || (int) ($data['exp'] ?? 0) < time()) {
        return null;
    }
    return $data;
}

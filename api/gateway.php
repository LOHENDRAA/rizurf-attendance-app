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
    if (($claims['token_use'] ?? null) !== $expectedUse) {
        throw new RuntimeException("Expected a \"$expectedUse\" token.");
    }
    if (!isset($claims['exp']) || (int) $claims['exp'] < time()) {
        throw new RuntimeException('Token has expired.');
    }
    if (($claims['iss'] ?? null) !== rtrim(envOrFail('GATEWAY_URL'), '/')) {
        throw new RuntimeException('Token issuer is not this app\'s gateway.');
    }
    if (($claims['aud'] ?? null) !== env('SERVICE_ID', 'attendance-api')) {
        throw new RuntimeException('Token audience is not this service.');
    }
    return $claims;
}

/**
 * The app's own session (MICROAPP_AUTH.md). Not built yet - the gateway
 * sign-in flow that issues this cookie is the remaining piece of work. Returns
 * null until then, so browser calls fall through to DEV_ALLOW_NO_AUTH locally
 * and to a 401 on the deployed service.
 */
function validateAppSession(): ?array
{
    return null;
}

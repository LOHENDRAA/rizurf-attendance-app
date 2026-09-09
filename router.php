<?php

// Local dev router. Mirrors vercel.json:
//
//   php -S 127.0.0.1:8000 router.php
//
// A real file under dist/ (the built frontend) is served as-is; everything
// else goes to the PHP front controller, which routes /health, /openapi.json
// and /api/*, and returns the SS-5 404 envelope for anything unknown.

$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';

$static = __DIR__ . '/dist' . $path;
if ($path !== '/' && is_file($static)) {
    return false;
}

require __DIR__ . '/api/index.php';

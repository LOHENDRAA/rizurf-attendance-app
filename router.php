<?php

// Local dev router. Mirrors vercel.json:
//
//   php -S 127.0.0.1:8000 router.php
//
// Everything goes to the PHP front controller, which routes /health,
// /openapi.json and /api/*, serves a built file under dist/ as a static
// asset, and returns the SS-5 404 envelope for anything unknown.
//
// (A `return false` shortcut here to let the built-in server serve dist/
// files directly would need docroot set to dist/ to work -- it isn't, so
// that was 404ing every asset. The front controller's own DIST_DIR fallback
// already serves them correctly, so just defer to it.)

require __DIR__ . '/api/index.php';

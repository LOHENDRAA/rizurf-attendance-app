<?php

$builtIndex = __DIR__ . DIRECTORY_SEPARATOR . 'dist' . DIRECTORY_SEPARATOR . 'index.html';
if (!is_file($builtIndex)) {
    http_response_code(503);
    echo 'The frontend has not been built yet. Run: npm.cmd run build';
    exit;
}
header('Content-Type: text/html; charset=utf-8');
readfile($builtIndex);

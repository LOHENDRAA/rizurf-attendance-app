<?php

require_once __DIR__ . '/config.php';

// ============================================================================
// GET  /api/admin/qr -- the office QR's current value.
// POST /api/admin/qr -- regenerate it (invalidates the old one immediately;
//   whoever's holding the printed/displayed code needs the new one before
//   anyone can clock in via Office again). Admin-only both ways.
// ============================================================================

try {
    requireAdmin();
    $pdo = database();

    if ($_SERVER['REQUEST_METHOD'] === 'GET') {
        respond(['success' => true, 'qr' => officeQr()]);
    }

    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        respond(['success' => false, 'message' => 'Method not allowed.'], 405);
    }

    $auth = $GLOBALS['auth'] ?? [];
    $updatedBy = $auth['session']['email'] ?? $auth['session']['sub'] ?? 'dev';
    $newQr = regenerateOfficeQr($pdo, $updatedBy);
    respond(['success' => true, 'qr' => $newQr]);
} catch (ConfigException $error) {
    throw $error;
} catch (Throwable $error) {
    error_log('[attendance-api] admin-qr: ' . $error);
    respond(['success' => false, 'message' => 'Could not update the office QR.'], 502);
}

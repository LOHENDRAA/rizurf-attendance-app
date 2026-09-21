<?php

require_once __DIR__ . '/config.php';

// ============================================================================
// GET /api/admin/attendance-calendar?month=YYYY-MM -- attendance and late
// counts for every day in the month that has at least one record,
// admin-only, read-only. Powers the admin calendar's day badges.
// ============================================================================

try {
    requireAdmin();
    $pdo = database();

    if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
        respond(['success' => false, 'message' => 'Method not allowed.'], 405);
    }

    $month = trim((string) ($_GET['month'] ?? '')) ?: date('Y-m');
    $parsed = DateTime::createFromFormat('Y-m-d', "$month-01");
    if (!$parsed || $parsed->format('Y-m') !== $month) {
        respond(['success' => false, 'message' => 'Invalid month.'], 422);
    }

    $start = $parsed->format('Y-m-01');
    $end = $parsed->format('Y-m-t');

    respond(['success' => true, 'month' => $month, 'days' => attendanceSummaryForAdmin($pdo, $start, $end)]);
} catch (ConfigException $error) {
    throw $error;
} catch (Throwable $error) {
    error_log('[attendance-api] admin-calendar: ' . $error);
    respond(['success' => false, 'message' => 'Admin service is temporarily unavailable.'], 502);
}

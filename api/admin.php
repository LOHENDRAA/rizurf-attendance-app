<?php

require_once __DIR__ . '/config.php';

// ============================================================================
// GET /api/admin/attendance?date=YYYY-MM-DD -- every intern's attendance for
// one day, admin-only. Defaults to today. Read-only; nothing here writes
// attendance on anyone's behalf.
// ============================================================================

try {
    requireAdmin();
    $pdo = database();

    if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
        respond(['success' => false, 'message' => 'Method not allowed.'], 405);
    }

    $date = trim((string) ($_GET['date'] ?? '')) ?: date('Y-m-d');
    $parsed = DateTime::createFromFormat('Y-m-d', $date);
    if (!$parsed || $parsed->format('Y-m-d') !== $date) {
        respond(['success' => false, 'message' => 'Invalid date.'], 422);
    }

    respond(['success' => true, 'date' => $date, 'records' => allAttendanceForAdmin($pdo, $date)]);
} catch (ConfigException $error) {
    throw $error;
} catch (InternDbException $error) {
    respond(['success' => false, 'message' => 'The Intern Database is unavailable right now - try again shortly.'], 502);
} catch (Throwable $error) {
    error_log('[attendance-api] admin: ' . $error);
    respond(['success' => false, 'message' => 'Admin service is temporarily unavailable.'], 502);
}

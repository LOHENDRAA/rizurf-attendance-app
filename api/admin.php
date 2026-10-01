<?php

require_once __DIR__ . '/config.php';

// ============================================================================
// GET /api/admin/attendance?date=YYYY-MM-DD -- every intern's attendance for
// one day, admin-only. Defaults to today.
// GET /api/admin/attendance?month=YYYY-MM[&status=Late|On time|Excused (MC)]
//   [&intern=<uuid>][&format=csv] -- every matching record across the whole
// month instead of one day, for the "show all late/on-time this month"
// status filter view. format=csv returns the same rows as a downloadable
// CSV (opens directly in Excel) instead of JSON, honoring whatever
// status/intern filter is also given -- so exporting mirrors whatever's
// currently on screen.
// GET ?requests=1 -- pending clock-out corrections; POST settles one.
// ============================================================================

try {
    requireAdmin();
    $pdo = database();

    // POST {id, decision: approve|reject} -- settle a clock-out correction.
    // Approve moves clock_out to the requested time; reject leaves 18:00.
    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        $input = json_decode(file_get_contents('php://input'), true) ?? [];
        $decision = $input['decision'] ?? '';
        if (!in_array($decision, ['approve', 'reject'], true)) {
            respond(['success' => false, 'message' => 'Choose approve or reject.'], 422);
        }
        $update = $pdo->prepare($decision === 'approve'
            ? "UPDATE attendance_records SET clock_out = requested_clock_out, clock_out_request_status = 'Approved' WHERE id = ? AND clock_out_request_status = 'Pending'"
            : "UPDATE attendance_records SET clock_out_request_status = 'Rejected' WHERE id = ? AND clock_out_request_status = 'Pending'");
        $update->execute([(int) ($input['id'] ?? 0)]);
        if ($update->rowCount() !== 1) {
            respond(['success' => false, 'message' => 'That request was already handled.'], 409);
        }
        $find = $pdo->prepare('SELECT intern_id, attendance_date, requested_clock_out FROM attendance_records WHERE id = ?');
        $find->execute([(int) $input['id']]);
        $row = $find->fetch();
        $day = date('D, M j', strtotime($row['attendance_date']));
        notifyInterns($pdo, [$row['intern_id']], $decision === 'approve' ? 'Clock-out request approved' : 'Clock-out request rejected',
            $decision === 'approve'
                ? "Your clock-out on $day is now " . date('g:i A', strtotime($row['requested_clock_out'])) . '.'
                : "Your clock-out on $day stays at 6:00 PM.");
        respond(['success' => true, 'requests' => pendingClockOutRequests($pdo)]);
    }

    if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
        respond(['success' => false, 'message' => 'Method not allowed.'], 405);
    }

    if (isset($_GET['requests'])) {
        respond(['success' => true, 'requests' => pendingClockOutRequests($pdo)]);
    }

    // Every intern, for the admin's filter-by-name dropdown.
    if (isset($_GET['interns'])) {
        $interns = [];
        foreach (internDirectory() as $intern) {
            $interns[] = ['id' => $intern['id'], 'name' => trim(($intern['first_name'] ?? '') . ' ' . ($intern['last_name'] ?? ''))];
        }
        usort($interns, static fn (array $a, array $b): int => strcasecmp($a['name'], $b['name']));
        respond(['success' => true, 'interns' => $interns]);
    }

    $internId = trim((string) ($_GET['intern'] ?? '')) ?: null;
    if ($internId !== null && !preg_match('/^[0-9a-f-]{36}$/i', $internId)) {
        respond(['success' => false, 'message' => 'Invalid intern id.'], 422);
    }
    $status = trim((string) ($_GET['status'] ?? '')) ?: null;
    if ($status !== null && !in_array($status, ['On time', 'Late', 'Excused (MC)'], true)) {
        respond(['success' => false, 'message' => 'Invalid status.'], 422);
    }

    $month = trim((string) ($_GET['month'] ?? ''));
    if ($month !== '') {
        $parsedMonth = DateTime::createFromFormat('Y-m-d', "$month-01");
        if (!$parsedMonth || $parsedMonth->format('Y-m') !== $month) {
            respond(['success' => false, 'message' => 'Invalid month.'], 422);
        }
        $records = allAttendanceForAdminMonth($pdo, $parsedMonth->format('Y-m-01'), $parsedMonth->format('Y-m-t'), $internId, $status);

        if (trim((string) ($_GET['format'] ?? '')) === 'csv') {
            header('Content-Type: text/csv; charset=utf-8');
            header('Content-Disposition: attachment; filename="attendance-' . $month . '.csv"');
            header('Cache-Control: no-store');
            $out = fopen('php://output', 'w');
            fputcsv($out, ['Date', 'Intern', 'Reference', 'Department', 'Clock In', 'Clock Out', 'Mode', 'Status']);
            $directory = internDirectory();
            foreach ($records as $record) {
                $intern = $directory[$record['internId']] ?? null;
                fputcsv($out, [
                    $record['rawDate'],
                    $record['internName'],
                    $record['refNumber'],
                    $intern ? departmentName($intern['department_id'] ?? null) : '',
                    $record['clockIn'],
                    $record['clockOut'],
                    $record['mode'],
                    $record['status'],
                ]);
            }
            fclose($out);
            exit;
        }

        respond(['success' => true, 'month' => $month, 'records' => $records]);
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

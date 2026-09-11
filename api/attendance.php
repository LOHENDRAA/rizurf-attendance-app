<?php

require __DIR__ . '/config.php';

try {
    $pdo = database();
    if ($_SERVER['REQUEST_METHOD'] === 'GET') {
        $records = currentRecords($pdo);
        $todayStatement = $pdo->prepare('SELECT * FROM attendance_records WHERE employee_id = ? AND attendance_date = ? LIMIT 1');
        $todayStatement->execute([EMPLOYEE_ID, date('Y-m-d')]);
        $todayRecord = $todayStatement->fetch();
        respond(['success' => true, 'records' => $records, 'today' => $todayRecord ? formatRecord($todayRecord) : null, 'lunchWindow' => ['start' => LUNCH_BREAK_START, 'end' => LUNCH_BREAK_END]]);
    }

    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        respond(['success' => false, 'message' => 'Method not allowed.'], 405);
    }

    $input = json_decode(file_get_contents('php://input'), true) ?? [];
    $action = $input['action'] ?? '';
    $mode = $input['mode'] ?? '';
    $latitude = isset($input['latitude']) ? (float) $input['latitude'] : null;
    $longitude = isset($input['longitude']) ? (float) $input['longitude'] : null;
    $accuracy = isset($input['accuracy']) ? max(0, (float) $input['accuracy']) : null;

    if (!in_array($action, ['in', 'out', 'break_start', 'break_end'], true)) {
        respond(['success' => false, 'message' => 'Choose a valid attendance action and mode.'], 422);
    }

    $today = date('Y-m-d');
    $now = date('Y-m-d H:i:s');
    $pdo->beginTransaction();
    $find = $pdo->prepare('SELECT * FROM attendance_records WHERE employee_id = ? AND attendance_date = ? FOR UPDATE');
    $find->execute([EMPLOYEE_ID, $today]);
    $existing = $find->fetch();

    if (in_array($action, ['break_start', 'break_end'], true)) {
        if (!$existing || !$existing['clock_in'] || $existing['clock_out']) {
            respond(['success' => false, 'message' => 'Breaks are available only during an active workday.'], 409);
        }
        if ($action === 'break_start') {
            if ($existing['break_started_at']) respond(['success' => false, 'message' => 'A break is already active.'], 409);
            // Lunch break can only be started within the configured window --
            // ending it isn't time-restricted, since a break started right at
            // the edge of the window is expected to run past it (tracked as
            // overtime below).
            $lunchStart = strtotime($today . ' ' . LUNCH_BREAK_START . ':00');
            $lunchEnd = strtotime($today . ' ' . LUNCH_BREAK_END . ':00');
            if (strtotime($now) < $lunchStart || strtotime($now) > $lunchEnd) {
                respond(['success' => false, 'message' => 'Lunch break can only be started between ' . LUNCH_BREAK_START . ' and ' . LUNCH_BREAK_END . '.'], 409);
            }
            $statement = $pdo->prepare('UPDATE attendance_records SET break_started_at = ? WHERE id = ?');
            $statement->execute([$now, $existing['id']]);
            $message = 'Break started.';
        } else {
            if (!$existing['break_started_at']) respond(['success' => false, 'message' => 'No active break to end.'], 409);
            $breakSeconds = max(0, strtotime($now) - strtotime($existing['break_started_at']));
            $lunchEnd = strtotime($today . ' ' . LUNCH_BREAK_END . ':00');
            $breakOvertimeSeconds = max(0, strtotime($now) - max($lunchEnd, strtotime($existing['break_started_at'])));
            $statement = $pdo->prepare('UPDATE attendance_records SET break_started_at = NULL, break_seconds = break_seconds + ?, break_overtime_seconds = break_overtime_seconds + ? WHERE id = ?');
            $statement->execute([$breakSeconds, $breakOvertimeSeconds, $existing['id']]);
            $message = 'Break ended.';
        }
        $pdo->commit();
        $records = currentRecords($pdo);
        $todayStatement = $pdo->prepare('SELECT * FROM attendance_records WHERE employee_id = ? AND attendance_date = ? LIMIT 1');
        $todayStatement->execute([EMPLOYEE_ID, $today]);
        $todayRecord = $todayStatement->fetch();
        respond(['success' => true, 'message' => $message, 'records' => $records, 'today' => $todayRecord ? formatRecord($todayRecord) : null, 'lunchWindow' => ['start' => LUNCH_BREAK_START, 'end' => LUNCH_BREAK_END]]);
    }

    if (!in_array($mode, ['Office', 'Hybrid'], true)) {
        respond(['success' => false, 'message' => 'Choose a valid attendance mode.'], 422);
    }

    if ($mode === 'Office') {
        if (($input['qrToken'] ?? '') !== OFFICE_QR) {
            respond(['success' => false, 'message' => 'The office QR code is invalid.'], 422);
        }
        if ($latitude === null || $longitude === null) {
            respond(['success' => false, 'message' => 'Office attendance needs location permission.'], 422);
        }
        $distance = distanceInMeters($latitude, $longitude);
        // Indoor GPS can be off by tens of metres. A valid office QR plus a
        // position inside the reported accuracy circle is accepted.
        $withinGpsUncertainty = $accuracy !== null && $accuracy > OFFICE_RADIUS_METERS && $distance <= $accuracy;
        if ($distance > OFFICE_RADIUS_METERS && !$withinGpsUncertainty) {
            respond(['success' => false, 'message' => 'You are ' . round($distance) . 'm from the office. You must be within 100m.'], 422);
        }
    }

    $minutes = ((int) date('G') * 60) + (int) date('i');
    $status = ($minutes >= 530 && $minutes <= 550) ? 'On time' : 'Late';

    if ($action === 'in') {
        if ($existing) {
            respond(['success' => false, 'message' => 'You have already clocked in today.'], 409);
        }
        $insert = $pdo->prepare('INSERT INTO attendance_records (employee_id, employee_name, attendance_date, clock_in, clock_in_mode, clock_in_latitude, clock_in_longitude, clock_in_qr, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
        $insert->execute([EMPLOYEE_ID, EMPLOYEE_NAME, $today, $now, $mode, $latitude, $longitude, $mode === 'Office' ? OFFICE_QR : null, $status]);
    } else {
        if (!$existing || !$existing['clock_in']) {
            respond(['success' => false, 'message' => 'Clock in before clocking out.'], 409);
        }
        if ($existing['clock_out']) {
            respond(['success' => false, 'message' => 'You have already clocked out today.'], 409);
        }
        if ($existing['break_started_at']) {
            respond(['success' => false, 'message' => 'End your break before clocking out.'], 409);
        }
        $update = $pdo->prepare('UPDATE attendance_records SET clock_out = ?, clock_out_mode = ?, clock_out_latitude = ?, clock_out_longitude = ?, clock_out_qr = ? WHERE id = ?');
        $update->execute([$now, $mode, $latitude, $longitude, $mode === 'Office' ? OFFICE_QR : null, $existing['id']]);
    }
    $pdo->commit();

    $records = currentRecords($pdo);
    $todayStatement = $pdo->prepare('SELECT * FROM attendance_records WHERE employee_id = ? AND attendance_date = ? LIMIT 1');
    $todayStatement->execute([EMPLOYEE_ID, $today]);
    $todayRecord = $todayStatement->fetch();
    respond(['success' => true, 'message' => $action === 'in' ? ($status . '.') : 'Attendance saved.', 'records' => $records, 'today' => $todayRecord ? formatRecord($todayRecord) : null, 'lunchWindow' => ['start' => LUNCH_BREAK_START, 'end' => LUNCH_BREAK_END]]);
} catch (Throwable $error) {
    if (isset($pdo) && $pdo->inTransaction()) {
        $pdo->rollBack();
    }
    respond(['success' => false, 'message' => 'Database unavailable. Import database/schema.sql and check XAMPP MySQL.'], 500);
}

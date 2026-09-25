<?php

require_once __DIR__ . '/config.php';

try {
    $pdo = database();

    if ($_SERVER['REQUEST_METHOD'] === 'GET') {
        // Reading is soft: a signed-in person who is not a linked intern gets an
        // empty history + linked:false, not an error.
        ['id' => $internId, 'reason' => $reason] = resolveInternId($pdo);
        if ($internId === null) {
            respond([
                'success' => true,
                'linked' => false,
                'reason' => $reason,
                'records' => [],
                'today' => null,
            ]);
        }
        $month = trim((string) ($_GET['month'] ?? ''));
        if ($month !== '') {
            $parsed = DateTime::createFromFormat('Y-m-d', "$month-01");
            if (!$parsed || $parsed->format('Y-m') !== $month) {
                respond(['success' => false, 'message' => 'Invalid month.'], 422);
            }
            $monthStart = $parsed->format('Y-m-01');
            $monthEnd = $parsed->format('Y-m-t');
            respond([
                'success' => true,
                'linked' => true,
                'month' => $month,
                'records' => attendanceForInternMonth($pdo, $internId, $monthStart, $monthEnd),
                'holidays' => companyHolidays($monthStart, $monthEnd),
            ]);
        }

        respond([
            'success' => true,
            'linked' => true,
            'records' => currentRecords($pdo, $internId),
            'today' => todayRecord($pdo, $internId),
        ]);
    }

    // Writing requires a linked intern (ends the response otherwise).
    $internId = currentInternId($pdo);

    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        respond(['success' => false, 'message' => 'Method not allowed.'], 405);
    }

    $input = json_decode(file_get_contents('php://input'), true) ?? [];
    $action = $input['action'] ?? '';
    $mode = $input['mode'] ?? '';
    $latitude = isset($input['latitude']) ? (float) $input['latitude'] : null;
    $longitude = isset($input['longitude']) ? (float) $input['longitude'] : null;
    $accuracy = isset($input['accuracy']) ? max(0, (float) $input['accuracy']) : null;

    if (!in_array($action, ['in', 'out'], true) || !in_array($mode, ['Office', 'Hybrid'], true)) {
        respond(['success' => false, 'message' => 'Choose a valid attendance action and mode.'], 422);
    }

    // The actual anti-buddy-punching check -- a device that already clocked
    // in a different intern is refused here, before anything else happens.
    enforceDeviceOwnership($pdo, $internId);

    if ($mode === 'Office') {
        if (($input['qrToken'] ?? '') !== officeQr()) {
            respond(['success' => false, 'message' => 'The office QR code is invalid.'], 422);
        }
        if ($latitude === null || $longitude === null) {
            respond(['success' => false, 'message' => 'Office attendance needs location permission.'], 422);
        }
        $distance = distanceInMeters($latitude, $longitude);
        // Indoor GPS can be off by tens of metres. A valid office QR plus a
        // position inside the reported accuracy circle is accepted.
        $withinGpsUncertainty = $accuracy !== null && $accuracy > officeRadiusMeters() && $distance <= $accuracy;
        if ($distance > officeRadiusMeters() && !$withinGpsUncertainty) {
            respond(['success' => false, 'message' => 'You are ' . round($distance) . 'm from the office. You must be within ' . round(officeRadiusMeters()) . 'm.'], 422);
        }
    }

    $today = date('Y-m-d');
    $minutes = ((int) date('G') * 60) + (int) date('i');
    $status = ($minutes >= 530 && $minutes <= 550) ? 'On time' : 'Late';
    $qr = $mode === 'Office' ? officeQr() : null;

    $pdo->beginTransaction();
    $find = $pdo->prepare('SELECT * FROM attendance_records WHERE intern_id = ? AND attendance_date = ? FOR UPDATE');
    $find->execute([$internId, $today]);
    $existing = $find->fetch();

    if ($action === 'in') {
        if ($existing) {
            respond(['success' => false, 'message' => 'You have already clocked in today.'], 409);
        }
        $insert = $pdo->prepare(
            'INSERT INTO attendance_records
               (intern_id, attendance_date, clock_in, clock_in_mode,
                clock_in_latitude, clock_in_longitude, clock_in_qr, status)
             VALUES (?, ?, now(), ?, ?, ?, ?, ?)'
        );
        $insert->execute([$internId, $today, $mode, $latitude, $longitude, $qr, $status]);
    } else {
        if (!$existing || !$existing['clock_in']) {
            respond(['success' => false, 'message' => 'Clock in before clocking out.'], 409);
        }
        if ($existing['clock_out']) {
            respond(['success' => false, 'message' => 'You have already clocked out today.'], 409);
        }
        // Clock-out mode must match clock-in mode -- otherwise Office's QR +
        // geofence check (above) only ever applies to whichever mode happens
        // to be submitted, so clocking in at the office and then clocking
        // out via Hybrid skipped it entirely, with nothing to show that the
        // record no longer actually proves an office departure.
        if ($existing['clock_in_mode'] !== $mode) {
            respond(['success' => false, 'message' => "You clocked in via {$existing['clock_in_mode']}. Clock out the same way."], 422);
        }
        $update = $pdo->prepare(
            'UPDATE attendance_records
                SET clock_out = now(), clock_out_mode = ?,
                    clock_out_latitude = ?, clock_out_longitude = ?, clock_out_qr = ?
              WHERE id = ?'
        );
        $update->execute([$mode, $latitude, $longitude, $qr, $existing['id']]);
    }
    $pdo->commit();
    publishInternBadge($pdo, $internId);

    respond([
        'success' => true,
        'message' => $action === 'in' ? ($status . '.') : 'Attendance saved.',
        'records' => currentRecords($pdo, $internId),
        'today' => todayRecord($pdo, $internId),
    ]);
} catch (ConfigException $error) {
    // A missing env var - let the front controller name it (SERVER_MISCONFIGURED).
    throw $error;
} catch (Throwable $error) {
    error_log('[attendance-api] attendance: ' . $error);
    if (isset($pdo) && $pdo->inTransaction()) {
        $pdo->rollBack();
    }
    respond(['success' => false, 'message' => 'Attendance service is temporarily unavailable.'], 502);
}

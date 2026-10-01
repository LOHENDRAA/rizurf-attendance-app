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
            'scheduledMode' => scheduledMode($internId, date('Y-m-d')),
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

    // "I actually left at 18:45" on a day the 18:00 auto clock-out closed.
    // Only stored as a request: clock_out changes only when an admin approves.
    if ($action === 'request_clock_out') {
        $date = (string) ($input['date'] ?? '');
        $time = (string) ($input['time'] ?? '');
        $requested = DateTime::createFromFormat('Y-m-d H:i', "$date $time");
        if (!$requested || $requested->format('Y-m-d H:i') !== "$date $time") {
            respond(['success' => false, 'message' => 'Enter a valid clock-out time.'], 422);
        }
        if ($requested->format('H:i:s') <= AUTO_CLOCK_OUT_TIME || $requested > new DateTime()) {
            respond(['success' => false, 'message' => 'The time must be after 6:00 PM and not in the future.'], 422);
        }
        $update = $pdo->prepare(
            "UPDATE attendance_records SET requested_clock_out = ?, clock_out_request_status = 'Pending'
              WHERE intern_id = ? AND attendance_date = ? AND auto_clocked_out = 1 AND clock_out_request_status IS NULL"
        );
        $update->execute([$requested->format('Y-m-d H:i:s'), $internId, $date]);
        if ($update->rowCount() !== 1) {
            respond(['success' => false, 'message' => 'There is nothing to correct for that day, or a request was already sent.'], 409);
        }
        $intern = internDirectory()[$internId] ?? null;
        $name = $intern ? trim($intern['first_name'] . ' ' . $intern['last_name']) : 'An intern';
        notifyInterns($pdo, adminInternIds($pdo), 'New clock-out request',
            "$name says they clocked out at " . $requested->format('g:i A') . ' on ' . $requested->format('D, M j') . '.');
        respond([
            'success' => true,
            'message' => 'Request sent to the admin.',
            'records' => currentRecords($pdo, $internId),
            'today' => todayRecord($pdo, $internId),
        ]);
    }

    if (!in_array($action, ['in', 'out'], true) || !in_array($mode, ['Office', 'Hybrid'], true)) {
        respond(['success' => false, 'message' => 'Choose a valid attendance action and mode.'], 422);
    }

    // The rota decides how someone may clock in: onsite days need the office
    // QR + GPS. Hybrid/remote days allow either. Not on the rota, or the rota
    // unreachable, means no restriction -- that dependency never blocks
    // attendance. Clock-out already has to match clock-in's mode.
    if ($action === 'in' && $mode === 'Hybrid' && scheduledMode($internId, date('Y-m-d')) === 'onsite') {
        respond(['success' => false, 'message' => 'Please clock in at the office with the QR code.'], 422);
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
    $status = $minutes <= 550 ? 'On time' : 'Late'; // on time up to 09:10, early included
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

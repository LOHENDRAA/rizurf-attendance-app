<?php

require __DIR__ . '/config.php';

try {
    $pdo = database();

    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        respond(['success' => false, 'message' => 'Method not allowed.'], 405);
    }

    $input = json_decode(file_get_contents('php://input'), true) ?? [];
    $action = $input['action'] ?? 'subscribe';

    if ($action === 'unsubscribe') {
        $endpoint = trim($input['endpoint'] ?? '');
        if ($endpoint === '') {
            respond(['success' => false, 'message' => 'Missing endpoint.'], 422);
        }
        $delete = $pdo->prepare('DELETE FROM push_subscriptions WHERE endpoint = ?');
        $delete->execute([$endpoint]);
        respond(['success' => true, 'message' => 'Notifications turned off.']);
    }

    // Flip individual reminder types on/off for a device that's already
    // subscribed -- doesn't touch the push subscription itself.
    if ($action === 'update_preferences') {
        $endpoint = trim($input['endpoint'] ?? '');
        if ($endpoint === '') {
            respond(['success' => false, 'message' => 'Missing endpoint.'], 422);
        }
        $preferences = $input['preferences'] ?? [];
        $update = $pdo->prepare('UPDATE push_subscriptions SET notify_clock_in = ?, notify_clock_out = ?, notify_leave_status = ? WHERE endpoint = ?');
        $update->execute([
            !empty($preferences['clockIn']) ? 1 : 0,
            !empty($preferences['clockOut']) ? 1 : 0,
            !empty($preferences['leaveStatus']) ? 1 : 0,
            $endpoint,
        ]);
        respond(['success' => true, 'message' => 'Notification preferences updated.']);
    }

    $subscription = $input['subscription'] ?? null;
    $endpoint = $subscription['endpoint'] ?? '';
    $p256dh = $subscription['keys']['p256dh'] ?? '';
    $auth = $subscription['keys']['auth'] ?? '';
    $preferences = $input['preferences'] ?? [];
    $notifyClockIn = array_key_exists('clockIn', $preferences) ? (!empty($preferences['clockIn']) ? 1 : 0) : 1;
    $notifyClockOut = array_key_exists('clockOut', $preferences) ? (!empty($preferences['clockOut']) ? 1 : 0) : 1;
    $notifyLeaveStatus = array_key_exists('leaveStatus', $preferences) ? (!empty($preferences['leaveStatus']) ? 1 : 0) : 1;

    if ($endpoint === '' || $p256dh === '' || $auth === '') {
        respond(['success' => false, 'message' => 'Invalid subscription.'], 422);
    }

    $upsert = $pdo->prepare(
        'INSERT INTO push_subscriptions (employee_id, endpoint, p256dh, auth, notify_clock_in, notify_clock_out, notify_leave_status) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE employee_id = VALUES(employee_id), p256dh = VALUES(p256dh), auth = VALUES(auth), notify_clock_in = VALUES(notify_clock_in), notify_clock_out = VALUES(notify_clock_out), notify_leave_status = VALUES(notify_leave_status)'
    );
    $upsert->execute([EMPLOYEE_ID, $endpoint, $p256dh, $auth, $notifyClockIn, $notifyClockOut, $notifyLeaveStatus]);

    respond(['success' => true, 'message' => 'Notifications turned on.']);
} catch (Throwable $error) {
    respond(['success' => false, 'message' => 'Could not save your notification subscription.'], 500);
}

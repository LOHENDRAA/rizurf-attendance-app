<?php

require_once __DIR__ . '/config.php';

// ============================================================================
// Clock-in/out push reminders. A device that turns this on registers its
// browser PushSubscription here; api/cron-reminders.php later sends to
// whatever's on file for an intern who hasn't clocked in/out in time.
// ============================================================================

try {
    $pdo = database();
    $internId = currentInternId($pdo);

    if ($_SERVER['REQUEST_METHOD'] === 'GET') {
        // Whether *this device* is already subscribed -- keyed by endpoint,
        // since that's what the browser gives back for "am I subscribed".
        $endpoint = trim((string) ($_GET['endpoint'] ?? ''));
        if ($endpoint === '') {
            respond(['success' => true, 'subscribed' => false]);
        }
        $statement = $pdo->prepare('SELECT notify_clock_in, notify_clock_out FROM push_subscriptions WHERE endpoint = ? AND intern_id = ?');
        $statement->execute([$endpoint, $internId]);
        $row = $statement->fetch();
        respond(['success' => true, 'subscribed' => (bool) $row]);
    }

    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        respond(['success' => false, 'message' => 'Method not allowed.'], 405);
    }

    $input = json_decode(file_get_contents('php://input'), true) ?? [];
    $action = $input['action'] ?? 'subscribe';

    if ($action === 'unsubscribe') {
        $endpoint = trim((string) ($input['endpoint'] ?? ''));
        if ($endpoint === '') {
            respond(['success' => false, 'message' => 'Missing endpoint.'], 422);
        }
        $pdo->prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND intern_id = ?')
            ->execute([$endpoint, $internId]);
        respond(['success' => true, 'subscribed' => false]);
    }

    $subscription = $input['subscription'] ?? null;
    $endpoint = $subscription['endpoint'] ?? '';
    $p256dh = $subscription['keys']['p256dh'] ?? '';
    $auth = $subscription['keys']['auth'] ?? '';

    if ($endpoint === '' || $p256dh === '' || $auth === '') {
        respond(['success' => false, 'message' => 'Invalid subscription.'], 422);
    }

    // One combined "clock in/out reminder" toggle in the UI -- both flags
    // always move together. Columns stay separate in case that ever changes.
    $upsert = $pdo->prepare(
        'INSERT INTO push_subscriptions (intern_id, endpoint, p256dh, auth, notify_clock_in, notify_clock_out)
         VALUES (?, ?, ?, ?, 1, 1)
         ON DUPLICATE KEY UPDATE intern_id = VALUES(intern_id), p256dh = VALUES(p256dh), auth = VALUES(auth),
           notify_clock_in = 1, notify_clock_out = 1'
    );
    $upsert->execute([$internId, $endpoint, $p256dh, $auth]);

    respond(['success' => true, 'subscribed' => true]);
} catch (ConfigException $error) {
    throw $error;
} catch (Throwable $error) {
    error_log('[attendance-api] subscribe: ' . $error);
    respond(['success' => false, 'message' => 'Could not save your notification subscription.'], 502);
}

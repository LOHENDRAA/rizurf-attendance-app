<?php

require_once __DIR__ . '/config.php';

// api/vendor is committed to git (see .gitignore) rather than left for the
// vercel-php runtime to `composer install` at build time -- confirmed via
// production returning a bare 500 with 6ms execution and zero outgoing
// requests (dying before ever reaching the database) that the runtime
// wasn't reliably installing it for this nested api/ directory. This check
// stays as a guard so a regression names itself instead of a generic 500.
if (!is_file(__DIR__ . '/vendor/autoload.php')) {
    sendError(500, 'SERVER_MISCONFIGURED', 'api/vendor/autoload.php is missing from this deployment.');
}
require_once __DIR__ . '/vendor/autoload.php';

use Minishlink\WebPush\WebPush;
use Minishlink\WebPush\Subscription;

// ============================================================================
// GET /api/cron-reminders -- meant to be hit on a schedule (Vercel Cron; see
// vercel.json), never by a person. Two reminders, each sent at most once per
// intern per day (reminders_sent):
//
//   clock_in  - past REMINDER_CLOCK_IN_DEADLINE, nothing recorded yet today.
//   clock_out - within REMINDER_LEAD_MINUTES of REMINDER_SHIFT_END, clocked
//               in but never clocked out.
//
// Runs entirely off push_subscriptions -- an intern who never turned
// reminders on is never even considered.
//
// vercel.json fires this twice a day, not on an interval: the Hobby plan
// caps a single cron schedule at once/day, so a naive "*/10 * * * *" (the
// original attempt here) fails every deployment outright rather than just
// running less often. Two separate once-daily crons, timed to land inside
// each reminder's own window, cover both checks within that limit -- this
// function still checks both conditions on every run regardless of which
// cron triggered it, so which one fires when doesn't matter functionally.
//
// Vercel Cron schedules are always UTC, never the app's APP_TIMEZONE. With
// the .env.example defaults (Asia/Kuala_Lumpur, UTC+8):
//   "0 1 * * *"   -> 09:00 MYT, matching REMINDER_CLOCK_IN_DEADLINE
//   "0 10 * * *"  -> 18:00 MYT, matching REMINDER_SHIFT_END itself -- the
//                    clock-out window's upper bound gets a few minutes of
//                    grace past shift end (below) so a cron scheduled right
//                    at the boundary isn't missed by a few seconds of
//                    serverless execution delay.
// Change REMINDER_CLOCK_IN_DEADLINE / REMINDER_SHIFT_END and these two
// schedules need updating by hand to match -- they aren't read from env.
// ============================================================================

// A person calling this directly gets the same 401 shape as everything else;
// only `php api/cron-reminders.php` (no HTTP request at all) skips the check.
if (php_sapi_name() !== 'cli') {
    $header = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
    if (!hash_equals('Bearer ' . envOrFail('CRON_SECRET'), (string) $header)) {
        sendError(401, 'UNAUTHORIZED', 'A valid cron secret is required.');
    }
}

/** $preferenceColumn is always one of our own two column names, never input. */
function sendReminderPush(WebPush $webPush, PDO $pdo, string $internId, string $title, string $body, string $preferenceColumn): void
{
    $statement = $pdo->prepare("SELECT * FROM push_subscriptions WHERE intern_id = ? AND $preferenceColumn = 1");
    $statement->execute([$internId]);
    $subscriptions = $statement->fetchAll();
    if (!$subscriptions) {
        return;
    }
    $payload = json_encode(['title' => $title, 'body' => $body]);
    foreach ($subscriptions as $row) {
        $webPush->queueNotification(
            Subscription::create(['endpoint' => $row['endpoint'], 'keys' => ['p256dh' => $row['p256dh'], 'auth' => $row['auth']]]),
            $payload
        );
    }
    try {
        foreach ($webPush->flush() as $report) {
            // The browser itself expired/revoked this one -- stop trying it.
            if (!$report->isSuccess() && in_array($report->getResponse()?->getStatusCode(), [404, 410], true)) {
                $pdo->prepare('DELETE FROM push_subscriptions WHERE endpoint = ?')
                    ->execute([$report->getRequest()->getUri()->__toString()]);
            }
        }
    } catch (Throwable $error) {
        // One malformed subscription must not take down the rest of this run.
        error_log('[attendance-api] cron-reminders: push batch for ' . $title . ' failed: ' . $error->getMessage());
    }
}

function reminderAlreadySentToday(PDO $pdo, string $internId, string $type): bool
{
    $statement = $pdo->prepare('SELECT 1 FROM reminders_sent WHERE intern_id = ? AND reminder_type = ? AND reminder_date = ?');
    $statement->execute([$internId, $type, date('Y-m-d')]);
    return (bool) $statement->fetchColumn();
}

function markReminderSent(PDO $pdo, string $internId, string $type): void
{
    $pdo->prepare('INSERT IGNORE INTO reminders_sent (intern_id, reminder_type, reminder_date) VALUES (?, ?, ?)')
        ->execute([$internId, $type, date('Y-m-d')]);
}

$pdo = database();
$webPush = new WebPush([
    'VAPID' => [
        'subject' => envOrFail('VAPID_SUBJECT'),
        'publicKey' => envOrFail('VAPID_PUBLIC_KEY'),
        'privateKey' => envOrFail('VAPID_PRIVATE_KEY'),
    ],
]);

$now = new DateTime();
$today = $now->format('Y-m-d');
$sent = ['clock_in' => 0, 'clock_out' => 0];

$internIds = $pdo->query('SELECT DISTINCT intern_id FROM push_subscriptions')->fetchAll(PDO::FETCH_COLUMN);
foreach ($internIds as $internId) {
    $todayStatement = $pdo->prepare('SELECT * FROM attendance_records WHERE intern_id = ? AND attendance_date = ? LIMIT 1');
    $todayStatement->execute([$internId, $today]);
    $todayRecord = $todayStatement->fetch();

    $clockInDeadline = DateTime::createFromFormat('Y-m-d H:i', $today . ' ' . env('REMINDER_CLOCK_IN_DEADLINE', '09:00'));
    if ($now >= $clockInDeadline && !$todayRecord && !reminderAlreadySentToday($pdo, $internId, 'clock_in')) {
        sendReminderPush($webPush, $pdo, $internId, "Don't forget to clock in", "You haven't clocked in yet today.", 'notify_clock_in');
        markReminderSent($pdo, $internId, 'clock_in');
        $sent['clock_in']++;
    }

    $shiftEnd = DateTime::createFromFormat('Y-m-d H:i', $today . ' ' . env('REMINDER_SHIFT_END', '18:00'));
    $reminderWindowStart = (clone $shiftEnd)->modify('-' . (int) env('REMINDER_LEAD_MINUTES', '15') . ' minutes');
    // A few minutes of grace past shift end -- the cron is scheduled for
    // exactly this moment, and a strict "<= shiftEnd" would miss the window
    // entirely if the function takes even a few seconds to start running.
    $reminderWindowEnd = (clone $shiftEnd)->modify('+5 minutes');
    if ($now >= $reminderWindowStart && $now <= $reminderWindowEnd && $todayRecord && $todayRecord['clock_in'] && !$todayRecord['clock_out']
        && !reminderAlreadySentToday($pdo, $internId, 'clock_out')) {
        sendReminderPush($webPush, $pdo, $internId, 'Shift ending soon', 'Remember to clock out before you leave.', 'notify_clock_out');
        markReminderSent($pdo, $internId, 'clock_out');
        $sent['clock_out']++;
    }
}

$result = ['success' => true, 'checked' => count($internIds), 'sent' => $sent, 'at' => $now->format('Y-m-d H:i:s')];
if (php_sapi_name() === 'cli') {
    echo json_encode($result, JSON_PRETTY_PRINT), PHP_EOL;
} else {
    sendJson(200, $result);
}

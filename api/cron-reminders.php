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
// vercel.json), never by a person. Four reminders, each sent at most once
// per intern per day (reminders_sent), and each with a lower bound only, no
// upper bound:
//
//   clock_in           - past REMINDER_CLOCK_IN_DEADLINE, nothing recorded
//                         yet today.
//   clock_in_followup  - clock_in already sent today, still nothing
//                         recorded.
//   clock_out          - past REMINDER_SHIFT_END, clocked in but never
//                         clocked out.
//   clock_out_followup - clock_out already sent today, still not clocked
//                         out.
//
// Runs entirely off push_subscriptions -- an intern who never turned
// reminders on is never even considered.
//
// vercel.json fires this four times a day, not on an interval: the Hobby
// plan caps a single cron schedule at once/day, so a naive "*/10 * * * *"
// (the original attempt here) fails every deployment outright rather than
// just running less often. Four separate once-daily crons cover all four
// checks -- this function still evaluates every condition on every run
// regardless of which cron triggered it, so which one fires when doesn't
// matter functionally, and none of the checks need an upper bound:
// reminders_sent already caps each one to once per day, so there's nothing
// to protect against by cutting a check off after some point.
//
// That lower-bound-only shape isn't just simpler, it's required: Vercel's
// own Cron Jobs settings page states Hobby-plan crons run within "a
// flexible time window of 1 hour" of their scheduled time, not on the
// minute. An earlier version of the clock-out check had an upper bound (a
// 17:45-18:05 window), which missed every single real firing -- confirmed
// via reminders_sent never once recording a clock_out send despite
// clock_in (already lower-bound-only) firing correctly every day. The same
// imprecision means each follow-up's "5 minutes after" is best-effort, not
// guaranteed -- on a bad day the gap could be much longer.
//
// Vercel Cron schedules are always UTC, never the app's APP_TIMEZONE. With
// the .env.example defaults (Asia/Kuala_Lumpur, UTC+8):
//   "0 1 * * *"   -> 09:00 MYT, matching REMINDER_CLOCK_IN_DEADLINE
//   "5 1 * * *"   -> 09:05 MYT, the clock-in follow-up
//   "0 10 * * *"  -> 18:00 MYT, matching REMINDER_SHIFT_END
//   "5 10 * * *"  -> 18:05 MYT, the clock-out follow-up
// Change REMINDER_CLOCK_IN_DEADLINE / REMINDER_SHIFT_END and these four
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
$sent = ['clock_in' => 0, 'clock_in_followup' => 0, 'clock_out' => 0, 'clock_out_followup' => 0];

$internIds = $pdo->query('SELECT DISTINCT intern_id FROM push_subscriptions')->fetchAll(PDO::FETCH_COLUMN);
foreach ($internIds as $internId) {
    $todayStatement = $pdo->prepare('SELECT * FROM attendance_records WHERE intern_id = ? AND attendance_date = ? LIMIT 1');
    $todayStatement->execute([$internId, $today]);
    $todayRecord = $todayStatement->fetch();

    // Each reminder has an independent one-shot follow-up, gated on the
    // first having already gone out and still being unresolved -- fired by
    // its own cron entry 5 minutes after the first (vercel.json), not by
    // waiting inside this request. "5 minutes" is best-effort, same as the
    // first reminder's own timing: Vercel Hobby crons land within "a
    // flexible time window of 1 hour" of their scheduled time, not on the
    // minute, so some days the gap will be longer.
    $clockInDeadline = DateTime::createFromFormat('Y-m-d H:i', $today . ' ' . env('REMINDER_CLOCK_IN_DEADLINE', '09:00'));
    $clockInDue = $now >= $clockInDeadline && !$todayRecord;
    if ($clockInDue && !reminderAlreadySentToday($pdo, $internId, 'clock_in')) {
        sendReminderPush($webPush, $pdo, $internId, "Don't forget to clock in", "You haven't clocked in yet today.", 'notify_clock_in');
        markReminderSent($pdo, $internId, 'clock_in');
        $sent['clock_in']++;
    } elseif ($clockInDue && reminderAlreadySentToday($pdo, $internId, 'clock_in')
        && !reminderAlreadySentToday($pdo, $internId, 'clock_in_followup')) {
        sendReminderPush($webPush, $pdo, $internId, 'Still not clocked in', "Second reminder -- you still haven't clocked in today.", 'notify_clock_in');
        markReminderSent($pdo, $internId, 'clock_in_followup');
        $sent['clock_in_followup']++;
    }

    // No upper bound, deliberately -- see the module comment above for why:
    // a narrow window here silently missed every single real firing.
    $shiftEnd = DateTime::createFromFormat('Y-m-d H:i', $today . ' ' . env('REMINDER_SHIFT_END', '18:00'));
    $clockOutDue = $now >= $shiftEnd && $todayRecord && $todayRecord['clock_in'] && !$todayRecord['clock_out'];
    if ($clockOutDue && !reminderAlreadySentToday($pdo, $internId, 'clock_out')) {
        sendReminderPush($webPush, $pdo, $internId, 'Shift ending soon', 'Remember to clock out before you leave.', 'notify_clock_out');
        markReminderSent($pdo, $internId, 'clock_out');
        $sent['clock_out']++;
    } elseif ($clockOutDue && reminderAlreadySentToday($pdo, $internId, 'clock_out')
        && !reminderAlreadySentToday($pdo, $internId, 'clock_out_followup')) {
        sendReminderPush($webPush, $pdo, $internId, 'Still clocked in', "Second reminder -- don't forget to clock out.", 'notify_clock_out');
        markReminderSent($pdo, $internId, 'clock_out_followup');
        $sent['clock_out_followup']++;
    }
}

$result = ['success' => true, 'checked' => count($internIds), 'sent' => $sent, 'at' => $now->format('Y-m-d H:i:s')];
if (php_sapi_name() === 'cli') {
    echo json_encode($result, JSON_PRETTY_PRINT), PHP_EOL;
} else {
    sendJson(200, $result);
}

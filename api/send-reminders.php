<?php
/**
 * Run this on a schedule (every 5-10 minutes) via Windows Task Scheduler,
 * cron, or similar -- see PUSH_NOTIFICATIONS_SETUP.md for how. It has
 * nothing to do with anyone having the app open; that's the whole point.
 *
 * Usage: php send-reminders.php
 */

require __DIR__ . '/config.php';
require __DIR__ . '/vendor/autoload.php';

use Minishlink\WebPush\WebPush;
use Minishlink\WebPush\Subscription;

/**
 * $preferenceColumn is which reminder type this push is for
 * ('notify_clock_in' or 'notify_clock_out') -- only devices that have that
 * type turned on receive it. Always one of our own two hardcoded column
 * names, never user input.
 */
function sendPush(WebPush $webPush, PDO $pdo, string $title, string $body, string $preferenceColumn): void
{
    $statement = $pdo->prepare("SELECT * FROM push_subscriptions WHERE employee_id = ? AND $preferenceColumn = 1");
    $statement->execute([EMPLOYEE_ID]);
    $subscriptions = $statement->fetchAll();
    $payload = json_encode(['title' => $title, 'body' => $body]);

    foreach ($subscriptions as $row) {
        $subscription = Subscription::create([
            'endpoint' => $row['endpoint'],
            'keys' => ['p256dh' => $row['p256dh'], 'auth' => $row['auth']],
        ]);
        $webPush->queueNotification($subscription, $payload);
    }

    try {
        foreach ($webPush->flush() as $report) {
            // A subscription the browser itself has expired/revoked --
            // stop trying to push to it.
            if (!$report->isSuccess() && in_array($report->getResponse()?->getStatusCode(), [404, 410], true)) {
                $endpoint = $report->getRequest()->getUri()->__toString();
                $pdo->prepare('DELETE FROM push_subscriptions WHERE endpoint = ?')->execute([$endpoint]);
            }
        }
    } catch (Throwable $error) {
        // A single malformed/corrupt subscription (e.g. a truncated key)
        // must not take down the rest of this run -- clock-in, clock-out and
        // leave-status checks are independent and each still deserves a try.
        error_log('send-reminders.php: push batch for ' . $title . ' failed: ' . $error->getMessage());
    }
}

function alreadySentToday(PDO $pdo, string $type): bool
{
    $statement = $pdo->prepare('SELECT 1 FROM reminders_sent WHERE employee_id = ? AND reminder_type = ? AND reminder_date = ?');
    $statement->execute([EMPLOYEE_ID, $type, date('Y-m-d')]);
    return (bool) $statement->fetchColumn();
}

function markSent(PDO $pdo, string $type): void
{
    $pdo->prepare('INSERT IGNORE INTO reminders_sent (employee_id, reminder_type, reminder_date) VALUES (?, ?, ?)')
        ->execute([EMPLOYEE_ID, $type, date('Y-m-d')]);
}

$pdo = database();
$webPush = new WebPush([
    'VAPID' => [
        'subject' => VAPID_SUBJECT,
        'publicKey' => VAPID_PUBLIC_KEY,
        'privateKey' => VAPID_PRIVATE_KEY,
    ],
]);

$now = new DateTime();
$today = $now->format('Y-m-d');

$todayStatement = $pdo->prepare('SELECT * FROM attendance_records WHERE employee_id = ? AND attendance_date = ? LIMIT 1');
$todayStatement->execute([EMPLOYEE_ID, $today]);
$todayRecord = $todayStatement->fetch();

// Clock-in reminder: past the deadline, nothing recorded yet today.
$clockInDeadline = DateTime::createFromFormat('Y-m-d H:i', $today . ' ' . REMINDER_CLOCK_IN_DEADLINE);
if ($now >= $clockInDeadline && !$todayRecord && !alreadySentToday($pdo, 'clock_in')) {
    sendPush($webPush, $pdo, 'Don\'t forget to clock in', 'You haven\'t clocked in yet today.', 'notify_clock_in');
    markSent($pdo, 'clock_in');
}

// Clock-out reminder: within REMINDER_LEAD_MINUTES of shift end, clocked
// in but never clocked out.
$shiftEnd = DateTime::createFromFormat('Y-m-d H:i', $today . ' ' . REMINDER_SHIFT_END);
$reminderWindowStart = (clone $shiftEnd)->modify('-' . REMINDER_LEAD_MINUTES . ' minutes');
if ($now >= $reminderWindowStart && $now <= $shiftEnd && $todayRecord && $todayRecord['clock_in'] && !$todayRecord['clock_out'] && !alreadySentToday($pdo, 'clock_out')) {
    sendPush($webPush, $pdo, 'Shift ending soon', 'Remember to clock out before you leave.', 'notify_clock_out');
    markSent($pdo, 'clock_out');
}

// Leave/MC approval updates: a supervisor changes status directly in the
// database (this app has no admin UI), so this is the only place that
// notices it happened -- pick up any decision that hasn't been pushed yet.
$decidedStatement = $pdo->prepare(
    "SELECT * FROM leave_requests WHERE employee_id = ? AND status IN ('Approved', 'Rejected') AND notified_at IS NULL"
);
$decidedStatement->execute([EMPLOYEE_ID]);
foreach ($decidedStatement->fetchAll() as $leaveRequest) {
    $title = $leaveRequest['status'] === 'Approved' ? 'Leave request approved' : 'Leave request rejected';
    $body = $leaveRequest['category'] . ' on ' . $leaveRequest['leave_date'] . ' was ' . strtolower($leaveRequest['status']) . '.';
    sendPush($webPush, $pdo, $title, $body, 'notify_leave_status');
    $pdo->prepare('UPDATE leave_requests SET notified_at = NOW(), reviewed_at = COALESCE(reviewed_at, NOW()) WHERE id = ?')
        ->execute([$leaveRequest['id']]);
}

echo "Reminder check complete at " . $now->format('Y-m-d H:i:s') . "\n";

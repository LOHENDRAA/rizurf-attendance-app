<?php

require __DIR__ . '/config.php';

try {
    $pdo = database();

    if ($_SERVER['REQUEST_METHOD'] === 'GET') {
        $statement = $pdo->prepare('SELECT * FROM leave_requests WHERE employee_id = ? ORDER BY created_at DESC LIMIT 50');
        $statement->execute([EMPLOYEE_ID]);
        $requests = array_map('formatLeaveRequest', $statement->fetchAll());
        respond(['success' => true, 'requests' => $requests]);
    }

    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        respond(['success' => false, 'message' => 'Method not allowed.'], 405);
    }

    $input = json_decode(file_get_contents('php://input'), true) ?? [];
    $leaveDate = trim($input['leaveDate'] ?? '');
    $category = trim($input['category'] ?? '');
    $reason = trim($input['reason'] ?? '');
    $notes = trim($input['notes'] ?? '');
    $attachmentName = trim($input['attachmentName'] ?? '');

    $validCategories = ['Medical Leave/MC', 'Emergency Leave', 'University Event', 'Other'];
    if ($leaveDate === '' || !in_array($category, $validCategories, true)) {
        respond(['success' => false, 'message' => 'Choose a date and a valid category.'], 422);
    }
    if ($category === 'Other' && $reason === '') {
        respond(['success' => false, 'message' => 'Please specify a reason.'], 422);
    }

    $insert = $pdo->prepare(
        'INSERT INTO leave_requests (employee_id, leave_date, category, reason, notes, attachment_name, status) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    $insert->execute([EMPLOYEE_ID, $leaveDate, $category, $reason ?: null, $notes ?: null, $attachmentName ?: null, 'Pending']);

    respond(['success' => true, 'message' => 'Leave request submitted for approval.']);
} catch (Throwable $error) {
    respond(['success' => false, 'message' => 'Database unavailable. Import database/schema.sql and check XAMPP MySQL.'], 500);
}

/**
 * Shape a raw leave_requests row for the frontend. Field names match what
 * App.jsx reads: request.leave_date, category, reason, status.
 */
function formatLeaveRequest(array $record): array
{
    return [
        'id' => (int) $record['id'],
        'leave_date' => $record['leave_date'],
        'category' => $record['category'],
        'reason' => $record['reason'],
        'notes' => $record['notes'],
        'attachmentName' => $record['attachment_name'],
        'status' => $record['status'],
    ];
}

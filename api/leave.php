<?php

require_once __DIR__ . '/config.php';

try {
    $pdo = database();

    if ($_SERVER['REQUEST_METHOD'] === 'GET') {
        ['id' => $internId] = resolveInternId($pdo);
        if ($internId === null) {
            respond(['success' => true, 'linked' => false, 'requests' => []]);
        }
        $statement = $pdo->prepare(
            'SELECT id, leave_date, category, attachment_name, notes, status, created_at
               FROM leave_requests
              WHERE intern_id = ?
              ORDER BY leave_date DESC, created_at DESC
              LIMIT 30'
        );
        $statement->execute([$internId]);
        respond(['success' => true, 'linked' => true, 'requests' => $statement->fetchAll()]);
    }

    $internId = currentInternId($pdo);

    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        respond(['success' => false, 'message' => 'Method not allowed.'], 405);
    }

    $input = json_decode(file_get_contents('php://input'), true) ?? [];
    $leaveDate = trim((string) ($input['leaveDate'] ?? ''));
    $category = trim((string) ($input['category'] ?? ''));
    $attachmentName = trim((string) ($input['attachmentName'] ?? '')) ?: null;
    $notes = trim((string) ($input['notes'] ?? '')) ?: null;
    $categories = ['Medical Leave/MC', 'Emergency Leave', 'University Event'];
    $date = DateTime::createFromFormat('Y-m-d', $leaveDate);

    if (!$date || $date->format('Y-m-d') !== $leaveDate || !in_array($category, $categories, true)) {
        respond(['success' => false, 'message' => 'Enter a valid date and leave category.'], 422);
    }

    $statement = $pdo->prepare(
        'INSERT INTO leave_requests (intern_id, leave_date, category, attachment_name, notes)
         VALUES (?, ?, ?, ?, ?)'
    );
    $statement->execute([$internId, $leaveDate, $category, $attachmentName, $notes]);
    respond(['success' => true, 'message' => 'Request submitted for approval.']);
} catch (ConfigException $error) {
    throw $error;
} catch (Throwable $error) {
    error_log('[attendance-api] leave: ' . $error);
    respond(['success' => false, 'message' => 'Leave service is temporarily unavailable.'], 502);
}

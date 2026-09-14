<?php

require __DIR__ . '/config.php';

try {
    $pdo = database();
    $deviceId = resolveDeviceId();

    if (($_SERVER['REQUEST_METHOD'] ?? '') === 'GET') {
        $statement = $pdo->prepare(
            'SELECT d.employee_id, e.name, d.first_seen_at FROM device_registrations d
             JOIN employees e ON e.id = d.employee_id WHERE d.device_id = ?'
        );
        $statement->execute([$deviceId]);
        $owner = $statement->fetch();
        respond([
            'success' => true,
            'linked' => (bool) $owner,
            'employeeId' => $owner['employee_id'] ?? null,
            'employeeName' => $owner['name'] ?? null,
            'linkedAt' => $owner['first_seen_at'] ?? null,
        ]);
    }

    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
        respond(['success' => false, 'message' => 'Method not allowed.'], 405);
    }

    // Explicitly "adding" a device is the same claim enforceDeviceOwnership()
    // already does on every clock-in -- this just lets someone do it as its
    // own deliberate step (and see the result), rather than only discovering
    // it implicitly the first time they clock in.
    $input = json_decode(file_get_contents('php://input'), true) ?? [];
    $employee = resolveEmployee($pdo, $input['employeeId'] ?? null);
    enforceDeviceOwnership($pdo, $employee['id']);

    respond(['success' => true, 'message' => 'This device is now linked to your account.']);
} catch (Throwable $error) {
    respond(['success' => false, 'message' => 'Could not check device status.'], 500);
}

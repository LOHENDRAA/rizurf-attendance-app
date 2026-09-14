<?php

require __DIR__ . '/config.php';

try {
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') {
        respond(['success' => false, 'message' => 'Method not allowed.'], 405);
    }

    $pdo = database();
    $employees = $pdo->query('SELECT id, name FROM employees ORDER BY name')->fetchAll();
    respond(['success' => true, 'employees' => array_map(fn ($row) => ['id' => (string) $row['id'], 'name' => $row['name']], $employees)]);
} catch (Throwable $error) {
    respond(['success' => false, 'message' => 'Database unavailable. Import database/schema.sql and check XAMPP MySQL.'], 500);
}

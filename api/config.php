<?php

declare(strict_types=1);

date_default_timezone_set('Asia/Kuala_Lumpur');

const DB_HOST = '127.0.0.1';
const DB_NAME = 'qr_system';
const DB_USER = 'root';
const DB_PASSWORD = '';
const EMPLOYEE_ID = 'alex-morgan';
const EMPLOYEE_NAME = 'Alex Morgan';
const OFFICE_LATITUDE = 3.0862205788137413;
const OFFICE_LONGITUDE = 101.69002156884324;
const OFFICE_RADIUS_METERS = 100;
const OFFICE_QR = 'Rizurf_Attandance';

function database(): PDO
{
    static $pdo = null;
    if ($pdo === null) {
        $pdo = new PDO(
            'mysql:host=' . DB_HOST . ';dbname=' . DB_NAME . ';charset=utf8mb4',
            DB_USER,
            DB_PASSWORD,
            [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]
        );
    }
    return $pdo;
}

function respond(array $payload, int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($payload);
    exit;
}

function distanceInMeters(float $latitude, float $longitude): float
{
    $earthRadius = 6371000;
    $latitudeDelta = deg2rad($latitude - OFFICE_LATITUDE);
    $longitudeDelta = deg2rad($longitude - OFFICE_LONGITUDE);
    $a = sin($latitudeDelta / 2) ** 2 + cos(deg2rad(OFFICE_LATITUDE)) * cos(deg2rad($latitude)) * sin($longitudeDelta / 2) ** 2;
    return $earthRadius * 2 * atan2(sqrt($a), sqrt(1 - $a));
}

function formatRecord(array $record): array
{
    return [
        'id' => (string) $record['id'],
        'date' => date('D, M d', strtotime($record['attendance_date'])),
        'clockIn' => $record['clock_in'] ? date('h:i A', strtotime($record['clock_in'])) : '',
        'clockOut' => $record['clock_out'] ? date('h:i A', strtotime($record['clock_out'])) : '',
        'mode' => $record['clock_in_mode'] ?? 'Hybrid',
        'clockOutMode' => $record['clock_out_mode'],
        'status' => !empty($record['approved_mc_id']) ? 'Excused (MC)' : ($record['status'] ?? 'On time'),
    ];
}

function currentRecords(PDO $pdo): array
{
    $statement = $pdo->prepare("SELECT attendance_records.*, approved_mc.id AS approved_mc_id FROM attendance_records LEFT JOIN leave_requests approved_mc ON approved_mc.employee_id = attendance_records.employee_id AND approved_mc.leave_date = attendance_records.attendance_date AND approved_mc.category = 'Medical Leave/MC' AND approved_mc.status = 'Approved' WHERE attendance_records.employee_id = ? ORDER BY attendance_records.attendance_date DESC, attendance_records.id DESC LIMIT 30");
    $statement->execute([EMPLOYEE_ID]);
    return array_map('formatRecord', $statement->fetchAll());
}

CREATE DATABASE IF NOT EXISTS qr_system CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE qr_system;

-- No passwords here on purpose. Identity is just "pick your name" -- the
-- thing that actually stops one intern clocking another in is the device
-- check below, not a login screen.
CREATE TABLE IF NOT EXISTS employees (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- A device "claims" whichever employee first clocks in from it, and is
-- refused for any other employee from then on -- see enforceDeviceOwnership()
-- in config.php. Getting a new phone just claims a fresh, unclaimed device;
-- there's no re-binding step because nothing was ever bound to hardware,
-- only to "has this browser storage been used for someone else already."
CREATE TABLE IF NOT EXISTS device_registrations (
  device_id VARCHAR(100) PRIMARY KEY,
  employee_id VARCHAR(80) NOT NULL,
  first_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX device_registrations_employee (employee_id)
);

CREATE TABLE IF NOT EXISTS attendance_records (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  employee_id VARCHAR(80) NOT NULL,
  employee_name VARCHAR(120) NOT NULL,
  attendance_date DATE NOT NULL,
  clock_in DATETIME NULL,
  clock_out DATETIME NULL,
  clock_in_mode ENUM('Office', 'Hybrid') NULL,
  clock_out_mode ENUM('Office', 'Hybrid') NULL,
  clock_in_latitude DECIMAL(10, 7) NULL,
  clock_in_longitude DECIMAL(10, 7) NULL,
  clock_out_latitude DECIMAL(10, 7) NULL,
  clock_out_longitude DECIMAL(10, 7) NULL,
  clock_in_qr VARCHAR(100) NULL,
  clock_out_qr VARCHAR(100) NULL,
  status ENUM('On time', 'Late', 'Excused (MC)') NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY one_record_per_employee_per_day (employee_id, attendance_date),
  INDEX attendance_date_index (attendance_date)
);

CREATE TABLE IF NOT EXISTS leave_requests (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  employee_id VARCHAR(80) NOT NULL,
  employee_name VARCHAR(120) NOT NULL,
  leave_date DATE NOT NULL,
  category ENUM('Medical Leave/MC', 'Emergency Leave', 'University Event', 'Other') NOT NULL,
  reason VARCHAR(255) NULL,
  attachment_name VARCHAR(255) NULL,
  notes VARCHAR(500) NULL,
  status ENUM('Pending', 'Approved', 'Rejected') NOT NULL DEFAULT 'Pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  reviewed_at DATETIME NULL,
  -- Set once a push has gone out for the current status, so the reminders
  -- script (which just polls for Approved/Rejected rows) never re-notifies
  -- for the same decision on its next run.
  notified_at DATETIME NULL,
  INDEX leave_employee_date (employee_id, leave_date),
  INDEX leave_status (status)
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  employee_id VARCHAR(80) NOT NULL,
  endpoint VARCHAR(500) NOT NULL,
  p256dh VARCHAR(255) NOT NULL,
  auth VARCHAR(255) NOT NULL,
  -- Per-device notification preferences. One row per subscribed device, so
  -- each intern's own device remembers only the reminder types they asked
  -- for; unrelated to other interns' subscriptions.
  notify_clock_in TINYINT(1) NOT NULL DEFAULT 1,
  notify_clock_out TINYINT(1) NOT NULL DEFAULT 1,
  notify_leave_status TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY one_row_per_endpoint (endpoint(255)),
  INDEX push_subscriptions_employee (employee_id)
);

CREATE TABLE IF NOT EXISTS reminders_sent (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  employee_id VARCHAR(80) NOT NULL,
  reminder_type VARCHAR(40) NOT NULL,
  reminder_date DATE NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY one_reminder_per_day (employee_id, reminder_type, reminder_date)
);

INSERT INTO employees (id, name) VALUES
  (1, 'Alex Morgan'),
  (2, 'Jordan Lee')
ON DUPLICATE KEY UPDATE name = VALUES(name);

INSERT INTO attendance_records
  (employee_id, employee_name, attendance_date, clock_in, clock_out, clock_in_mode, clock_out_mode, status)
VALUES
  ('1', 'Alex Morgan', '2026-09-07', '2026-09-07 08:56:00', '2026-09-07 18:02:00', 'Office', 'Office', 'On time'),
  ('1', 'Alex Morgan', '2026-09-04', '2026-09-04 09:18:00', '2026-09-04 18:11:00', 'Office', 'Office', 'Late'),
  ('1', 'Alex Morgan', '2026-09-03', '2026-09-03 08:49:00', '2026-09-03 17:58:00', 'Hybrid', 'Hybrid', 'On time')
ON DUPLICATE KEY UPDATE employee_name = VALUES(employee_name);

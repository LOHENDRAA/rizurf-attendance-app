-- ============================================================================
-- Rizurf Attendance App - MySQL schema (self-hosted VPS)
-- MySQL 8.0.16+ (or MariaDB 10.5+). Import with:
--
--   mysql -u root -p < database/schema.mysql.sql
--
-- Same model as schema.postgres.sql / schema.supabase.sql, in MySQL form:
--   * BIGINT auto-increment PKs (not uuid) - the app treats `id` as opaque.
--   * intern_id is CHAR(36): the uuid the Intern Database service issues.
--   * ENUMs instead of CHECK-in lists; native ON UPDATE CURRENT_TIMESTAMP
--     instead of the set_updated_at() trigger.
--   * No interns table (owned by the Intern Database service, SS-13) and no
--     password column (auth is the Rizurf gateway's, SS-24).
--
-- Time zone: clock_in/clock_out are TIMESTAMP (stored UTC, converted per the
-- session time zone). Run the server or the app connection at '+08:00'
-- (api/config.php does `SET time_zone` on connect) so times display in
-- Asia/Kuala_Lumpur.
-- ============================================================================

CREATE DATABASE IF NOT EXISTS rizurf_attendance
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE rizurf_attendance;


-- ----------------------------------------------------------------------------
-- app_identities - one row per gateway sign-in, linked to an intern id.
-- The server UPSERTs this from the verified identity token; if intern_id is
-- NULL it resolves it from the Intern Database by email and writes it back.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_identities (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  gateway_sub       VARCHAR(255) NOT NULL,
  email_address     VARCHAR(320) NOT NULL,
  full_name         VARCHAR(255) NULL,
  -- The gateway role from the verified identity token: 'admin' / 'hr' /
  -- 'supervisor' / 'user' (MICROAPP_AUTH.md S2). Authorization reads it live
  -- from the token each request; this column is only a synced snapshot for
  -- admin-side queries.
  role              VARCHAR(40)  NULL,
  -- The uuid the Intern Database issued. Not a foreign key - that service owns
  -- the record. NULL until the email match succeeds.
  intern_id         CHAR(36)     NULL,
  intern_synced_at  TIMESTAMP    NULL DEFAULT NULL,
  created_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY app_identities_gateway_sub (gateway_sub),
  -- MySQL allows many NULLs in a UNIQUE index, so this is "at most one identity
  -- per intern" without needing a partial index.
  UNIQUE KEY app_identities_intern (intern_id),
  KEY app_identities_email (email_address)
) ENGINE=InnoDB;


-- ----------------------------------------------------------------------------
-- attendance_records - one row per intern per day.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attendance_records (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  intern_id            CHAR(36) NOT NULL,
  attendance_date      DATE NOT NULL,
  clock_in             TIMESTAMP NULL DEFAULT NULL,
  clock_out            TIMESTAMP NULL DEFAULT NULL,
  -- Per-punch method; a different axis from the intern's overall arrangement
  -- in the Intern Database ('On-site' / 'Remote' / 'Hybrid').
  clock_in_mode        ENUM('Office','Hybrid') NULL,
  clock_out_mode       ENUM('Office','Hybrid') NULL,
  clock_in_latitude    DECIMAL(10,7) NULL,
  clock_in_longitude   DECIMAL(10,7) NULL,
  clock_out_latitude   DECIMAL(10,7) NULL,
  clock_out_longitude  DECIMAL(10,7) NULL,
  clock_in_qr          VARCHAR(100) NULL,
  clock_out_qr         VARCHAR(100) NULL,
  status               ENUM('On time','Late','Excused (MC)') NULL,
  created_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY attendance_one_per_intern_per_day (intern_id, attendance_date),
  KEY attendance_date_idx (attendance_date),
  KEY attendance_intern_idx (intern_id, attendance_date),
  CONSTRAINT attendance_clock_order
    CHECK (clock_out IS NULL OR clock_in IS NULL OR clock_out >= clock_in)
) ENGINE=InnoDB;


-- ----------------------------------------------------------------------------
-- leave_requests - MC / leave submissions.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leave_requests (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  intern_id         CHAR(36) NOT NULL,
  leave_date        DATE NOT NULL,
  category          ENUM('Medical Leave/MC','Emergency Leave','University Event') NOT NULL,
  -- File name shown in the UI; the object lives on disk / object store and
  -- attachment_path holds its key. Keep the directory private - an MC is
  -- sensitive.
  attachment_name   VARCHAR(255) NULL,
  attachment_path   VARCHAR(512) NULL,
  notes             TEXT NULL,
  status            ENUM('Pending','Approved','Rejected') NOT NULL DEFAULT 'Pending',
  -- The supervisor / admin who acted, by gateway identity.
  reviewed_by       VARCHAR(255) NULL,
  reviewed_at       TIMESTAMP NULL DEFAULT NULL,
  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY leave_intern_date_idx (intern_id, leave_date),
  KEY leave_status_idx (status),
  CONSTRAINT leave_reviewed_by_fk FOREIGN KEY (reviewed_by)
    REFERENCES app_identities (gateway_sub) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB;


-- ----------------------------------------------------------------------------
-- attendance_feed - the read model the app renders. An approved Medical
-- Leave/MC on the same day overrides the stored status. Intern name /
-- ref_number are merged in by the app from the Intern Database API.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW attendance_feed AS
SELECT
  a.*,
  (mc.id IS NOT NULL) AS mc_excused,
  CASE WHEN mc.id IS NOT NULL THEN 'Excused (MC)' ELSE a.status END AS effective_status
FROM attendance_records a
LEFT JOIN leave_requests mc
  ON  mc.intern_id  = a.intern_id
  AND mc.leave_date = a.attendance_date
  AND mc.category   = 'Medical Leave/MC'
  AND mc.status     = 'Approved';


-- No seed data. Every intern comes from the Intern Database service; attendance
-- and leave rows are created by the app as interns clock in and file requests.


-- ============================================================================
-- The least-privilege user the app connects as. Run once as root, set the
-- password from the environment, and point DATABASE_URL_DIRECT at it:
--   DATABASE_URL_DIRECT=mysql://rizurf_app:...@127.0.0.1:3306/rizurf_attendance
-- ============================================================================
-- CREATE USER 'rizurf_app'@'%' IDENTIFIED BY 'change-me-in-env';
-- GRANT SELECT, INSERT, UPDATE, DELETE ON rizurf_attendance.* TO 'rizurf_app'@'%';
-- FLUSH PRIVILEGES;

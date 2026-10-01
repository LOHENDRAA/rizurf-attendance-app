-- Adds the auto clock-out / clock-out correction columns to an existing
-- database (fresh installs get them from schema.mysql.sql). The view is
-- recreated because MySQL expands its `a.*` when it is created, so new
-- columns don't appear in it until then.
ALTER TABLE attendance_records
  ADD COLUMN auto_clocked_out TINYINT(1) NOT NULL DEFAULT 0 AFTER status,
  ADD COLUMN requested_clock_out TIMESTAMP NULL DEFAULT NULL AFTER auto_clocked_out,
  ADD COLUMN clock_out_request_status ENUM('Pending','Approved','Rejected') NULL AFTER requested_clock_out;

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

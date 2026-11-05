-- Teachers only (20 Oct 2026). The Teachers section keeps teaching staff only; a separate
-- Staff section (non-teaching staff, staff attendance, leave) will be designed later.
--   1. Staff attendance and leave are removed completely.
--   2. NON_TEACHING records are deleted with everything that hangs off them. Their school
--      logins are revoked (memberships, roles, invitations, sessions, app PINs), except
--      logins that hold the School Admin role. Global user accounts and the audit log stay.
--   3. teachers.staff_type is dropped: every remaining record is a teacher.
DROP TABLE IF EXISTS `staff_attendance`;--> statement-breakpoint
DROP TABLE IF EXISTS `leave_requests`;--> statement-breakpoint
DROP TABLE IF EXISTS `leave_types`;--> statement-breakpoint
UPDATE `teachers` t JOIN `teachers` m ON m.`tenant_id` = t.`tenant_id` AND m.`id` = t.`reporting_manager_id`
  SET t.`reporting_manager_id` = NULL WHERE m.`staff_type` = 'NON_TEACHING';--> statement-breakpoint
UPDATE `attendance_sessions` x JOIN `teachers` t ON t.`tenant_id` = x.`tenant_id` AND t.`id` = x.`teacher_id`
  SET x.`teacher_id` = NULL WHERE t.`staff_type` = 'NON_TEACHING';--> statement-breakpoint
UPDATE `timetable_periods` x JOIN `teachers` t ON t.`tenant_id` = x.`tenant_id` AND t.`id` = x.`teacher_id`
  SET x.`teacher_id` = NULL, x.`teaching_assignment_id` = NULL WHERE t.`staff_type` = 'NON_TEACHING';--> statement-breakpoint
UPDATE `timetable_day_overrides` x JOIN `teachers` t ON t.`tenant_id` = x.`tenant_id` AND t.`id` = x.`teacher_id`
  SET x.`teacher_id` = NULL, x.`teaching_assignment_id` = NULL WHERE t.`staff_type` = 'NON_TEACHING';--> statement-breakpoint
UPDATE `timetable_periods` x JOIN `teaching_assignments` a ON a.`tenant_id` = x.`tenant_id` AND a.`id` = x.`teaching_assignment_id`
  JOIN `teachers` t ON t.`tenant_id` = a.`tenant_id` AND t.`id` = a.`teacher_id`
  SET x.`teaching_assignment_id` = NULL WHERE t.`staff_type` = 'NON_TEACHING';--> statement-breakpoint
UPDATE `timetable_day_overrides` x JOIN `teaching_assignments` a ON a.`tenant_id` = x.`tenant_id` AND a.`id` = x.`teaching_assignment_id`
  JOIN `teachers` t ON t.`tenant_id` = a.`tenant_id` AND t.`id` = a.`teacher_id`
  SET x.`teaching_assignment_id` = NULL WHERE t.`staff_type` = 'NON_TEACHING';--> statement-breakpoint
DELETE x FROM `exam_paper_staff` x JOIN `teachers` t ON t.`tenant_id` = x.`tenant_id` AND t.`id` = x.`teacher_id`
  WHERE t.`staff_type` = 'NON_TEACHING';--> statement-breakpoint
DELETE x FROM `class_class_teachers` x JOIN `teachers` t ON t.`tenant_id` = x.`tenant_id` AND t.`id` = x.`teacher_id`
  WHERE t.`staff_type` = 'NON_TEACHING';--> statement-breakpoint
DELETE x FROM `section_class_teachers` x JOIN `teachers` t ON t.`tenant_id` = x.`tenant_id` AND t.`id` = x.`teacher_id`
  WHERE t.`staff_type` = 'NON_TEACHING';--> statement-breakpoint
DELETE x FROM `teaching_assignments` x JOIN `teachers` t ON t.`tenant_id` = x.`tenant_id` AND t.`id` = x.`teacher_id`
  WHERE t.`staff_type` = 'NON_TEACHING';--> statement-breakpoint
DELETE x FROM `staff_documents` x JOIN `teachers` t ON t.`tenant_id` = x.`tenant_id` AND t.`id` = x.`teacher_id`
  WHERE t.`staff_type` = 'NON_TEACHING';--> statement-breakpoint
DELETE x FROM `teacher_qualifications` x JOIN `teachers` t ON t.`tenant_id` = x.`tenant_id` AND t.`id` = x.`teacher_id`
  WHERE t.`staff_type` = 'NON_TEACHING';--> statement-breakpoint
DELETE x FROM `teacher_history` x JOIN `teachers` t ON t.`tenant_id` = x.`tenant_id` AND t.`id` = x.`teacher_id`
  WHERE t.`staff_type` = 'NON_TEACHING';--> statement-breakpoint
UPDATE `memberships` m JOIN `teachers` t ON t.`tenant_id` = m.`tenant_id` AND t.`membership_id` = m.`id`
  SET m.`status` = 'REVOKED', m.`ended_at` = CURRENT_TIMESTAMP(3)
  WHERE t.`staff_type` = 'NON_TEACHING' AND m.`status` <> 'REVOKED'
    AND NOT EXISTS (
      SELECT 1 FROM `role_assignments` ra JOIN `roles` r ON r.`id` = ra.`role_id`
      WHERE ra.`membership_id` = m.`id` AND ra.`status` = 'ACTIVE' AND r.`code` = 'SCHOOL_ADMIN'
    );--> statement-breakpoint
UPDATE `role_assignments` ra JOIN `memberships` m ON m.`id` = ra.`membership_id`
  JOIN `teachers` t ON t.`tenant_id` = m.`tenant_id` AND t.`membership_id` = m.`id`
  SET ra.`status` = 'REVOKED', ra.`ends_at` = CURRENT_TIMESTAMP(3)
  WHERE t.`staff_type` = 'NON_TEACHING' AND m.`status` = 'REVOKED' AND ra.`status` = 'ACTIVE';--> statement-breakpoint
UPDATE `invitations` i JOIN `memberships` m ON m.`id` = i.`membership_id`
  JOIN `teachers` t ON t.`tenant_id` = m.`tenant_id` AND t.`membership_id` = m.`id`
  SET i.`status` = 'REVOKED'
  WHERE t.`staff_type` = 'NON_TEACHING' AND m.`status` = 'REVOKED' AND i.`status` IN ('PENDING', 'SENT');--> statement-breakpoint
UPDATE `user_sessions` s JOIN `memberships` m ON m.`id` = s.`membership_id`
  JOIN `teachers` t ON t.`tenant_id` = m.`tenant_id` AND t.`membership_id` = m.`id`
  SET s.`revoked_at` = CURRENT_TIMESTAMP(3), s.`revoked_reason` = 'MEMBERSHIP_REVOKED'
  WHERE t.`staff_type` = 'NON_TEACHING' AND m.`status` = 'REVOKED' AND s.`revoked_at` IS NULL;--> statement-breakpoint
DELETE p FROM `app_pins` p JOIN `memberships` m ON m.`id` = p.`membership_id`
  JOIN `teachers` t ON t.`tenant_id` = m.`tenant_id` AND t.`membership_id` = m.`id`
  WHERE t.`staff_type` = 'NON_TEACHING' AND m.`status` = 'REVOKED';--> statement-breakpoint
DELETE FROM `teachers` WHERE `staff_type` = 'NON_TEACHING';--> statement-breakpoint
DROP INDEX `teachers_tenant_type_idx` ON `teachers`;--> statement-breakpoint
ALTER TABLE `teachers` DROP COLUMN `staff_type`;

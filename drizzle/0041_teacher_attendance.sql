-- Teacher attendance (20 Oct 2026): the office marks each teacher per day again, in the
-- Teachers section. staff_attendance was dropped with leave in 0040; this starts empty.
CREATE TABLE IF NOT EXISTS `teacher_attendance` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`teacher_id` char(36) NOT NULL,
	`attendance_date` date NOT NULL,
	`status` enum('PRESENT','ABSENT','LEAVE','LATE','HALF_DAY') NOT NULL,
	`note` varchar(255),
	`marked_by` char(36),
	`version` int NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `teacher_attendance_id` PRIMARY KEY(`id`),
	CONSTRAINT `teacher_attendance_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	CONSTRAINT `teacher_attendance_day_uq` UNIQUE(`tenant_id`,`teacher_id`,`attendance_date`),
	CONSTRAINT `teacher_attendance_teacher_fk` FOREIGN KEY (`tenant_id`,`teacher_id`) REFERENCES `teachers`(`tenant_id`,`id`),
	INDEX `teacher_attendance_date_idx` (`tenant_id`,`attendance_date`)
);

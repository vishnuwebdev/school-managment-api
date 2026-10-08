CREATE TABLE `attendance_corrections` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`record_id` char(36) NOT NULL,
	`old_status_id` char(36) NOT NULL,
	`new_status_id` char(36) NOT NULL,
	`reason` varchar(500) NOT NULL,
	`status` enum('PENDING','APPROVED','REJECTED','AUTO_APPLIED') NOT NULL DEFAULT 'PENDING',
	`requested_by` char(36),
	`requested_at` datetime(3) NOT NULL,
	`decided_by` char(36),
	`decided_at` datetime(3),
	`decision_note` varchar(500),
	`pending_key` varchar(36) GENERATED ALWAYS AS ((IF(`status` = 'PENDING', `record_id`, NULL))) VIRTUAL,
	`version` int NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `attendance_corrections_id` PRIMARY KEY(`id`),
	CONSTRAINT `attendance_corrections_tenant_id_uq` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `attendance_corrections_pending_uq` UNIQUE(`pending_key`)
);
--> statement-breakpoint
CREATE TABLE `attendance_records` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`session_id` char(36) NOT NULL,
	`student_id` char(36) NOT NULL,
	`enrollment_id` char(36) NOT NULL,
	`status_id` char(36) NOT NULL,
	`present_weight` decimal(3,2) NOT NULL,
	`absent_weight` decimal(3,2) NOT NULL,
	`remarks` varchar(500),
	`marked_at` datetime(3) NOT NULL,
	`marked_by` char(36),
	`version` int NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `attendance_records_id` PRIMARY KEY(`id`),
	CONSTRAINT `attendance_records_tenant_id_uq` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `attendance_records_session_student_uq` UNIQUE(`tenant_id`,`session_id`,`student_id`)
);
--> statement-breakpoint
CREATE TABLE `attendance_sessions` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`attendance_type` enum('DAILY','SUBJECT') NOT NULL DEFAULT 'DAILY',
	`academic_year_id` char(36) NOT NULL,
	`class_id` char(36) NOT NULL,
	`section_id` char(36) NOT NULL,
	`session_date` date NOT NULL,
	`subject_offering_id` char(36),
	`teacher_id` char(36),
	`period_label` varchar(40),
	`status` enum('DRAFT','SUBMITTED','FINAL') NOT NULL DEFAULT 'DRAFT',
	`session_key` varchar(200) GENERATED ALWAYS AS ((IF(`attendance_type` = 'DAILY', CONCAT('D:', `academic_year_id`, ':', `section_id`, ':', `session_date`), CONCAT('S:', IFNULL(`subject_offering_id`, ''), ':', `section_id`, ':', `session_date`, ':', IFNULL(`period_label`, ''))))) VIRTUAL,
	`started_at` datetime(3) NOT NULL,
	`started_by` char(36),
	`submitted_at` datetime(3),
	`submitted_by` char(36),
	`approved_at` datetime(3),
	`approved_by` char(36),
	`finalized_at` datetime(3),
	`rejected_at` datetime(3),
	`rejected_by` char(36),
	`rejection_reason` varchar(500),
	`reopened_at` datetime(3),
	`reopened_by` char(36),
	`reopen_reason` varchar(500),
	`version` int NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `attendance_sessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `attendance_sessions_tenant_id_uq` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `attendance_sessions_key_uq` UNIQUE(`tenant_id`,`session_key`)
);
--> statement-breakpoint
CREATE TABLE `attendance_settings` (
	`tenant_id` char(36) NOT NULL,
	`approval_required` boolean NOT NULL DEFAULT false,
	`correction_requires_approval` boolean NOT NULL DEFAULT false,
	`edit_window_days` int NOT NULL DEFAULT 7,
	`defaulter_threshold_percent` decimal(5,2) NOT NULL DEFAULT '75.00',
	`late_counts_as_present` boolean NOT NULL DEFAULT true,
	`version` int NOT NULL DEFAULT 1,
	`updated_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `attendance_settings_tenant_id` PRIMARY KEY(`tenant_id`)
);
--> statement-breakpoint
CREATE TABLE `attendance_statuses` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`code` varchar(32) NOT NULL,
	`name` varchar(80) NOT NULL,
	`category` enum('PRESENT','ABSENT','LATE','HALF_DAY','EXCUSED','LEAVE','OTHER') NOT NULL,
	`counts_as_present` decimal(3,2) NOT NULL DEFAULT '0.00',
	`counts_as_absent` decimal(3,2) NOT NULL DEFAULT '0.00',
	`requires_reason` boolean NOT NULL DEFAULT false,
	`sort_order` int NOT NULL DEFAULT 0,
	`status` enum('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
	`is_system` boolean NOT NULL DEFAULT false,
	`version` int NOT NULL DEFAULT 1,
	`created_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` char(36),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `attendance_statuses_id` PRIMARY KEY(`id`),
	CONSTRAINT `attendance_statuses_tenant_id_uq` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `attendance_statuses_tenant_code_uq` UNIQUE(`tenant_id`,`code`)
);
--> statement-breakpoint
ALTER TABLE `attendance_corrections` ADD CONSTRAINT `attendance_corrections_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `attendance_corrections` ADD CONSTRAINT `attendance_corrections_record_fk` FOREIGN KEY (`tenant_id`,`record_id`) REFERENCES `attendance_records`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `attendance_corrections` ADD CONSTRAINT `attendance_corrections_old_status_fk` FOREIGN KEY (`tenant_id`,`old_status_id`) REFERENCES `attendance_statuses`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `attendance_corrections` ADD CONSTRAINT `attendance_corrections_new_status_fk` FOREIGN KEY (`tenant_id`,`new_status_id`) REFERENCES `attendance_statuses`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `attendance_records` ADD CONSTRAINT `attendance_records_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `attendance_records` ADD CONSTRAINT `attendance_records_session_fk` FOREIGN KEY (`tenant_id`,`session_id`) REFERENCES `attendance_sessions`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `attendance_records` ADD CONSTRAINT `attendance_records_student_fk` FOREIGN KEY (`tenant_id`,`student_id`) REFERENCES `students`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `attendance_records` ADD CONSTRAINT `attendance_records_enrollment_fk` FOREIGN KEY (`tenant_id`,`enrollment_id`) REFERENCES `enrollments`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `attendance_records` ADD CONSTRAINT `attendance_records_status_fk` FOREIGN KEY (`tenant_id`,`status_id`) REFERENCES `attendance_statuses`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `attendance_sessions` ADD CONSTRAINT `attendance_sessions_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `attendance_sessions` ADD CONSTRAINT `attendance_sessions_year_fk` FOREIGN KEY (`tenant_id`,`academic_year_id`) REFERENCES `academic_years`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `attendance_sessions` ADD CONSTRAINT `attendance_sessions_class_fk` FOREIGN KEY (`tenant_id`,`class_id`) REFERENCES `academic_classes`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `attendance_sessions` ADD CONSTRAINT `attendance_sessions_section_fk` FOREIGN KEY (`tenant_id`,`section_id`) REFERENCES `academic_sections`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `attendance_sessions` ADD CONSTRAINT `attendance_sessions_offering_fk` FOREIGN KEY (`tenant_id`,`subject_offering_id`) REFERENCES `subject_offerings`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `attendance_sessions` ADD CONSTRAINT `attendance_sessions_teacher_fk` FOREIGN KEY (`tenant_id`,`teacher_id`) REFERENCES `teachers`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `attendance_settings` ADD CONSTRAINT `attendance_settings_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `attendance_statuses` ADD CONSTRAINT `attendance_statuses_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `attendance_corrections_record_idx` ON `attendance_corrections` (`tenant_id`,`record_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `attendance_corrections_state_idx` ON `attendance_corrections` (`tenant_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `attendance_records_student_idx` ON `attendance_records` (`tenant_id`,`student_id`);--> statement-breakpoint
CREATE INDEX `attendance_records_status_idx` ON `attendance_records` (`tenant_id`,`status_id`);--> statement-breakpoint
CREATE INDEX `attendance_records_enrollment_idx` ON `attendance_records` (`tenant_id`,`enrollment_id`);--> statement-breakpoint
CREATE INDEX `attendance_sessions_section_date_idx` ON `attendance_sessions` (`tenant_id`,`section_id`,`session_date`);--> statement-breakpoint
CREATE INDEX `attendance_sessions_date_idx` ON `attendance_sessions` (`tenant_id`,`session_date`,`status`);--> statement-breakpoint
CREATE INDEX `attendance_sessions_year_date_idx` ON `attendance_sessions` (`tenant_id`,`academic_year_id`,`session_date`);--> statement-breakpoint
CREATE INDEX `attendance_statuses_tenant_state_idx` ON `attendance_statuses` (`tenant_id`,`status`,`sort_order`);
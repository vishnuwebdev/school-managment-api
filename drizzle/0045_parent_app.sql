-- Parent app (1 Nov 2026). Parents sign in with their mobile number (or email) and see their
-- children's attendance, results, fees and school notices.
--   users.login_phone: the mobile number a parent signs in with (unique, digits only).
--   enrollments.roll_number: a student's roll number in the class / section for the year.
--   exam_student_remarks: the class teacher's report-card remark, shared with parents or not.
--   notices / notice_receipts: notices for parents (office or teacher) and who read / acknowledged.
ALTER TABLE `users` ADD `login_phone` varchar(20);--> statement-breakpoint
CREATE UNIQUE INDEX `users_login_phone_uq` ON `users` (`login_phone`);--> statement-breakpoint
ALTER TABLE `enrollments` ADD `roll_number` varchar(16);--> statement-breakpoint
ALTER TABLE `files` MODIFY COLUMN `purpose` enum('LOGO','BANNER','DOCUMENT_HEADER','STUDENT_PHOTO','STUDENT_DOCUMENT','STAFF_PHOTO','STAFF_DOCUMENT','STUDENT_CERTIFICATE','PAYMENT_PROOF','NOTICE_ATTACHMENT') NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `exam_student_remarks` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`exam_id` char(36) NOT NULL,
	`student_id` char(36) NOT NULL,
	`remark` varchar(1000) NOT NULL,
	`share_with_parent` boolean NOT NULL DEFAULT false,
	`teacher_id` char(36),
	`created_by` char(36),
	`updated_by` char(36),
	`version` int NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `exam_student_remarks_id` PRIMARY KEY(`id`),
	CONSTRAINT `exam_student_remarks_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	CONSTRAINT `exam_student_remarks_exam_fk` FOREIGN KEY (`tenant_id`,`exam_id`) REFERENCES `exams`(`tenant_id`,`id`),
	CONSTRAINT `exam_student_remarks_student_fk` FOREIGN KEY (`tenant_id`,`student_id`) REFERENCES `students`(`tenant_id`,`id`),
	CONSTRAINT `exam_student_remarks_uq` UNIQUE(`tenant_id`,`exam_id`,`student_id`),
	INDEX `exam_student_remarks_student_idx` (`tenant_id`,`student_id`)
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `notices` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`category` enum('NOTICE','CIRCULAR','ANNOUNCEMENT','EVENT') NOT NULL DEFAULT 'NOTICE',
	`title` varchar(150) NOT NULL,
	`summary` varchar(300) NOT NULL,
	`body` text NOT NULL,
	`audience` enum('SCHOOL','CLASSES','SECTIONS') NOT NULL DEFAULT 'SCHOOL',
	`class_ids` json,
	`section_ids` json,
	`attachment_file_id` char(36),
	`requires_acknowledgement` boolean NOT NULL DEFAULT false,
	`event_date` date,
	`event_title` varchar(120),
	`event_subtitle` varchar(160),
	`publish_at` datetime(3) NOT NULL,
	`status` enum('ACTIVE','CANCELLED') NOT NULL DEFAULT 'ACTIVE',
	`teacher_id` char(36),
	`posted_by_name` varchar(150) NOT NULL,
	`cancelled_at` datetime(3),
	`cancel_reason` varchar(500),
	`created_by` char(36),
	`updated_by` char(36),
	`version` int NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `notices_id` PRIMARY KEY(`id`),
	CONSTRAINT `notices_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	CONSTRAINT `notices_tenant_id_uq` UNIQUE(`tenant_id`,`id`),
	INDEX `notices_publish_idx` (`tenant_id`,`status`,`publish_at`),
	INDEX `notices_teacher_idx` (`tenant_id`,`teacher_id`)
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `notice_receipts` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`notice_id` char(36) NOT NULL,
	`guardian_id` char(36) NOT NULL,
	`read_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`acknowledged_at` datetime(3),
	`acknowledged_by` char(36),
	CONSTRAINT `notice_receipts_id` PRIMARY KEY(`id`),
	CONSTRAINT `notice_receipts_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	CONSTRAINT `notice_receipts_notice_fk` FOREIGN KEY (`tenant_id`,`notice_id`) REFERENCES `notices`(`tenant_id`,`id`),
	CONSTRAINT `notice_receipts_uq` UNIQUE(`tenant_id`,`notice_id`,`guardian_id`),
	INDEX `notice_receipts_guardian_idx` (`tenant_id`,`guardian_id`)
);

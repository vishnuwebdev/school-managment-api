CREATE TABLE `academic_classes` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`code` varchar(32) NOT NULL,
	`name` varchar(100) NOT NULL,
	`display_name` varchar(100),
	`sequence` int NOT NULL DEFAULT 0,
	`status` enum('ACTIVE','INACTIVE','ARCHIVED') NOT NULL DEFAULT 'ACTIVE',
	`version` int NOT NULL DEFAULT 1,
	`created_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `academic_classes_id` PRIMARY KEY(`id`),
	CONSTRAINT `academic_classes_tenant_id_uq` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `academic_classes_tenant_code_uq` UNIQUE(`tenant_id`,`code`)
);
--> statement-breakpoint
CREATE TABLE `academic_sections` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`academic_year_id` char(36) NOT NULL,
	`class_id` char(36) NOT NULL,
	`code` varchar(32) NOT NULL,
	`name` varchar(100) NOT NULL,
	`capacity` int,
	`status` enum('DRAFT','ACTIVE','CLOSED','ARCHIVED') NOT NULL DEFAULT 'ACTIVE',
	`version` int NOT NULL DEFAULT 1,
	`created_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `academic_sections_id` PRIMARY KEY(`id`),
	CONSTRAINT `academic_sections_tenant_id_uq` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `academic_sections_code_uq` UNIQUE(`tenant_id`,`academic_year_id`,`class_id`,`code`)
);
--> statement-breakpoint
CREATE TABLE `academic_years` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`code` varchar(32) NOT NULL,
	`name` varchar(120) NOT NULL,
	`start_date` date NOT NULL,
	`end_date` date NOT NULL,
	`status` enum('DRAFT','UPCOMING','ACTIVE','COMPLETED','ARCHIVED') NOT NULL DEFAULT 'DRAFT',
	`is_current` boolean NOT NULL DEFAULT false,
	`current_key` varchar(36) GENERATED ALWAYS AS ((IF(`is_current`, `tenant_id`, NULL))) VIRTUAL,
	`activated_at` datetime(3),
	`completed_at` datetime(3),
	`archived_at` datetime(3),
	`version` int NOT NULL DEFAULT 1,
	`created_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `academic_years_id` PRIMARY KEY(`id`),
	CONSTRAINT `academic_years_tenant_id_uq` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `academic_years_tenant_code_uq` UNIQUE(`tenant_id`,`code`),
	CONSTRAINT `academic_years_current_uq` UNIQUE(`current_key`)
);
--> statement-breakpoint
CREATE TABLE `subject_offerings` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`academic_year_id` char(36) NOT NULL,
	`subject_id` char(36) NOT NULL,
	`class_id` char(36) NOT NULL,
	`section_id` char(36),
	`section_key` varchar(36) GENERATED ALWAYS AS ((IFNULL(`section_id`, 'ALL'))) VIRTUAL,
	`status` enum('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
	`version` int NOT NULL DEFAULT 1,
	`created_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `subject_offerings_id` PRIMARY KEY(`id`),
	CONSTRAINT `subject_offerings_tenant_id_uq` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `subject_offerings_uq` UNIQUE(`tenant_id`,`academic_year_id`,`subject_id`,`class_id`,`section_key`)
);
--> statement-breakpoint
CREATE TABLE `subjects` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`code` varchar(32) NOT NULL,
	`name` varchar(120) NOT NULL,
	`description` varchar(500),
	`subject_type` enum('CORE','ELECTIVE','OPTIONAL','EXTRACURRICULAR','OTHER') NOT NULL DEFAULT 'CORE',
	`status` enum('ACTIVE','ARCHIVED') NOT NULL DEFAULT 'ACTIVE',
	`version` int NOT NULL DEFAULT 1,
	`created_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `subjects_id` PRIMARY KEY(`id`),
	CONSTRAINT `subjects_tenant_id_uq` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `subjects_tenant_code_uq` UNIQUE(`tenant_id`,`code`)
);
--> statement-breakpoint
CREATE TABLE `admissions` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`student_id` char(36) NOT NULL,
	`admission_number` varchar(32) NOT NULL,
	`application_date` date NOT NULL,
	`status` enum('DRAFT','SUBMITTED','UNDER_REVIEW','APPROVED','REJECTED','CANCELLED') NOT NULL DEFAULT 'DRAFT',
	`admission_date` date,
	`source` varchar(64),
	`notes` text,
	`decision_note` varchar(500),
	`decided_by` char(36),
	`decided_at` datetime(3),
	`version` int NOT NULL DEFAULT 1,
	`created_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `admissions_id` PRIMARY KEY(`id`),
	CONSTRAINT `admissions_tenant_id_uq` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `admissions_tenant_number_uq` UNIQUE(`tenant_id`,`admission_number`)
);
--> statement-breakpoint
CREATE TABLE `enrollments` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`student_id` char(36) NOT NULL,
	`academic_year_id` char(36) NOT NULL,
	`class_id` char(36) NOT NULL,
	`section_id` char(36),
	`status` enum('PENDING','ACTIVE','COMPLETED','CANCELLED','TRANSFERRED','WITHDRAWN') NOT NULL DEFAULT 'ACTIVE',
	`enrollment_type` enum('NEW','PROMOTION','TRANSFER_IN','REJOIN','CHANGE','OTHER') NOT NULL DEFAULT 'NEW',
	`start_date` date NOT NULL,
	`end_date` date,
	`reason` varchar(500),
	`open_key` varchar(80) GENERATED ALWAYS AS ((IF(`status` IN ('PENDING','ACTIVE'), CONCAT(`student_id`, ':', `academic_year_id`), NULL))) VIRTUAL,
	`version` int NOT NULL DEFAULT 1,
	`created_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `enrollments_id` PRIMARY KEY(`id`),
	CONSTRAINT `enrollments_tenant_id_uq` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `enrollments_open_uq` UNIQUE(`open_key`)
);
--> statement-breakpoint
CREATE TABLE `guardians` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`first_name` varchar(100) NOT NULL,
	`middle_name` varchar(100),
	`last_name` varchar(100) NOT NULL,
	`email` varchar(254),
	`phone` varchar(32),
	`address` json,
	`occupation` varchar(100),
	`status` enum('ACTIVE','ARCHIVED') NOT NULL DEFAULT 'ACTIVE',
	`user_id` char(36),
	`version` int NOT NULL DEFAULT 1,
	`created_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `guardians_id` PRIMARY KEY(`id`),
	CONSTRAINT `guardians_tenant_id_uq` UNIQUE(`tenant_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `number_sequences` (
	`tenant_id` char(36) NOT NULL,
	`sequence_key` varchar(64) NOT NULL,
	`last_value` bigint NOT NULL DEFAULT 0,
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `number_sequences_pk` PRIMARY KEY(`tenant_id`,`sequence_key`)
);
--> statement-breakpoint
CREATE TABLE `student_guardians` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`student_id` char(36) NOT NULL,
	`guardian_id` char(36) NOT NULL,
	`relationship_type` enum('PARENT','GUARDIAN','GRANDPARENT','SIBLING','OTHER') NOT NULL,
	`relationship_label` varchar(64),
	`is_primary` boolean NOT NULL DEFAULT false,
	`is_emergency_contact` boolean NOT NULL DEFAULT false,
	`can_pick_up` boolean NOT NULL DEFAULT false,
	`portal_access_allowed` boolean NOT NULL DEFAULT false,
	`effective_from` date,
	`effective_until` date,
	`status` enum('ACTIVE','ENDED') NOT NULL DEFAULT 'ACTIVE',
	`primary_key` char(36) GENERATED ALWAYS AS ((IF(`is_primary` AND `status` = 'ACTIVE', `student_id`, NULL))) VIRTUAL,
	`active_key` varchar(80) GENERATED ALWAYS AS ((IF(`status` = 'ACTIVE', CONCAT(`student_id`, ':', `guardian_id`), NULL))) VIRTUAL,
	`version` int NOT NULL DEFAULT 1,
	`created_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `student_guardians_id` PRIMARY KEY(`id`),
	CONSTRAINT `student_guardians_tenant_id_uq` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `student_guardians_primary_uq` UNIQUE(`primary_key`),
	CONSTRAINT `student_guardians_active_uq` UNIQUE(`active_key`)
);
--> statement-breakpoint
CREATE TABLE `student_history` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`student_id` char(36) NOT NULL,
	`event_type` varchar(64) NOT NULL,
	`from_status` varchar(32),
	`to_status` varchar(32),
	`effective_date` date,
	`reason` varchar(500),
	`details` json,
	`actor_user_id` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `student_history_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `students` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`student_number` varchar(32) NOT NULL,
	`admission_number` varchar(32),
	`first_name` varchar(100) NOT NULL,
	`middle_name` varchar(100),
	`last_name` varchar(100) NOT NULL,
	`preferred_name` varchar(100),
	`date_of_birth` date,
	`gender` enum('MALE','FEMALE','OTHER','UNDISCLOSED') NOT NULL DEFAULT 'UNDISCLOSED',
	`status` enum('PROSPECTIVE','ADMISSION_PENDING','ADMITTED','ACTIVE','TRANSFERRED','WITHDRAWN','GRADUATED','ARCHIVED') NOT NULL DEFAULT 'PROSPECTIVE',
	`primary_email` varchar(254),
	`primary_phone` varchar(32),
	`nationality` varchar(64),
	`address` json,
	`photo_file_id` char(36),
	`user_id` char(36),
	`notes` text,
	`status_changed_at` datetime(3),
	`version` int NOT NULL DEFAULT 1,
	`created_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `students_id` PRIMARY KEY(`id`),
	CONSTRAINT `students_tenant_id_uq` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `students_tenant_number_uq` UNIQUE(`tenant_id`,`student_number`),
	CONSTRAINT `students_tenant_admission_uq` UNIQUE(`tenant_id`,`admission_number`)
);
--> statement-breakpoint
ALTER TABLE `academic_classes` ADD CONSTRAINT `academic_classes_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `academic_sections` ADD CONSTRAINT `academic_sections_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `academic_sections` ADD CONSTRAINT `academic_sections_year_fk` FOREIGN KEY (`tenant_id`,`academic_year_id`) REFERENCES `academic_years`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `academic_sections` ADD CONSTRAINT `academic_sections_class_fk` FOREIGN KEY (`tenant_id`,`class_id`) REFERENCES `academic_classes`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `academic_years` ADD CONSTRAINT `academic_years_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `subject_offerings` ADD CONSTRAINT `subject_offerings_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `subject_offerings` ADD CONSTRAINT `subject_offerings_year_fk` FOREIGN KEY (`tenant_id`,`academic_year_id`) REFERENCES `academic_years`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `subject_offerings` ADD CONSTRAINT `subject_offerings_subject_fk` FOREIGN KEY (`tenant_id`,`subject_id`) REFERENCES `subjects`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `subject_offerings` ADD CONSTRAINT `subject_offerings_class_fk` FOREIGN KEY (`tenant_id`,`class_id`) REFERENCES `academic_classes`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `subject_offerings` ADD CONSTRAINT `subject_offerings_section_fk` FOREIGN KEY (`tenant_id`,`section_id`) REFERENCES `academic_sections`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `subjects` ADD CONSTRAINT `subjects_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `admissions` ADD CONSTRAINT `admissions_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `admissions` ADD CONSTRAINT `admissions_student_fk` FOREIGN KEY (`tenant_id`,`student_id`) REFERENCES `students`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `enrollments` ADD CONSTRAINT `enrollments_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `enrollments` ADD CONSTRAINT `enrollments_student_fk` FOREIGN KEY (`tenant_id`,`student_id`) REFERENCES `students`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `enrollments` ADD CONSTRAINT `enrollments_year_fk` FOREIGN KEY (`tenant_id`,`academic_year_id`) REFERENCES `academic_years`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `enrollments` ADD CONSTRAINT `enrollments_class_fk` FOREIGN KEY (`tenant_id`,`class_id`) REFERENCES `academic_classes`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `enrollments` ADD CONSTRAINT `enrollments_section_fk` FOREIGN KEY (`tenant_id`,`section_id`) REFERENCES `academic_sections`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `guardians` ADD CONSTRAINT `guardians_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `guardians` ADD CONSTRAINT `guardians_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `number_sequences` ADD CONSTRAINT `number_sequences_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `student_guardians` ADD CONSTRAINT `student_guardians_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `student_guardians` ADD CONSTRAINT `student_guardians_student_fk` FOREIGN KEY (`tenant_id`,`student_id`) REFERENCES `students`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `student_guardians` ADD CONSTRAINT `student_guardians_guardian_fk` FOREIGN KEY (`tenant_id`,`guardian_id`) REFERENCES `guardians`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `student_history` ADD CONSTRAINT `student_history_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `student_history` ADD CONSTRAINT `student_history_student_fk` FOREIGN KEY (`tenant_id`,`student_id`) REFERENCES `students`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `students` ADD CONSTRAINT `students_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `students` ADD CONSTRAINT `students_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `academic_classes_tenant_status_idx` ON `academic_classes` (`tenant_id`,`status`,`sequence`);--> statement-breakpoint
CREATE INDEX `academic_sections_year_class_idx` ON `academic_sections` (`tenant_id`,`academic_year_id`,`class_id`);--> statement-breakpoint
CREATE INDEX `academic_years_tenant_status_idx` ON `academic_years` (`tenant_id`,`status`);--> statement-breakpoint
CREATE INDEX `subject_offerings_year_class_idx` ON `subject_offerings` (`tenant_id`,`academic_year_id`,`class_id`);--> statement-breakpoint
CREATE INDEX `subject_offerings_subject_idx` ON `subject_offerings` (`tenant_id`,`subject_id`);--> statement-breakpoint
CREATE INDEX `subjects_tenant_status_idx` ON `subjects` (`tenant_id`,`status`);--> statement-breakpoint
CREATE INDEX `admissions_tenant_status_idx` ON `admissions` (`tenant_id`,`status`);--> statement-breakpoint
CREATE INDEX `admissions_student_idx` ON `admissions` (`tenant_id`,`student_id`);--> statement-breakpoint
CREATE INDEX `enrollments_student_idx` ON `enrollments` (`tenant_id`,`student_id`);--> statement-breakpoint
CREATE INDEX `enrollments_year_idx` ON `enrollments` (`tenant_id`,`academic_year_id`);--> statement-breakpoint
CREATE INDEX `enrollments_roster_idx` ON `enrollments` (`tenant_id`,`class_id`,`section_id`,`status`);--> statement-breakpoint
CREATE INDEX `guardians_tenant_name_idx` ON `guardians` (`tenant_id`,`last_name`,`first_name`);--> statement-breakpoint
CREATE INDEX `guardians_tenant_phone_idx` ON `guardians` (`tenant_id`,`phone`);--> statement-breakpoint
CREATE INDEX `guardians_tenant_email_idx` ON `guardians` (`tenant_id`,`email`);--> statement-breakpoint
CREATE INDEX `student_guardians_student_idx` ON `student_guardians` (`tenant_id`,`student_id`);--> statement-breakpoint
CREATE INDEX `student_guardians_guardian_idx` ON `student_guardians` (`tenant_id`,`guardian_id`);--> statement-breakpoint
CREATE INDEX `student_history_student_idx` ON `student_history` (`tenant_id`,`student_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `students_tenant_status_idx` ON `students` (`tenant_id`,`status`);--> statement-breakpoint
CREATE INDEX `students_tenant_name_idx` ON `students` (`tenant_id`,`last_name`,`first_name`);--> statement-breakpoint
CREATE INDEX `students_tenant_dob_idx` ON `students` (`tenant_id`,`date_of_birth`);
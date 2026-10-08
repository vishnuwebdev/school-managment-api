CREATE TABLE `teacher_history` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`teacher_id` char(36) NOT NULL,
	`event_type` varchar(64) NOT NULL,
	`from_status` varchar(32),
	`to_status` varchar(32),
	`effective_date` date,
	`reason` varchar(500),
	`details` json,
	`actor_user_id` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `teacher_history_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `teacher_qualifications` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`teacher_id` char(36) NOT NULL,
	`qualification_type` enum('DEGREE','DIPLOMA','CERTIFICATION','LICENSE','OTHER') NOT NULL,
	`title` varchar(200) NOT NULL,
	`institution` varchar(200),
	`field_of_study` varchar(200),
	`completion_year` smallint,
	`status` enum('ACTIVE','REMOVED') NOT NULL DEFAULT 'ACTIVE',
	`version` int NOT NULL DEFAULT 1,
	`created_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` char(36),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `teacher_qualifications_id` PRIMARY KEY(`id`),
	CONSTRAINT `teacher_qualifications_tenant_id_uq` UNIQUE(`tenant_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `teachers` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`teacher_number` varchar(32) NOT NULL,
	`staff_type` enum('TEACHING','NON_TEACHING') NOT NULL DEFAULT 'TEACHING',
	`status` enum('PROSPECTIVE','ONBOARDING','ACTIVE','ON_LEAVE','INACTIVE','RESIGNED','TERMINATED','ARCHIVED') NOT NULL DEFAULT 'ACTIVE',
	`first_name` varchar(100) NOT NULL,
	`middle_name` varchar(100),
	`last_name` varchar(100) NOT NULL,
	`preferred_name` varchar(100),
	`date_of_birth` date,
	`gender` enum('MALE','FEMALE','OTHER','UNDISCLOSED') NOT NULL DEFAULT 'UNDISCLOSED',
	`email` varchar(254),
	`phone` varchar(32),
	`address` json,
	`joining_date` date,
	`employment_type` enum('FULL_TIME','PART_TIME','CONTRACT','VISITING') NOT NULL DEFAULT 'FULL_TIME',
	`department` varchar(100),
	`designation` varchar(100),
	`exit_date` date,
	`exit_reason` varchar(500),
	`notes` text,
	`membership_id` char(36),
	`status_changed_at` datetime(3),
	`version` int NOT NULL DEFAULT 1,
	`created_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` char(36),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `teachers_id` PRIMARY KEY(`id`),
	CONSTRAINT `teachers_tenant_id_uq` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `teachers_tenant_number_uq` UNIQUE(`tenant_id`,`teacher_number`),
	CONSTRAINT `teachers_membership_uq` UNIQUE(`membership_id`)
);
--> statement-breakpoint
CREATE TABLE `teaching_assignments` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`teacher_id` char(36) NOT NULL,
	`subject_offering_id` char(36) NOT NULL,
	`role` enum('PRIMARY','CO_TEACHER','SUBSTITUTE') NOT NULL DEFAULT 'PRIMARY',
	`status` enum('ACTIVE','ENDED','CANCELLED') NOT NULL DEFAULT 'ACTIVE',
	`start_date` date NOT NULL,
	`end_date` date,
	`reason` varchar(500),
	`open_key` varchar(80) GENERATED ALWAYS AS ((IF(`status` = 'ACTIVE', CONCAT(`teacher_id`, ':', `subject_offering_id`), NULL))) VIRTUAL,
	`version` int NOT NULL DEFAULT 1,
	`created_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` char(36),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `teaching_assignments_id` PRIMARY KEY(`id`),
	CONSTRAINT `teaching_assignments_tenant_id_uq` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `teaching_assignments_open_uq` UNIQUE(`open_key`)
);
--> statement-breakpoint
ALTER TABLE `memberships` ADD CONSTRAINT `memberships_tenant_id_uq` UNIQUE(`tenant_id`,`id`);--> statement-breakpoint
ALTER TABLE `teacher_history` ADD CONSTRAINT `teacher_history_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `teacher_history` ADD CONSTRAINT `teacher_history_teacher_fk` FOREIGN KEY (`tenant_id`,`teacher_id`) REFERENCES `teachers`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `teacher_qualifications` ADD CONSTRAINT `teacher_qualifications_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `teacher_qualifications` ADD CONSTRAINT `teacher_qualifications_teacher_fk` FOREIGN KEY (`tenant_id`,`teacher_id`) REFERENCES `teachers`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `teachers` ADD CONSTRAINT `teachers_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `teachers` ADD CONSTRAINT `teachers_membership_fk` FOREIGN KEY (`tenant_id`,`membership_id`) REFERENCES `memberships`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `teaching_assignments` ADD CONSTRAINT `teaching_assignments_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `teaching_assignments` ADD CONSTRAINT `teaching_assignments_teacher_fk` FOREIGN KEY (`tenant_id`,`teacher_id`) REFERENCES `teachers`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `teaching_assignments` ADD CONSTRAINT `teaching_assignments_offering_fk` FOREIGN KEY (`tenant_id`,`subject_offering_id`) REFERENCES `subject_offerings`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `teacher_history_teacher_idx` ON `teacher_history` (`tenant_id`,`teacher_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `teacher_qualifications_teacher_idx` ON `teacher_qualifications` (`tenant_id`,`teacher_id`,`status`);--> statement-breakpoint
CREATE INDEX `teachers_tenant_status_idx` ON `teachers` (`tenant_id`,`status`);--> statement-breakpoint
CREATE INDEX `teachers_tenant_name_idx` ON `teachers` (`tenant_id`,`last_name`,`first_name`);--> statement-breakpoint
CREATE INDEX `teachers_tenant_type_idx` ON `teachers` (`tenant_id`,`staff_type`,`status`);--> statement-breakpoint
CREATE INDEX `teachers_tenant_department_idx` ON `teachers` (`tenant_id`,`department`);--> statement-breakpoint
CREATE INDEX `teaching_assignments_teacher_idx` ON `teaching_assignments` (`tenant_id`,`teacher_id`,`status`);--> statement-breakpoint
CREATE INDEX `teaching_assignments_offering_idx` ON `teaching_assignments` (`tenant_id`,`subject_offering_id`,`status`);
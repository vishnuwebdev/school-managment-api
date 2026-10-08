CREATE TABLE `timetable_entries` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`timetable_id` char(36) NOT NULL,
	`academic_year_id` char(36) NOT NULL,
	`day_of_week` smallint NOT NULL,
	`period_id` char(36) NOT NULL,
	`section_id` char(36) NOT NULL,
	`subject_offering_id` char(36) NOT NULL,
	`teaching_assignment_id` char(36) NOT NULL,
	`teacher_id` char(36) NOT NULL,
	`venue_id` char(36),
	`status` enum('ACTIVE','CANCELLED') NOT NULL DEFAULT 'ACTIVE',
	`section_slot_key` varchar(120) GENERATED ALWAYS AS ((IF(`status` = 'ACTIVE', CONCAT(`timetable_id`, ':', `section_id`, ':', `day_of_week`, ':', `period_id`), NULL))) VIRTUAL,
	`teacher_slot_key` varchar(120) GENERATED ALWAYS AS ((IF(`status` = 'ACTIVE', CONCAT(`timetable_id`, ':', `teacher_id`, ':', `day_of_week`, ':', `period_id`), NULL))) VIRTUAL,
	`venue_slot_key` varchar(120) GENERATED ALWAYS AS ((IF(`status` = 'ACTIVE' AND `venue_id` IS NOT NULL, CONCAT(`timetable_id`, ':', `venue_id`, ':', `day_of_week`, ':', `period_id`), NULL))) VIRTUAL,
	`version` int NOT NULL DEFAULT 1,
	`created_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` char(36),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `timetable_entries_id` PRIMARY KEY(`id`),
	CONSTRAINT `timetable_entries_tenant_id_uq` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `timetable_entries_section_slot_uq` UNIQUE(`section_slot_key`),
	CONSTRAINT `timetable_entries_teacher_slot_uq` UNIQUE(`teacher_slot_key`),
	CONSTRAINT `timetable_entries_venue_slot_uq` UNIQUE(`venue_slot_key`)
);
--> statement-breakpoint
CREATE TABLE `timetable_periods` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`code` varchar(32) NOT NULL,
	`name` varchar(80) NOT NULL,
	`start_time` time NOT NULL,
	`end_time` time NOT NULL,
	`kind` enum('LESSON','BREAK','LUNCH','ASSEMBLY') NOT NULL DEFAULT 'LESSON',
	`display_order` int NOT NULL DEFAULT 0,
	`status` enum('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
	`version` int NOT NULL DEFAULT 1,
	`created_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` char(36),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `timetable_periods_id` PRIMARY KEY(`id`),
	CONSTRAINT `timetable_periods_tenant_id_uq` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `timetable_periods_tenant_code_uq` UNIQUE(`tenant_id`,`code`)
);
--> statement-breakpoint
CREATE TABLE `timetable_settings` (
	`tenant_id` char(36) NOT NULL,
	`working_days` json NOT NULL,
	`version` int NOT NULL DEFAULT 1,
	`updated_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `timetable_settings_tenant_id` PRIMARY KEY(`tenant_id`)
);
--> statement-breakpoint
CREATE TABLE `timetable_venues` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`code` varchar(32) NOT NULL,
	`name` varchar(100) NOT NULL,
	`venue_type` enum('CLASSROOM','LAB','HALL','OTHER') NOT NULL DEFAULT 'CLASSROOM',
	`capacity` int,
	`status` enum('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
	`version` int NOT NULL DEFAULT 1,
	`created_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` char(36),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `timetable_venues_id` PRIMARY KEY(`id`),
	CONSTRAINT `timetable_venues_tenant_id_uq` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `timetable_venues_tenant_code_uq` UNIQUE(`tenant_id`,`code`)
);
--> statement-breakpoint
CREATE TABLE `timetables` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`academic_year_id` char(36) NOT NULL,
	`name` varchar(120) NOT NULL,
	`status` enum('DRAFT','PUBLISHED','ARCHIVED') NOT NULL DEFAULT 'DRAFT',
	`version_no` int NOT NULL,
	`effective_from` date,
	`effective_to` date,
	`notes` varchar(500),
	`copied_from_id` char(36),
	`superseded_by_id` char(36),
	`published_key` varchar(36) GENERATED ALWAYS AS ((IF(`status` = 'PUBLISHED', `academic_year_id`, NULL))) VIRTUAL,
	`published_at` datetime(3),
	`published_by` char(36),
	`archived_at` datetime(3),
	`archived_by` char(36),
	`version` int NOT NULL DEFAULT 1,
	`created_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` char(36),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `timetables_id` PRIMARY KEY(`id`),
	CONSTRAINT `timetables_tenant_id_uq` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `timetables_tenant_id_year_uq` UNIQUE(`tenant_id`,`id`,`academic_year_id`),
	CONSTRAINT `timetables_version_no_uq` UNIQUE(`tenant_id`,`academic_year_id`,`version_no`),
	CONSTRAINT `timetables_published_uq` UNIQUE(`published_key`)
);
--> statement-breakpoint
ALTER TABLE `academic_sections` ADD CONSTRAINT `academic_sections_tenant_id_year_uq` UNIQUE(`tenant_id`,`id`,`academic_year_id`);--> statement-breakpoint
ALTER TABLE `subject_offerings` ADD CONSTRAINT `subject_offerings_tenant_id_year_uq` UNIQUE(`tenant_id`,`id`,`academic_year_id`);--> statement-breakpoint
ALTER TABLE `timetable_entries` ADD CONSTRAINT `timetable_entries_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `timetable_entries` ADD CONSTRAINT `timetable_entries_timetable_fk` FOREIGN KEY (`tenant_id`,`timetable_id`,`academic_year_id`) REFERENCES `timetables`(`tenant_id`,`id`,`academic_year_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `timetable_entries` ADD CONSTRAINT `timetable_entries_period_fk` FOREIGN KEY (`tenant_id`,`period_id`) REFERENCES `timetable_periods`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `timetable_entries` ADD CONSTRAINT `timetable_entries_section_fk` FOREIGN KEY (`tenant_id`,`section_id`,`academic_year_id`) REFERENCES `academic_sections`(`tenant_id`,`id`,`academic_year_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `timetable_entries` ADD CONSTRAINT `timetable_entries_offering_fk` FOREIGN KEY (`tenant_id`,`subject_offering_id`,`academic_year_id`) REFERENCES `subject_offerings`(`tenant_id`,`id`,`academic_year_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `timetable_entries` ADD CONSTRAINT `timetable_entries_assignment_fk` FOREIGN KEY (`tenant_id`,`teaching_assignment_id`) REFERENCES `teaching_assignments`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `timetable_entries` ADD CONSTRAINT `timetable_entries_teacher_fk` FOREIGN KEY (`tenant_id`,`teacher_id`) REFERENCES `teachers`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `timetable_entries` ADD CONSTRAINT `timetable_entries_venue_fk` FOREIGN KEY (`tenant_id`,`venue_id`) REFERENCES `timetable_venues`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `timetable_periods` ADD CONSTRAINT `timetable_periods_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `timetable_settings` ADD CONSTRAINT `timetable_settings_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `timetable_venues` ADD CONSTRAINT `timetable_venues_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `timetables` ADD CONSTRAINT `timetables_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `timetables` ADD CONSTRAINT `timetables_year_fk` FOREIGN KEY (`tenant_id`,`academic_year_id`) REFERENCES `academic_years`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `timetables` ADD CONSTRAINT `timetables_copied_from_fk` FOREIGN KEY (`tenant_id`,`copied_from_id`) REFERENCES `timetables`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `timetables` ADD CONSTRAINT `timetables_superseded_by_fk` FOREIGN KEY (`tenant_id`,`superseded_by_id`) REFERENCES `timetables`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `timetable_entries_slot_idx` ON `timetable_entries` (`tenant_id`,`timetable_id`,`day_of_week`,`period_id`);--> statement-breakpoint
CREATE INDEX `timetable_entries_section_idx` ON `timetable_entries` (`tenant_id`,`timetable_id`,`section_id`);--> statement-breakpoint
CREATE INDEX `timetable_entries_teacher_idx` ON `timetable_entries` (`tenant_id`,`timetable_id`,`teacher_id`);--> statement-breakpoint
CREATE INDEX `timetable_entries_venue_idx` ON `timetable_entries` (`tenant_id`,`venue_id`);--> statement-breakpoint
CREATE INDEX `timetable_entries_period_idx` ON `timetable_entries` (`tenant_id`,`period_id`);--> statement-breakpoint
CREATE INDEX `timetable_entries_assignment_idx` ON `timetable_entries` (`tenant_id`,`teaching_assignment_id`);--> statement-breakpoint
CREATE INDEX `timetable_periods_tenant_status_idx` ON `timetable_periods` (`tenant_id`,`status`,`start_time`);--> statement-breakpoint
CREATE INDEX `timetable_venues_tenant_status_idx` ON `timetable_venues` (`tenant_id`,`status`,`name`);--> statement-breakpoint
CREATE INDEX `timetables_year_status_idx` ON `timetables` (`tenant_id`,`academic_year_id`,`status`);
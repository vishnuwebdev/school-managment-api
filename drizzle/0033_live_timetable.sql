-- One live timetable, no versions (Plan — Live timetable). Existing timetable data is
-- removed by decision: lessons, versions and periods. Working days and venues stay.
DROP TABLE IF EXISTS `timetable_entries`;--> statement-breakpoint
DROP TABLE IF EXISTS `timetables`;--> statement-breakpoint
DELETE FROM `timetable_periods`;--> statement-breakpoint
ALTER TABLE `timetable_periods` ADD `academic_year_id` char(36);--> statement-breakpoint
ALTER TABLE `timetable_periods` ADD `subject_offering_id` char(36);--> statement-breakpoint
ALTER TABLE `timetable_periods` ADD `teaching_assignment_id` char(36);--> statement-breakpoint
ALTER TABLE `timetable_periods` ADD `teacher_id` char(36);--> statement-breakpoint
ALTER TABLE `timetable_periods` ADD `venue_id` char(36);--> statement-breakpoint
CREATE INDEX `timetable_periods_year_idx` ON `timetable_periods` (`tenant_id`,`academic_year_id`);--> statement-breakpoint
CREATE INDEX `timetable_periods_teacher_idx` ON `timetable_periods` (`tenant_id`,`teacher_id`);--> statement-breakpoint
ALTER TABLE `timetable_periods` ADD CONSTRAINT `timetable_periods_class_fk` FOREIGN KEY (`tenant_id`,`academic_class_id`) REFERENCES `academic_classes`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `timetable_periods` ADD CONSTRAINT `timetable_periods_section_fk` FOREIGN KEY (`tenant_id`,`academic_section_id`) REFERENCES `academic_sections`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `timetable_periods` ADD CONSTRAINT `timetable_periods_year_fk` FOREIGN KEY (`tenant_id`,`academic_year_id`) REFERENCES `academic_years`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `timetable_periods` ADD CONSTRAINT `timetable_periods_offering_fk` FOREIGN KEY (`tenant_id`,`subject_offering_id`) REFERENCES `subject_offerings`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `timetable_periods` ADD CONSTRAINT `timetable_periods_assignment_fk` FOREIGN KEY (`tenant_id`,`teaching_assignment_id`) REFERENCES `teaching_assignments`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `timetable_periods` ADD CONSTRAINT `timetable_periods_teacher_fk` FOREIGN KEY (`tenant_id`,`teacher_id`) REFERENCES `teachers`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `timetable_periods` ADD CONSTRAINT `timetable_periods_venue_fk` FOREIGN KEY (`tenant_id`,`venue_id`) REFERENCES `timetable_venues`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE TABLE `timetable_day_overrides` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`period_id` char(36) NOT NULL,
	`day_of_week` smallint NOT NULL,
	`kind` enum('LESSON','FREE') NOT NULL DEFAULT 'LESSON',
	`subject_offering_id` char(36),
	`teaching_assignment_id` char(36),
	`teacher_id` char(36),
	`venue_id` char(36),
	`version` int NOT NULL DEFAULT 1,
	`created_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` char(36),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `timetable_day_overrides_id` PRIMARY KEY(`id`),
	CONSTRAINT `timetable_day_overrides_tenant_id_uq` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `timetable_day_overrides_slot_uq` UNIQUE(`period_id`,`day_of_week`)
);
--> statement-breakpoint
CREATE INDEX `timetable_day_overrides_teacher_idx` ON `timetable_day_overrides` (`tenant_id`,`teacher_id`);--> statement-breakpoint
ALTER TABLE `timetable_day_overrides` ADD CONSTRAINT `timetable_day_overrides_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `timetable_day_overrides` ADD CONSTRAINT `timetable_day_overrides_period_fk` FOREIGN KEY (`tenant_id`,`period_id`) REFERENCES `timetable_periods`(`tenant_id`,`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `timetable_day_overrides` ADD CONSTRAINT `timetable_day_overrides_offering_fk` FOREIGN KEY (`tenant_id`,`subject_offering_id`) REFERENCES `subject_offerings`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `timetable_day_overrides` ADD CONSTRAINT `timetable_day_overrides_assignment_fk` FOREIGN KEY (`tenant_id`,`teaching_assignment_id`) REFERENCES `teaching_assignments`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `timetable_day_overrides` ADD CONSTRAINT `timetable_day_overrides_teacher_fk` FOREIGN KEY (`tenant_id`,`teacher_id`) REFERENCES `teachers`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `timetable_day_overrides` ADD CONSTRAINT `timetable_day_overrides_venue_fk` FOREIGN KEY (`tenant_id`,`venue_id`) REFERENCES `timetable_venues`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;

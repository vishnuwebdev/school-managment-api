-- A class (or one section) can have its own periods. Both null = the whole school.
ALTER TABLE `timetable_periods` ADD COLUMN `academic_class_id` char(36) NULL, ADD COLUMN `academic_section_id` char(36) NULL;
--> statement-breakpoint
CREATE INDEX `timetable_periods_scope_idx` ON `timetable_periods` (`tenant_id`, `academic_class_id`, `academic_section_id`);

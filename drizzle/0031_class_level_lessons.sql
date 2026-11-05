-- A lesson can belong to a whole class (a class without sections): section_id may be
-- NULL, and class_id is always set. The section slot key covers both owners.
ALTER TABLE `timetable_entries` ADD `class_id` char(36);--> statement-breakpoint
UPDATE `timetable_entries` e JOIN `academic_sections` s ON s.`id` = e.`section_id` SET e.`class_id` = s.`class_id`;--> statement-breakpoint
ALTER TABLE `timetable_entries` MODIFY `class_id` char(36) NOT NULL;--> statement-breakpoint
ALTER TABLE `timetable_entries` DROP INDEX `timetable_entries_section_slot_uq`;--> statement-breakpoint
ALTER TABLE `timetable_entries` DROP COLUMN `section_slot_key`;--> statement-breakpoint
ALTER TABLE `timetable_entries` MODIFY `section_id` char(36) NULL;--> statement-breakpoint
ALTER TABLE `timetable_entries` ADD `section_slot_key` varchar(120) GENERATED ALWAYS AS ((IF(`status` = 'ACTIVE', CONCAT(`timetable_id`, ':', COALESCE(`section_id`, CONCAT('C', `class_id`)), ':', `day_of_week`, ':', `period_id`), NULL))) VIRTUAL;--> statement-breakpoint
ALTER TABLE `timetable_entries` ADD CONSTRAINT `timetable_entries_section_slot_uq` UNIQUE(`section_slot_key`);--> statement-breakpoint
CREATE INDEX `timetable_entries_class_idx` ON `timetable_entries` (`tenant_id`,`timetable_id`,`class_id`);--> statement-breakpoint
ALTER TABLE `timetable_entries` ADD CONSTRAINT `timetable_entries_class_fk` FOREIGN KEY (`tenant_id`,`class_id`) REFERENCES `academic_classes`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;

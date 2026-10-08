ALTER TABLE `academic_classes` ADD `phase` enum('EARLY_YEARS','PRIMARY','SECONDARY','SENIOR');--> statement-breakpoint
ALTER TABLE `academic_classes` ADD `language_of_instruction` varchar(64);--> statement-breakpoint
ALTER TABLE `academic_classes` ADD `promotes_to_class_id` char(36);--> statement-breakpoint
ALTER TABLE `academic_sections` ADD `room` varchar(50);

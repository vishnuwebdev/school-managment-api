-- Exam timetable: when and where each paper is sat, section overrides, invigilators and markers.
ALTER TABLE `exam_papers` ADD `start_time` time;--> statement-breakpoint
ALTER TABLE `exam_papers` ADD `end_time` time;--> statement-breakpoint
ALTER TABLE `exam_papers` ADD `venue_id` char(36);--> statement-breakpoint
ALTER TABLE `exam_papers` ADD CONSTRAINT `exam_papers_venue_fk` FOREIGN KEY (`tenant_id`,`venue_id`) REFERENCES `timetable_venues`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `exam_papers_date_idx` ON `exam_papers` (`tenant_id`,`exam_date`);--> statement-breakpoint
CREATE TABLE `exam_paper_sittings` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`paper_id` char(36) NOT NULL,
	`section_id` char(36) NOT NULL,
	`exam_date` date,
	`start_time` time,
	`end_time` time,
	`venue_id` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `exam_paper_sittings_id` PRIMARY KEY(`id`),
	CONSTRAINT `exam_paper_sittings_uq` UNIQUE(`tenant_id`,`paper_id`,`section_id`)
);
--> statement-breakpoint
CREATE INDEX `exam_paper_sittings_date_idx` ON `exam_paper_sittings` (`tenant_id`,`exam_date`);--> statement-breakpoint
ALTER TABLE `exam_paper_sittings` ADD CONSTRAINT `exam_paper_sittings_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `exam_paper_sittings` ADD CONSTRAINT `exam_paper_sittings_paper_fk` FOREIGN KEY (`tenant_id`,`paper_id`) REFERENCES `exam_papers`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `exam_paper_sittings` ADD CONSTRAINT `exam_paper_sittings_section_fk` FOREIGN KEY (`tenant_id`,`section_id`) REFERENCES `academic_sections`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `exam_paper_sittings` ADD CONSTRAINT `exam_paper_sittings_venue_fk` FOREIGN KEY (`tenant_id`,`venue_id`) REFERENCES `timetable_venues`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE TABLE `exam_paper_staff` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`paper_id` char(36) NOT NULL,
	`section_id` char(36),
	`section_key` varchar(36) GENERATED ALWAYS AS ((IFNULL(`section_id`, ''))) VIRTUAL,
	`teacher_id` char(36) NOT NULL,
	`role` enum('INVIGILATOR','MARKER') NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `exam_paper_staff_id` PRIMARY KEY(`id`),
	CONSTRAINT `exam_paper_staff_uq` UNIQUE(`tenant_id`,`paper_id`,`section_key`,`teacher_id`,`role`)
);
--> statement-breakpoint
CREATE INDEX `exam_paper_staff_teacher_idx` ON `exam_paper_staff` (`tenant_id`,`teacher_id`,`role`);--> statement-breakpoint
ALTER TABLE `exam_paper_staff` ADD CONSTRAINT `exam_paper_staff_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `exam_paper_staff` ADD CONSTRAINT `exam_paper_staff_paper_fk` FOREIGN KEY (`tenant_id`,`paper_id`) REFERENCES `exam_papers`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `exam_paper_staff` ADD CONSTRAINT `exam_paper_staff_section_fk` FOREIGN KEY (`tenant_id`,`section_id`) REFERENCES `academic_sections`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `exam_paper_staff` ADD CONSTRAINT `exam_paper_staff_teacher_fk` FOREIGN KEY (`tenant_id`,`teacher_id`) REFERENCES `teachers`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;

-- The class teacher of a whole class without sections (per academic year).
CREATE TABLE `class_class_teachers` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`class_id` char(36) NOT NULL,
	`academic_year_id` char(36) NOT NULL,
	`teacher_id` char(36) NOT NULL,
	`status` enum('ACTIVE','ENDED') NOT NULL DEFAULT 'ACTIVE',
	`start_date` date NOT NULL,
	`end_date` date,
	`reason` varchar(500),
	`open_key` varchar(80) GENERATED ALWAYS AS ((IF(`status` = 'ACTIVE', CONCAT(`class_id`, ':', `academic_year_id`), NULL))) VIRTUAL,
	`created_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` char(36),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `class_class_teachers_id` PRIMARY KEY(`id`),
	CONSTRAINT `class_class_teachers_open_uq` UNIQUE(`tenant_id`,`open_key`)
);
--> statement-breakpoint
CREATE INDEX `class_class_teachers_teacher_idx` ON `class_class_teachers` (`tenant_id`,`teacher_id`,`status`);--> statement-breakpoint
CREATE INDEX `class_class_teachers_class_idx` ON `class_class_teachers` (`tenant_id`,`class_id`,`academic_year_id`,`status`);--> statement-breakpoint
ALTER TABLE `class_class_teachers` ADD CONSTRAINT `class_class_teachers_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `class_class_teachers` ADD CONSTRAINT `class_class_teachers_class_fk` FOREIGN KEY (`tenant_id`,`class_id`) REFERENCES `academic_classes`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `class_class_teachers` ADD CONSTRAINT `class_class_teachers_year_fk` FOREIGN KEY (`tenant_id`,`academic_year_id`) REFERENCES `academic_years`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `class_class_teachers` ADD CONSTRAINT `class_class_teachers_teacher_fk` FOREIGN KEY (`tenant_id`,`teacher_id`) REFERENCES `teachers`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;

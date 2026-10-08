CREATE TABLE `student_houses` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`name` varchar(64) NOT NULL,
	`is_active` boolean NOT NULL DEFAULT true,
	`sort_order` int NOT NULL DEFAULT 0,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `student_houses_id` PRIMARY KEY(`id`),
	CONSTRAINT `student_houses_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	CONSTRAINT `student_houses_tenant_id_uq` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `student_houses_tenant_name_uq` UNIQUE(`tenant_id`,`name`)
);--> statement-breakpoint
CREATE TABLE `student_settings` (
	`tenant_id` char(36) NOT NULL,
	`admission_number_mode` enum('AUTO','MANUAL') NOT NULL DEFAULT 'AUTO',
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `student_settings_tenant_id` PRIMARY KEY(`tenant_id`),
	CONSTRAINT `student_settings_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`)
);--> statement-breakpoint
ALTER TABLE `students` ADD COLUMN `blood_group` enum('A+','A-','B+','B-','AB+','AB-','O+','O-');--> statement-breakpoint
ALTER TABLE `students` ADD COLUMN `government_id_enc` varchar(512);--> statement-breakpoint
ALTER TABLE `students` ADD COLUMN `government_id_last4` varchar(8);--> statement-breakpoint
ALTER TABLE `students` ADD COLUMN `house_id` char(36);--> statement-breakpoint
ALTER TABLE `students` ADD COLUMN `previous_school` varchar(200);--> statement-breakpoint
ALTER TABLE `students` ADD COLUMN `category` varchar(64);--> statement-breakpoint
ALTER TABLE `students` ADD COLUMN `admission_date` date;--> statement-breakpoint
ALTER TABLE `students` ADD COLUMN `admission_type` enum('NEW','TRANSFER_IN','RE_ADMISSION') NOT NULL DEFAULT 'NEW';--> statement-breakpoint
ALTER TABLE `students` ADD CONSTRAINT `students_house_fk` FOREIGN KEY (`tenant_id`,`house_id`) REFERENCES `student_houses`(`tenant_id`,`id`);--> statement-breakpoint
CREATE INDEX `students_tenant_admission_type_idx` ON `students` (`tenant_id`,`admission_type`);--> statement-breakpoint
ALTER TABLE `student_guardians` MODIFY COLUMN `relationship_type` enum('PARENT','FATHER','MOTHER','GUARDIAN','GRANDPARENT','SIBLING','OTHER') NOT NULL;

CREATE TABLE `staff_lookups` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`kind` enum('DEPARTMENT','DESIGNATION') NOT NULL,
	`name` varchar(100) NOT NULL,
	`is_active` boolean NOT NULL DEFAULT true,
	`sort_order` int NOT NULL DEFAULT 0,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `staff_lookups_id` PRIMARY KEY(`id`),
	CONSTRAINT `staff_lookups_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	CONSTRAINT `staff_lookups_tenant_id_uq` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `staff_lookups_tenant_kind_name_uq` UNIQUE(`tenant_id`,`kind`,`name`)
);--> statement-breakpoint
ALTER TABLE `teachers` ADD COLUMN `emergency_contact_name` varchar(150);--> statement-breakpoint
ALTER TABLE `teachers` ADD COLUMN `emergency_contact_phone` varchar(32);--> statement-breakpoint
ALTER TABLE `teachers` ADD COLUMN `emergency_contact_relation` varchar(50);--> statement-breakpoint
ALTER TABLE `teachers` ADD COLUMN `id_number_enc` varchar(512);--> statement-breakpoint
ALTER TABLE `teachers` ADD COLUMN `id_number_last4` varchar(8);--> statement-breakpoint
ALTER TABLE `teachers` ADD COLUMN `reporting_manager_id` char(36);--> statement-breakpoint
ALTER TABLE `teachers` ADD CONSTRAINT `teachers_manager_fk` FOREIGN KEY (`tenant_id`,`reporting_manager_id`) REFERENCES `teachers`(`tenant_id`,`id`);

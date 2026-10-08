CREATE TABLE `school_calendar_settings` (
	`tenant_id` char(36) NOT NULL,
	`weekly_off_days` json NOT NULL,
	`off_saturdays` json NOT NULL,
	`version` int NOT NULL DEFAULT 1,
	`updated_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `school_calendar_settings_tenant_id` PRIMARY KEY(`tenant_id`)
);
--> statement-breakpoint
CREATE TABLE `school_holidays` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`name` varchar(120) NOT NULL,
	`start_date` date NOT NULL,
	`end_date` date NOT NULL,
	`audience` enum('ALL','STUDENTS','CLASSES') NOT NULL DEFAULT 'ALL',
	`class_ids` json,
	`description` varchar(500),
	`status` enum('ACTIVE','CANCELLED') NOT NULL DEFAULT 'ACTIVE',
	`version` int NOT NULL DEFAULT 1,
	`created_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` char(36),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `school_holidays_id` PRIMARY KEY(`id`),
	CONSTRAINT `school_holidays_tenant_id_uq` UNIQUE(`tenant_id`,`id`)
);
--> statement-breakpoint
CREATE INDEX `school_holidays_range_idx` ON `school_holidays` (`tenant_id`,`status`,`start_date`,`end_date`);
--> statement-breakpoint
ALTER TABLE `school_calendar_settings` ADD CONSTRAINT `school_calendar_settings_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `school_holidays` ADD CONSTRAINT `school_holidays_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;

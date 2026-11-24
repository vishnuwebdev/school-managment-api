CREATE TABLE `calendar_categories` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`code` varchar(32) NOT NULL,
	`name` varchar(60) NOT NULL,
	`color` varchar(7) NOT NULL,
	`closes_school` boolean NOT NULL DEFAULT false,
	`is_system` boolean NOT NULL DEFAULT false,
	`is_active` boolean NOT NULL DEFAULT true,
	`sort_order` int NOT NULL DEFAULT 100,
	`version` int NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `calendar_categories_id` PRIMARY KEY(`id`),
	CONSTRAINT `calendar_categories_tenant_id_uq` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `calendar_categories_tenant_code_uq` UNIQUE(`tenant_id`,`code`)
);
--> statement-breakpoint
CREATE TABLE `calendar_events` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`category_id` char(36) NOT NULL,
	`title` varchar(120) NOT NULL,
	`start_date` date NOT NULL,
	`end_date` date NOT NULL,
	`start_time` time,
	`end_time` time,
	`audience` enum('ALL','STAFF','STUDENTS','CLASSES','SECTIONS') NOT NULL DEFAULT 'ALL',
	`class_ids` json,
	`section_ids` json,
	`description` varchar(500),
	`staff_action` varchar(200),
	`action_link` enum('NONE','ATTENDANCE','MARKS','TIMETABLE','LEAVE') NOT NULL DEFAULT 'NONE',
	`status` enum('ACTIVE','CANCELLED') NOT NULL DEFAULT 'ACTIVE',
	`version` int NOT NULL DEFAULT 1,
	`created_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` char(36),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `calendar_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `calendar_events_tenant_id_uq` UNIQUE(`tenant_id`,`id`)
);
--> statement-breakpoint
CREATE INDEX `calendar_events_range_idx` ON `calendar_events` (`tenant_id`,`status`,`start_date`,`end_date`);
--> statement-breakpoint
CREATE INDEX `calendar_events_category_idx` ON `calendar_events` (`tenant_id`,`category_id`);
--> statement-breakpoint
ALTER TABLE `calendar_categories` ADD CONSTRAINT `calendar_categories_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `calendar_events` ADD CONSTRAINT `calendar_events_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `calendar_events` ADD CONSTRAINT `calendar_events_category_fk` FOREIGN KEY (`tenant_id`,`category_id`) REFERENCES `calendar_categories`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;

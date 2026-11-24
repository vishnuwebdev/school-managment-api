CREATE TABLE `school_events` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`type` enum('EVENT','EXAM','MEETING') NOT NULL,
	`title` varchar(120) NOT NULL,
	`start_date` date NOT NULL,
	`end_date` date NOT NULL,
	`start_time` time,
	`end_time` time,
	`audience` enum('ALL','STAFF','STUDENTS','CLASSES') NOT NULL DEFAULT 'ALL',
	`class_ids` json,
	`description` varchar(500),
	`staff_action` varchar(200),
	`action_link` enum('NONE','ATTENDANCE','MARKS','TIMETABLE','LEAVE') NOT NULL DEFAULT 'NONE',
	`status` enum('ACTIVE','CANCELLED') NOT NULL DEFAULT 'ACTIVE',
	`version` int NOT NULL DEFAULT 1,
	`created_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` char(36),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `school_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `school_events_tenant_id_uq` UNIQUE(`tenant_id`,`id`)
);
--> statement-breakpoint
CREATE INDEX `school_events_range_idx` ON `school_events` (`tenant_id`,`status`,`start_date`,`end_date`);
--> statement-breakpoint
ALTER TABLE `school_events` ADD CONSTRAINT `school_events_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;

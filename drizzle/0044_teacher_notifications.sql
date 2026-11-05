-- Teacher notifications (26 Oct 2026). The office writes a notification in the admin panel
-- for all teachers or chosen teachers, now or at a set time; teachers read it in the app.
-- No push yet: the app lists notifications whose send time has passed.
CREATE TABLE IF NOT EXISTS `teacher_notifications` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`title` varchar(150) NOT NULL,
	`body` varchar(2000) NOT NULL,
	`audience` enum('ALL','SELECTED') NOT NULL DEFAULT 'ALL',
	`teacher_ids` json,
	`send_at` datetime(3) NOT NULL,
	`status` enum('ACTIVE','CANCELLED') NOT NULL DEFAULT 'ACTIVE',
	`created_by` char(36),
	`version` int NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `teacher_notifications_id` PRIMARY KEY(`id`),
	CONSTRAINT `teacher_notifications_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	INDEX `teacher_notifications_send_idx` (`tenant_id`,`status`,`send_at`)
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `teacher_notification_reads` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`notification_id` char(36) NOT NULL,
	`teacher_id` char(36) NOT NULL,
	`read_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `teacher_notification_reads_id` PRIMARY KEY(`id`),
	CONSTRAINT `teacher_notification_reads_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	CONSTRAINT `teacher_notification_reads_uq` UNIQUE(`notification_id`,`teacher_id`)
);

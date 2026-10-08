CREATE TABLE `leave_types` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`code` varchar(32) NOT NULL,
	`name` varchar(100) NOT NULL,
	`annual_quota` int,
	`is_paid` boolean NOT NULL DEFAULT true,
	`is_active` boolean NOT NULL DEFAULT true,
	`sort_order` int NOT NULL DEFAULT 0,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `leave_types_id` PRIMARY KEY(`id`),
	CONSTRAINT `leave_types_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	CONSTRAINT `leave_types_tenant_id_uq` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `leave_types_tenant_code_uq` UNIQUE(`tenant_id`,`code`)
);--> statement-breakpoint
CREATE TABLE `leave_requests` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`teacher_id` char(36) NOT NULL,
	`leave_type_id` char(36) NOT NULL,
	`start_date` date NOT NULL,
	`end_date` date NOT NULL,
	`days` int NOT NULL,
	`reason` varchar(500),
	`status` enum('PENDING','APPROVED','REJECTED','CANCELLED') NOT NULL DEFAULT 'PENDING',
	`decided_by` char(36),
	`decided_at` datetime(3),
	`decision_note` varchar(500),
	`version` int NOT NULL DEFAULT 1,
	`created_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `leave_requests_id` PRIMARY KEY(`id`),
	CONSTRAINT `leave_requests_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	CONSTRAINT `leave_requests_tenant_id_uq` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `leave_requests_teacher_fk` FOREIGN KEY (`tenant_id`,`teacher_id`) REFERENCES `teachers`(`tenant_id`,`id`),
	CONSTRAINT `leave_requests_type_fk` FOREIGN KEY (`tenant_id`,`leave_type_id`) REFERENCES `leave_types`(`tenant_id`,`id`)
);--> statement-breakpoint
CREATE INDEX `leave_requests_teacher_idx` ON `leave_requests` (`tenant_id`,`teacher_id`,`start_date`);--> statement-breakpoint
CREATE INDEX `leave_requests_status_idx` ON `leave_requests` (`tenant_id`,`status`,`start_date`);--> statement-breakpoint
CREATE TABLE `staff_attendance` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`teacher_id` char(36) NOT NULL,
	`attendance_date` date NOT NULL,
	`status` enum('PRESENT','ABSENT','LEAVE','LATE') NOT NULL,
	`note` varchar(255),
	`marked_by` char(36),
	`version` int NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `staff_attendance_id` PRIMARY KEY(`id`),
	CONSTRAINT `staff_attendance_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	CONSTRAINT `staff_attendance_day_uq` UNIQUE(`tenant_id`,`teacher_id`,`attendance_date`),
	CONSTRAINT `staff_attendance_teacher_fk` FOREIGN KEY (`tenant_id`,`teacher_id`) REFERENCES `teachers`(`tenant_id`,`id`)
);--> statement-breakpoint
CREATE INDEX `staff_attendance_date_idx` ON `staff_attendance` (`tenant_id`,`attendance_date`);

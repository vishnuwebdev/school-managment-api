CREATE TABLE `student_exits` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`student_id` char(36) NOT NULL,
	`kind` enum('WITHDRAWN','TRANSFERRED') NOT NULL,
	`exit_date` date NOT NULL,
	`reason` varchar(500) NOT NULL,
	`remarks` varchar(1000),
	`destination_school` varchar(200),
	`document_file_id` char(36),
	`document_name` varchar(255),
	`reinstated_at` datetime(3),
	`recorded_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `student_exits_id` PRIMARY KEY(`id`),
	CONSTRAINT `student_exits_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	CONSTRAINT `student_exits_student_fk` FOREIGN KEY (`tenant_id`,`student_id`) REFERENCES `students`(`tenant_id`,`id`)
);--> statement-breakpoint
CREATE INDEX `student_exits_student_idx` ON `student_exits` (`tenant_id`,`student_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `student_exits_date_idx` ON `student_exits` (`tenant_id`,`kind`,`exit_date`);

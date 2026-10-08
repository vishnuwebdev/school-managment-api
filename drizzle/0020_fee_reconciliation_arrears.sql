CREATE TABLE `bank_statements` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`file_name` varchar(255) NOT NULL,
	`statement_from` date,
	`statement_to` date,
	`line_count` int NOT NULL DEFAULT 0,
	`duplicate_count` int NOT NULL DEFAULT 0,
	`imported_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `bank_statements_id` PRIMARY KEY(`id`),
	CONSTRAINT `bank_statements_tenant_id_uq` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `bank_statements_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`)
);--> statement-breakpoint
CREATE INDEX `bank_statements_created_idx` ON `bank_statements` (`tenant_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `bank_statement_lines` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`statement_id` char(36) NOT NULL,
	`line_date` date NOT NULL,
	`description` varchar(300) NOT NULL DEFAULT '',
	`reference` varchar(150),
	`amount` decimal(14,2) NOT NULL,
	`line_hash` char(64) NOT NULL,
	`status` enum('UNMATCHED','SUGGESTED','MATCHED','IGNORED') NOT NULL DEFAULT 'UNMATCHED',
	`match_type` enum('REFERENCE_AMOUNT','AMOUNT','MANUAL','RECORDED'),
	`suggested_payment_id` char(36),
	`payment_id` char(36),
	`note` varchar(500),
	`resolved_by` char(36),
	`resolved_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `bank_statement_lines_id` PRIMARY KEY(`id`),
	CONSTRAINT `bank_lines_hash_uq` UNIQUE(`tenant_id`,`line_hash`),
	CONSTRAINT `bank_lines_payment_uq` UNIQUE(`tenant_id`,`payment_id`),
	CONSTRAINT `bank_lines_amount_chk` CHECK(`amount` > 0),
	CONSTRAINT `bank_statement_lines_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	CONSTRAINT `bank_lines_statement_fk` FOREIGN KEY (`tenant_id`,`statement_id`) REFERENCES `bank_statements`(`tenant_id`,`id`),
	CONSTRAINT `bank_lines_payment_fk` FOREIGN KEY (`tenant_id`,`payment_id`) REFERENCES `school_payments`(`tenant_id`,`id`)
);--> statement-breakpoint
CREATE INDEX `bank_lines_statement_idx` ON `bank_statement_lines` (`tenant_id`,`statement_id`,`status`);--> statement-breakpoint
CREATE INDEX `bank_lines_status_idx` ON `bank_statement_lines` (`tenant_id`,`status`,`line_date`);--> statement-breakpoint
CREATE TABLE `fee_reminders` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`student_id` char(36) NOT NULL,
	`stage` enum('FIRST_REMINDER','SECOND_REMINDER','LETTER_OF_DEMAND','COLLECTIONS_HANDOVER') NOT NULL,
	`outstanding_amount` decimal(14,2) NOT NULL,
	`oldest_due_date` date,
	`days_overdue` int NOT NULL DEFAULT 0,
	`note` varchar(500),
	`created_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `fee_reminders_id` PRIMARY KEY(`id`),
	CONSTRAINT `fee_reminders_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	CONSTRAINT `fee_reminders_student_fk` FOREIGN KEY (`tenant_id`,`student_id`) REFERENCES `students`(`tenant_id`,`id`)
);--> statement-breakpoint
CREATE INDEX `fee_reminders_student_idx` ON `fee_reminders` (`tenant_id`,`student_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `fee_reminders_stage_idx` ON `fee_reminders` (`tenant_id`,`stage`,`created_at`);--> statement-breakpoint
CREATE TABLE `fee_payment_plans` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`student_id` char(36) NOT NULL,
	`status` enum('ACTIVE','COMPLETED','BROKEN','CANCELLED') NOT NULL DEFAULT 'ACTIVE',
	`total_amount` decimal(14,2) NOT NULL,
	`start_date` date NOT NULL,
	`note` varchar(500),
	`broken_on` date,
	`closed_reason` varchar(500),
	`active_key` char(36) GENERATED ALWAYS AS ((IF(`status` = 'ACTIVE', `student_id`, NULL))) VIRTUAL,
	`version` int NOT NULL DEFAULT 1,
	`created_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `fee_payment_plans_id` PRIMARY KEY(`id`),
	CONSTRAINT `fee_plans_tenant_id_uq` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `fee_plans_active_uq` UNIQUE(`active_key`),
	CONSTRAINT `fee_plans_total_chk` CHECK(`total_amount` > 0),
	CONSTRAINT `fee_payment_plans_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	CONSTRAINT `fee_plans_student_fk` FOREIGN KEY (`tenant_id`,`student_id`) REFERENCES `students`(`tenant_id`,`id`)
);--> statement-breakpoint
CREATE INDEX `fee_plans_student_idx` ON `fee_payment_plans` (`tenant_id`,`student_id`,`status`);--> statement-breakpoint
CREATE TABLE `fee_plan_instalments` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`plan_id` char(36) NOT NULL,
	`seq` smallint NOT NULL,
	`due_date` date NOT NULL,
	`amount` decimal(14,2) NOT NULL,
	CONSTRAINT `fee_plan_instalments_id` PRIMARY KEY(`id`),
	CONSTRAINT `fee_plan_instalments_seq_uq` UNIQUE(`plan_id`,`seq`),
	CONSTRAINT `fee_plan_instalments_amount_chk` CHECK(`amount` > 0),
	CONSTRAINT `fee_plan_instalments_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	CONSTRAINT `fee_plan_instalments_plan_fk` FOREIGN KEY (`tenant_id`,`plan_id`) REFERENCES `fee_payment_plans`(`tenant_id`,`id`)
);--> statement-breakpoint
CREATE INDEX `fee_plan_instalments_due_idx` ON `fee_plan_instalments` (`tenant_id`,`due_date`);

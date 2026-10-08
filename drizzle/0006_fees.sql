CREATE TABLE `fee_adjustments` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`type` enum('CONCESSION','WAIVER') NOT NULL,
	`student_id` char(36) NOT NULL,
	`fee_demand_id` char(36) NOT NULL,
	`value_type` enum('AMOUNT','PERCENT') NOT NULL,
	`value` decimal(14,2) NOT NULL,
	`applied_amount` decimal(14,2),
	`currency` char(3) NOT NULL,
	`reason` varchar(500) NOT NULL,
	`status` enum('REQUESTED','APPROVED','APPLIED','REJECTED','CANCELLED') NOT NULL DEFAULT 'REQUESTED',
	`requested_on` date NOT NULL,
	`requested_by` char(36),
	`requested_at` datetime(3) NOT NULL,
	`approved_by` char(36),
	`approved_at` datetime(3),
	`decision_note` varchar(500),
	`rejected_by` char(36),
	`rejected_at` datetime(3),
	`applied_by` char(36),
	`applied_at` datetime(3),
	`cancelled_by` char(36),
	`cancelled_at` datetime(3),
	`cancel_reason` varchar(500),
	`version` int NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `fee_adjustments_id` PRIMARY KEY(`id`),
	CONSTRAINT `fee_adjustments_tenant_id_uq` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `fee_adjustments_value_chk` CHECK(`fee_adjustments`.`value` > 0)
);
--> statement-breakpoint
CREATE TABLE `fee_categories` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`code` varchar(32) NOT NULL,
	`name` varchar(100) NOT NULL,
	`description` varchar(500),
	`status` enum('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
	`version` int NOT NULL DEFAULT 1,
	`created_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` char(36),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `fee_categories_id` PRIMARY KEY(`id`),
	CONSTRAINT `fee_categories_tenant_id_uq` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `fee_categories_tenant_code_uq` UNIQUE(`tenant_id`,`code`)
);
--> statement-breakpoint
CREATE TABLE `fee_components` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`fee_structure_id` char(36) NOT NULL,
	`fee_category_id` char(36) NOT NULL,
	`name` varchar(120) NOT NULL,
	`amount` decimal(14,2) NOT NULL,
	`frequency` enum('ONE_TIME','MONTHLY','QUARTERLY','HALF_YEARLY','ANNUAL','CUSTOM') NOT NULL,
	`due_rule` json NOT NULL,
	`display_order` int NOT NULL DEFAULT 0,
	`version` int NOT NULL DEFAULT 1,
	`created_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` char(36),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `fee_components_id` PRIMARY KEY(`id`),
	CONSTRAINT `fee_components_tenant_id_uq` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `fee_components_amount_chk` CHECK(`fee_components`.`amount` > 0)
);
--> statement-breakpoint
CREATE TABLE `fee_demands` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`demand_number` varchar(32) NOT NULL,
	`student_id` char(36) NOT NULL,
	`enrollment_id` char(36) NOT NULL,
	`academic_year_id` char(36) NOT NULL,
	`student_fee_assignment_id` char(36) NOT NULL,
	`fee_component_id` char(36) NOT NULL,
	`fee_category_id` char(36) NOT NULL,
	`period_key` varchar(16) NOT NULL,
	`period_label` varchar(80) NOT NULL,
	`description` varchar(200) NOT NULL,
	`currency` char(3) NOT NULL,
	`original_amount` decimal(14,2) NOT NULL,
	`discount_amount` decimal(14,2) NOT NULL DEFAULT '0.00',
	`concession_amount` decimal(14,2) NOT NULL DEFAULT '0.00',
	`waiver_amount` decimal(14,2) NOT NULL DEFAULT '0.00',
	`late_fee_amount` decimal(14,2) NOT NULL DEFAULT '0.00',
	`final_amount` decimal(14,2) NOT NULL,
	`paid_amount` decimal(14,2) NOT NULL DEFAULT '0.00',
	`written_off_amount` decimal(14,2) NOT NULL DEFAULT '0.00',
	`due_date` date NOT NULL,
	`status` enum('DRAFT','ISSUED','PARTIALLY_PAID','PAID','OVERDUE','CANCELLED','WRITTEN_OFF','WAIVED') NOT NULL DEFAULT 'DRAFT',
	`issued_at` datetime(3),
	`issued_by` char(36),
	`settled_at` datetime(3),
	`late_fee_applied_at` datetime(3),
	`cancelled_at` datetime(3),
	`cancelled_by` char(36),
	`cancel_reason` varchar(500),
	`written_off_at` datetime(3),
	`written_off_by` char(36),
	`write_off_reason` varchar(500),
	`version` int NOT NULL DEFAULT 1,
	`created_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `fee_demands_id` PRIMARY KEY(`id`),
	CONSTRAINT `fee_demands_tenant_id_uq` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `fee_demands_tenant_id_student_uq` UNIQUE(`tenant_id`,`id`,`student_id`),
	CONSTRAINT `fee_demands_tenant_number_uq` UNIQUE(`tenant_id`,`demand_number`),
	CONSTRAINT `fee_demands_slot_uq` UNIQUE(`tenant_id`,`student_fee_assignment_id`,`fee_component_id`,`period_key`),
	CONSTRAINT `fee_demands_amounts_chk` CHECK(`fee_demands`.`original_amount` >= 0 AND `fee_demands`.`discount_amount` >= 0 AND `fee_demands`.`concession_amount` >= 0 AND `fee_demands`.`waiver_amount` >= 0 AND `fee_demands`.`late_fee_amount` >= 0 AND `fee_demands`.`paid_amount` >= 0 AND `fee_demands`.`written_off_amount` >= 0),
	CONSTRAINT `fee_demands_final_chk` CHECK(`fee_demands`.`final_amount` = `fee_demands`.`original_amount` - `fee_demands`.`discount_amount` - `fee_demands`.`concession_amount` - `fee_demands`.`waiver_amount` + `fee_demands`.`late_fee_amount`),
	CONSTRAINT `fee_demands_balance_chk` CHECK(`fee_demands`.`final_amount` >= 0 AND `fee_demands`.`paid_amount` + `fee_demands`.`written_off_amount` <= `fee_demands`.`final_amount`)
);
--> statement-breakpoint
CREATE TABLE `receipts` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`payment_id` char(36) NOT NULL,
	`student_id` char(36) NOT NULL,
	`receipt_number` varchar(32) NOT NULL,
	`status` enum('ISSUED','VOID') NOT NULL DEFAULT 'ISSUED',
	`amount` decimal(14,2) NOT NULL,
	`currency` char(3) NOT NULL,
	`issued_at` datetime(3) NOT NULL,
	`issued_by` char(36),
	`voided_at` datetime(3),
	`voided_by` char(36),
	`void_reason` varchar(500),
	`active_key` varchar(36) GENERATED ALWAYS AS ((IF(`status` = 'ISSUED', `payment_id`, NULL))) VIRTUAL,
	`version` int NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `receipts_id` PRIMARY KEY(`id`),
	CONSTRAINT `receipts_tenant_id_uq` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `receipts_tenant_number_uq` UNIQUE(`tenant_id`,`receipt_number`),
	CONSTRAINT `receipts_active_uq` UNIQUE(`active_key`)
);
--> statement-breakpoint
CREATE TABLE `fee_refunds` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`refund_number` varchar(32) NOT NULL,
	`payment_id` char(36) NOT NULL,
	`student_id` char(36) NOT NULL,
	`amount` decimal(14,2) NOT NULL,
	`currency` char(3) NOT NULL,
	`reason` varchar(500) NOT NULL,
	`status` enum('REQUESTED','APPROVED','PROCESSING','COMPLETED','FAILED','CANCELLED') NOT NULL DEFAULT 'REQUESTED',
	`provider_reference` varchar(128),
	`from_unallocated` decimal(14,2),
	`requested_on` date NOT NULL,
	`requested_by` char(36),
	`requested_at` datetime(3) NOT NULL,
	`approved_by` char(36),
	`approved_at` datetime(3),
	`processing_at` datetime(3),
	`processing_by` char(36),
	`completed_at` datetime(3),
	`completed_by` char(36),
	`failed_at` datetime(3),
	`failed_reason` varchar(500),
	`cancelled_at` datetime(3),
	`cancelled_by` char(36),
	`cancel_reason` varchar(500),
	`version` int NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `fee_refunds_id` PRIMARY KEY(`id`),
	CONSTRAINT `fee_refunds_tenant_id_uq` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `fee_refunds_tenant_number_uq` UNIQUE(`tenant_id`,`refund_number`),
	CONSTRAINT `fee_refunds_amount_chk` CHECK(`fee_refunds`.`amount` > 0)
);
--> statement-breakpoint
CREATE TABLE `fee_settings` (
	`tenant_id` char(36) NOT NULL,
	`currency` char(3) NOT NULL,
	`late_fee_enabled` boolean NOT NULL DEFAULT false,
	`late_fee_type` enum('FIXED','PERCENT','PER_DAY') NOT NULL DEFAULT 'FIXED',
	`late_fee_value` decimal(14,2) NOT NULL DEFAULT '0.00',
	`late_fee_grace_days` int NOT NULL DEFAULT 0,
	`late_fee_cap` decimal(14,2),
	`version` int NOT NULL DEFAULT 1,
	`updated_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `fee_settings_tenant_id` PRIMARY KEY(`tenant_id`),
	CONSTRAINT `fee_settings_late_value_chk` CHECK(`fee_settings`.`late_fee_value` >= 0)
);
--> statement-breakpoint
CREATE TABLE `fee_structures` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`code` varchar(32) NOT NULL,
	`name` varchar(120) NOT NULL,
	`description` varchar(500),
	`version_no` int NOT NULL,
	`academic_year_id` char(36) NOT NULL,
	`academic_class_id` char(36),
	`currency` char(3) NOT NULL,
	`status` enum('DRAFT','PUBLISHED','ARCHIVED') NOT NULL DEFAULT 'DRAFT',
	`effective_from` date,
	`effective_to` date,
	`copied_from_id` char(36),
	`superseded_by_id` char(36),
	`published_key` varchar(160) GENERATED ALWAYS AS ((IF(`status` = 'PUBLISHED', CONCAT(`tenant_id`, ':', `academic_year_id`, ':', IFNULL(`academic_class_id`, 'ALL'), ':', `code`), NULL))) VIRTUAL,
	`published_at` datetime(3),
	`published_by` char(36),
	`archived_at` datetime(3),
	`archived_by` char(36),
	`version` int NOT NULL DEFAULT 1,
	`created_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` char(36),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `fee_structures_id` PRIMARY KEY(`id`),
	CONSTRAINT `fee_structures_tenant_id_uq` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `fee_structures_tenant_id_year_uq` UNIQUE(`tenant_id`,`id`,`academic_year_id`),
	CONSTRAINT `fee_structures_code_version_uq` UNIQUE(`tenant_id`,`code`,`version_no`),
	CONSTRAINT `fee_structures_published_uq` UNIQUE(`published_key`)
);
--> statement-breakpoint
CREATE TABLE `payment_allocations` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`payment_id` char(36) NOT NULL,
	`fee_demand_id` char(36) NOT NULL,
	`student_id` char(36) NOT NULL,
	`currency` char(3) NOT NULL,
	`allocated_amount` decimal(14,2) NOT NULL,
	`reversed_amount` decimal(14,2) NOT NULL DEFAULT '0.00',
	`status` enum('ACTIVE','PARTIALLY_REVERSED','REVERSED') NOT NULL DEFAULT 'ACTIVE',
	`allocated_by` char(36),
	`reversed_at` datetime(3),
	`reversed_by` char(36),
	`reversal_reason` varchar(500),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `payment_allocations_id` PRIMARY KEY(`id`),
	CONSTRAINT `payment_allocations_tenant_id_uq` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `payment_allocations_amount_chk` CHECK(`payment_allocations`.`allocated_amount` > 0),
	CONSTRAINT `payment_allocations_reversed_chk` CHECK(`payment_allocations`.`reversed_amount` >= 0 AND `payment_allocations`.`reversed_amount` <= `payment_allocations`.`allocated_amount`)
);
--> statement-breakpoint
CREATE TABLE `refund_allocations` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`refund_id` char(36) NOT NULL,
	`payment_allocation_id` char(36) NOT NULL,
	`amount` decimal(14,2) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `refund_allocations_id` PRIMARY KEY(`id`),
	CONSTRAINT `refund_allocations_amount_chk` CHECK(`refund_allocations`.`amount` > 0)
);
--> statement-breakpoint
CREATE TABLE `school_payments` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`payment_number` varchar(32) NOT NULL,
	`student_id` char(36) NOT NULL,
	`payer_type` enum('STUDENT','GUARDIAN','OTHER') NOT NULL DEFAULT 'GUARDIAN',
	`payer_name` varchar(150),
	`payer_reference` varchar(100),
	`amount` decimal(14,2) NOT NULL,
	`currency` char(3) NOT NULL,
	`method` enum('CASH','BANK_TRANSFER','CHEQUE','CARD','UPI','ONLINE_GATEWAY','OTHER') NOT NULL,
	`status` enum('PENDING','RECEIVED','VERIFIED','FAILED','CANCELLED','REFUNDED','PARTIALLY_REFUNDED') NOT NULL DEFAULT 'PENDING',
	`provider` varchar(64),
	`provider_reference` varchar(128),
	`idempotency_key` varchar(128),
	`notes` varchar(500),
	`received_on` date NOT NULL,
	`received_at` datetime(3),
	`verified_at` datetime(3),
	`verified_by` char(36),
	`failed_reason` varchar(500),
	`cancelled_at` datetime(3),
	`cancelled_by` char(36),
	`cancel_reason` varchar(500),
	`allocated_amount` decimal(14,2) NOT NULL DEFAULT '0.00',
	`refunded_amount` decimal(14,2) NOT NULL DEFAULT '0.00',
	`version` int NOT NULL DEFAULT 1,
	`recorded_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `school_payments_id` PRIMARY KEY(`id`),
	CONSTRAINT `school_payments_tenant_id_uq` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `school_payments_tenant_id_student_uq` UNIQUE(`tenant_id`,`id`,`student_id`),
	CONSTRAINT `school_payments_tenant_number_uq` UNIQUE(`tenant_id`,`payment_number`),
	CONSTRAINT `school_payments_idempotency_uq` UNIQUE(`tenant_id`,`idempotency_key`),
	CONSTRAINT `school_payments_provider_ref_uq` UNIQUE(`tenant_id`,`provider_reference`),
	CONSTRAINT `school_payments_amount_chk` CHECK(`school_payments`.`amount` > 0),
	CONSTRAINT `school_payments_balance_chk` CHECK(`school_payments`.`allocated_amount` >= 0 AND `school_payments`.`refunded_amount` >= 0 AND `school_payments`.`allocated_amount` + `school_payments`.`refunded_amount` <= `school_payments`.`amount`)
);
--> statement-breakpoint
CREATE TABLE `student_fee_assignments` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`student_id` char(36) NOT NULL,
	`enrollment_id` char(36) NOT NULL,
	`academic_year_id` char(36) NOT NULL,
	`fee_structure_id` char(36) NOT NULL,
	`structure_code` varchar(32) NOT NULL,
	`status` enum('ACTIVE','CANCELLED') NOT NULL DEFAULT 'ACTIVE',
	`discount_percent` decimal(5,2) NOT NULL DEFAULT '0.00',
	`discount_reason` varchar(500),
	`notes` varchar(500),
	`assigned_at` datetime(3) NOT NULL,
	`assigned_by` char(36),
	`cancelled_at` datetime(3),
	`cancelled_by` char(36),
	`cancel_reason` varchar(500),
	`active_key` varchar(80) GENERATED ALWAYS AS ((IF(`status` = 'ACTIVE', CONCAT(`enrollment_id`, ':', `structure_code`), NULL))) VIRTUAL,
	`version` int NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `student_fee_assignments_id` PRIMARY KEY(`id`),
	CONSTRAINT `student_fee_assignments_tenant_id_uq` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `student_fee_assignments_tenant_id_student_uq` UNIQUE(`tenant_id`,`id`,`student_id`),
	CONSTRAINT `student_fee_assignments_active_uq` UNIQUE(`active_key`),
	CONSTRAINT `student_fee_assignments_discount_chk` CHECK(`student_fee_assignments`.`discount_percent` >= 0 AND `student_fee_assignments`.`discount_percent` <= 100)
);
--> statement-breakpoint
ALTER TABLE `enrollments` ADD CONSTRAINT `enrollments_tenant_id_student_year_uq` UNIQUE(`tenant_id`,`id`,`student_id`,`academic_year_id`);--> statement-breakpoint
ALTER TABLE `fee_adjustments` ADD CONSTRAINT `fee_adjustments_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `fee_adjustments` ADD CONSTRAINT `fee_adjustments_demand_fk` FOREIGN KEY (`tenant_id`,`fee_demand_id`,`student_id`) REFERENCES `fee_demands`(`tenant_id`,`id`,`student_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `fee_categories` ADD CONSTRAINT `fee_categories_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `fee_components` ADD CONSTRAINT `fee_components_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `fee_components` ADD CONSTRAINT `fee_components_structure_fk` FOREIGN KEY (`tenant_id`,`fee_structure_id`) REFERENCES `fee_structures`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `fee_components` ADD CONSTRAINT `fee_components_category_fk` FOREIGN KEY (`tenant_id`,`fee_category_id`) REFERENCES `fee_categories`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `fee_demands` ADD CONSTRAINT `fee_demands_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `fee_demands` ADD CONSTRAINT `fee_demands_student_fk` FOREIGN KEY (`tenant_id`,`student_id`) REFERENCES `students`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `fee_demands` ADD CONSTRAINT `fee_demands_enrollment_fk` FOREIGN KEY (`tenant_id`,`enrollment_id`) REFERENCES `enrollments`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `fee_demands` ADD CONSTRAINT `fee_demands_year_fk` FOREIGN KEY (`tenant_id`,`academic_year_id`) REFERENCES `academic_years`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `fee_demands` ADD CONSTRAINT `fee_demands_assignment_fk` FOREIGN KEY (`tenant_id`,`student_fee_assignment_id`,`student_id`) REFERENCES `student_fee_assignments`(`tenant_id`,`id`,`student_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `fee_demands` ADD CONSTRAINT `fee_demands_component_fk` FOREIGN KEY (`tenant_id`,`fee_component_id`) REFERENCES `fee_components`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `fee_demands` ADD CONSTRAINT `fee_demands_category_fk` FOREIGN KEY (`tenant_id`,`fee_category_id`) REFERENCES `fee_categories`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `receipts` ADD CONSTRAINT `receipts_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `receipts` ADD CONSTRAINT `receipts_payment_fk` FOREIGN KEY (`tenant_id`,`payment_id`,`student_id`) REFERENCES `school_payments`(`tenant_id`,`id`,`student_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `fee_refunds` ADD CONSTRAINT `fee_refunds_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `fee_refunds` ADD CONSTRAINT `fee_refunds_payment_fk` FOREIGN KEY (`tenant_id`,`payment_id`,`student_id`) REFERENCES `school_payments`(`tenant_id`,`id`,`student_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `fee_settings` ADD CONSTRAINT `fee_settings_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `fee_structures` ADD CONSTRAINT `fee_structures_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `fee_structures` ADD CONSTRAINT `fee_structures_year_fk` FOREIGN KEY (`tenant_id`,`academic_year_id`) REFERENCES `academic_years`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `fee_structures` ADD CONSTRAINT `fee_structures_class_fk` FOREIGN KEY (`tenant_id`,`academic_class_id`) REFERENCES `academic_classes`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `fee_structures` ADD CONSTRAINT `fee_structures_copied_from_fk` FOREIGN KEY (`tenant_id`,`copied_from_id`) REFERENCES `fee_structures`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `fee_structures` ADD CONSTRAINT `fee_structures_superseded_by_fk` FOREIGN KEY (`tenant_id`,`superseded_by_id`) REFERENCES `fee_structures`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payment_allocations` ADD CONSTRAINT `payment_allocations_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payment_allocations` ADD CONSTRAINT `payment_allocations_payment_fk` FOREIGN KEY (`tenant_id`,`payment_id`,`student_id`) REFERENCES `school_payments`(`tenant_id`,`id`,`student_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payment_allocations` ADD CONSTRAINT `payment_allocations_demand_fk` FOREIGN KEY (`tenant_id`,`fee_demand_id`,`student_id`) REFERENCES `fee_demands`(`tenant_id`,`id`,`student_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `refund_allocations` ADD CONSTRAINT `refund_allocations_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `refund_allocations` ADD CONSTRAINT `refund_allocations_refund_fk` FOREIGN KEY (`tenant_id`,`refund_id`) REFERENCES `fee_refunds`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `refund_allocations` ADD CONSTRAINT `refund_allocations_allocation_fk` FOREIGN KEY (`tenant_id`,`payment_allocation_id`) REFERENCES `payment_allocations`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `school_payments` ADD CONSTRAINT `school_payments_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `school_payments` ADD CONSTRAINT `school_payments_student_fk` FOREIGN KEY (`tenant_id`,`student_id`) REFERENCES `students`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `student_fee_assignments` ADD CONSTRAINT `student_fee_assignments_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `student_fee_assignments` ADD CONSTRAINT `student_fee_assignments_student_fk` FOREIGN KEY (`tenant_id`,`student_id`) REFERENCES `students`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `student_fee_assignments` ADD CONSTRAINT `student_fee_assignments_enrollment_fk` FOREIGN KEY (`tenant_id`,`enrollment_id`,`student_id`,`academic_year_id`) REFERENCES `enrollments`(`tenant_id`,`id`,`student_id`,`academic_year_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `student_fee_assignments` ADD CONSTRAINT `student_fee_assignments_structure_fk` FOREIGN KEY (`tenant_id`,`fee_structure_id`,`academic_year_id`) REFERENCES `fee_structures`(`tenant_id`,`id`,`academic_year_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `fee_adjustments_demand_idx` ON `fee_adjustments` (`tenant_id`,`fee_demand_id`);--> statement-breakpoint
CREATE INDEX `fee_adjustments_student_idx` ON `fee_adjustments` (`tenant_id`,`student_id`);--> statement-breakpoint
CREATE INDEX `fee_adjustments_status_idx` ON `fee_adjustments` (`tenant_id`,`status`,`type`);--> statement-breakpoint
CREATE INDEX `fee_adjustments_requested_idx` ON `fee_adjustments` (`tenant_id`,`requested_on`);--> statement-breakpoint
CREATE INDEX `fee_categories_tenant_status_idx` ON `fee_categories` (`tenant_id`,`status`);--> statement-breakpoint
CREATE INDEX `fee_components_structure_idx` ON `fee_components` (`tenant_id`,`fee_structure_id`,`display_order`);--> statement-breakpoint
CREATE INDEX `fee_components_category_idx` ON `fee_components` (`tenant_id`,`fee_category_id`);--> statement-breakpoint
CREATE INDEX `fee_demands_student_status_idx` ON `fee_demands` (`tenant_id`,`student_id`,`status`);--> statement-breakpoint
CREATE INDEX `fee_demands_due_idx` ON `fee_demands` (`tenant_id`,`due_date`,`status`);--> statement-breakpoint
CREATE INDEX `fee_demands_year_idx` ON `fee_demands` (`tenant_id`,`academic_year_id`,`status`);--> statement-breakpoint
CREATE INDEX `fee_demands_assignment_idx` ON `fee_demands` (`tenant_id`,`student_fee_assignment_id`);--> statement-breakpoint
CREATE INDEX `fee_demands_category_idx` ON `fee_demands` (`tenant_id`,`fee_category_id`);--> statement-breakpoint
CREATE INDEX `receipts_payment_idx` ON `receipts` (`tenant_id`,`payment_id`);--> statement-breakpoint
CREATE INDEX `receipts_student_idx` ON `receipts` (`tenant_id`,`student_id`);--> statement-breakpoint
CREATE INDEX `fee_refunds_payment_idx` ON `fee_refunds` (`tenant_id`,`payment_id`,`status`);--> statement-breakpoint
CREATE INDEX `fee_refunds_student_idx` ON `fee_refunds` (`tenant_id`,`student_id`);--> statement-breakpoint
CREATE INDEX `fee_refunds_status_idx` ON `fee_refunds` (`tenant_id`,`status`);--> statement-breakpoint
CREATE INDEX `fee_refunds_requested_idx` ON `fee_refunds` (`tenant_id`,`requested_on`);--> statement-breakpoint
CREATE INDEX `fee_structures_year_status_idx` ON `fee_structures` (`tenant_id`,`academic_year_id`,`status`);--> statement-breakpoint
CREATE INDEX `payment_allocations_payment_idx` ON `payment_allocations` (`tenant_id`,`payment_id`);--> statement-breakpoint
CREATE INDEX `payment_allocations_demand_idx` ON `payment_allocations` (`tenant_id`,`fee_demand_id`);--> statement-breakpoint
CREATE INDEX `refund_allocations_refund_idx` ON `refund_allocations` (`tenant_id`,`refund_id`);--> statement-breakpoint
CREATE INDEX `refund_allocations_allocation_idx` ON `refund_allocations` (`tenant_id`,`payment_allocation_id`);--> statement-breakpoint
CREATE INDEX `school_payments_student_idx` ON `school_payments` (`tenant_id`,`student_id`,`status`);--> statement-breakpoint
CREATE INDEX `school_payments_status_idx` ON `school_payments` (`tenant_id`,`status`);--> statement-breakpoint
CREATE INDEX `school_payments_received_idx` ON `school_payments` (`tenant_id`,`received_on`);--> statement-breakpoint
CREATE INDEX `student_fee_assignments_student_idx` ON `student_fee_assignments` (`tenant_id`,`student_id`);--> statement-breakpoint
CREATE INDEX `student_fee_assignments_enrollment_idx` ON `student_fee_assignments` (`tenant_id`,`enrollment_id`);--> statement-breakpoint
CREATE INDEX `student_fee_assignments_structure_idx` ON `student_fee_assignments` (`tenant_id`,`fee_structure_id`,`status`);
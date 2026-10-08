CREATE TABLE `billing_sequences` (
	`sequence_key` varchar(64) NOT NULL,
	`last_value` bigint NOT NULL DEFAULT 0,
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `billing_sequences_sequence_key` PRIMARY KEY(`sequence_key`)
);
--> statement-breakpoint
CREATE TABLE `subscription_invoices` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`subscription_id` char(36),
	`invoice_number` varchar(32) NOT NULL,
	`status` enum('OPEN','PAID','VOID') NOT NULL DEFAULT 'OPEN',
	`currency` char(3) NOT NULL,
	`description` varchar(300) NOT NULL,
	`plan_name` varchar(120),
	`period_start` datetime(3),
	`period_end` datetime(3),
	`issued_at` datetime(3) NOT NULL,
	`due_at` datetime(3) NOT NULL,
	`subtotal_minor` bigint NOT NULL,
	`discount_minor` bigint NOT NULL DEFAULT 0,
	`total_minor` bigint NOT NULL,
	`paid_minor` bigint NOT NULL DEFAULT 0,
	`paid_at` datetime(3),
	`voided_at` datetime(3),
	`void_reason` varchar(500),
	`created_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `subscription_invoices_id` PRIMARY KEY(`id`),
	CONSTRAINT `subscription_invoices_number_uq` UNIQUE(`invoice_number`)
);
--> statement-breakpoint
CREATE TABLE `subscription_payments` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`invoice_id` char(36) NOT NULL,
	`receipt_number` varchar(32) NOT NULL,
	`amount_minor` bigint NOT NULL,
	`currency` char(3) NOT NULL,
	`method` enum('CASH','BANK_TRANSFER','CHEQUE','CARD','MOBILE_MONEY','OTHER') NOT NULL,
	`reference` varchar(100),
	`received_at` datetime(3) NOT NULL,
	`status` enum('RECEIVED','REVERSED') NOT NULL DEFAULT 'RECEIVED',
	`notes` varchar(500),
	`reversed_at` datetime(3),
	`reverse_reason` varchar(500),
	`recorded_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `subscription_payments_id` PRIMARY KEY(`id`),
	CONSTRAINT `subscription_payments_receipt_uq` UNIQUE(`receipt_number`)
);
--> statement-breakpoint
ALTER TABLE `subscription_invoices` ADD CONSTRAINT `subscription_invoices_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `subscription_invoices` ADD CONSTRAINT `subscription_invoices_subscription_id_subscriptions_id_fk` FOREIGN KEY (`subscription_id`) REFERENCES `subscriptions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `subscription_payments` ADD CONSTRAINT `subscription_payments_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `subscription_payments` ADD CONSTRAINT `subscription_payments_invoice_id_subscription_invoices_id_fk` FOREIGN KEY (`invoice_id`) REFERENCES `subscription_invoices`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `subscription_invoices_tenant_idx` ON `subscription_invoices` (`tenant_id`,`issued_at`);--> statement-breakpoint
CREATE INDEX `subscription_invoices_subscription_idx` ON `subscription_invoices` (`subscription_id`);--> statement-breakpoint
CREATE INDEX `subscription_payments_invoice_idx` ON `subscription_payments` (`invoice_id`);--> statement-breakpoint
CREATE INDEX `subscription_payments_tenant_idx` ON `subscription_payments` (`tenant_id`,`received_at`);

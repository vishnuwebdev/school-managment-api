-- School payments (20 Nov 2026): the yearly platform fee each school pays us, offline, in
-- agreed instalments. Reuses the subscription invoice / payment tables: an invoice of kind
-- SESSION_FEE is one school's fee for one session (Indian financial year, e.g. 2026-27).
ALTER TABLE `subscription_invoices`
  ADD COLUMN `kind` enum('SUBSCRIPTION','SESSION_FEE') NOT NULL DEFAULT 'SUBSCRIPTION' AFTER `invoice_number`,
  ADD COLUMN `session` varchar(7) NULL AFTER `kind`,
  ADD COLUMN `discount_reason` varchar(300) NULL AFTER `discount_minor`;
--> statement-breakpoint
CREATE INDEX `subscription_invoices_session_idx` ON `subscription_invoices` (`kind`, `session`);
--> statement-breakpoint
CREATE TABLE `billing_instalments` (
  `id` char(36) NOT NULL,
  `invoice_id` char(36) NOT NULL,
  `seq` int NOT NULL,
  `amount_minor` bigint NOT NULL,
  `due_date` date NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `billing_instalments_invoice_seq_uq` (`invoice_id`, `seq`),
  CONSTRAINT `billing_instalments_invoice_fk` FOREIGN KEY (`invoice_id`) REFERENCES `subscription_invoices` (`id`)
);
--> statement-breakpoint
CREATE TABLE `platform_settings` (
  `setting_key` varchar(100) NOT NULL,
  `value` json NOT NULL,
  `updated_by` char(36) NULL,
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`setting_key`)
);
--> statement-breakpoint
INSERT INTO `platform_settings` (`setting_key`, `value`) VALUES ('school_payments.default_fee_minor', '1000000');

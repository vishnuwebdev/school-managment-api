CREATE TABLE `tenant_profiles` (
	`tenant_id` char(36) NOT NULL,
	`affiliation_board` varchar(64),
	`affiliation_number` varchar(64),
	`school_code` varchar(64),
	`established_year` smallint,
	`medium_of_instruction` varchar(100),
	`motto` varchar(200),
	`about` text,
	`secondary_phone` varchar(32),
	`landline` varchar(32),
	`reception_phone` varchar(32),
	`alternate_email` varchar(254),
	`contact_person_name` varchar(200),
	`contact_person_role` varchar(100),
	`document_footer` varchar(500),
	`updated_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `tenant_profiles_tenant_id` PRIMARY KEY(`tenant_id`),
	CONSTRAINT `tenant_profiles_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`)
);--> statement-breakpoint
CREATE TABLE `files` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`purpose` enum('LOGO','BANNER','DOCUMENT_HEADER') NOT NULL,
	`original_name` varchar(255) NOT NULL,
	`mime_type` varchar(100) NOT NULL,
	`size_bytes` int NOT NULL,
	`checksum_sha256` char(64) NOT NULL,
	`storage_driver` varchar(16) NOT NULL,
	`storage_key` varchar(255) NOT NULL,
	`uploaded_by` char(36),
	`superseded_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `files_id` PRIMARY KEY(`id`),
	CONSTRAINT `files_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`)
);--> statement-breakpoint
CREATE INDEX `files_tenant_purpose_idx` ON `files` (`tenant_id`,`purpose`,`created_at`);--> statement-breakpoint
CREATE TABLE `tenant_bank_accounts` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`label` varchar(100),
	`account_holder` varchar(200) NOT NULL,
	`bank_name` varchar(200) NOT NULL,
	`branch_name` varchar(200),
	`account_number_enc` text NOT NULL,
	`account_last4` char(4) NOT NULL,
	`fingerprint` char(64) NOT NULL,
	`ifsc` varchar(11) NOT NULL,
	`account_type` enum('SAVINGS','CURRENT','OTHER') NOT NULL DEFAULT 'CURRENT',
	`upi_id` varchar(100),
	`is_default` boolean NOT NULL DEFAULT false,
	`archived_at` datetime(3),
	`version` int NOT NULL DEFAULT 1,
	`created_by` char(36),
	`updated_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `tenant_bank_accounts_id` PRIMARY KEY(`id`),
	CONSTRAINT `tenant_bank_accounts_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`)
);--> statement-breakpoint
CREATE INDEX `tenant_bank_accounts_tenant_idx` ON `tenant_bank_accounts` (`tenant_id`,`archived_at`);--> statement-breakpoint
CREATE TABLE `tenant_registrations` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`type_code` varchar(32) NOT NULL,
	`value` varchar(200) NOT NULL,
	`issued_on` date,
	`valid_until` date,
	`authority` varchar(200),
	`updated_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `tenant_registrations_id` PRIMARY KEY(`id`),
	CONSTRAINT `tenant_registrations_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	CONSTRAINT `tenant_registrations_type_uq` UNIQUE(`tenant_id`,`type_code`)
);--> statement-breakpoint
ALTER TABLE `tenant_settings` ADD `brand_secondary_color` varchar(9);--> statement-breakpoint
ALTER TABLE `tenant_settings` ADD `brand_accent_color` varchar(9);--> statement-breakpoint
ALTER TABLE `tenant_settings` ADD `banner_file_id` char(36);--> statement-breakpoint
ALTER TABLE `tenant_settings` ADD `document_header_file_id` char(36);

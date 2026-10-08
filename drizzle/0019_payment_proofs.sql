ALTER TABLE `files` MODIFY COLUMN `purpose` enum('LOGO','BANNER','DOCUMENT_HEADER','STUDENT_PHOTO','STUDENT_DOCUMENT','STAFF_PHOTO','STAFF_DOCUMENT','STUDENT_CERTIFICATE','PAYMENT_PROOF') NOT NULL;--> statement-breakpoint
CREATE TABLE `payment_proofs` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`payment_id` char(36) NOT NULL,
	`file_id` char(36) NOT NULL,
	`file_name` varchar(255) NOT NULL,
	`uploaded_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `payment_proofs_id` PRIMARY KEY(`id`),
	CONSTRAINT `payment_proofs_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	CONSTRAINT `payment_proofs_payment_fk` FOREIGN KEY (`tenant_id`,`payment_id`) REFERENCES `school_payments`(`tenant_id`,`id`)
);--> statement-breakpoint
CREATE INDEX `payment_proofs_payment_idx` ON `payment_proofs` (`tenant_id`,`payment_id`);

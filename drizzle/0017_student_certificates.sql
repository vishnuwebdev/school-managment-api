ALTER TABLE `files` MODIFY COLUMN `purpose` enum('LOGO','BANNER','DOCUMENT_HEADER','STUDENT_PHOTO','STUDENT_DOCUMENT','STAFF_PHOTO','STAFF_DOCUMENT','STUDENT_CERTIFICATE') NOT NULL;--> statement-breakpoint
CREATE TABLE `student_document_templates` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`kind` enum('BONAFIDE','TRANSFER_CERTIFICATE','CHARACTER_CERTIFICATE','ID_CARD') NOT NULL,
	`version` int NOT NULL,
	`title` varchar(150) NOT NULL,
	`body` text NOT NULL,
	`is_current` boolean NOT NULL DEFAULT true,
	`created_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `student_document_templates_id` PRIMARY KEY(`id`),
	CONSTRAINT `student_doc_templates_version_uq` UNIQUE(`tenant_id`,`kind`,`version`),
	CONSTRAINT `student_document_templates_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`)
);--> statement-breakpoint
CREATE INDEX `student_doc_templates_current_idx` ON `student_document_templates` (`tenant_id`,`kind`,`is_current`);--> statement-breakpoint
CREATE TABLE `issued_documents` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`student_id` char(36) NOT NULL,
	`kind` enum('BONAFIDE','TRANSFER_CERTIFICATE','CHARACTER_CERTIFICATE','ID_CARD') NOT NULL,
	`serial_number` varchar(32) NOT NULL,
	`template_id` char(36) NOT NULL,
	`template_version` int NOT NULL,
	`snapshot` json NOT NULL,
	`file_id` char(36) NOT NULL,
	`is_duplicate` boolean NOT NULL DEFAULT false,
	`remarks` varchar(500),
	`issued_by` char(36),
	`issued_at` datetime(3) NOT NULL,
	`voided_at` datetime(3),
	`voided_by` char(36),
	`void_reason` varchar(500),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `issued_documents_id` PRIMARY KEY(`id`),
	CONSTRAINT `issued_documents_serial_uq` UNIQUE(`tenant_id`,`serial_number`),
	CONSTRAINT `issued_documents_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	CONSTRAINT `issued_documents_student_fk` FOREIGN KEY (`tenant_id`,`student_id`) REFERENCES `students`(`tenant_id`,`id`)
);--> statement-breakpoint
CREATE INDEX `issued_documents_student_idx` ON `issued_documents` (`tenant_id`,`student_id`,`issued_at`);

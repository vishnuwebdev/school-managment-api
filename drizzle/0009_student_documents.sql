ALTER TABLE `files` MODIFY COLUMN `purpose` enum('LOGO','BANNER','DOCUMENT_HEADER','STUDENT_PHOTO','STUDENT_DOCUMENT') NOT NULL;--> statement-breakpoint
CREATE TABLE `student_document_types` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`code` varchar(32) NOT NULL,
	`name` varchar(100) NOT NULL,
	`is_required` boolean NOT NULL DEFAULT false,
	`has_expiry` boolean NOT NULL DEFAULT false,
	`allow_multiple` boolean NOT NULL DEFAULT false,
	`is_active` boolean NOT NULL DEFAULT true,
	`sort_order` int NOT NULL DEFAULT 0,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `student_document_types_id` PRIMARY KEY(`id`),
	CONSTRAINT `student_document_types_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	CONSTRAINT `student_document_types_tenant_id_uq` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `student_document_types_tenant_code_uq` UNIQUE(`tenant_id`,`code`)
);--> statement-breakpoint
CREATE TABLE `student_documents` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`student_id` char(36) NOT NULL,
	`type_id` char(36) NOT NULL,
	`file_id` char(36) NOT NULL,
	`expires_on` date,
	`notes` varchar(500),
	`replaced_at` datetime(3),
	`uploaded_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `student_documents_id` PRIMARY KEY(`id`),
	CONSTRAINT `student_documents_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	CONSTRAINT `student_documents_student_fk` FOREIGN KEY (`tenant_id`,`student_id`) REFERENCES `students`(`tenant_id`,`id`),
	CONSTRAINT `student_documents_type_fk` FOREIGN KEY (`tenant_id`,`type_id`) REFERENCES `student_document_types`(`tenant_id`,`id`)
);--> statement-breakpoint
CREATE INDEX `student_documents_student_idx` ON `student_documents` (`tenant_id`,`student_id`,`replaced_at`);

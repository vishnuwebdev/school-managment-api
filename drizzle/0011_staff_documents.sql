ALTER TABLE `files` MODIFY COLUMN `purpose` enum('LOGO','BANNER','DOCUMENT_HEADER','STUDENT_PHOTO','STUDENT_DOCUMENT','STAFF_PHOTO','STAFF_DOCUMENT') NOT NULL;--> statement-breakpoint
CREATE TABLE `staff_document_types` (
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
	CONSTRAINT `staff_document_types_id` PRIMARY KEY(`id`),
	CONSTRAINT `staff_document_types_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	CONSTRAINT `staff_document_types_tenant_id_uq` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `staff_document_types_tenant_code_uq` UNIQUE(`tenant_id`,`code`)
);--> statement-breakpoint
CREATE TABLE `staff_documents` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`teacher_id` char(36) NOT NULL,
	`type_id` char(36) NOT NULL,
	`file_id` char(36) NOT NULL,
	`expires_on` date,
	`notes` varchar(500),
	`replaced_at` datetime(3),
	`uploaded_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `staff_documents_id` PRIMARY KEY(`id`),
	CONSTRAINT `staff_documents_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	CONSTRAINT `staff_documents_teacher_fk` FOREIGN KEY (`tenant_id`,`teacher_id`) REFERENCES `teachers`(`tenant_id`,`id`),
	CONSTRAINT `staff_documents_type_fk` FOREIGN KEY (`tenant_id`,`type_id`) REFERENCES `staff_document_types`(`tenant_id`,`id`)
);--> statement-breakpoint
CREATE INDEX `staff_documents_teacher_idx` ON `staff_documents` (`tenant_id`,`teacher_id`,`replaced_at`);

--> statement-breakpoint
ALTER TABLE `teachers` ADD COLUMN `photo_file_id` char(36);

CREATE TABLE `exams` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`academic_year_id` char(36) NOT NULL,
	`name` varchar(120) NOT NULL,
	`exam_type` enum('UNIT_TEST','MID_TERM','FINAL','PRACTICAL','OTHER') NOT NULL DEFAULT 'UNIT_TEST',
	`start_date` date,
	`end_date` date,
	`status` enum('DRAFT','PUBLISHED') NOT NULL DEFAULT 'DRAFT',
	`published_at` datetime(3),
	`version` int NOT NULL DEFAULT 1,
	`created_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `exams_id` PRIMARY KEY(`id`),
	CONSTRAINT `exams_tenant_id_uq` UNIQUE(`tenant_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `exam_papers` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`exam_id` char(36) NOT NULL,
	`class_id` char(36) NOT NULL,
	`subject_id` char(36) NOT NULL,
	`exam_date` date,
	`max_marks` decimal(6,2) NOT NULL DEFAULT '100.00',
	`pass_marks` decimal(6,2) NOT NULL DEFAULT '35.00',
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `exam_papers_id` PRIMARY KEY(`id`),
	CONSTRAINT `exam_papers_tenant_id_uq` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `exam_papers_uq` UNIQUE(`tenant_id`,`exam_id`,`class_id`,`subject_id`)
);
--> statement-breakpoint
CREATE TABLE `exam_marks` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`paper_id` char(36) NOT NULL,
	`student_id` char(36) NOT NULL,
	`marks` decimal(6,2),
	`absent` boolean NOT NULL DEFAULT false,
	`remark` varchar(200),
	`entered_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `exam_marks_id` PRIMARY KEY(`id`),
	CONSTRAINT `exam_marks_uq` UNIQUE(`tenant_id`,`paper_id`,`student_id`)
);
--> statement-breakpoint
CREATE INDEX `exams_year_idx` ON `exams` (`tenant_id`,`academic_year_id`,`status`);
--> statement-breakpoint
CREATE INDEX `exam_papers_class_idx` ON `exam_papers` (`tenant_id`,`exam_id`,`class_id`);
--> statement-breakpoint
CREATE INDEX `exam_marks_student_idx` ON `exam_marks` (`tenant_id`,`student_id`);
--> statement-breakpoint
ALTER TABLE `exams` ADD CONSTRAINT `exams_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `exams` ADD CONSTRAINT `exams_year_fk` FOREIGN KEY (`tenant_id`,`academic_year_id`) REFERENCES `academic_years`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `exam_papers` ADD CONSTRAINT `exam_papers_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `exam_papers` ADD CONSTRAINT `exam_papers_exam_fk` FOREIGN KEY (`tenant_id`,`exam_id`) REFERENCES `exams`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `exam_papers` ADD CONSTRAINT `exam_papers_class_fk` FOREIGN KEY (`tenant_id`,`class_id`) REFERENCES `academic_classes`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `exam_papers` ADD CONSTRAINT `exam_papers_subject_fk` FOREIGN KEY (`tenant_id`,`subject_id`) REFERENCES `subjects`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `exam_marks` ADD CONSTRAINT `exam_marks_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `exam_marks` ADD CONSTRAINT `exam_marks_paper_fk` FOREIGN KEY (`tenant_id`,`paper_id`) REFERENCES `exam_papers`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `exam_marks` ADD CONSTRAINT `exam_marks_student_fk` FOREIGN KEY (`tenant_id`,`student_id`) REFERENCES `students`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;

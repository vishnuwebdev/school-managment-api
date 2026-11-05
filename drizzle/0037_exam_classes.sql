-- The classes that sit an exam, so a class with no papers (no subjects offered yet) still shows.
CREATE TABLE `exam_classes` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`exam_id` char(36) NOT NULL,
	`class_id` char(36) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `exam_classes_id` PRIMARY KEY(`id`),
	CONSTRAINT `exam_classes_uq` UNIQUE(`tenant_id`,`exam_id`,`class_id`)
);
--> statement-breakpoint
ALTER TABLE `exam_classes` ADD CONSTRAINT `exam_classes_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `exam_classes` ADD CONSTRAINT `exam_classes_exam_fk` FOREIGN KEY (`tenant_id`,`exam_id`) REFERENCES `exams`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `exam_classes` ADD CONSTRAINT `exam_classes_class_fk` FOREIGN KEY (`tenant_id`,`class_id`) REFERENCES `academic_classes`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Existing exams: every class that already has a paper sits the exam.
INSERT INTO `exam_classes` (`id`, `tenant_id`, `exam_id`, `class_id`)
SELECT UUID(), `tenant_id`, `exam_id`, `class_id` FROM `exam_papers` GROUP BY `tenant_id`, `exam_id`, `class_id`;

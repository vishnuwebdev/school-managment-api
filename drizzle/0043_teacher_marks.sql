-- Teacher marks (26 Oct 2026). A teacher enters marks only for the sections and subjects
-- they teach and hands each section to the office when it is complete.
--   exams.section_id / exams.teacher_id: a teacher's own test, for one section of a class.
--   exam_paper_sections: per paper and section, DRAFT while the teacher works and
--   SUBMITTED once handed in (locked for the teacher; the office can return it).
ALTER TABLE `exams` ADD `section_id` char(36);--> statement-breakpoint
ALTER TABLE `exams` ADD `teacher_id` char(36);--> statement-breakpoint
CREATE INDEX `exams_teacher_idx` ON `exams` (`tenant_id`,`teacher_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `exam_paper_sections` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`paper_id` char(36) NOT NULL,
	`section_id` char(36) NOT NULL,
	`status` enum('DRAFT','SUBMITTED') NOT NULL DEFAULT 'DRAFT',
	`submitted_by` char(36),
	`submitted_at` datetime(3),
	`returned_by` char(36),
	`returned_at` datetime(3),
	`return_note` varchar(500),
	`version` int NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `exam_paper_sections_id` PRIMARY KEY(`id`),
	CONSTRAINT `exam_paper_sections_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	CONSTRAINT `exam_paper_sections_uq` UNIQUE(`tenant_id`,`paper_id`,`section_id`)
);

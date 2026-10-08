CREATE TABLE `section_class_teachers` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`section_id` char(36) NOT NULL,
	`teacher_id` char(36) NOT NULL,
	`status` enum('ACTIVE','ENDED') NOT NULL DEFAULT 'ACTIVE',
	`start_date` date NOT NULL,
	`end_date` date,
	`reason` varchar(500),
	`open_key` varchar(36) GENERATED ALWAYS AS ((IF(`status` = 'ACTIVE', `section_id`, NULL))) VIRTUAL,
	`created_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` char(36),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `section_class_teachers_id` PRIMARY KEY(`id`),
	CONSTRAINT `section_class_teachers_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	CONSTRAINT `section_class_teachers_section_fk` FOREIGN KEY (`tenant_id`,`section_id`) REFERENCES `academic_sections`(`tenant_id`,`id`),
	CONSTRAINT `section_class_teachers_teacher_fk` FOREIGN KEY (`tenant_id`,`teacher_id`) REFERENCES `teachers`(`tenant_id`,`id`),
	CONSTRAINT `section_class_teachers_open_uq` UNIQUE(`tenant_id`,`open_key`)
);--> statement-breakpoint
CREATE INDEX `section_class_teachers_teacher_idx` ON `section_class_teachers` (`tenant_id`,`teacher_id`,`status`);--> statement-breakpoint
CREATE INDEX `section_class_teachers_section_idx` ON `section_class_teachers` (`tenant_id`,`section_id`,`status`);

--> statement-breakpoint
-- Teacher logins now see only the sections they are assigned to (derived from teaching
-- assignments and class teacher). Existing Teacher-role assignments that were school-wide
-- are narrowed; give a teacher school-wide access by assigning another role.
UPDATE `role_assignments` ra
JOIN `roles` r ON r.`id` = ra.`role_id`
SET ra.`scope_type` = 'ASSIGNED_SECTION', ra.`scope_ref` = NULL
WHERE r.`code` = 'TEACHER' AND ra.`scope_type` = 'ALL_TENANT';

ALTER TABLE `fee_structures` ADD `academic_section_id` char(36);--> statement-breakpoint
CREATE INDEX `fee_structures_section_idx` ON `fee_structures` (`tenant_id`,`academic_section_id`);

ALTER TABLE `role_assignments` MODIFY COLUMN `scope_type` enum('ALL_TENANTS','SELECTED_TENANTS','ALL_TENANT','ASSIGNED_CLASS','ASSIGNED_SECTION','ASSIGNED_SUBJECT','OWN_RECORD','SELECTED_RESOURCE') NOT NULL DEFAULT 'ALL_TENANT';--> statement-breakpoint
ALTER TABLE `subscriptions` MODIFY COLUMN `status` enum('PENDING','TRIAL','ACTIVE','PAST_DUE','EXPIRED','CANCELLED','SUPERSEDED') NOT NULL;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `currency` char(3) NOT NULL DEFAULT 'INR';--> statement-breakpoint
ALTER TABLE `subscription_items` ADD `currency` char(3) NOT NULL DEFAULT 'INR';--> statement-breakpoint
UPDATE `subscriptions` s JOIN `plan_versions` pv ON pv.`id` = s.`plan_version_id` SET s.`currency` = pv.`currency`;--> statement-breakpoint
UPDATE `subscription_items` i JOIN `subscriptions` s ON s.`id` = i.`subscription_id` SET i.`currency` = s.`currency`;--> statement-breakpoint
ALTER TABLE `subscriptions` ALTER COLUMN `currency` DROP DEFAULT;--> statement-breakpoint
ALTER TABLE `subscription_items` ALTER COLUMN `currency` DROP DEFAULT;

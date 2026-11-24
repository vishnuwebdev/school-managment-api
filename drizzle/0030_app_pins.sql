CREATE TABLE `app_pins` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`membership_id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`pin_hash` varchar(255) NOT NULL,
	`device_token_hash` char(64) NOT NULL,
	`device_name` varchar(100),
	`device_type` varchar(32),
	`failed_attempts` int NOT NULL DEFAULT 0,
	`locked_at` datetime(3),
	`last_used_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `app_pins_id` PRIMARY KEY(`id`),
	CONSTRAINT `app_pins_membership_uq` UNIQUE(`membership_id`),
	CONSTRAINT `app_pins_device_token_uq` UNIQUE(`device_token_hash`)
);
--> statement-breakpoint
CREATE INDEX `app_pins_user_idx` ON `app_pins` (`user_id`);--> statement-breakpoint
ALTER TABLE `app_pins` ADD CONSTRAINT `app_pins_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `app_pins` ADD CONSTRAINT `app_pins_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `app_pins` ADD CONSTRAINT `app_pins_membership_fk` FOREIGN KEY (`tenant_id`,`membership_id`) REFERENCES `memberships`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;

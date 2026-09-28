CREATE TABLE `school_requests` (
	`id` char(36) NOT NULL,
	`school_name` varchar(200) NOT NULL,
	`contact_name` varchar(200) NOT NULL,
	`contact_email` varchar(254) NOT NULL,
	`contact_phone` varchar(32),
	`city` varchar(100),
	`country` char(2),
	`message` text,
	`status` enum('PENDING','UNDER_REVIEW','APPROVED','REJECTED') NOT NULL DEFAULT 'PENDING',
	`reviewed_by` char(36),
	`reviewed_at` datetime(3),
	`review_note` varchar(500),
	`tenant_id` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `school_requests_id` PRIMARY KEY(`id`),
	CONSTRAINT `school_requests_tenant_uq` UNIQUE(`tenant_id`)
);
--> statement-breakpoint
CREATE TABLE `tenant_settings` (
	`tenant_id` char(36) NOT NULL,
	`timezone` varchar(64) NOT NULL DEFAULT 'Asia/Kolkata',
	`locale` varchar(16) NOT NULL DEFAULT 'en-IN',
	`currency` char(3) NOT NULL DEFAULT 'INR',
	`date_format` varchar(20) NOT NULL DEFAULT 'DD/MM/YYYY',
	`week_starts_on` tinyint NOT NULL DEFAULT 1,
	`working_days` json NOT NULL,
	`academic_year_start_month` tinyint NOT NULL DEFAULT 4,
	`brand_primary_color` varchar(9),
	`logo_file_id` char(36),
	`version` int NOT NULL DEFAULT 1,
	`updated_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `tenant_settings_tenant_id` PRIMARY KEY(`tenant_id`)
);
--> statement-breakpoint
CREATE TABLE `tenant_status_history` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`from_status` enum('REQUESTED','UNDER_REVIEW','APPROVED','PROVISIONING','ACTIVE','SUSPENDED','ARCHIVED'),
	`to_status` enum('REQUESTED','UNDER_REVIEW','APPROVED','PROVISIONING','ACTIVE','SUSPENDED','ARCHIVED') NOT NULL,
	`reason` varchar(500),
	`actor_user_id` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `tenant_status_history_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `tenants` (
	`id` char(36) NOT NULL,
	`code` varchar(64) NOT NULL,
	`name` varchar(200) NOT NULL,
	`short_name` varchar(64),
	`school_type` varchar(64),
	`status` enum('REQUESTED','UNDER_REVIEW','APPROVED','PROVISIONING','ACTIVE','SUSPENDED','ARCHIVED') NOT NULL DEFAULT 'APPROVED',
	`contact_email` varchar(254),
	`contact_phone` varchar(32),
	`address_line1` varchar(200),
	`address_line2` varchar(200),
	`city` varchar(100),
	`state` varchar(100),
	`postal_code` varchar(20),
	`country` char(2),
	`version` int NOT NULL DEFAULT 1,
	`activated_at` datetime(3),
	`suspended_at` datetime(3),
	`archived_at` datetime(3),
	`created_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `tenants_id` PRIMARY KEY(`id`),
	CONSTRAINT `tenants_code_uq` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `invitations` (
	`id` char(36) NOT NULL,
	`membership_id` char(36) NOT NULL,
	`tenant_id` char(36),
	`email` varchar(254) NOT NULL,
	`invited_first_name` varchar(100),
	`invited_last_name` varchar(100),
	`token_hash` char(64),
	`status` enum('PENDING','SENT','USED','EXPIRED','REVOKED') NOT NULL DEFAULT 'PENDING',
	`expires_at` datetime(3) NOT NULL,
	`sent_at` datetime(3),
	`accepted_at` datetime(3),
	`created_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `invitations_id` PRIMARY KEY(`id`),
	CONSTRAINT `invitations_token_hash_uq` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `memberships` (
	`id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`tenant_id` char(36),
	`tenant_key` varchar(36) NOT NULL,
	`kind` enum('PLATFORM','TENANT') NOT NULL,
	`status` enum('INVITED','ACTIVE','SUSPENDED','REVOKED') NOT NULL DEFAULT 'INVITED',
	`joined_at` datetime(3),
	`ended_at` datetime(3),
	`invited_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `memberships_id` PRIMARY KEY(`id`),
	CONSTRAINT `memberships_user_tenant_uq` UNIQUE(`user_id`,`tenant_key`)
);
--> statement-breakpoint
CREATE TABLE `password_reset_tokens` (
	`id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`token_hash` char(64),
	`status` enum('PENDING','SENT','USED','EXPIRED','REVOKED') NOT NULL DEFAULT 'PENDING',
	`expires_at` datetime(3) NOT NULL,
	`sent_at` datetime(3),
	`used_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `password_reset_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `password_reset_tokens_hash_uq` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `user_sessions` (
	`id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`membership_id` char(36),
	`refresh_token_hash` char(64) NOT NULL,
	`device_name` varchar(100),
	`device_type` varchar(32),
	`ip_address` varchar(45),
	`user_agent` varchar(500),
	`expires_at` datetime(3) NOT NULL,
	`last_used_at` datetime(3),
	`revoked_at` datetime(3),
	`revoked_reason` varchar(64),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `user_sessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `user_sessions_refresh_hash_uq` UNIQUE(`refresh_token_hash`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` char(36) NOT NULL,
	`email` varchar(254) NOT NULL,
	`phone` varchar(32),
	`password_hash` varchar(255),
	`first_name` varchar(100) NOT NULL,
	`last_name` varchar(100) NOT NULL DEFAULT '',
	`status` enum('INVITED','ACTIVE','SUSPENDED','DEACTIVATED') NOT NULL DEFAULT 'INVITED',
	`email_verified_at` datetime(3),
	`last_login_at` datetime(3),
	`password_changed_at` datetime(3),
	`failed_login_count` int NOT NULL DEFAULT 0,
	`locked_until` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_email_uq` UNIQUE(`email`)
);
--> statement-breakpoint
CREATE TABLE `permissions` (
	`id` char(36) NOT NULL,
	`code` varchar(100) NOT NULL,
	`name` varchar(150) NOT NULL,
	`description` varchar(500),
	`feature_code` varchar(64) NOT NULL,
	`scope` enum('PLATFORM','TENANT') NOT NULL,
	`is_sensitive` boolean NOT NULL DEFAULT false,
	`status` enum('ACTIVE','ARCHIVED') NOT NULL DEFAULT 'ACTIVE',
	`sort_order` int NOT NULL DEFAULT 0,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `permissions_id` PRIMARY KEY(`id`),
	CONSTRAINT `permissions_code_uq` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `role_assignments` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36),
	`membership_id` char(36) NOT NULL,
	`role_id` char(36) NOT NULL,
	`scope_type` enum('ALL_TENANTS','ALL_TENANT','ASSIGNED_CLASS','ASSIGNED_SECTION','ASSIGNED_SUBJECT','OWN_RECORD','SELECTED_RESOURCE') NOT NULL DEFAULT 'ALL_TENANT',
	`scope_ref` json,
	`status` enum('ACTIVE','REVOKED') NOT NULL DEFAULT 'ACTIVE',
	`starts_at` datetime(3),
	`ends_at` datetime(3),
	`created_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `role_assignments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `role_permissions` (
	`role_id` char(36) NOT NULL,
	`permission_id` char(36) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `role_permissions_pk` PRIMARY KEY(`role_id`,`permission_id`)
);
--> statement-breakpoint
CREATE TABLE `roles` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36),
	`tenant_key` varchar(36) NOT NULL,
	`code` varchar(64) NOT NULL,
	`name` varchar(100) NOT NULL,
	`description` varchar(500),
	`role_type` enum('SYSTEM','CUSTOM') NOT NULL,
	`scope` enum('PLATFORM','TENANT') NOT NULL,
	`status` enum('ACTIVE','ARCHIVED') NOT NULL DEFAULT 'ACTIVE',
	`version` int NOT NULL DEFAULT 1,
	`created_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `roles_id` PRIMARY KEY(`id`),
	CONSTRAINT `roles_tenant_code_uq` UNIQUE(`tenant_key`,`code`)
);
--> statement-breakpoint
CREATE TABLE `entitlements` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`feature_id` char(36) NOT NULL,
	`source_type` enum('PLAN','ADD_ON','CUSTOM_CONTRACT','ADMIN_OVERRIDE') NOT NULL,
	`source_reference` varchar(64),
	`effect` enum('GRANT','DENY') NOT NULL DEFAULT 'GRANT',
	`status` enum('ACTIVE','REVOKED') NOT NULL DEFAULT 'ACTIVE',
	`starts_at` datetime(3) NOT NULL,
	`ends_at` datetime(3),
	`granted_by` char(36),
	`reason` varchar(500),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `entitlements_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `feature_dependencies` (
	`feature_id` char(36) NOT NULL,
	`depends_on_feature_id` char(36) NOT NULL,
	CONSTRAINT `feature_dependencies_pk` PRIMARY KEY(`feature_id`,`depends_on_feature_id`)
);
--> statement-breakpoint
CREATE TABLE `features` (
	`id` char(36) NOT NULL,
	`code` varchar(64) NOT NULL,
	`name` varchar(100) NOT NULL,
	`description` varchar(500),
	`parent_code` varchar(64),
	`is_core` boolean NOT NULL DEFAULT false,
	`sort_order` int NOT NULL DEFAULT 0,
	`status` enum('ACTIVE','ARCHIVED') NOT NULL DEFAULT 'ACTIVE',
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `features_id` PRIMARY KEY(`id`),
	CONSTRAINT `features_code_uq` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `plan_features` (
	`plan_version_id` char(36) NOT NULL,
	`feature_id` char(36) NOT NULL,
	CONSTRAINT `plan_features_pk` PRIMARY KEY(`plan_version_id`,`feature_id`)
);
--> statement-breakpoint
CREATE TABLE `plan_versions` (
	`id` char(36) NOT NULL,
	`plan_id` char(36) NOT NULL,
	`version` int NOT NULL,
	`status` enum('DRAFT','ACTIVE','RETIRED') NOT NULL DEFAULT 'ACTIVE',
	`currency` char(3) NOT NULL,
	`price_monthly_minor` bigint NOT NULL,
	`price_annual_minor` bigint NOT NULL,
	`effective_from` datetime(3) NOT NULL,
	`effective_to` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `plan_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `plan_versions_plan_version_uq` UNIQUE(`plan_id`,`version`)
);
--> statement-breakpoint
CREATE TABLE `plans` (
	`id` char(36) NOT NULL,
	`code` varchar(64) NOT NULL,
	`name` varchar(100) NOT NULL,
	`description` varchar(500),
	`status` enum('ACTIVE','ARCHIVED') NOT NULL DEFAULT 'ACTIVE',
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `plans_id` PRIMARY KEY(`id`),
	CONSTRAINT `plans_code_uq` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `subscription_items` (
	`id` char(36) NOT NULL,
	`subscription_id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`item_type` enum('PLAN','ADD_ON') NOT NULL,
	`feature_id` char(36),
	`quantity` int NOT NULL DEFAULT 1,
	`standard_price_minor` bigint NOT NULL,
	`custom_price_minor` bigint,
	`discount_minor` bigint NOT NULL DEFAULT 0,
	`final_price_minor` bigint NOT NULL,
	`pricing_source` enum('CATALOG','CUSTOM_CONTRACT') NOT NULL DEFAULT 'CATALOG',
	`approved_by` char(36),
	`reason` varchar(500),
	`starts_at` datetime(3) NOT NULL,
	`ends_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `subscription_items_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`plan_version_id` char(36) NOT NULL,
	`status` enum('PENDING','TRIAL','ACTIVE','PAST_DUE','EXPIRED','CANCELLED') NOT NULL,
	`billing_interval` enum('MONTHLY','ANNUAL','CUSTOM') NOT NULL,
	`starts_at` datetime(3) NOT NULL,
	`trial_ends_at` datetime(3),
	`current_period_start` datetime(3) NOT NULL,
	`current_period_end` datetime(3) NOT NULL,
	`cancelled_at` datetime(3),
	`ended_at` datetime(3),
	`auto_renew` boolean NOT NULL DEFAULT true,
	`version` int NOT NULL DEFAULT 1,
	`created_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `subscriptions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36),
	`actor_user_id` char(36),
	`actor_type` enum('USER','PLATFORM_USER','SYSTEM','ANONYMOUS') NOT NULL,
	`action` varchar(64) NOT NULL,
	`entity_type` varchar(64) NOT NULL,
	`entity_id` varchar(64),
	`before` json,
	`after` json,
	`reason` varchar(500),
	`request_id` varchar(64),
	`correlation_id` varchar(64),
	`ip_address` varchar(45),
	`user_agent` varchar(500),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `audit_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `event_consumptions` (
	`event_id` char(36) NOT NULL,
	`handler` varchar(100) NOT NULL,
	`processed_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `event_consumptions_pk` PRIMARY KEY(`event_id`,`handler`)
);
--> statement-breakpoint
CREATE TABLE `outbox_events` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36),
	`event_type` varchar(100) NOT NULL,
	`schema_version` int NOT NULL DEFAULT 1,
	`aggregate_type` varchar(64) NOT NULL,
	`aggregate_id` varchar(64) NOT NULL,
	`payload` json NOT NULL,
	`actor_user_id` char(36),
	`correlation_id` varchar(64),
	`status` enum('PENDING','PUBLISHED','FAILED') NOT NULL DEFAULT 'PENDING',
	`retry_count` int NOT NULL DEFAULT 0,
	`last_error` text,
	`available_at` datetime(3) NOT NULL,
	`occurred_at` datetime(3) NOT NULL,
	`published_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `outbox_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `school_requests` ADD CONSTRAINT `school_requests_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tenant_settings` ADD CONSTRAINT `tenant_settings_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tenant_status_history` ADD CONSTRAINT `tenant_status_history_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invitations` ADD CONSTRAINT `invitations_membership_id_memberships_id_fk` FOREIGN KEY (`membership_id`) REFERENCES `memberships`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invitations` ADD CONSTRAINT `invitations_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memberships` ADD CONSTRAINT `memberships_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memberships` ADD CONSTRAINT `memberships_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `password_reset_tokens` ADD CONSTRAINT `password_reset_tokens_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_sessions` ADD CONSTRAINT `user_sessions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_sessions` ADD CONSTRAINT `user_sessions_membership_id_memberships_id_fk` FOREIGN KEY (`membership_id`) REFERENCES `memberships`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `role_assignments` ADD CONSTRAINT `role_assignments_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `role_assignments` ADD CONSTRAINT `role_assignments_membership_id_memberships_id_fk` FOREIGN KEY (`membership_id`) REFERENCES `memberships`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `role_assignments` ADD CONSTRAINT `role_assignments_role_id_roles_id_fk` FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `role_permissions` ADD CONSTRAINT `role_permissions_role_id_roles_id_fk` FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `role_permissions` ADD CONSTRAINT `role_permissions_permission_id_permissions_id_fk` FOREIGN KEY (`permission_id`) REFERENCES `permissions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `roles` ADD CONSTRAINT `roles_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `entitlements` ADD CONSTRAINT `entitlements_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `entitlements` ADD CONSTRAINT `entitlements_feature_id_features_id_fk` FOREIGN KEY (`feature_id`) REFERENCES `features`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `feature_dependencies` ADD CONSTRAINT `feature_dependencies_feature_id_features_id_fk` FOREIGN KEY (`feature_id`) REFERENCES `features`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `feature_dependencies` ADD CONSTRAINT `feature_dependencies_depends_on_feature_id_features_id_fk` FOREIGN KEY (`depends_on_feature_id`) REFERENCES `features`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `plan_features` ADD CONSTRAINT `plan_features_plan_version_id_plan_versions_id_fk` FOREIGN KEY (`plan_version_id`) REFERENCES `plan_versions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `plan_features` ADD CONSTRAINT `plan_features_feature_id_features_id_fk` FOREIGN KEY (`feature_id`) REFERENCES `features`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `plan_versions` ADD CONSTRAINT `plan_versions_plan_id_plans_id_fk` FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `subscription_items` ADD CONSTRAINT `subscription_items_subscription_id_subscriptions_id_fk` FOREIGN KEY (`subscription_id`) REFERENCES `subscriptions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `subscription_items` ADD CONSTRAINT `subscription_items_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `subscription_items` ADD CONSTRAINT `subscription_items_feature_id_features_id_fk` FOREIGN KEY (`feature_id`) REFERENCES `features`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD CONSTRAINT `subscriptions_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD CONSTRAINT `subscriptions_plan_version_id_plan_versions_id_fk` FOREIGN KEY (`plan_version_id`) REFERENCES `plan_versions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `school_requests_status_idx` ON `school_requests` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `tenant_status_history_tenant_idx` ON `tenant_status_history` (`tenant_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `tenants_status_idx` ON `tenants` (`status`);--> statement-breakpoint
CREATE INDEX `tenants_created_at_idx` ON `tenants` (`created_at`);--> statement-breakpoint
CREATE INDEX `invitations_membership_idx` ON `invitations` (`membership_id`,`status`);--> statement-breakpoint
CREATE INDEX `invitations_tenant_idx` ON `invitations` (`tenant_id`,`status`);--> statement-breakpoint
CREATE INDEX `memberships_tenant_status_idx` ON `memberships` (`tenant_id`,`status`);--> statement-breakpoint
CREATE INDEX `password_reset_tokens_user_idx` ON `password_reset_tokens` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `user_sessions_user_idx` ON `user_sessions` (`user_id`,`revoked_at`);--> statement-breakpoint
CREATE INDEX `user_sessions_membership_idx` ON `user_sessions` (`membership_id`);--> statement-breakpoint
CREATE INDEX `users_status_idx` ON `users` (`status`);--> statement-breakpoint
CREATE INDEX `permissions_feature_idx` ON `permissions` (`feature_code`);--> statement-breakpoint
CREATE INDEX `role_assignments_membership_idx` ON `role_assignments` (`membership_id`,`status`);--> statement-breakpoint
CREATE INDEX `role_assignments_tenant_role_idx` ON `role_assignments` (`tenant_id`,`role_id`);--> statement-breakpoint
CREATE INDEX `role_permissions_permission_idx` ON `role_permissions` (`permission_id`);--> statement-breakpoint
CREATE INDEX `roles_tenant_status_idx` ON `roles` (`tenant_id`,`status`);--> statement-breakpoint
CREATE INDEX `entitlements_tenant_status_idx` ON `entitlements` (`tenant_id`,`status`);--> statement-breakpoint
CREATE INDEX `entitlements_source_ref_idx` ON `entitlements` (`source_reference`);--> statement-breakpoint
CREATE INDEX `subscription_items_tenant_idx` ON `subscription_items` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `subscription_items_subscription_idx` ON `subscription_items` (`subscription_id`);--> statement-breakpoint
CREATE INDEX `subscriptions_tenant_status_idx` ON `subscriptions` (`tenant_id`,`status`);--> statement-breakpoint
CREATE INDEX `audit_logs_tenant_created_idx` ON `audit_logs` (`tenant_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_logs_entity_idx` ON `audit_logs` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `audit_logs_actor_idx` ON `audit_logs` (`actor_user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_logs_action_idx` ON `audit_logs` (`action`,`created_at`);--> statement-breakpoint
CREATE INDEX `outbox_events_status_available_idx` ON `outbox_events` (`status`,`available_at`);--> statement-breakpoint
CREATE INDEX `outbox_events_tenant_type_idx` ON `outbox_events` (`tenant_id`,`event_type`);
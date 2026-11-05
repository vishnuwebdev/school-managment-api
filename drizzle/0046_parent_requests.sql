-- Parent requests (2 Nov 2026). From the parent app:
--   student_change_requests: a parent asks to change their child's details; the office approves.
--   parent_messages / parent_message_replies: complaints (to the principal), feedback and
--   suggestions, with a conversation between the school and the parent.
CREATE TABLE IF NOT EXISTS `student_change_requests` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`student_id` char(36) NOT NULL,
	`guardian_id` char(36) NOT NULL,
	`changes` json NOT NULL,
	`note` varchar(1000),
	`status` enum('PENDING','APPROVED','REJECTED','CANCELLED') NOT NULL DEFAULT 'PENDING',
	`requested_by` char(36),
	`decided_by` char(36),
	`decided_at` datetime(3),
	`decision_note` varchar(1000),
	`version` int NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `student_change_requests_id` PRIMARY KEY(`id`),
	CONSTRAINT `student_change_requests_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	CONSTRAINT `student_change_requests_student_fk` FOREIGN KEY (`tenant_id`,`student_id`) REFERENCES `students`(`tenant_id`,`id`),
	CONSTRAINT `student_change_requests_tenant_id_uq` UNIQUE(`tenant_id`,`id`),
	INDEX `student_change_requests_status_idx` (`tenant_id`,`status`,`created_at`),
	INDEX `student_change_requests_student_idx` (`tenant_id`,`student_id`)
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `parent_messages` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`reference_number` varchar(24) NOT NULL,
	`guardian_id` char(36) NOT NULL,
	`student_id` char(36),
	`kind` enum('COMPLAINT','FEEDBACK','SUGGESTION') NOT NULL,
	`topic` enum('SCHOOL','STUDENT_PROGRESS','TEACHING','FACILITIES','FEES','TRANSPORT','OTHER') NOT NULL DEFAULT 'SCHOOL',
	`subject` varchar(150) NOT NULL,
	`body` text NOT NULL,
	`status` enum('OPEN','IN_PROGRESS','RESOLVED','CLOSED') NOT NULL DEFAULT 'OPEN',
	`assigned_to` char(36),
	`unread_by_school` boolean NOT NULL DEFAULT true,
	`unread_by_parent` boolean NOT NULL DEFAULT false,
	`last_activity_at` datetime(3) NOT NULL,
	`resolved_at` datetime(3),
	`created_by` char(36),
	`version` int NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `parent_messages_id` PRIMARY KEY(`id`),
	CONSTRAINT `parent_messages_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	CONSTRAINT `parent_messages_tenant_id_uq` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `parent_messages_reference_uq` UNIQUE(`tenant_id`,`reference_number`),
	INDEX `parent_messages_status_idx` (`tenant_id`,`kind`,`status`,`last_activity_at`),
	INDEX `parent_messages_guardian_idx` (`tenant_id`,`guardian_id`)
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `parent_message_replies` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`message_id` char(36) NOT NULL,
	`author` enum('PARENT','SCHOOL') NOT NULL,
	`author_user_id` char(36),
	`author_name` varchar(150) NOT NULL,
	`body` text NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `parent_message_replies_id` PRIMARY KEY(`id`),
	CONSTRAINT `parent_message_replies_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	CONSTRAINT `parent_message_replies_message_fk` FOREIGN KEY (`tenant_id`,`message_id`) REFERENCES `parent_messages`(`tenant_id`,`id`),
	INDEX `parent_message_replies_message_idx` (`tenant_id`,`message_id`,`created_at`)
);

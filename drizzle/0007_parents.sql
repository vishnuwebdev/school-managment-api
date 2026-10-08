ALTER TABLE `guardians` ADD `preferred_channel` enum('EMAIL','SMS','WHATSAPP','PHONE');--> statement-breakpoint
ALTER TABLE `guardians` ADD `notify_email` boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `guardians` ADD `notify_sms` boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `guardians` ADD `notify_whatsapp` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `guardians` ADD `preferred_language` varchar(16);

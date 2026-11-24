-- Optional login email (6 Nov 2026). Every login signs in with email + password OR mobile number
-- + password, so a login needs at least one of them and email may be empty. Parent logins that
-- had a placeholder address (guardian-…@parents.invalid) get no email instead.
ALTER TABLE `users` MODIFY `email` varchar(254) NULL;--> statement-breakpoint
UPDATE `users` SET `email` = NULL WHERE `email` LIKE '%@parents.invalid';

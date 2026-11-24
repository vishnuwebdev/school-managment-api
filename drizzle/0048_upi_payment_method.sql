-- UPI for subscription payments (9 Nov 2026, U11). India has no "mobile money": the old
-- MOBILE_MONEY code (shown as "UPI" by the admin panel) becomes UPI, and MOBILE_MONEY is dropped.
-- School fee payments already have UPI in their enum; only the API's allowed list changed.
ALTER TABLE `subscription_payments` MODIFY COLUMN `method` enum('CASH','BANK_TRANSFER','CHEQUE','CARD','MOBILE_MONEY','UPI','OTHER') NOT NULL;--> statement-breakpoint
UPDATE `subscription_payments` SET `method` = 'UPI' WHERE `method` = 'MOBILE_MONEY';--> statement-breakpoint
ALTER TABLE `subscription_payments` MODIFY COLUMN `method` enum('CASH','BANK_TRANSFER','CHEQUE','CARD','UPI','OTHER') NOT NULL;

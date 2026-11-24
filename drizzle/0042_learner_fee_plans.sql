-- Grade fees with a payment plan per learner (Monthly / Termly / Annually with an early-payment discount).
ALTER TABLE `student_fee_assignments`
  ADD COLUMN `payment_plan` enum('MONTHLY','TERMLY','ANNUAL') NULL AFTER `status`;
--> statement-breakpoint
ALTER TABLE `fee_settings`
  ADD COLUMN `monthly_instalments` int NOT NULL DEFAULT 11,
  ADD COLUMN `monthly_due_day` int NOT NULL DEFAULT 1,
  ADD COLUMN `term_due_dates` json NULL,
  ADD COLUMN `annual_discount_percent` decimal(5,2) NOT NULL DEFAULT '5.00',
  ADD COLUMN `annual_pay_by` varchar(5) NULL,
  ADD COLUMN `default_payment_plan` enum('MONTHLY','TERMLY','ANNUAL') NOT NULL DEFAULT 'MONTHLY',
  ADD CONSTRAINT `fee_settings_plans_chk` CHECK (`monthly_instalments` BETWEEN 1 AND 12 AND `monthly_due_day` BETWEEN 1 AND 28 AND `annual_discount_percent` BETWEEN 0 AND 100);

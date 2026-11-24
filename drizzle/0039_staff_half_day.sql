-- Staff attendance: a half-day mark (counts as ½ a day of loss of pay).
ALTER TABLE `staff_attendance` MODIFY COLUMN `status` enum('PRESENT','ABSENT','LEAVE','LATE','HALF_DAY') NOT NULL;

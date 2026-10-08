-- A school can add its own kind of period (sports, club, library ...).
ALTER TABLE `timetable_periods` MODIFY COLUMN `kind` enum('LESSON','BREAK','LUNCH','ASSEMBLY','CUSTOM') NOT NULL DEFAULT 'LESSON';

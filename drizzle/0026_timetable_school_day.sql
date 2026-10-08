-- The school day window (first bell to last) is saved with the timetable settings.
ALTER TABLE `timetable_settings` ADD COLUMN `day_start` time NULL, ADD COLUMN `day_end` time NULL;

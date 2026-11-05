-- A period can run on some weekdays only (NULL = every working day), so one day can have its own times.
ALTER TABLE `timetable_periods` ADD `days_of_week` json;

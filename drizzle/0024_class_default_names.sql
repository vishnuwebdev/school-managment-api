-- Base class names are "Class 7", not "Grade 7". Schools keep any wording they
-- like in display_name. Only untouched default names ("Grade <number>") change.
UPDATE `academic_classes`
SET `name` = CONCAT('Class ', SUBSTRING(`name`, 7))
WHERE `name` REGEXP '^Grade [0-9]+$';

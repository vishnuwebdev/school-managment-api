-- A subject can be limited to some class phases (e.g. Early Years only); NULL = every phase.
ALTER TABLE `subjects` ADD `phases` json;

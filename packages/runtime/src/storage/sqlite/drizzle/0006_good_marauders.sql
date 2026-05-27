ALTER TABLE `tool_calls` ADD `request_message_id` text REFERENCES messages(id);--> statement-breakpoint
ALTER TABLE `tool_calls` ADD `assistant_message_id` text REFERENCES messages(id);--> statement-breakpoint
UPDATE `tool_calls`
SET
	`request_message_id` = (SELECT `request_message_id` FROM `runs` WHERE `runs`.`id` = `tool_calls`.`run_id`),
	`assistant_message_id` = (SELECT `assistant_message_id` FROM `runs` WHERE `runs`.`id` = `tool_calls`.`run_id`);

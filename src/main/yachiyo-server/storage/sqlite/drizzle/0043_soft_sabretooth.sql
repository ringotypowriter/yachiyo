ALTER TABLE `runs` ADD `cache_read_tokens` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `cache_write_tokens` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `model_id` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `provider_name` text;--> statement-breakpoint
UPDATE `runs` SET `model_id` = (SELECT `model_id` FROM `messages` WHERE `messages`.`id` = `runs`.`assistant_message_id`), `provider_name` = (SELECT `provider_name` FROM `messages` WHERE `messages`.`id` = `runs`.`assistant_message_id`) WHERE `runs`.`assistant_message_id` IS NOT NULL AND `runs`.`model_id` IS NULL;
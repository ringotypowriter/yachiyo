ALTER TABLE `messages` ADD `parent_message_id` text REFERENCES `messages`(`id`) ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE `threads` ADD `branch_from_thread_id` text;
--> statement-breakpoint
ALTER TABLE `threads` ADD `branch_from_message_id` text;
--> statement-breakpoint
ALTER TABLE `threads` ADD `head_message_id` text;
--> statement-breakpoint
ALTER TABLE `runs` ADD `request_message_id` text REFERENCES `messages`(`id`) ON DELETE set null;
--> statement-breakpoint
WITH ordered_messages AS (
  SELECT
    `id`,
    `thread_id`,
    LAG(`id`) OVER (PARTITION BY `thread_id` ORDER BY `created_at`, `id`) AS `parent_id`
  FROM `messages`
)
UPDATE `messages`
SET `parent_message_id` = (
  SELECT `parent_id`
  FROM `ordered_messages`
  WHERE `ordered_messages`.`id` = `messages`.`id`
)
WHERE `parent_message_id` IS NULL;
--> statement-breakpoint
WITH latest_messages AS (
  SELECT
    `id`,
    `thread_id`,
    ROW_NUMBER() OVER (PARTITION BY `thread_id` ORDER BY `created_at` DESC, `id` DESC) AS `row_num`
  FROM `messages`
)
UPDATE `threads`
SET `head_message_id` = (
  SELECT `id`
  FROM `latest_messages`
  WHERE `latest_messages`.`thread_id` = `threads`.`id`
    AND `latest_messages`.`row_num` = 1
)
WHERE `head_message_id` IS NULL;

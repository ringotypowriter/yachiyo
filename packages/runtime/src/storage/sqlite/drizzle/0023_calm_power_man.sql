ALTER TABLE `messages` ADD `visible_reply` text;--> statement-breakpoint
ALTER TABLE `threads` ADD `rolling_summary` text;--> statement-breakpoint
ALTER TABLE `threads` ADD `summary_watermark_message_id` text;
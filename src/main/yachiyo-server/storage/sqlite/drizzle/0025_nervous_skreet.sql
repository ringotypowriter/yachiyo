CREATE TABLE `channel_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`platform` text NOT NULL,
	`external_group_id` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`workspace_path` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `messages` ADD `sender_name` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `sender_external_user_id` text;--> statement-breakpoint
ALTER TABLE `threads` ADD `channel_group_id` text REFERENCES channel_groups(id);
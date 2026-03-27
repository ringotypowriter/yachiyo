CREATE TABLE `channel_users` (
	`id` text PRIMARY KEY NOT NULL,
	`platform` text NOT NULL,
	`external_user_id` text NOT NULL,
	`username` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`usage_limit_k_tokens` integer,
	`used_k_tokens` integer DEFAULT 0 NOT NULL,
	`workspace_path` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `threads` ADD `source` text DEFAULT 'local';--> statement-breakpoint
ALTER TABLE `threads` ADD `channel_user_id` text REFERENCES channel_users(id);
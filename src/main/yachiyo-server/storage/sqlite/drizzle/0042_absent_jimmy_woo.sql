CREATE TABLE `thread_folders` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `threads` ADD `folder_id` text REFERENCES thread_folders(id);
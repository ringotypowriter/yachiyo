CREATE TABLE `builtin_memories` (
	`id` text PRIMARY KEY NOT NULL,
	`topic` text NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`labels` text NOT NULL,
	`unit_type` text NOT NULL,
	`importance` real,
	`source_thread_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);

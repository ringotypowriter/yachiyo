CREATE TABLE `thing_source_quotes` (
	`id` text PRIMARY KEY NOT NULL,
	`thing_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`message_id` text,
	`span_row_id` text,
	`source_row_id` text NOT NULL,
	`quote` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`thing_id`) REFERENCES `things`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `thing_source_quotes_thing_id_idx` ON `thing_source_quotes` (`thing_id`);--> statement-breakpoint
CREATE INDEX `thing_source_quotes_thread_id_idx` ON `thing_source_quotes` (`thread_id`);--> statement-breakpoint
CREATE TABLE `thing_thread_scopes` (
	`thing_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`thing_id`) REFERENCES `things`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `thing_thread_scopes_thing_thread_idx` ON `thing_thread_scopes` (`thing_id`,`thread_id`);--> statement-breakpoint
CREATE TABLE `things` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`summary` text NOT NULL,
	`last_updated_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `things_name_unique` ON `things` (`name`);
CREATE TABLE `group_monitor_buffers` (
	`group_id` text PRIMARY KEY NOT NULL,
	`phase` text DEFAULT 'dormant' NOT NULL,
	`buffer` text NOT NULL,
	`saved_at` text NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `channel_groups`(`id`) ON UPDATE no action ON DELETE cascade
);

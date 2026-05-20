ALTER TABLE `cognitive_rows` ADD `activation_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `cognitive_rows` ADD `last_activated_at` text;
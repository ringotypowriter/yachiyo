CREATE TABLE `cognitive_events` (
	`id` text PRIMARY KEY NOT NULL,
	`operation` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cognitive_events_created_at_idx` ON `cognitive_events` (`created_at`);--> statement-breakpoint
CREATE TABLE `cognitive_relations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`purpose` text DEFAULT '' NOT NULL,
	`columns` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cognitive_relations_name_idx` ON `cognitive_relations` (`name`);--> statement-breakpoint
CREATE TABLE `cognitive_rows` (
	`id` text PRIMARY KEY NOT NULL,
	`relation` text NOT NULL,
	`key` text NOT NULL,
	`values` text DEFAULT '{}' NOT NULL,
	`subjects` text DEFAULT '[]' NOT NULL,
	`aliases` text DEFAULT '[]' NOT NULL,
	`triggers` text DEFAULT '[]' NOT NULL,
	`scope` text DEFAULT '{}' NOT NULL,
	`evidence` text DEFAULT '[]' NOT NULL,
	`confidence` real DEFAULT 0.6 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`activation_text` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cognitive_rows_relation_key_idx` ON `cognitive_rows` (`relation`,`key`);--> statement-breakpoint
CREATE INDEX `cognitive_rows_relation_idx` ON `cognitive_rows` (`relation`);--> statement-breakpoint
CREATE INDEX `cognitive_rows_status_idx` ON `cognitive_rows` (`status`);
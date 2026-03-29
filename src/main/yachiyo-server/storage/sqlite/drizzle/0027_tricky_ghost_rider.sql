CREATE TABLE `schedule_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`schedule_id` text NOT NULL,
	`thread_id` text,
	`status` text NOT NULL,
	`result_status` text,
	`result_summary` text,
	`error` text,
	`prompt_tokens` integer,
	`completion_tokens` integer,
	`started_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`schedule_id`) REFERENCES `schedules`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`cron_expression` text NOT NULL,
	`prompt` text NOT NULL,
	`workspace_path` text,
	`model_override` text,
	`enabled_tools` text,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);

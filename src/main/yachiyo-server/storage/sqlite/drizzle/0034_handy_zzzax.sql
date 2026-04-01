PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`cron_expression` text,
	`run_at` text,
	`prompt` text NOT NULL,
	`workspace_path` text,
	`model_override` text,
	`enabled_tools` text,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_schedules`("id", "name", "cron_expression", "run_at", "prompt", "workspace_path", "model_override", "enabled_tools", "enabled", "created_at", "updated_at") SELECT "id", "name", "cron_expression", NULL, "prompt", "workspace_path", "model_override", "enabled_tools", "enabled", "created_at", "updated_at" FROM `schedules`;--> statement-breakpoint
DROP TABLE `schedules`;--> statement-breakpoint
ALTER TABLE `__new_schedules` RENAME TO `schedules`;--> statement-breakpoint
PRAGMA foreign_keys=ON;

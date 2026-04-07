PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_tool_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text,
	`request_message_id` text,
	`assistant_message_id` text,
	`thread_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`status` text NOT NULL,
	`input_summary` text NOT NULL,
	`output_summary` text,
	`cwd` text,
	`error` text,
	`details` text,
	`started_at` text NOT NULL,
	`finished_at` text,
	`step_index` integer,
	`step_budget` integer,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`request_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`assistant_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_tool_calls`("id", "run_id", "request_message_id", "assistant_message_id", "thread_id", "tool_name", "status", "input_summary", "output_summary", "cwd", "error", "details", "started_at", "finished_at", "step_index", "step_budget") SELECT "id", "run_id", "request_message_id", "assistant_message_id", "thread_id", "tool_name", "status", "input_summary", "output_summary", "cwd", "error", "details", "started_at", "finished_at", "step_index", "step_budget" FROM `tool_calls`;--> statement-breakpoint
DROP TABLE `tool_calls`;--> statement-breakpoint
ALTER TABLE `__new_tool_calls` RENAME TO `tool_calls`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
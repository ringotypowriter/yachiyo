CREATE TABLE `worker_transcript_turns` (
	`id` text PRIMARY KEY NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`agent_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`launch_run_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`agent_type` text NOT NULL,
	`workspace_path` text NOT NULL,
	`model_id` text NOT NULL,
	`messages` text NOT NULL,
	`compaction` text,
	`status` text NOT NULL,
	`error` text,
	`prompt_tokens` integer,
	`completion_tokens` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`launch_run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `worker_transcript_turns_thread_idx` ON `worker_transcript_turns` (`thread_id`);--> statement-breakpoint
CREATE INDEX `worker_transcript_turns_agent_idx` ON `worker_transcript_turns` (`agent_id`,`created_at`);
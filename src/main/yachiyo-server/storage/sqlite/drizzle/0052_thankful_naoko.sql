CREATE INDEX `messages_parent_message_id_idx` ON `messages` (`parent_message_id`);--> statement-breakpoint
CREATE INDEX `run_recovery_checkpoints_thread_id_idx` ON `run_recovery_checkpoints` (`thread_id`);--> statement-breakpoint
CREATE INDEX `run_recovery_checkpoints_request_message_id_idx` ON `run_recovery_checkpoints` (`request_message_id`);--> statement-breakpoint
CREATE INDEX `runs_request_message_id_idx` ON `runs` (`request_message_id`);--> statement-breakpoint
CREATE INDEX `runs_assistant_message_id_idx` ON `runs` (`assistant_message_id`);--> statement-breakpoint
CREATE INDEX `schedule_runs_thread_id_idx` ON `schedule_runs` (`thread_id`);--> statement-breakpoint
CREATE INDEX `threads_folder_id_idx` ON `threads` (`folder_id`);--> statement-breakpoint
CREATE INDEX `tool_calls_run_id_idx` ON `tool_calls` (`run_id`);--> statement-breakpoint
CREATE INDEX `tool_calls_request_message_id_idx` ON `tool_calls` (`request_message_id`);--> statement-breakpoint
CREATE INDEX `tool_calls_assistant_message_id_idx` ON `tool_calls` (`assistant_message_id`);
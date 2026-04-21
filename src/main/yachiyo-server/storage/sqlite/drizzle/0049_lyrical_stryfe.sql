CREATE INDEX `messages_thread_id_idx` ON `messages` (`thread_id`);--> statement-breakpoint
CREATE INDEX `runs_thread_id_idx` ON `runs` (`thread_id`);--> statement-breakpoint
CREATE INDEX `threads_channel_group_id_idx` ON `threads` (`channel_group_id`);--> statement-breakpoint
CREATE INDEX `tool_calls_thread_id_idx` ON `tool_calls` (`thread_id`);
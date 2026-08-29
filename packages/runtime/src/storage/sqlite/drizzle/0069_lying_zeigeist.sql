DROP INDEX `runs_thread_id_idx`;--> statement-breakpoint
CREATE INDEX `runs_thread_id_created_at_idx` ON `runs` (`thread_id`,`created_at`);
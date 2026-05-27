CREATE TABLE `activity_source_records` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`run_id` text NOT NULL,
	`request_message_id` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text NOT NULL,
	`total_duration_ms` integer NOT NULL,
	`unique_apps` integer NOT NULL,
	`afk_duration_ms` integer,
	`payload_algorithm` text NOT NULL,
	`payload_key_version` integer NOT NULL,
	`payload_nonce` text NOT NULL,
	`payload_auth_tag` text NOT NULL,
	`payload_ciphertext` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `activity_source_records_started_at_idx` ON `activity_source_records` (`started_at`);--> statement-breakpoint
CREATE INDEX `activity_source_records_run_id_idx` ON `activity_source_records` (`run_id`);
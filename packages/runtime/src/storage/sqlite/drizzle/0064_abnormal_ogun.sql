CREATE TABLE `sync_applied_ops` (
	`op_id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`seq` integer NOT NULL,
	`applied_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_conflicts` (
	`id` text PRIMARY KEY NOT NULL,
	`op_id` text NOT NULL,
	`device_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`local_hash` text NOT NULL,
	`remote_hash` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text NOT NULL,
	`resolved_at` text,
	`resolution` text
);
--> statement-breakpoint
CREATE INDEX `sync_conflicts_resolved_at_idx` ON `sync_conflicts` (`resolved_at`);--> statement-breakpoint
CREATE TABLE `sync_devices` (
	`device_id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`label` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_local_ops` (
	`op_id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`payload_json` text NOT NULL,
	`base_hash` text,
	`created_at` text NOT NULL,
	`exported_at` text
);
--> statement-breakpoint
CREATE INDEX `sync_local_ops_device_seq_idx` ON `sync_local_ops` (`device_id`,`seq`);--> statement-breakpoint
ALTER TABLE `threads` ADD `sync_origin_device_id` text;--> statement-breakpoint
ALTER TABLE `threads` ADD `sync_imported_at` text;
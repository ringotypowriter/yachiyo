ALTER TABLE `runs` ADD `prompt_tokens` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `completion_tokens` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `total_prompt_tokens` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `total_completion_tokens` integer;
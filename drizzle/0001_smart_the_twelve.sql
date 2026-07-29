CREATE TABLE `sync_assertions` (
	`fleet_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`ok` integer NOT NULL,
	PRIMARY KEY(`fleet_id`, `operation_id`, `ordinal`),
	FOREIGN KEY (`fleet_id`) REFERENCES `fleets`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "sync_assertions_ok_check" CHECK("sync_assertions"."ok" = 1)
);
--> statement-breakpoint
CREATE TABLE `sync_commits` (
	`fleet_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`response_json` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`fleet_id`, `operation_id`),
	FOREIGN KEY (`fleet_id`) REFERENCES `fleets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sync_commits_created_at_idx` ON `sync_commits` (`created_at`);
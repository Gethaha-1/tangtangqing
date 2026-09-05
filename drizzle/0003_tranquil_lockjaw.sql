CREATE TABLE `restore_chunks` (
	`fleet_id` text NOT NULL,
	`job_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`hash` text NOT NULL,
	`payload` text NOT NULL,
	PRIMARY KEY(`fleet_id`, `job_id`, `ordinal`),
	FOREIGN KEY (`fleet_id`,`job_id`) REFERENCES `restore_jobs`(`fleet_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "restore_chunks_ordinal_check" CHECK("restore_chunks"."ordinal" >= 0 AND "restore_chunks"."ordinal" < 256)
);
--> statement-breakpoint
CREATE TABLE `restore_jobs` (
	`fleet_id` text NOT NULL,
	`id` text NOT NULL,
	`membership_id` text NOT NULL,
	`user_id` text NOT NULL,
	`base_version` integer NOT NULL,
	`manifest_json` text NOT NULL,
	`status` text DEFAULT 'uploading' NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	PRIMARY KEY(`fleet_id`, `id`),
	FOREIGN KEY (`fleet_id`) REFERENCES `fleets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`membership_id`) REFERENCES `fleet_members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "restore_jobs_version_check" CHECK("restore_jobs"."base_version" > 0),
	CONSTRAINT "restore_jobs_status_check" CHECK("restore_jobs"."status" IN ('uploading','ready','complete','cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `restore_jobs_one_active` ON `restore_jobs` (`fleet_id`) WHERE "restore_jobs"."status" IN ('uploading','ready');--> statement-breakpoint
CREATE INDEX `restore_jobs_expiry` ON `restore_jobs` (`expires_at`);--> statement-breakpoint
CREATE INDEX `restore_jobs_membership` ON `restore_jobs` (`membership_id`);--> statement-breakpoint
CREATE INDEX `restore_jobs_user` ON `restore_jobs` (`user_id`);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS fleet_settings_ledger_revision_insert
AFTER INSERT ON fleet_settings BEGIN
  UPDATE fleets SET version = version + 1 WHERE id = NEW.fleet_id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS fleet_settings_ledger_revision_update
AFTER UPDATE ON fleet_settings BEGIN
  UPDATE fleets SET version = version + 1 WHERE id = NEW.fleet_id;
  UPDATE fleets SET version = version + 1 WHERE id = OLD.fleet_id AND OLD.fleet_id <> NEW.fleet_id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS fleet_settings_ledger_revision_delete
AFTER DELETE ON fleet_settings BEGIN
  UPDATE fleets SET version = version + 1 WHERE id = OLD.fleet_id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS categories_ledger_revision_insert
AFTER INSERT ON categories BEGIN
  UPDATE fleets SET version = version + 1 WHERE id = NEW.fleet_id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS categories_ledger_revision_update
AFTER UPDATE ON categories BEGIN
  UPDATE fleets SET version = version + 1 WHERE id = NEW.fleet_id;
  UPDATE fleets SET version = version + 1 WHERE id = OLD.fleet_id AND OLD.fleet_id <> NEW.fleet_id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS categories_ledger_revision_delete
AFTER DELETE ON categories BEGIN
  UPDATE fleets SET version = version + 1 WHERE id = OLD.fleet_id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS vehicles_ledger_revision_insert
AFTER INSERT ON vehicles BEGIN
  UPDATE fleets SET version = version + 1 WHERE id = NEW.fleet_id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS vehicles_ledger_revision_update
AFTER UPDATE ON vehicles BEGIN
  UPDATE fleets SET version = version + 1 WHERE id = NEW.fleet_id;
  UPDATE fleets SET version = version + 1 WHERE id = OLD.fleet_id AND OLD.fleet_id <> NEW.fleet_id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS vehicles_ledger_revision_delete
AFTER DELETE ON vehicles BEGIN
  UPDATE fleets SET version = version + 1 WHERE id = OLD.fleet_id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS trips_ledger_revision_insert
AFTER INSERT ON trips BEGIN
  UPDATE fleets SET version = version + 1 WHERE id = NEW.fleet_id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS trips_ledger_revision_update
AFTER UPDATE ON trips BEGIN
  UPDATE fleets SET version = version + 1 WHERE id = NEW.fleet_id;
  UPDATE fleets SET version = version + 1 WHERE id = OLD.fleet_id AND OLD.fleet_id <> NEW.fleet_id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS trips_ledger_revision_delete
AFTER DELETE ON trips BEGIN
  UPDATE fleets SET version = version + 1 WHERE id = OLD.fleet_id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS trip_expenses_ledger_revision_insert
AFTER INSERT ON trip_expenses BEGIN
  UPDATE fleets SET version = version + 1 WHERE id = NEW.fleet_id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS trip_expenses_ledger_revision_update
AFTER UPDATE ON trip_expenses BEGIN
  UPDATE fleets SET version = version + 1 WHERE id = NEW.fleet_id;
  UPDATE fleets SET version = version + 1 WHERE id = OLD.fleet_id AND OLD.fleet_id <> NEW.fleet_id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS trip_expenses_ledger_revision_delete
AFTER DELETE ON trip_expenses BEGIN
  UPDATE fleets SET version = version + 1 WHERE id = OLD.fleet_id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS trip_incomes_ledger_revision_insert
AFTER INSERT ON trip_incomes BEGIN
  UPDATE fleets SET version = version + 1 WHERE id = NEW.fleet_id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS trip_incomes_ledger_revision_update
AFTER UPDATE ON trip_incomes BEGIN
  UPDATE fleets SET version = version + 1 WHERE id = NEW.fleet_id;
  UPDATE fleets SET version = version + 1 WHERE id = OLD.fleet_id AND OLD.fleet_id <> NEW.fleet_id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS trip_incomes_ledger_revision_delete
AFTER DELETE ON trip_incomes BEGIN
  UPDATE fleets SET version = version + 1 WHERE id = OLD.fleet_id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS maintenance_ledger_revision_insert
AFTER INSERT ON maintenance BEGIN
  UPDATE fleets SET version = version + 1 WHERE id = NEW.fleet_id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS maintenance_ledger_revision_update
AFTER UPDATE ON maintenance BEGIN
  UPDATE fleets SET version = version + 1 WHERE id = NEW.fleet_id;
  UPDATE fleets SET version = version + 1 WHERE id = OLD.fleet_id AND OLD.fleet_id <> NEW.fleet_id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS maintenance_ledger_revision_delete
AFTER DELETE ON maintenance BEGIN
  UPDATE fleets SET version = version + 1 WHERE id = OLD.fleet_id;
END;

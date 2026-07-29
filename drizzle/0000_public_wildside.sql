CREATE TABLE `categories` (
	`fleet_id` text NOT NULL,
	`id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`icon` text DEFAULT '' NOT NULL,
	`builtin` integer DEFAULT false NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`fleet_id`, `kind`, `id`),
	FOREIGN KEY (`fleet_id`) REFERENCES `fleets`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "categories_kind_check" CHECK("categories"."kind" IN ('expense', 'income')),
	CONSTRAINT "categories_builtin_check" CHECK("categories"."builtin" IN (0, 1)),
	CONSTRAINT "categories_active_check" CHECK("categories"."active" IN (0, 1)),
	CONSTRAINT "categories_sort_order_check" CHECK("categories"."sort_order" >= 0),
	CONSTRAINT "categories_version_check" CHECK("categories"."version" > 0)
);
--> statement-breakpoint
CREATE INDEX `categories_fleet_kind_active_idx` ON `categories` (`fleet_id`,`kind`,`active`);--> statement-breakpoint
CREATE TABLE `fleet_members` (
	`id` text PRIMARY KEY NOT NULL,
	`fleet_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`fleet_id`) REFERENCES `fleets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "fleet_members_role_check" CHECK("fleet_members"."role" IN ('owner', 'driver')),
	CONSTRAINT "fleet_members_active_check" CHECK("fleet_members"."active" IN (0, 1)),
	CONSTRAINT "fleet_members_version_check" CHECK("fleet_members"."version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fleet_members_fleet_user_uq` ON `fleet_members` (`fleet_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `fleet_members_user_idx` ON `fleet_members` (`user_id`,`active`);--> statement-breakpoint
CREATE TABLE `fleet_settings` (
	`fleet_id` text PRIMARY KEY NOT NULL,
	`theme` text DEFAULT 'day' NOT NULL,
	`last_report_seen` text DEFAULT '' NOT NULL,
	`last_backup_at` text DEFAULT '' NOT NULL,
	`active_vehicle_id` text DEFAULT 'all' NOT NULL,
	`period_start_date` text NOT NULL,
	`period_end_date` text NOT NULL,
	`initialized_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`fleet_id`) REFERENCES `fleets`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "fleet_settings_theme_check" CHECK("fleet_settings"."theme" IN ('day', 'night')),
	CONSTRAINT "fleet_settings_version_check" CHECK("fleet_settings"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE `fleets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "fleets_version_check" CHECK("fleets"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE `identities` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_subject` text NOT NULL,
	`email` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "identities_version_check" CHECK("identities"."version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `identities_provider_subject_uq` ON `identities` (`provider`,`provider_subject`);--> statement-breakpoint
CREATE INDEX `identities_user_idx` ON `identities` (`user_id`);--> statement-breakpoint
CREATE TABLE `maintenance` (
	`fleet_id` text NOT NULL,
	`id` text NOT NULL,
	`vehicle_id` text NOT NULL,
	`date` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`fleet_id`, `id`),
	FOREIGN KEY (`fleet_id`) REFERENCES `fleets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`fleet_id`,`vehicle_id`) REFERENCES `vehicles`(`fleet_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "maintenance_amount_check" CHECK("maintenance"."amount_cents" >= 0),
	CONSTRAINT "maintenance_sort_order_check" CHECK("maintenance"."sort_order" >= 0),
	CONSTRAINT "maintenance_version_check" CHECK("maintenance"."version" > 0)
);
--> statement-breakpoint
CREATE INDEX `maintenance_fleet_vehicle_date_idx` ON `maintenance` (`fleet_id`,`vehicle_id`,`date`);--> statement-breakpoint
CREATE TABLE `trip_expenses` (
	`fleet_id` text NOT NULL,
	`id` text NOT NULL,
	`trip_id` text NOT NULL,
	`category_id` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`date` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`fleet_id`, `id`),
	FOREIGN KEY (`fleet_id`) REFERENCES `fleets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`fleet_id`,`trip_id`) REFERENCES `trips`(`fleet_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "trip_expenses_amount_check" CHECK("trip_expenses"."amount_cents" >= 0),
	CONSTRAINT "trip_expenses_sort_order_check" CHECK("trip_expenses"."sort_order" >= 0),
	CONSTRAINT "trip_expenses_version_check" CHECK("trip_expenses"."version" > 0)
);
--> statement-breakpoint
CREATE INDEX `trip_expenses_fleet_trip_idx` ON `trip_expenses` (`fleet_id`,`trip_id`);--> statement-breakpoint
CREATE TABLE `trip_incomes` (
	`fleet_id` text NOT NULL,
	`id` text NOT NULL,
	`trip_id` text NOT NULL,
	`category_id` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`date` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`fleet_id`, `id`),
	FOREIGN KEY (`fleet_id`) REFERENCES `fleets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`fleet_id`,`trip_id`) REFERENCES `trips`(`fleet_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "trip_incomes_amount_check" CHECK("trip_incomes"."amount_cents" >= 0),
	CONSTRAINT "trip_incomes_sort_order_check" CHECK("trip_incomes"."sort_order" >= 0),
	CONSTRAINT "trip_incomes_version_check" CHECK("trip_incomes"."version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trip_incomes_trip_category_uq` ON `trip_incomes` (`fleet_id`,`trip_id`,`category_id`);--> statement-breakpoint
CREATE INDEX `trip_incomes_fleet_trip_idx` ON `trip_incomes` (`fleet_id`,`trip_id`);--> statement-breakpoint
CREATE TABLE `trips` (
	`fleet_id` text NOT NULL,
	`id` text NOT NULL,
	`vehicle_id` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text,
	`status` text NOT NULL,
	`closed_at` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`fleet_id`, `id`),
	FOREIGN KEY (`fleet_id`) REFERENCES `fleets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`fleet_id`,`vehicle_id`) REFERENCES `vehicles`(`fleet_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "trips_status_check" CHECK("trips"."status" IN ('open', 'closed')),
	CONSTRAINT "trips_sort_order_check" CHECK("trips"."sort_order" >= 0),
	CONSTRAINT "trips_version_check" CHECK("trips"."version" > 0)
);
--> statement-breakpoint
CREATE INDEX `trips_fleet_vehicle_status_idx` ON `trips` (`fleet_id`,`vehicle_id`,`status`);--> statement-breakpoint
CREATE INDEX `trips_fleet_end_date_idx` ON `trips` (`fleet_id`,`end_date`);--> statement-breakpoint
CREATE UNIQUE INDEX `trips_one_open_per_vehicle_uq` ON `trips` (`fleet_id`,`vehicle_id`) WHERE "trips"."status" = 'open';--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	CONSTRAINT "users_version_check" CHECK("users"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE `vehicle_assignments` (
	`fleet_id` text NOT NULL,
	`id` text NOT NULL,
	`vehicle_id` text NOT NULL,
	`user_id` text NOT NULL,
	`starts_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`ends_at` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`fleet_id`, `id`),
	FOREIGN KEY (`fleet_id`) REFERENCES `fleets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`fleet_id`,`vehicle_id`) REFERENCES `vehicles`(`fleet_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "vehicle_assignments_active_check" CHECK("vehicle_assignments"."active" IN (0, 1)),
	CONSTRAINT "vehicle_assignments_version_check" CHECK("vehicle_assignments"."version" > 0)
);
--> statement-breakpoint
CREATE INDEX `vehicle_assignments_user_active_idx` ON `vehicle_assignments` (`fleet_id`,`user_id`,`active`);--> statement-breakpoint
CREATE INDEX `vehicle_assignments_vehicle_active_idx` ON `vehicle_assignments` (`fleet_id`,`vehicle_id`,`active`);--> statement-breakpoint
CREATE TABLE `vehicles` (
	`fleet_id` text NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`plate_no` text DEFAULT '' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`fleet_id`, `id`),
	FOREIGN KEY (`fleet_id`) REFERENCES `fleets`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "vehicles_active_check" CHECK("vehicles"."active" IN (0, 1)),
	CONSTRAINT "vehicles_sort_order_check" CHECK("vehicles"."sort_order" >= 0),
	CONSTRAINT "vehicles_version_check" CHECK("vehicles"."version" > 0)
);
--> statement-breakpoint
CREATE INDEX `vehicles_fleet_active_idx` ON `vehicles` (`fleet_id`,`active`);--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS vehicles_require_active_on_first_insert
BEFORE INSERT ON vehicles
WHEN NEW.active = 0
  AND NOT EXISTS (
    SELECT 1 FROM vehicles
    WHERE fleet_id = NEW.fleet_id AND active = 1
  )
BEGIN
  SELECT RAISE(ABORT, 'last_active_vehicle');
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS vehicles_keep_one_active_on_update
BEFORE UPDATE OF active ON vehicles
WHEN NEW.active = 0
  AND NOT EXISTS (
    SELECT 1 FROM vehicles
    WHERE fleet_id = NEW.fleet_id
      AND id <> OLD.id
      AND active = 1
  )
BEGIN
  SELECT RAISE(ABORT, 'last_active_vehicle');
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS vehicles_keep_one_active_on_delete
BEFORE DELETE ON vehicles
WHEN OLD.active = 1
  AND EXISTS (SELECT 1 FROM fleets WHERE id = OLD.fleet_id)
  AND NOT EXISTS (
    SELECT 1 FROM vehicles
    WHERE fleet_id = OLD.fleet_id
      AND id <> OLD.id
      AND active = 1
  )
BEGIN
  SELECT RAISE(ABORT, 'last_active_vehicle');
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS vehicles_no_open_trip_on_disable
BEFORE UPDATE OF active ON vehicles
WHEN NEW.active = 0
  AND EXISTS (
    SELECT 1 FROM trips
    WHERE fleet_id = NEW.fleet_id
      AND vehicle_id = NEW.id
      AND status = 'open'
  )
BEGIN
  SELECT RAISE(ABORT, 'vehicle_has_open_trip');
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS trips_open_requires_active_vehicle_on_insert
BEFORE INSERT ON trips
WHEN NEW.status = 'open'
  AND NOT EXISTS (
    SELECT 1 FROM vehicles
    WHERE fleet_id = NEW.fleet_id
      AND id = NEW.vehicle_id
      AND active = 1
  )
BEGIN
  SELECT RAISE(ABORT, 'vehicle_inactive');
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS trips_open_requires_active_vehicle_on_update
BEFORE UPDATE OF status, vehicle_id ON trips
WHEN NEW.status = 'open'
  AND NOT EXISTS (
    SELECT 1 FROM vehicles
    WHERE fleet_id = NEW.fleet_id
      AND id = NEW.vehicle_id
      AND active = 1
  )
BEGIN
  SELECT RAISE(ABORT, 'vehicle_inactive');
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS trips_no_delete_with_entries
BEFORE DELETE ON trips
WHEN EXISTS (
    SELECT 1 FROM trip_expenses
    WHERE fleet_id = OLD.fleet_id AND trip_id = OLD.id
  )
  OR EXISTS (
    SELECT 1 FROM trip_incomes
    WHERE fleet_id = OLD.fleet_id AND trip_id = OLD.id
  )
BEGIN
  SELECT RAISE(ABORT, 'trip_has_entries');
END;

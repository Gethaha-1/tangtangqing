import { getD1 } from "./index";
import { INVARIANT_SCHEMA_STATEMENTS } from "./invariants";

// Keep one SQL statement per item. Sites' D1 adapter prepares each item
// independently; do not concatenate this list into an exec() call.
export const RUNTIME_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY NOT NULL,
    display_name TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
  )`,
  `CREATE TABLE IF NOT EXISTS identities (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    provider_subject TEXT NOT NULL,
    email TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS identities_provider_subject_uq
    ON identities(provider, provider_subject)`,
  `CREATE INDEX IF NOT EXISTS identities_user_idx ON identities(user_id)`,
  `CREATE TABLE IF NOT EXISTS fleets (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    created_by_user_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    FOREIGN KEY (created_by_user_id) REFERENCES users(id)
  )`,
  `CREATE TABLE IF NOT EXISTS fleet_members (
    id TEXT PRIMARY KEY NOT NULL,
    fleet_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'driver')),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    FOREIGN KEY (fleet_id) REFERENCES fleets(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS fleet_members_fleet_user_uq
    ON fleet_members(fleet_id, user_id)`,
  `CREATE INDEX IF NOT EXISTS fleet_members_user_idx
    ON fleet_members(user_id, active)`,
  `CREATE TABLE IF NOT EXISTS vehicles (
    fleet_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    plate_no TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    PRIMARY KEY (fleet_id, id),
    FOREIGN KEY (fleet_id) REFERENCES fleets(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS vehicles_fleet_active_idx
    ON vehicles(fleet_id, active)`,
  `CREATE TABLE IF NOT EXISTS vehicle_assignments (
    fleet_id TEXT NOT NULL,
    id TEXT NOT NULL,
    vehicle_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    starts_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ends_at TEXT,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    PRIMARY KEY (fleet_id, id),
    CONSTRAINT vehicle_assignments_vehicle_fk
      FOREIGN KEY (fleet_id, vehicle_id)
      REFERENCES vehicles(fleet_id, id) ON DELETE CASCADE,
    FOREIGN KEY (fleet_id) REFERENCES fleets(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS vehicle_assignments_user_active_idx
    ON vehicle_assignments(fleet_id, user_id, active)`,
  `CREATE INDEX IF NOT EXISTS vehicle_assignments_vehicle_active_idx
    ON vehicle_assignments(fleet_id, vehicle_id, active)`,
  `CREATE TABLE IF NOT EXISTS categories (
    fleet_id TEXT NOT NULL,
    id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('expense', 'income')),
    name TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT '',
    builtin INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0, 1)),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    PRIMARY KEY (fleet_id, kind, id),
    FOREIGN KEY (fleet_id) REFERENCES fleets(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS categories_fleet_kind_active_idx
    ON categories(fleet_id, kind, active)`,
  `CREATE TABLE IF NOT EXISTS fleet_settings (
    fleet_id TEXT PRIMARY KEY NOT NULL,
    theme TEXT NOT NULL DEFAULT 'day' CHECK (theme IN ('day', 'night')),
    last_report_seen TEXT NOT NULL DEFAULT '',
    last_backup_at TEXT NOT NULL DEFAULT '',
    active_vehicle_id TEXT NOT NULL DEFAULT 'all',
    period_start_date TEXT NOT NULL,
    period_end_date TEXT NOT NULL,
    initialized_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    FOREIGN KEY (fleet_id) REFERENCES fleets(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS trips (
    fleet_id TEXT NOT NULL,
    id TEXT NOT NULL,
    vehicle_id TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT,
    status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
    closed_at TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    PRIMARY KEY (fleet_id, id),
    CONSTRAINT trips_vehicle_fk
      FOREIGN KEY (fleet_id, vehicle_id)
      REFERENCES vehicles(fleet_id, id),
    FOREIGN KEY (fleet_id) REFERENCES fleets(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS trips_fleet_vehicle_status_idx
    ON trips(fleet_id, vehicle_id, status)`,
  `CREATE INDEX IF NOT EXISTS trips_fleet_end_date_idx
    ON trips(fleet_id, end_date)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS trips_one_open_per_vehicle_uq
    ON trips(fleet_id, vehicle_id) WHERE status = 'open'`,
  `CREATE TABLE IF NOT EXISTS trip_expenses (
    fleet_id TEXT NOT NULL,
    id TEXT NOT NULL,
    trip_id TEXT NOT NULL,
    category_id TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
    date TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    PRIMARY KEY (fleet_id, id),
    CONSTRAINT trip_expenses_trip_fk
      FOREIGN KEY (fleet_id, trip_id)
      REFERENCES trips(fleet_id, id) ON DELETE CASCADE,
    FOREIGN KEY (fleet_id) REFERENCES fleets(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS trip_expenses_fleet_trip_idx
    ON trip_expenses(fleet_id, trip_id)`,
  `CREATE TABLE IF NOT EXISTS trip_incomes (
    fleet_id TEXT NOT NULL,
    id TEXT NOT NULL,
    trip_id TEXT NOT NULL,
    category_id TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
    date TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    PRIMARY KEY (fleet_id, id),
    CONSTRAINT trip_incomes_trip_fk
      FOREIGN KEY (fleet_id, trip_id)
      REFERENCES trips(fleet_id, id) ON DELETE CASCADE,
    FOREIGN KEY (fleet_id) REFERENCES fleets(id) ON DELETE CASCADE
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS trip_incomes_trip_category_uq
    ON trip_incomes(fleet_id, trip_id, category_id)`,
  `CREATE INDEX IF NOT EXISTS trip_incomes_fleet_trip_idx
    ON trip_incomes(fleet_id, trip_id)`,
  `CREATE TABLE IF NOT EXISTS maintenance (
    fleet_id TEXT NOT NULL,
    id TEXT NOT NULL,
    vehicle_id TEXT NOT NULL,
    date TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
    note TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    PRIMARY KEY (fleet_id, id),
    CONSTRAINT maintenance_vehicle_fk
      FOREIGN KEY (fleet_id, vehicle_id)
      REFERENCES vehicles(fleet_id, id),
    FOREIGN KEY (fleet_id) REFERENCES fleets(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS maintenance_fleet_vehicle_date_idx
    ON maintenance(fleet_id, vehicle_id, date)`,
  ...INVARIANT_SCHEMA_STATEMENTS,
] as const;

let schemaPromise: Promise<void> | null = null;

export function ensureSchema(): Promise<void> {
  if (!schemaPromise) {
    const d1 = getD1();
    schemaPromise = d1
      .batch(
        RUNTIME_SCHEMA_STATEMENTS.map((statement) => d1.prepare(statement)),
      )
      .then(() => undefined)
      .catch((error: unknown) => {
        schemaPromise = null;
        throw error;
      });
  }
  return schemaPromise!;
}

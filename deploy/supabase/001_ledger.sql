-- Initial schema for an empty, explicitly authorized Supabase project.
-- Never re-run blindly against an existing ledger; use a reviewed migration.
-- Application tables are intentionally outside the exposed public/auth schemas.
BEGIN;
CREATE SCHEMA IF NOT EXISTS ttq;
REVOKE ALL ON SCHEMA ttq FROM PUBLIC;
DO $role$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ttq_app') THEN
    CREATE ROLE ttq_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END $role$;
SET LOCAL search_path = ttq, pg_catalog;
CREATE TABLE IF NOT EXISTS ttq.schema_versions (version INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY NOT NULL,
    display_name TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
  );

CREATE TABLE IF NOT EXISTS identities (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    provider_subject TEXT NOT NULL,
    email TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

CREATE UNIQUE INDEX IF NOT EXISTS identities_provider_subject_uq
    ON identities(provider, provider_subject);

CREATE INDEX IF NOT EXISTS identities_user_idx ON identities(user_id);

CREATE TABLE IF NOT EXISTS fleets (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    created_by_user_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    FOREIGN KEY (created_by_user_id) REFERENCES users(id)
  );

CREATE TABLE IF NOT EXISTS fleet_members (
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
  );

CREATE UNIQUE INDEX IF NOT EXISTS fleet_members_fleet_user_uq
    ON fleet_members(fleet_id, user_id);

CREATE INDEX IF NOT EXISTS fleet_members_user_idx
    ON fleet_members(user_id, active);

CREATE TABLE IF NOT EXISTS vehicles (
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
  );

CREATE INDEX IF NOT EXISTS vehicles_fleet_active_idx
    ON vehicles(fleet_id, active);

CREATE TABLE IF NOT EXISTS vehicle_assignments (
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
  );

CREATE INDEX IF NOT EXISTS vehicle_assignments_user_active_idx
    ON vehicle_assignments(fleet_id, user_id, active);

CREATE INDEX IF NOT EXISTS vehicle_assignments_vehicle_active_idx
    ON vehicle_assignments(fleet_id, vehicle_id, active);

CREATE TABLE IF NOT EXISTS categories (
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
  );

CREATE INDEX IF NOT EXISTS categories_fleet_kind_active_idx
    ON categories(fleet_id, kind, active);

CREATE TABLE IF NOT EXISTS fleet_settings (
    fleet_id TEXT PRIMARY KEY NOT NULL,
    theme TEXT NOT NULL DEFAULT 'day' CHECK (theme IN ('day', 'night')),
    last_report_seen TEXT NOT NULL DEFAULT '',
    last_backup_at TEXT NOT NULL DEFAULT '',
    active_vehicle_id TEXT NOT NULL DEFAULT 'all',
    period_start_date TEXT NOT NULL,
    period_end_date TEXT NOT NULL,
    business_json TEXT NOT NULL DEFAULT '{}'
      CONSTRAINT fleet_settings_business_json_check CHECK (jsonb_typeof(business_json::jsonb) = 'object'),
    initialized_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    FOREIGN KEY (fleet_id) REFERENCES fleets(id) ON DELETE CASCADE
  );

CREATE TABLE IF NOT EXISTS trips (
    fleet_id TEXT NOT NULL,
    id TEXT NOT NULL,
    vehicle_id TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT,
    status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
    closed_at TEXT,
    business_json TEXT NOT NULL DEFAULT '{}'
      CONSTRAINT trips_business_json_check CHECK (jsonb_typeof(business_json::jsonb) = 'object'),
    sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    PRIMARY KEY (fleet_id, id),
    CONSTRAINT trips_vehicle_fk
      FOREIGN KEY (fleet_id, vehicle_id)
      REFERENCES vehicles(fleet_id, id),
    FOREIGN KEY (fleet_id) REFERENCES fleets(id) ON DELETE CASCADE
  );

CREATE INDEX IF NOT EXISTS trips_fleet_vehicle_status_idx
    ON trips(fleet_id, vehicle_id, status);

CREATE INDEX IF NOT EXISTS trips_fleet_end_date_idx
    ON trips(fleet_id, end_date);

CREATE UNIQUE INDEX IF NOT EXISTS trips_one_open_per_vehicle_uq
    ON trips(fleet_id, vehicle_id) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS trip_expenses (
    fleet_id TEXT NOT NULL,
    id TEXT NOT NULL,
    trip_id TEXT NOT NULL,
    category_id TEXT NOT NULL,
    amount_cents BIGINT NOT NULL CHECK (amount_cents BETWEEN 0 AND 99999999999),
    fuel_unit_price_x10000 INTEGER,
    fuel_volume_ml INTEGER,
    date TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    CONSTRAINT trip_expenses_fuel_metadata_check CHECK (
      (fuel_unit_price_x10000 IS NULL AND fuel_volume_ml IS NULL) OR
      (category_id = 'fuel' AND
       fuel_unit_price_x10000 IS NOT NULL AND fuel_volume_ml IS NOT NULL AND
       fuel_unit_price_x10000 BETWEEN 1 AND 9999999 AND fuel_volume_ml BETWEEN 1 AND 100000000)
    ),
    PRIMARY KEY (fleet_id, id),
    CONSTRAINT trip_expenses_trip_fk
      FOREIGN KEY (fleet_id, trip_id)
      REFERENCES trips(fleet_id, id) ON DELETE CASCADE,
    FOREIGN KEY (fleet_id) REFERENCES fleets(id) ON DELETE CASCADE
  );

CREATE INDEX IF NOT EXISTS trip_expenses_fleet_trip_idx
    ON trip_expenses(fleet_id, trip_id);

CREATE TABLE IF NOT EXISTS trip_incomes (
    fleet_id TEXT NOT NULL,
    id TEXT NOT NULL,
    trip_id TEXT NOT NULL,
    category_id TEXT NOT NULL,
    amount_cents BIGINT NOT NULL CHECK (amount_cents BETWEEN 0 AND 99999999999),
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
  );

CREATE UNIQUE INDEX IF NOT EXISTS trip_incomes_trip_category_uq
    ON trip_incomes(fleet_id, trip_id, category_id);

CREATE INDEX IF NOT EXISTS trip_incomes_fleet_trip_idx
    ON trip_incomes(fleet_id, trip_id);

CREATE TABLE IF NOT EXISTS maintenance (
    fleet_id TEXT NOT NULL,
    id TEXT NOT NULL,
    vehicle_id TEXT NOT NULL,
    date TEXT NOT NULL,
    amount_cents BIGINT NOT NULL CHECK (amount_cents BETWEEN 0 AND 99999999999),
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
  );

CREATE INDEX IF NOT EXISTS maintenance_fleet_vehicle_date_idx
    ON maintenance(fleet_id, vehicle_id, date);

CREATE TABLE IF NOT EXISTS sync_commits (
    fleet_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (fleet_id, operation_id),
    FOREIGN KEY (fleet_id) REFERENCES fleets(id) ON DELETE CASCADE
  );

CREATE INDEX IF NOT EXISTS sync_commits_created_at_idx
    ON sync_commits(created_at);

CREATE TABLE IF NOT EXISTS sync_assertions (
    fleet_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    ok INTEGER NOT NULL,
    CONSTRAINT sync_assertions_ok_check CHECK (ok = 1),
    PRIMARY KEY (fleet_id, operation_id, ordinal),
    FOREIGN KEY (fleet_id) REFERENCES fleets(id) ON DELETE CASCADE
  );

CREATE OR REPLACE FUNCTION ttq.datetime(value TEXT) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql STABLE SET search_path = pg_catalog SET timezone = 'UTC'
AS $function$ BEGIN
  RETURN value::TIMESTAMPTZ;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
  RETURN NULL;
END $function$;

CREATE OR REPLACE FUNCTION ttq.guard_vehicle() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = ttq, pg_catalog AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.active = 1 AND EXISTS (SELECT 1 FROM ttq.fleets WHERE id = OLD.fleet_id)
      AND NOT EXISTS (SELECT 1 FROM ttq.vehicles WHERE fleet_id = OLD.fleet_id AND id <> OLD.id AND active = 1)
    THEN RAISE EXCEPTION 'last_active_vehicle' USING ERRCODE = '23514'; END IF;
    RETURN OLD;
  END IF;
  IF NEW.active = 0 AND NOT EXISTS (
    SELECT 1 FROM ttq.vehicles WHERE fleet_id = NEW.fleet_id AND id <> NEW.id AND active = 1
  ) THEN RAISE EXCEPTION 'last_active_vehicle' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'UPDATE' AND NEW.active = 0 AND EXISTS (
    SELECT 1 FROM ttq.trips WHERE fleet_id = NEW.fleet_id AND vehicle_id = NEW.id AND status = 'open'
  ) THEN RAISE EXCEPTION 'vehicle_has_open_trip' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $function$;
DROP TRIGGER IF EXISTS vehicle_invariants ON ttq.vehicles;
CREATE TRIGGER vehicle_invariants BEFORE INSERT OR UPDATE OF active OR DELETE ON ttq.vehicles
FOR EACH ROW EXECUTE FUNCTION ttq.guard_vehicle();

CREATE OR REPLACE FUNCTION ttq.guard_trip() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = ttq, pg_catalog AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM ttq.trip_expenses WHERE fleet_id = OLD.fleet_id AND trip_id = OLD.id)
      OR EXISTS (SELECT 1 FROM ttq.trip_incomes WHERE fleet_id = OLD.fleet_id AND trip_id = OLD.id)
    THEN RAISE EXCEPTION 'trip_has_entries' USING ERRCODE = '23514'; END IF;
    RETURN OLD;
  END IF;
  IF NEW.status = 'open' AND NOT EXISTS (
    SELECT 1 FROM ttq.vehicles WHERE fleet_id = NEW.fleet_id AND id = NEW.vehicle_id AND active = 1
  ) THEN RAISE EXCEPTION 'vehicle_inactive' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $function$;
DROP TRIGGER IF EXISTS trip_invariants ON ttq.trips;
CREATE TRIGGER trip_invariants BEFORE INSERT OR UPDATE OF status, vehicle_id OR DELETE ON ttq.trips
FOR EACH ROW EXECUTE FUNCTION ttq.guard_trip();

GRANT USAGE ON SCHEMA ttq TO ttq_app;
REVOKE ALL ON ALL TABLES IN SCHEMA ttq FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ttq FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ttq.datetime(TEXT) TO ttq_app;
GRANT SELECT ON ttq.schema_versions TO ttq_app;
ALTER TABLE ttq.users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS backend_only ON ttq.users;
CREATE POLICY backend_only ON ttq.users TO ttq_app USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON ttq.users TO ttq_app;
ALTER TABLE ttq.identities ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS backend_only ON ttq.identities;
CREATE POLICY backend_only ON ttq.identities TO ttq_app USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON ttq.identities TO ttq_app;
ALTER TABLE ttq.fleets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS backend_only ON ttq.fleets;
CREATE POLICY backend_only ON ttq.fleets TO ttq_app USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON ttq.fleets TO ttq_app;
ALTER TABLE ttq.fleet_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS backend_only ON ttq.fleet_members;
CREATE POLICY backend_only ON ttq.fleet_members TO ttq_app USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON ttq.fleet_members TO ttq_app;
ALTER TABLE ttq.vehicles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS backend_only ON ttq.vehicles;
CREATE POLICY backend_only ON ttq.vehicles TO ttq_app USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON ttq.vehicles TO ttq_app;
ALTER TABLE ttq.vehicle_assignments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS backend_only ON ttq.vehicle_assignments;
CREATE POLICY backend_only ON ttq.vehicle_assignments TO ttq_app USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON ttq.vehicle_assignments TO ttq_app;
ALTER TABLE ttq.categories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS backend_only ON ttq.categories;
CREATE POLICY backend_only ON ttq.categories TO ttq_app USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON ttq.categories TO ttq_app;
ALTER TABLE ttq.fleet_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS backend_only ON ttq.fleet_settings;
CREATE POLICY backend_only ON ttq.fleet_settings TO ttq_app USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON ttq.fleet_settings TO ttq_app;
ALTER TABLE ttq.trips ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS backend_only ON ttq.trips;
CREATE POLICY backend_only ON ttq.trips TO ttq_app USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON ttq.trips TO ttq_app;
ALTER TABLE ttq.trip_expenses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS backend_only ON ttq.trip_expenses;
CREATE POLICY backend_only ON ttq.trip_expenses TO ttq_app USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON ttq.trip_expenses TO ttq_app;
ALTER TABLE ttq.trip_incomes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS backend_only ON ttq.trip_incomes;
CREATE POLICY backend_only ON ttq.trip_incomes TO ttq_app USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON ttq.trip_incomes TO ttq_app;
ALTER TABLE ttq.maintenance ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS backend_only ON ttq.maintenance;
CREATE POLICY backend_only ON ttq.maintenance TO ttq_app USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON ttq.maintenance TO ttq_app;
ALTER TABLE ttq.sync_commits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS backend_only ON ttq.sync_commits;
CREATE POLICY backend_only ON ttq.sync_commits TO ttq_app USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON ttq.sync_commits TO ttq_app;
ALTER TABLE ttq.sync_assertions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS backend_only ON ttq.sync_assertions;
CREATE POLICY backend_only ON ttq.sync_assertions TO ttq_app USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON ttq.sync_assertions TO ttq_app;
-- Defense in depth if this schema is accidentally added to exposed schemas.
DO $revoke$ DECLARE name TEXT; BEGIN
  FOREACH name IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = name) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA ttq FROM %I', name);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA ttq FROM %I', name);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ttq FROM %I', name);
    END IF;
  END LOOP;
END $revoke$;
INSERT INTO ttq.schema_versions(version) VALUES (1) ON CONFLICT DO NOTHING;
COMMIT;

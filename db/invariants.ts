/**
 * Cross-row invariants that SQLite cannot express with a table CHECK.
 *
 * D1 serializes writes. These BEFORE triggers therefore make the decision and
 * mutation part of the same database statement, closing the gap between an
 * application pre-read and a later UPDATE/INSERT.
 */
export const INVARIANT_SCHEMA_STATEMENTS = [
  `CREATE TRIGGER IF NOT EXISTS vehicles_require_active_on_first_insert
    BEFORE INSERT ON vehicles
    WHEN NEW.active = 0
      AND NOT EXISTS (
        SELECT 1 FROM vehicles
        WHERE fleet_id = NEW.fleet_id AND active = 1
      )
    BEGIN
      SELECT RAISE(ABORT, 'last_active_vehicle');
    END`,
  `CREATE TRIGGER IF NOT EXISTS vehicles_keep_one_active_on_update
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
    END`,
  `CREATE TRIGGER IF NOT EXISTS vehicles_keep_one_active_on_delete
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
    END`,
  `CREATE TRIGGER IF NOT EXISTS vehicles_no_open_trip_on_disable
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
    END`,
  `CREATE TRIGGER IF NOT EXISTS trips_open_requires_active_vehicle_on_insert
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
    END`,
  `CREATE TRIGGER IF NOT EXISTS trips_open_requires_active_vehicle_on_update
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
    END`,
  `CREATE TRIGGER IF NOT EXISTS trips_no_delete_with_entries
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
    END`,
] as const;

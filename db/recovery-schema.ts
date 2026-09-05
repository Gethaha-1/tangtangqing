/** Local compatibility schema. Production uses the reviewed Supabase migration. */
export const RECOVERY_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS restore_jobs (
    fleet_id TEXT NOT NULL REFERENCES fleets(id),
    id TEXT NOT NULL,
    membership_id TEXT NOT NULL REFERENCES fleet_members(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    base_version INTEGER NOT NULL CHECK (base_version > 0),
    manifest_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading','ready','complete','cancelled')),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    PRIMARY KEY (fleet_id, id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS restore_jobs_one_active ON restore_jobs(fleet_id)
    WHERE status IN ('uploading','ready')`,
  `CREATE INDEX IF NOT EXISTS restore_jobs_expiry ON restore_jobs(expires_at)`,
  `CREATE INDEX IF NOT EXISTS restore_jobs_membership ON restore_jobs(membership_id)`,
  `CREATE INDEX IF NOT EXISTS restore_jobs_user ON restore_jobs(user_id)`,
  `CREATE TABLE IF NOT EXISTS restore_chunks (
    fleet_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0 AND ordinal < 256),
    hash TEXT NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (fleet_id, job_id, ordinal),
    FOREIGN KEY (fleet_id, job_id) REFERENCES restore_jobs(fleet_id, id) ON DELETE CASCADE
  )`,
  // Database-level revision catches writes from old application instances too.
  ...['fleet_settings', 'categories', 'vehicles', 'trips', 'trip_expenses', 'trip_incomes', 'maintenance'].flatMap(table =>
    ['INSERT', 'UPDATE', 'DELETE'].map(event => `CREATE TRIGGER IF NOT EXISTS ${table}_ledger_revision_${event.toLowerCase()}
      AFTER ${event} ON ${table} BEGIN
        UPDATE fleets SET version = version + 1 WHERE id = ${event === 'DELETE' ? 'OLD' : 'NEW'}.fleet_id;
        ${event === 'UPDATE' ? 'UPDATE fleets SET version = version + 1 WHERE id = OLD.fleet_id AND OLD.fleet_id <> NEW.fleet_id;' : ''}
      END`)),
] as const;

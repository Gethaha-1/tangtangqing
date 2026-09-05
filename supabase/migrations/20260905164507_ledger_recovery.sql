-- Incremental, additive migration. Apply after deploy/supabase/001_ledger.sql.
-- No business rows, accounts or old backup fields are removed or rewritten.
BEGIN;
CREATE TABLE ttq.restore_jobs (
  fleet_id TEXT NOT NULL REFERENCES ttq.fleets(id),
  id TEXT NOT NULL,
  membership_id TEXT NOT NULL REFERENCES ttq.fleet_members(id),
  user_id TEXT NOT NULL REFERENCES ttq.users(id),
  base_version INTEGER NOT NULL CHECK (base_version > 0),
  manifest_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading','ready','complete','cancelled')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (fleet_id, id)
);
CREATE UNIQUE INDEX restore_jobs_one_active ON ttq.restore_jobs(fleet_id) WHERE status IN ('uploading','ready');
CREATE INDEX restore_jobs_expiry ON ttq.restore_jobs(expires_at);
CREATE INDEX restore_jobs_membership ON ttq.restore_jobs(membership_id);
CREATE INDEX restore_jobs_user ON ttq.restore_jobs(user_id);
CREATE TABLE ttq.restore_chunks (
  fleet_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0 AND ordinal < 256),
  hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (fleet_id, job_id, ordinal),
  FOREIGN KEY (fleet_id, job_id) REFERENCES ttq.restore_jobs(fleet_id, id) ON DELETE CASCADE
);
ALTER TABLE ttq.restore_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ttq.restore_chunks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ttq.restore_jobs, ttq.restore_chunks FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ttq.restore_jobs, ttq.restore_chunks TO ttq_app;
CREATE POLICY backend_only ON ttq.restore_jobs TO ttq_app USING (true) WITH CHECK (true);
CREATE POLICY backend_only ON ttq.restore_chunks TO ttq_app USING (true) WITH CHECK (true);

-- The revision belongs to the whole fleet ledger. Database triggers also cover
-- older application instances and authorized maintenance writes during rollout.
CREATE FUNCTION ttq.bump_ledger_version() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE ttq.fleets SET version = version + 1 WHERE id = OLD.fleet_id;
    RETURN OLD;
  END IF;
  UPDATE ttq.fleets SET version = version + 1 WHERE id = NEW.fleet_id;
  IF TG_OP = 'UPDATE' AND OLD.fleet_id IS DISTINCT FROM NEW.fleet_id THEN
    UPDATE ttq.fleets SET version = version + 1 WHERE id = OLD.fleet_id;
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION ttq.bump_ledger_version() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION ttq.bump_ledger_version() TO ttq_app;
DO $triggers$ DECLARE target TEXT; BEGIN
  FOREACH target IN ARRAY ARRAY['fleet_settings','categories','vehicles','trips','trip_expenses','trip_incomes','maintenance'] LOOP
    EXECUTE format('CREATE TRIGGER ledger_revision AFTER INSERT OR UPDATE OR DELETE ON ttq.%I FOR EACH ROW EXECUTE FUNCTION ttq.bump_ledger_version()', target);
  END LOOP;
END $triggers$;
INSERT INTO ttq.schema_versions(version) VALUES (2);
COMMIT;

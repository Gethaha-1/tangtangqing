-- Additive second-round business metadata for shipper groups, trip manifests,
-- return freight calculation and reusable loading/unloading notes.
-- Apply only after the recovery migration and after explicit production approval.
BEGIN;
ALTER TABLE ttq.fleet_settings
  ADD COLUMN IF NOT EXISTS business_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE ttq.trips
  ADD COLUMN IF NOT EXISTS business_json TEXT NOT NULL DEFAULT '{}';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fleet_settings_business_json_check'
      AND conrelid = 'ttq.fleet_settings'::regclass
  ) THEN
    ALTER TABLE ttq.fleet_settings
      ADD CONSTRAINT fleet_settings_business_json_check
      CHECK (jsonb_typeof(business_json::jsonb) = 'object');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'trips_business_json_check'
      AND conrelid = 'ttq.trips'::regclass
  ) THEN
    ALTER TABLE ttq.trips
      ADD CONSTRAINT trips_business_json_check
      CHECK (jsonb_typeof(business_json::jsonb) = 'object');
  END IF;
END
$$;
INSERT INTO ttq.schema_versions(version) VALUES (3) ON CONFLICT DO NOTHING;
COMMIT;

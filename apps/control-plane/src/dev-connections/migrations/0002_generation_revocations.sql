-- Archive may arrive before registration has been acknowledged (or dispatched).
-- Keep a permanent tombstone even when the corresponding generation row is absent.
CREATE TABLE dev_connections.generation_revocations (
  id uuid PRIMARY KEY,
  revoked_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
GRANT SELECT,INSERT ON dev_connections.generation_revocations TO zeros_app;
ALTER TABLE dev_connections.generation_revocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE dev_connections.generation_revocations FORCE ROW LEVEL SECURITY;
CREATE POLICY broker_only ON dev_connections.generation_revocations TO zeros_app
  USING (current_setting('dev_connections.authority',true)='broker')
  WITH CHECK (current_setting('dev_connections.authority',true)='broker');

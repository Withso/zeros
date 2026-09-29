-- Match the native keeper's one-minute cooldown even if only the refresh cache
-- rotates. A known new seed must be retained without claiming fresh access.
ALTER TABLE dev_connections.connections
  ADD COLUMN refresh_after timestamptz NOT NULL DEFAULT clock_timestamp();
CREATE INDEX refresh_fingerprints_connection ON dev_connections.refresh_fingerprints(connection_id);

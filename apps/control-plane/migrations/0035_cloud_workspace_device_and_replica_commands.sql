-- ──────────────────────────────────────────────────────────
-- 0035 — uncertain-response recovery for device/replica mutations
-- ──────────────────────────────────────────────────────────

CREATE TABLE device_key_rotation_requests (
  device_id          uuid NOT NULL,
  user_id            uuid NOT NULL,
  idempotency_key    text NOT NULL CHECK (
                       char_length(idempotency_key) BETWEEN 8 AND 128
                     ),
  request_sha256     bytea NOT NULL CHECK (octet_length(request_sha256) = 32),
  from_key_version   bigint NOT NULL CHECK (from_key_version > 0),
  to_key_version     bigint NOT NULL CHECK (to_key_version = from_key_version + 1),
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, idempotency_key),
  FOREIGN KEY (device_id, user_id) REFERENCES devices(id, user_id)
    ON DELETE CASCADE
);

CREATE TABLE workspace_replica_commands (
  replica_id         uuid NOT NULL,
  org_id             uuid NOT NULL,
  user_id            uuid NOT NULL,
  idempotency_key    text NOT NULL CHECK (
                       char_length(idempotency_key) BETWEEN 8 AND 128
                     ),
  operation          text NOT NULL CHECK (
                       operation IN ('pause', 'resume', 'remove')
                     ),
  request_sha256     bytea NOT NULL CHECK (octet_length(request_sha256) = 32),
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (replica_id, idempotency_key),
  FOREIGN KEY (replica_id, org_id)
    REFERENCES workspace_replicas(id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

ALTER TABLE device_key_rotation_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_replica_commands ENABLE ROW LEVEL SECURITY;

CREATE POLICY device_key_rotation_requests_system
  ON device_key_rotation_requests FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY workspace_replica_commands_read
  ON workspace_replica_commands FOR SELECT
  USING (app_is_system() OR org_id IN (SELECT app_user_org_ids()));
CREATE POLICY workspace_replica_commands_system
  ON workspace_replica_commands FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());

ALTER TABLE device_key_rotation_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_replica_commands FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  device_key_rotation_requests, workspace_replica_commands
TO zeros_app;

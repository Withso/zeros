-- ───────────────────────────────────────────────────────────
-- 0022 — One-use setup materials and durable engine registration
--
-- A setup admission is exchanged once for narrowly scoped repository,
-- settings, and engine-start material. Secret values remain encrypted at rest;
-- bridge and heartbeat credentials are represented only by SHA-256 verifiers.
-- Engine registration remains bound to the same live setup run/fence so a
-- reclaimed worker cannot bring an older engine instance back into authority.
-- ───────────────────────────────────────────────────────────

CREATE TABLE cloud_workspace_setup_secrets (
  id                     uuid PRIMARY KEY,
  workspace_id           uuid NOT NULL,
  generation             integer NOT NULL CHECK (generation > 0),
  org_id                 uuid NOT NULL,
  name                   text NOT NULL CHECK (
                           name ~ '^[A-Z_][A-Z0-9_]{0,127}$'
                         ),
  key_version            integer NOT NULL CHECK (key_version > 0),
  nonce                  bytea NOT NULL CHECK (octet_length(nonce) = 12),
  ciphertext             bytea NOT NULL CHECK (
                           octet_length(ciphertext) BETWEEN 1 AND 65536
                         ),
  auth_tag               bytea NOT NULL CHECK (octet_length(auth_tag) = 16),
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, generation, name),
  UNIQUE (id, workspace_id, generation, org_id, name),
  FOREIGN KEY (workspace_id, generation, org_id)
    REFERENCES cloud_workspace_setup_specs(workspace_id, generation, org_id)
    ON DELETE CASCADE
);

CREATE TABLE cloud_workspace_engine_instances (
  id                     uuid PRIMARY KEY,
  workspace_id           uuid NOT NULL,
  generation             integer NOT NULL CHECK (generation > 0),
  org_id                 uuid NOT NULL,
  account_user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  setup_run_id           uuid NOT NULL,
  setup_execution_fence  bigint NOT NULL CHECK (setup_execution_fence > 0),
  registration_grant_id  uuid NOT NULL UNIQUE
                         REFERENCES cloud_workspace_endpoint_grants(id)
                         ON DELETE CASCADE,
  protocol_version       integer NOT NULL CHECK (
                           protocol_version BETWEEN 1 AND 65535
                         ),
  state                  text NOT NULL CHECK (
                           state IN ('starting', 'ready', 'superseded', 'revoked')
                         ),
  bridge_token_hash      bytea NOT NULL UNIQUE CHECK (
                           octet_length(bridge_token_hash) = 32
                         ),
  heartbeat_token_hash   bytea UNIQUE CHECK (
                           heartbeat_token_hash IS NULL
                           OR octet_length(heartbeat_token_hash) = 32
                         ),
  registered_at          timestamptz,
  last_heartbeat_at      timestamptz,
  lease_expires_at       timestamptz,
  revoked_at             timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (
    id, workspace_id, generation, org_id, setup_run_id,
    setup_execution_fence
  ),
  FOREIGN KEY (
    setup_run_id, workspace_id, generation, org_id, setup_execution_fence
  ) REFERENCES cloud_workspace_setup_runs(
    id, workspace_id, generation, org_id, execution_fence
  ) ON DELETE CASCADE,
  CHECK (
    (
      state = 'starting'
      AND heartbeat_token_hash IS NULL
      AND registered_at IS NULL
      AND last_heartbeat_at IS NULL
      AND lease_expires_at IS NULL
      AND revoked_at IS NULL
    )
    OR (
      state = 'ready'
      AND heartbeat_token_hash IS NOT NULL
      AND registered_at IS NOT NULL
      AND last_heartbeat_at IS NOT NULL
      AND lease_expires_at > last_heartbeat_at
      AND revoked_at IS NULL
    )
    OR (
      state IN ('superseded', 'revoked')
      AND revoked_at IS NOT NULL
    )
  )
);

CREATE INDEX cloud_workspace_engine_instances_live_idx
  ON cloud_workspace_engine_instances (
    workspace_id, generation, lease_expires_at
  )
  WHERE state IN ('starting', 'ready');

ALTER TABLE cloud_workspace_setup_attestations
  ADD CONSTRAINT cloud_workspace_setup_attestations_engine_instance_fkey
  FOREIGN KEY (
    engine_instance_id, workspace_id, generation, org_id, setup_run_id,
    execution_fence
  ) REFERENCES cloud_workspace_engine_instances(
    id, workspace_id, generation, org_id, setup_run_id,
    setup_execution_fence
  );

CREATE FUNCTION enforce_cloud_workspace_setup_engine_attestation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM cloud_workspace_engine_instances ei
    WHERE ei.id = NEW.engine_instance_id
      AND ei.workspace_id = NEW.workspace_id
      AND ei.generation = NEW.generation
      AND ei.org_id = NEW.org_id
      AND ei.setup_run_id = NEW.setup_run_id
      AND ei.setup_execution_fence = NEW.execution_fence
      AND ei.protocol_version = NEW.engine_protocol_version
      AND ei.state = 'ready'
      AND ei.revoked_at IS NULL
      AND ei.lease_expires_at > now()
  ) THEN
    RAISE EXCEPTION 'setup attestation does not match a live registered engine'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cloud_workspace_setup_attestations_engine_binding
  BEFORE INSERT ON cloud_workspace_setup_attestations
  FOR EACH ROW EXECUTE FUNCTION
    enforce_cloud_workspace_setup_engine_attestation();

-- Secret ciphertext and credential verifiers are never user-readable SQL.
-- Setup workers and the internal engine-registration service use an explicit
-- system transaction; ordinary tenant reads receive no policy at all.
ALTER TABLE cloud_workspace_setup_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_engine_instances ENABLE ROW LEVEL SECURITY;

CREATE POLICY cloud_workspace_setup_secrets_system
  ON cloud_workspace_setup_secrets FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY cloud_workspace_engine_instances_system
  ON cloud_workspace_engine_instances FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());

ALTER TABLE cloud_workspace_setup_secrets FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_engine_instances FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON cloud_workspace_setup_secrets, cloud_workspace_engine_instances
  TO zeros_app;

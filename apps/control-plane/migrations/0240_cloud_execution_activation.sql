-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

ALTER TABLE cloud_v2_workspaces
  ADD COLUMN execution_transition_id uuid,
  ADD COLUMN execution_restore_claimed_at timestamptz;

CREATE TABLE cloud_v2_execution_activations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  org_id uuid NOT NULL,
  initiator_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  operator_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  runtime_sha256 text NOT NULL CHECK (runtime_sha256 ~ '^[a-f0-9]{64}$'),
  target_fingerprint text NOT NULL CHECK (target_fingerprint ~ '^[a-f0-9]{16}$'),
  request_hash bytea NOT NULL CHECK (octet_length(request_hash)=32),
  reason_hash bytea NOT NULL CHECK (octet_length(reason_hash)=32),
  prepared_snapshot jsonb NOT NULL CHECK (jsonb_typeof(prepared_snapshot)='object'),
  phase text NOT NULL DEFAULT 'prepared' CHECK (phase IN ('prepared','superseded','draining','authorizing','booting','active','failed','cancelled','rolled_back')),
  intent_id uuid NOT NULL DEFAULT gen_random_uuid(),
  access_epoch bigint,
  stop_generation bigint,
  sandbox_id text,
  boot_id uuid,
  worker_token_hash bytea CHECK (worker_token_hash IS NULL OR octet_length(worker_token_hash)=32),
  drained_at timestamptz,
  confirmed_stop_generation bigint,
  confirmed_stopped_at timestamptz,
  legacy_material text CHECK (legacy_material IN ('none','removed','refused')),
  first_error_code text CHECK (first_error_code IN ('actor_changed','member_access_revoked','agent_credentials_unavailable',
    'worker_update_required','execution_not_retired','activation_timeout','activation_cancelled','activation_runtime_changed','activation_boot_failed')),
  started_at timestamptz,
  deadline_at timestamptz,
  completed_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(id,workspace_id,org_id),
  FOREIGN KEY(workspace_id,org_id) REFERENCES cloud_v2_workspaces(id,org_id) ON DELETE CASCADE,
  CHECK ((phase IN ('prepared','superseded')) OR (started_at IS NOT NULL AND deadline_at IS NOT NULL)),
  CHECK (phase<>'active' OR (drained_at IS NOT NULL AND boot_id IS NOT NULL AND worker_token_hash IS NOT NULL
    AND legacy_material IS NOT NULL AND legacy_material IN ('none','removed') AND completed_at IS NOT NULL))
);
CREATE UNIQUE INDEX cloud_execution_activation_current ON cloud_v2_execution_activations(workspace_id)
  WHERE phase IN ('prepared','draining','authorizing','booting','active');
CREATE INDEX cloud_execution_activation_due ON cloud_v2_execution_activations(next_attempt_at,id)
  WHERE phase IN ('draining','authorizing','booting');
CREATE INDEX cloud_execution_activation_retention ON cloud_v2_execution_activations(completed_at,id)
  WHERE phase IN ('failed','cancelled','rolled_back');

ALTER TABLE cloud_v2_workspaces ADD CONSTRAINT cloud_execution_transition_scope
  FOREIGN KEY(execution_transition_id,id,org_id) REFERENCES cloud_v2_execution_activations(id,workspace_id,org_id)
  ON DELETE SET NULL(execution_transition_id);

CREATE TABLE cloud_v2_execution_activation_receipts (
  activation_id uuid NOT NULL REFERENCES cloud_v2_execution_activations(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('prepare','activate','rollback')),
  request_hash bytea NOT NULL CHECK (octet_length(request_hash)=32),
  approval_hash bytea NOT NULL CHECK (octet_length(approval_hash)=32),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(activation_id,action)
);
ALTER TABLE cloud_v2_execution_activations ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_v2_execution_activations FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_v2_execution_activations USING(app_is_system()) WITH CHECK(app_is_system());
ALTER TABLE cloud_v2_execution_activation_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_v2_execution_activation_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_v2_execution_activation_receipts USING(app_is_system()) WITH CHECK(app_is_system());
-- zeros-expand-exception: execution-operator-authority Remove inherited app DML only on this new operator-owned table
REVOKE ALL ON cloud_v2_execution_activations FROM PUBLIC, zeros_app;
-- zeros-expand-exception: execution-operator-authority Remove inherited app DML only on this new operator-owned receipt table
REVOKE ALL ON cloud_v2_execution_activation_receipts FROM PUBLIC, zeros_app;
GRANT SELECT ON cloud_v2_execution_activations,cloud_v2_execution_activation_receipts TO zeros_app;
GRANT UPDATE(phase,access_epoch,stop_generation,sandbox_id,boot_id,worker_token_hash,drained_at,confirmed_stop_generation,confirmed_stopped_at,legacy_material,
  first_error_code,completed_at,next_attempt_at,updated_at) ON cloud_v2_execution_activations TO zeros_app;

ALTER TABLE cloud_v2_execution_boots
  ADD COLUMN legacy_material text CHECK (legacy_material IN ('none','removed','refused')),
  ADD COLUMN first_failed_legacy_material text CHECK (first_failed_legacy_material IN ('none','removed','refused'));

-- This is a protocol fence, not authorization: zeros_app can set the marker.
-- Old replicas cannot select a Creator configuration for a protected row;
-- the ordinary membership/session/source checks still authorize every person.
-- zeros-expand-exception: execution-protocol-fence Hide active and transitioning workspaces only from replicas without the transaction protocol marker
CREATE POLICY cloud_execution_protocol ON cloud_v2_workspaces AS RESTRICTIVE FOR ALL TO zeros_app
  USING ((execution_mode<>'active' AND execution_transition_id IS NULL)
    OR current_setting('app.cloud_execution_protocol',true)='1')
  WITH CHECK ((execution_mode<>'active' AND execution_transition_id IS NULL)
    OR current_setting('app.cloud_execution_protocol',true)='1');

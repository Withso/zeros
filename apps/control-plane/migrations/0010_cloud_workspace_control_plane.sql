-- ───────────────────────────────────────────────────────────
-- 0010 — Provider-neutral cloud-workspace control-plane records
--
-- A provider resource is disposable and never serves as public identity. The
-- stable workspace row records desired state; immutable generations pin the
-- execution image; lifecycle intents provide idempotency and a durable
-- record-before-dispatch boundary; provider bindings record observed state.
--
-- No production quota row is created here. Creation therefore fails closed
-- until an operator/entitlement path installs an explicit organization quota.
-- ───────────────────────────────────────────────────────────

CREATE TYPE cloud_workspace_status AS ENUM (
  'requested',
  'provisioning',
  'setting_up',
  'ready',
  'busy',
  'stopping',
  'stopped',
  'waking',
  'archiving',
  'archived',
  'deleting',
  'deleted',
  'failed'
);

CREATE TYPE cloud_workspace_desired_state AS ENUM (
  'running',
  'stopped',
  'archived',
  'deleted'
);

CREATE TYPE cloud_workspace_operation AS ENUM (
  'create',
  'stop',
  'wake',
  'archive',
  'delete'
);

CREATE TYPE cloud_workspace_intent_state AS ENUM (
  'queued',
  'dispatching',
  'observing',
  'succeeded',
  'failed',
  'superseded'
);

CREATE TYPE cloud_workspace_setup_state AS ENUM (
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled'
);

-- Quotas are an entitlement input, not user-editable settings. A missing row
-- means cloud creation/wake is unavailable for the organization.
CREATE TABLE cloud_workspace_quotas (
  org_id                 uuid PRIMARY KEY
                         REFERENCES organizations(id) ON DELETE CASCADE,
  max_workspaces         integer NOT NULL CHECK (max_workspaces > 0),
  max_running_workspaces integer NOT NULL
                         CHECK (max_running_workspaces > 0
                                AND max_running_workspaces <= max_workspaces),
  max_cpu_millicores     integer NOT NULL CHECK (max_cpu_millicores > 0),
  max_memory_mib         integer NOT NULL CHECK (max_memory_mib > 0),
  max_storage_mib        integer NOT NULL CHECK (max_storage_mib > 0),
  updated_by             uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cloud_workspaces (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid NOT NULL
                         REFERENCES organizations(id) ON DELETE RESTRICT,
  team_id                uuid NOT NULL,
  created_by             uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  display_name           text NOT NULL CHECK (
                           char_length(display_name) BETWEEN 1 AND 120
                         ),
  repository_forge       text NOT NULL CHECK (
                           char_length(repository_forge) BETWEEN 1 AND 255
                         ),
  repository_owner       text NOT NULL CHECK (
                           char_length(repository_owner) BETWEEN 1 AND 255
                         ),
  repository_name        text NOT NULL CHECK (
                           char_length(repository_name) BETWEEN 1 AND 255
                         ),
  repository_revision    text NOT NULL CHECK (
                           char_length(repository_revision) BETWEEN 1 AND 512
                         ),
  github_installation_id uuid REFERENCES github_installations(id)
                         ON DELETE SET NULL,
  status                 cloud_workspace_status NOT NULL DEFAULT 'requested',
  desired_state          cloud_workspace_desired_state NOT NULL DEFAULT 'running',
  current_generation     integer NOT NULL DEFAULT 1
                         CHECK (current_generation > 0),
  version                bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  last_error_code        text CHECK (
                           last_error_code IS NULL
                           OR char_length(last_error_code) BETWEEN 1 AND 128
                         ),
  last_error_message     text CHECK (
                           last_error_message IS NULL
                           OR char_length(last_error_message) <= 2048
                         ),
  last_observed_at       timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  deleted_at             timestamptz,
  UNIQUE (id, org_id),
  FOREIGN KEY (team_id, org_id)
    REFERENCES teams(id, org_id) ON DELETE RESTRICT,
  CHECK (
    (status = 'deleted' AND desired_state = 'deleted' AND deleted_at IS NOT NULL)
    OR (status <> 'deleted' AND deleted_at IS NULL)
  )
);
CREATE INDEX cloud_workspaces_org_idx
  ON cloud_workspaces (org_id, created_at DESC, id);
CREATE INDEX cloud_workspaces_team_idx
  ON cloud_workspaces (team_id, created_at DESC, id);
CREATE INDEX cloud_workspaces_reconcile_idx
  ON cloud_workspaces (desired_state, status, updated_at)
  WHERE status NOT IN ('deleted');

CREATE TABLE cloud_workspace_generations (
  workspace_id           uuid NOT NULL,
  generation             integer NOT NULL CHECK (generation > 0),
  org_id                 uuid NOT NULL,
  provider               text NOT NULL CHECK (
                           provider ~ '^[a-z][a-z0-9_-]{0,63}$'
                         ),
  image_ref              text NOT NULL CHECK (
                           char_length(image_ref) BETWEEN 1 AND 1024
                         ),
  architecture           text NOT NULL CHECK (
                           architecture IN ('linux/amd64', 'linux/arm64')
                         ),
  cpu_millicores         integer NOT NULL CHECK (cpu_millicores > 0),
  memory_mib             integer NOT NULL CHECK (memory_mib > 0),
  storage_mib            integer NOT NULL CHECK (storage_mib > 0),
  source_commit          text CHECK (
                           source_commit IS NULL
                           OR source_commit ~ '^[a-f0-9]{40,64}$'
                         ),
  created_by             uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  retired_at             timestamptz,
  PRIMARY KEY (workspace_id, generation),
  UNIQUE (workspace_id, generation, org_id),
  FOREIGN KEY (workspace_id, org_id)
    REFERENCES cloud_workspaces(id, org_id) ON DELETE CASCADE
);
CREATE INDEX cloud_workspace_generations_org_idx
  ON cloud_workspace_generations (org_id, workspace_id, generation DESC);

-- The current generation must exist, but creation inserts both rows in one
-- transaction. A deferred key permits that atomic bootstrap without a
-- temporarily nullable compatibility state.
ALTER TABLE cloud_workspaces
  ADD CONSTRAINT cloud_workspaces_current_generation_fkey
  FOREIGN KEY (id, current_generation)
  REFERENCES cloud_workspace_generations(workspace_id, generation)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE cloud_workspace_provider_bindings (
  workspace_id           uuid NOT NULL,
  generation             integer NOT NULL,
  org_id                 uuid NOT NULL,
  provider               text NOT NULL CHECK (
                           provider ~ '^[a-z][a-z0-9_-]{0,63}$'
                         ),
  provider_resource_id   text CHECK (
                           provider_resource_id IS NULL
                           OR char_length(provider_resource_id) BETWEEN 1 AND 512
                         ),
  provider_target        text CHECK (
                           provider_target IS NULL
                           OR char_length(provider_target) BETWEEN 1 AND 255
                         ),
  observed_state         text NOT NULL DEFAULT 'absent' CHECK (
                           char_length(observed_state) BETWEEN 1 AND 64
                         ),
  observed_metadata      jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
                           jsonb_typeof(observed_metadata) = 'object'
                           AND octet_length(observed_metadata::text) <= 65536
                         ),
  last_observed_at       timestamptz,
  deletion_verified_at   timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, generation),
  FOREIGN KEY (workspace_id, generation, org_id)
    REFERENCES cloud_workspace_generations(workspace_id, generation, org_id)
    ON DELETE CASCADE,
  CHECK (
    deletion_verified_at IS NULL
    OR observed_state = 'deleted'
  )
);
CREATE UNIQUE INDEX cloud_workspace_provider_resource_unique
  ON cloud_workspace_provider_bindings (provider, provider_resource_id)
  WHERE provider_resource_id IS NOT NULL;
CREATE INDEX cloud_workspace_provider_observation_idx
  ON cloud_workspace_provider_bindings (provider, last_observed_at)
  WHERE deletion_verified_at IS NULL;

CREATE TABLE cloud_workspace_lifecycle_intents (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id           uuid NOT NULL,
  org_id                 uuid NOT NULL,
  requested_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  operation              cloud_workspace_operation NOT NULL,
  idempotency_key        text NOT NULL CHECK (
                           idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$'
                         ),
  request_sha256         bytea NOT NULL CHECK (octet_length(request_sha256) = 32),
  state                  cloud_workspace_intent_state NOT NULL DEFAULT 'queued',
  attempt_count          integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_owner            text CHECK (
                           lease_owner IS NULL
                           OR char_length(lease_owner) BETWEEN 1 AND 255
                         ),
  lease_expires_at       timestamptz,
  next_attempt_at        timestamptz NOT NULL DEFAULT now(),
  dispatched_at          timestamptz,
  completed_at           timestamptz,
  error_code             text CHECK (
                           error_code IS NULL OR char_length(error_code) <= 128
                         ),
  error_message          text CHECK (
                           error_message IS NULL OR char_length(error_message) <= 2048
                         ),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, idempotency_key),
  FOREIGN KEY (workspace_id, org_id)
    REFERENCES cloud_workspaces(id, org_id) ON DELETE CASCADE,
  CHECK (
    (state IN ('succeeded', 'failed', 'superseded') AND completed_at IS NOT NULL)
    OR (state NOT IN ('succeeded', 'failed', 'superseded') AND completed_at IS NULL)
  )
);
CREATE INDEX cloud_workspace_intents_claim_idx
  ON cloud_workspace_lifecycle_intents (next_attempt_at, created_at, id)
  WHERE state IN ('queued', 'observing') OR
        (state = 'dispatching' AND lease_expires_at IS NOT NULL);
CREATE INDEX cloud_workspace_intents_workspace_idx
  ON cloud_workspace_lifecycle_intents (workspace_id, created_at DESC, id);

CREATE TABLE cloud_workspace_endpoint_grants (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id           uuid NOT NULL,
  generation             integer NOT NULL,
  org_id                 uuid NOT NULL,
  account_user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose                text NOT NULL CHECK (
                           purpose IN ('engine-connect', 'repository-read',
                                       'repository-write', 'setup')
                         ),
  audience               text NOT NULL CHECK (
                           char_length(audience) BETWEEN 1 AND 512
                         ),
  token_hash             bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  expires_at             timestamptz NOT NULL,
  consumed_at            timestamptz,
  revoked_at             timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, generation, org_id)
    REFERENCES cloud_workspace_generations(workspace_id, generation, org_id)
    ON DELETE CASCADE,
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE INDEX cloud_workspace_endpoint_grants_live_idx
  ON cloud_workspace_endpoint_grants (workspace_id, expires_at)
  WHERE revoked_at IS NULL AND consumed_at IS NULL;

CREATE TABLE cloud_workspace_setup_runs (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id           uuid NOT NULL,
  generation             integer NOT NULL,
  org_id                 uuid NOT NULL,
  attempt                integer NOT NULL CHECK (attempt > 0),
  state                  cloud_workspace_setup_state NOT NULL DEFAULT 'queued',
  log_excerpt            text NOT NULL DEFAULT '' CHECK (
                           octet_length(log_excerpt) <= 262144
                         ),
  log_truncated          boolean NOT NULL DEFAULT false,
  error_code             text CHECK (
                           error_code IS NULL OR char_length(error_code) <= 128
                         ),
  started_at             timestamptz,
  completed_at           timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, generation, attempt),
  FOREIGN KEY (workspace_id, generation, org_id)
    REFERENCES cloud_workspace_generations(workspace_id, generation, org_id)
    ON DELETE CASCADE,
  CHECK (
    (state IN ('succeeded', 'failed', 'cancelled') AND completed_at IS NOT NULL)
    OR (state NOT IN ('succeeded', 'failed', 'cancelled') AND completed_at IS NULL)
  )
);

-- Provider resources found through a tightly scoped managed-resource listing
-- must be observed repeatedly across a grace period before an orphan cleanup
-- can delete them. A transient database outage must never trigger immediate
-- destructive cleanup.
CREATE TABLE cloud_workspace_provider_orphans (
  provider               text NOT NULL,
  provider_resource_id   text NOT NULL,
  workspace_id_hint      uuid,
  generation_hint        integer CHECK (generation_hint IS NULL OR generation_hint > 0),
  first_seen_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at           timestamptz NOT NULL DEFAULT now(),
  observation_count      integer NOT NULL DEFAULT 1 CHECK (observation_count > 0),
  delete_attempted_at    timestamptz,
  deletion_verified_at   timestamptz,
  PRIMARY KEY (provider, provider_resource_id),
  CHECK (char_length(provider) BETWEEN 1 AND 64),
  CHECK (char_length(provider_resource_id) BETWEEN 1 AND 512)
);

-- RLS is a second lock beneath route authorization. Background reconciliation
-- uses withSystemTx(), which still runs as zeros_app but binds app.system=on.
ALTER TABLE cloud_workspace_quotas            ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspaces                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_generations        ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_provider_bindings  ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_lifecycle_intents  ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_endpoint_grants    ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_setup_runs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_provider_orphans   ENABLE ROW LEVEL SECURITY;

CREATE POLICY cloud_workspace_quotas_read ON cloud_workspace_quotas
  FOR SELECT
  USING (app_is_system() OR org_id IN (SELECT app_user_org_ids()));
CREATE POLICY cloud_workspace_quotas_system ON cloud_workspace_quotas
  FOR ALL
  USING (app_is_system())
  WITH CHECK (app_is_system());

-- User-context transactions may read tenant rows, but every mutation is routed
-- through an explicitly authorized system transaction. This keeps RLS as a
-- second lock if a future route accidentally issues a raw write.
CREATE POLICY cloud_workspaces_read ON cloud_workspaces
  FOR SELECT
  USING (app_is_system() OR org_id IN (SELECT app_user_org_ids()));
CREATE POLICY cloud_workspaces_system ON cloud_workspaces
  FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());

CREATE POLICY cloud_workspace_generations_read ON cloud_workspace_generations
  FOR SELECT
  USING (app_is_system() OR org_id IN (SELECT app_user_org_ids()));
CREATE POLICY cloud_workspace_generations_system ON cloud_workspace_generations
  FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());

CREATE POLICY cloud_workspace_provider_bindings_read
  ON cloud_workspace_provider_bindings FOR SELECT
  USING (app_is_system() OR org_id IN (SELECT app_user_org_ids()));
CREATE POLICY cloud_workspace_provider_bindings_system
  ON cloud_workspace_provider_bindings FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());

CREATE POLICY cloud_workspace_lifecycle_intents_read
  ON cloud_workspace_lifecycle_intents FOR SELECT
  USING (app_is_system() OR org_id IN (SELECT app_user_org_ids()));
CREATE POLICY cloud_workspace_lifecycle_intents_system
  ON cloud_workspace_lifecycle_intents FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());

-- Grant verifiers are credential material. User-context SQL cannot read or
-- mutate them; issuance, consumption and revocation are system services.
CREATE POLICY cloud_workspace_endpoint_grants_system
  ON cloud_workspace_endpoint_grants FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());

CREATE POLICY cloud_workspace_setup_runs_read ON cloud_workspace_setup_runs
  FOR SELECT
  USING (app_is_system() OR org_id IN (SELECT app_user_org_ids()));
CREATE POLICY cloud_workspace_setup_runs_system ON cloud_workspace_setup_runs
  FOR ALL
  USING (app_is_system())
  WITH CHECK (app_is_system());

CREATE POLICY cloud_workspace_provider_orphans_system
  ON cloud_workspace_provider_orphans
  USING (app_is_system())
  WITH CHECK (app_is_system());

ALTER TABLE cloud_workspace_quotas            FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspaces                   FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_generations        FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_provider_bindings  FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_lifecycle_intents  FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_endpoint_grants    FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_setup_runs         FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_provider_orphans   FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON cloud_workspace_quotas, cloud_workspaces,
     cloud_workspace_generations, cloud_workspace_provider_bindings,
     cloud_workspace_lifecycle_intents, cloud_workspace_endpoint_grants,
     cloud_workspace_setup_runs, cloud_workspace_provider_orphans
  TO zeros_app;

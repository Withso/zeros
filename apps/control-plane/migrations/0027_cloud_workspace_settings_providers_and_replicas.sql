-- ──────────────────────────────────────────────────────────
-- 0027 — immutable settings, provider connections, devices, and fork intents
--
-- Device-private Local settings and absolute paths never enter PostgreSQL.
-- Local→cloud and cloud→local are copies with new workspace UUIDs; neither is
-- represented as an in-place placement mutation.
-- ──────────────────────────────────────────────────────────

CREATE TYPE cloud_settings_scope AS ENUM ('shared', 'cloud');
CREATE TYPE cloud_profile_owner AS ENUM ('user', 'organization');
CREATE TYPE cloud_provider_credential_source AS ENUM ('hosted', 'delegated');

CREATE TABLE repository_settings_versions (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                     uuid NOT NULL,
  repository_id              uuid NOT NULL,
  scope                      cloud_settings_scope NOT NULL,
  version                    bigint NOT NULL CHECK (version > 0),
  schema_version             integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  document                   jsonb NOT NULL CHECK (
                               jsonb_typeof(document) = 'object'
                               AND octet_length(document::text) <= 262144
                             ),
  document_sha256            bytea GENERATED ALWAYS AS (
                               digest(document::text, 'sha256')
                             ) STORED,
  created_by                 uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, repository_id, scope, version),
  UNIQUE (id, org_id),
  FOREIGN KEY (repository_id, org_id)
    REFERENCES repositories(id, org_id) ON DELETE CASCADE,
  CHECK (octet_length(document_sha256) = 32)
);

CREATE TABLE repository_settings_heads (
  org_id                     uuid NOT NULL,
  repository_id              uuid NOT NULL,
  scope                      cloud_settings_scope NOT NULL,
  current_version            bigint NOT NULL CHECK (current_version > 0),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, repository_id, scope),
  FOREIGN KEY (org_id, repository_id, scope, current_version)
    REFERENCES repository_settings_versions(
      org_id, repository_id, scope, version
    ) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE environment_profiles (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                     uuid NOT NULL REFERENCES organizations(id)
                             ON DELETE CASCADE,
  owner_kind                 cloud_profile_owner NOT NULL,
  owner_user_id              uuid REFERENCES users(id) ON DELETE CASCADE,
  name                       text NOT NULL CHECK (
                               char_length(name) BETWEEN 1 AND 120
                             ),
  placement                  text NOT NULL CHECK (
                               placement IN ('local', 'cloud', 'both')
                             ),
  is_default                 boolean NOT NULL DEFAULT false,
  current_version            bigint NOT NULL DEFAULT 1 CHECK (current_version > 0),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  deleted_at                 timestamptz,
  UNIQUE (id, org_id),
  CHECK (
    (owner_kind = 'user' AND owner_user_id IS NOT NULL)
    OR (owner_kind = 'organization' AND owner_user_id IS NULL)
  )
);
CREATE UNIQUE INDEX environment_profiles_live_name_unique
  ON environment_profiles (
    org_id, owner_kind,
    coalesce(owner_user_id, '00000000-0000-0000-0000-000000000000'::uuid),
    lower(name)
  ) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX environment_profiles_one_default_unique
  ON environment_profiles (
    org_id, owner_kind,
    coalesce(owner_user_id, '00000000-0000-0000-0000-000000000000'::uuid),
    placement
  ) WHERE is_default AND deleted_at IS NULL;

CREATE TABLE environment_profile_versions (
  profile_id                 uuid NOT NULL,
  org_id                     uuid NOT NULL,
  version                    bigint NOT NULL CHECK (version > 0),
  schema_version             integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  document                   jsonb NOT NULL CHECK (
                               jsonb_typeof(document) = 'object'
                               AND octet_length(document::text) <= 262144
                             ),
  document_sha256            bytea GENERATED ALWAYS AS (
                               digest(document::text, 'sha256')
                             ) STORED,
  created_by                 uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, version),
  UNIQUE (profile_id, version, org_id),
  FOREIGN KEY (profile_id, org_id)
    REFERENCES environment_profiles(id, org_id) ON DELETE CASCADE
);
ALTER TABLE environment_profiles
  ADD CONSTRAINT environment_profiles_current_version_fkey
  FOREIGN KEY (id, current_version, org_id)
  REFERENCES environment_profile_versions(profile_id, version, org_id)
  DEFERRABLE INITIALLY DEFERRED;

-- Managed policy is strongest and versioned separately so old execution
-- snapshots cannot freeze a permissive policy after an administrator tightens
-- it. The resolver records the applied version but checks the current head.
CREATE TABLE organization_cloud_policy_versions (
  org_id                     uuid NOT NULL REFERENCES organizations(id)
                             ON DELETE CASCADE,
  version                    bigint NOT NULL CHECK (version > 0),
  schema_version             integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  document                   jsonb NOT NULL CHECK (
                               jsonb_typeof(document) = 'object'
                               AND octet_length(document::text) <= 131072
                             ),
  document_sha256            bytea GENERATED ALWAYS AS (
                               digest(document::text, 'sha256')
                             ) STORED,
  created_by                 uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, version)
);
CREATE TABLE organization_cloud_policy_heads (
  org_id                     uuid PRIMARY KEY REFERENCES organizations(id)
                             ON DELETE CASCADE,
  current_version            bigint NOT NULL CHECK (current_version > 0),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, current_version)
    REFERENCES organization_cloud_policy_versions(org_id, version)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE personal_profile_inheritance_consents (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                     uuid NOT NULL REFERENCES organizations(id)
                             ON DELETE CASCADE,
  user_id                    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  personal_profile_id        uuid NOT NULL,
  personal_profile_version   bigint NOT NULL CHECK (personal_profile_version > 0),
  allowed_paths              jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
                               jsonb_typeof(allowed_paths) = 'array'
                               AND octet_length(allowed_paths::text) <= 32768
                             ),
  state                      text NOT NULL DEFAULT 'active' CHECK (
                               state IN ('active', 'revoked', 'expired')
                             ),
  consented_at               timestamptz NOT NULL DEFAULT now(),
  expires_at                 timestamptz,
  revoked_at                 timestamptz,
  UNIQUE (org_id, user_id, personal_profile_id, personal_profile_version),
  FOREIGN KEY (personal_profile_id, personal_profile_version)
    REFERENCES environment_profile_versions(profile_id, version)
    ON DELETE RESTRICT,
  CHECK (expires_at IS NULL OR expires_at > consented_at),
  CHECK (
    (state = 'revoked' AND revoked_at IS NOT NULL)
    OR (state <> 'revoked' AND revoked_at IS NULL)
  )
);

CREATE TABLE secret_bindings (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                     uuid NOT NULL REFERENCES organizations(id)
                             ON DELETE CASCADE,
  owner_kind                 cloud_profile_owner NOT NULL,
  owner_user_id              uuid REFERENCES users(id) ON DELETE CASCADE,
  name                       text NOT NULL CHECK (
                               name ~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$'
                             ),
  purpose                    text NOT NULL CHECK (
                               purpose IN ('environment', 'mcp', 'provider', 'agent')
                             ),
  placement                  text NOT NULL CHECK (
                               placement IN ('local', 'cloud', 'both')
                             ),
  current_version            bigint NOT NULL DEFAULT 1 CHECK (current_version > 0),
  state                      text NOT NULL DEFAULT 'active' CHECK (
                               state IN ('active', 'revoked')
                             ),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  revoked_at                 timestamptz,
  UNIQUE (id, org_id),
  CHECK (
    (owner_kind = 'user' AND owner_user_id IS NOT NULL)
    OR (owner_kind = 'organization' AND owner_user_id IS NULL)
  ),
  CHECK (
    (state = 'revoked' AND revoked_at IS NOT NULL)
    OR (state = 'active' AND revoked_at IS NULL)
  )
);
CREATE UNIQUE INDEX secret_bindings_live_name_unique
  ON secret_bindings (
    org_id, owner_kind,
    coalesce(owner_user_id, '00000000-0000-0000-0000-000000000000'::uuid),
    purpose, name
  ) WHERE state = 'active';

CREATE TABLE secret_binding_versions (
  binding_id                 uuid NOT NULL,
  org_id                     uuid NOT NULL,
  version                    bigint NOT NULL CHECK (version > 0),
  key_version                integer NOT NULL CHECK (key_version > 0),
  nonce                      bytea NOT NULL CHECK (octet_length(nonce) = 12),
  ciphertext                 bytea NOT NULL CHECK (
                               octet_length(ciphertext) BETWEEN 1 AND 1048576
                             ),
  auth_tag                   bytea NOT NULL CHECK (octet_length(auth_tag) = 16),
  value_sha256               bytea NOT NULL CHECK (octet_length(value_sha256) = 32),
  created_by                 uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  retired_at                 timestamptz,
  PRIMARY KEY (binding_id, version),
  UNIQUE (binding_id, version, org_id),
  FOREIGN KEY (binding_id, org_id)
    REFERENCES secret_bindings(id, org_id) ON DELETE CASCADE
);
ALTER TABLE secret_bindings
  ADD CONSTRAINT secret_bindings_current_version_fkey
  FOREIGN KEY (id, current_version, org_id)
  REFERENCES secret_binding_versions(binding_id, version, org_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE provider_connections (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                     uuid NOT NULL REFERENCES organizations(id)
                             ON DELETE CASCADE,
  owner_kind                 cloud_profile_owner NOT NULL,
  owner_user_id              uuid REFERENCES users(id) ON DELETE CASCADE,
  provider                   text NOT NULL CHECK (provider IN ('daytona')),
  display_name               text NOT NULL CHECK (
                               char_length(display_name) BETWEEN 1 AND 120
                             ),
  credential_source          cloud_provider_credential_source NOT NULL,
  current_version            bigint NOT NULL DEFAULT 1 CHECK (current_version > 0),
  state                      text NOT NULL DEFAULT 'active' CHECK (
                               state IN ('active', 'revoked', 'invalid')
                             ),
  capabilities               jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
                               jsonb_typeof(capabilities) = 'object'
                               AND octet_length(capabilities::text) <= 32768
                             ),
  region                     text CHECK (
                               region IS NULL OR char_length(region) BETWEEN 1 AND 128
                             ),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  revoked_at                 timestamptz,
  UNIQUE (id, org_id),
  CHECK (
    (owner_kind = 'user' AND owner_user_id IS NOT NULL)
    OR (owner_kind = 'organization' AND owner_user_id IS NULL)
  ),
  CHECK (
    (state = 'revoked' AND revoked_at IS NOT NULL)
    OR (state <> 'revoked' AND revoked_at IS NULL)
  )
);
CREATE UNIQUE INDEX provider_connections_live_name_unique
  ON provider_connections (
    org_id, owner_kind,
    coalesce(owner_user_id, '00000000-0000-0000-0000-000000000000'::uuid),
    provider,
    lower(display_name)
  ) WHERE state <> 'revoked';

CREATE TABLE provider_connection_versions (
  connection_id              uuid NOT NULL,
  org_id                     uuid NOT NULL,
  version                    bigint NOT NULL CHECK (version > 0),
  credential_source          cloud_provider_credential_source NOT NULL,
  endpoint                   text NOT NULL CHECK (
                               char_length(endpoint) BETWEEN 8 AND 2048
                             ),
  key_version                integer,
  nonce                      bytea,
  ciphertext                 bytea,
  auth_tag                   bytea,
  credential_sha256          bytea,
  created_by                 uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  retired_at                 timestamptz,
  PRIMARY KEY (connection_id, version),
  UNIQUE (connection_id, version, org_id),
  FOREIGN KEY (connection_id, org_id)
    REFERENCES provider_connections(id, org_id) ON DELETE CASCADE,
  CHECK (
    (credential_source = 'hosted'
      AND key_version IS NULL AND nonce IS NULL AND ciphertext IS NULL
      AND auth_tag IS NULL AND credential_sha256 IS NULL)
    OR
    (credential_source = 'delegated'
      AND key_version IS NOT NULL AND key_version > 0
      AND octet_length(nonce) = 12
      AND octet_length(ciphertext) BETWEEN 1 AND 1048576
      AND octet_length(auth_tag) = 16
      AND octet_length(credential_sha256) = 32)
  )
);
ALTER TABLE provider_connections
  ADD CONSTRAINT provider_connections_current_version_fkey
  FOREIGN KEY (id, current_version, org_id)
  REFERENCES provider_connection_versions(connection_id, version, org_id)
  DEFERRABLE INITIALLY DEFERRED;

-- Existing generations used the hosted deployment connection. Materialize an
-- explicit stable identity without persisting the deployment API key.
INSERT INTO provider_connections (
  org_id, owner_kind, owner_user_id, provider, display_name,
  credential_source, current_version, state
)
SELECT DISTINCT generation.org_id,
       CASE WHEN organization.is_personal THEN 'user'::cloud_profile_owner
            ELSE 'organization'::cloud_profile_owner END,
       CASE WHEN organization.is_personal THEN organization.created_by
            ELSE NULL END,
       generation.provider,
       'Hosted ' || initcap(generation.provider),
       'hosted'::cloud_provider_credential_source, 1, 'active'
FROM cloud_workspace_generations generation
JOIN organizations organization ON organization.id = generation.org_id
ON CONFLICT DO NOTHING;

INSERT INTO provider_connection_versions (
  connection_id, org_id, version, credential_source, endpoint
)
SELECT connection.id, connection.org_id, 1,
       'hosted'::cloud_provider_credential_source,
       'hosted://' || connection.provider
FROM provider_connections connection
ON CONFLICT (connection_id, version) DO NOTHING;
-- The current-version edge is deliberately deferred to permit atomic
-- connection+version creation. Drain those trigger events before later ALTER
-- statements in this migration; PostgreSQL otherwise rejects the ALTER even
-- though the rows already satisfy the constraint.
SET CONSTRAINTS provider_connections_current_version_fkey IMMEDIATE;
SET CONSTRAINTS provider_connections_current_version_fkey DEFERRED;

ALTER TABLE cloud_workspace_generations
  ADD COLUMN provider_connection_id uuid,
  ADD COLUMN provider_connection_version bigint;
UPDATE cloud_workspace_generations generation
SET provider_connection_id = connection.id,
    provider_connection_version = connection.current_version
FROM provider_connections connection
WHERE connection.org_id = generation.org_id
  AND connection.provider = generation.provider
  AND connection.credential_source = 'hosted'
  AND connection.state = 'active';

-- A generation is permanently bound to the exact provider credential version
-- that created its remote resource. Rotating a connection must not silently
-- route an existing sandbox into a different provider account or endpoint.
CREATE FUNCTION bind_cloud_workspace_provider_version() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  resolved_version bigint;
BEGIN
  IF NEW.provider_connection_version IS NULL
     OR (TG_OP = 'UPDATE'
         AND NEW.provider_connection_id IS DISTINCT FROM OLD.provider_connection_id
         AND NEW.provider_connection_version IS NOT DISTINCT FROM OLD.provider_connection_version)
  THEN
    SELECT connection.current_version INTO resolved_version
    FROM provider_connections connection
    WHERE connection.id = NEW.provider_connection_id
      AND connection.org_id = NEW.org_id
      AND connection.provider = NEW.provider;
    IF resolved_version IS NULL THEN
      RAISE EXCEPTION 'cloud generation provider connection is invalid'
        USING ERRCODE = '23514';
    END IF;
    NEW.provider_connection_version := resolved_version;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER cloud_workspace_generation_bind_provider_version
  BEFORE INSERT OR UPDATE OF provider_connection_id, provider_connection_version
  ON cloud_workspace_generations
  FOR EACH ROW EXECUTE FUNCTION bind_cloud_workspace_provider_version();
REVOKE ALL ON FUNCTION bind_cloud_workspace_provider_version() FROM PUBLIC;

ALTER TABLE cloud_workspace_generations
  ALTER COLUMN provider_connection_id SET NOT NULL,
  ALTER COLUMN provider_connection_version SET NOT NULL,
  ADD CONSTRAINT cloud_workspace_generation_provider_connection_fkey
  FOREIGN KEY (provider_connection_id, org_id)
  REFERENCES provider_connections(id, org_id) ON DELETE RESTRICT,
  ADD CONSTRAINT cloud_workspace_generation_provider_version_fkey
  FOREIGN KEY (provider_connection_id, provider_connection_version, org_id)
  REFERENCES provider_connection_versions(connection_id, version, org_id)
  ON DELETE RESTRICT;

ALTER TABLE cloud_workspace_provider_bindings
  ADD COLUMN provider_connection_id uuid,
  ADD COLUMN provider_connection_version bigint;
UPDATE cloud_workspace_provider_bindings binding
SET provider_connection_id = generation.provider_connection_id,
    provider_connection_version = generation.provider_connection_version
FROM cloud_workspace_generations generation
WHERE generation.workspace_id = binding.workspace_id
  AND generation.generation = binding.generation
  AND generation.org_id = binding.org_id;

CREATE FUNCTION bind_cloud_workspace_provider_binding() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  SELECT generation.provider_connection_id,
         generation.provider_connection_version,
         generation.provider
  INTO NEW.provider_connection_id,
       NEW.provider_connection_version,
       NEW.provider
  FROM cloud_workspace_generations generation
  WHERE generation.workspace_id = NEW.workspace_id
    AND generation.generation = NEW.generation
    AND generation.org_id = NEW.org_id;
  IF NEW.provider_connection_id IS NULL THEN
    RAISE EXCEPTION 'cloud provider binding generation is invalid'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER cloud_workspace_provider_binding_scope
  BEFORE INSERT OR UPDATE OF workspace_id, generation, org_id
  ON cloud_workspace_provider_bindings
  FOR EACH ROW EXECUTE FUNCTION bind_cloud_workspace_provider_binding();
REVOKE ALL ON FUNCTION bind_cloud_workspace_provider_binding() FROM PUBLIC;

DROP INDEX cloud_workspace_provider_resource_unique;
CREATE UNIQUE INDEX cloud_workspace_provider_resource_unique
  ON cloud_workspace_provider_bindings (
    provider_connection_id, provider_resource_id
  ) WHERE provider_resource_id IS NOT NULL;
ALTER TABLE cloud_workspace_provider_bindings
  ALTER COLUMN provider_connection_id SET NOT NULL,
  ALTER COLUMN provider_connection_version SET NOT NULL,
  ADD CONSTRAINT cloud_workspace_provider_binding_connection_fkey
  FOREIGN KEY (
    provider_connection_id, provider_connection_version, org_id
  ) REFERENCES provider_connection_versions(connection_id, version, org_id)
  ON DELETE RESTRICT;

CREATE TABLE workspace_settings_versions (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id               uuid NOT NULL,
  generation                 integer NOT NULL,
  org_id                     uuid NOT NULL,
  schema_version             integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  effective_document         jsonb NOT NULL CHECK (
                               jsonb_typeof(effective_document) = 'object'
                               AND octet_length(effective_document::text) <= 524288
                             ),
  provenance                 jsonb NOT NULL CHECK (
                               jsonb_typeof(provenance) = 'object'
                               AND octet_length(provenance::text) <= 524288
                             ),
  source_versions            jsonb NOT NULL CHECK (
                               jsonb_typeof(source_versions) = 'object'
                               AND octet_length(source_versions::text) <= 65536
                             ),
  effective_sha256           bytea GENERATED ALWAYS AS (
                               digest(effective_document::text, 'sha256')
                             ) STORED,
  environment_profile_id     uuid,
  environment_profile_version bigint,
  managed_policy_version     bigint,
  created_by                 uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, generation),
  UNIQUE (id, workspace_id, generation, org_id),
  FOREIGN KEY (workspace_id, generation, org_id)
    REFERENCES cloud_workspace_generations(workspace_id, generation, org_id)
    ON DELETE CASCADE,
  FOREIGN KEY (environment_profile_id, environment_profile_version)
    REFERENCES environment_profile_versions(profile_id, version)
    ON DELETE RESTRICT,
  FOREIGN KEY (org_id, managed_policy_version)
    REFERENCES organization_cloud_policy_versions(org_id, version)
    ON DELETE RESTRICT,
  CHECK (
    (environment_profile_id IS NULL) =
    (environment_profile_version IS NULL)
  )
);
ALTER TABLE cloud_workspace_setup_specs
  ADD COLUMN workspace_settings_version_id uuid;
ALTER TABLE cloud_workspace_setup_specs
  ADD CONSTRAINT cloud_workspace_setup_settings_version_fkey
  FOREIGN KEY (
    workspace_settings_version_id, workspace_id, generation, org_id
  ) REFERENCES workspace_settings_versions(id, workspace_id, generation, org_id)
  ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;

-- Backfill the exact immutable snapshots already held by setup specs.
INSERT INTO workspace_settings_versions (
  workspace_id, generation, org_id, schema_version, effective_document,
  provenance, source_versions, created_by
)
SELECT spec.workspace_id, spec.generation, spec.org_id, spec.spec_version,
       spec.settings_snapshot,
       '{}'::jsonb,
       jsonb_build_object('legacySetupSpecVersion', spec.spec_version),
       generation.created_by
FROM cloud_workspace_setup_specs spec
JOIN cloud_workspace_generations generation
  ON generation.workspace_id = spec.workspace_id
 AND generation.generation = spec.generation
 AND generation.org_id = spec.org_id
ON CONFLICT (workspace_id, generation) DO NOTHING;
-- The legacy snapshot is immutable to application code. Temporarily remove
-- its update guard only for this one schema backfill, then restore the exact
-- trigger before the migration commits.
DROP TRIGGER cloud_workspace_setup_specs_immutable
  ON cloud_workspace_setup_specs;
UPDATE cloud_workspace_setup_specs spec
SET workspace_settings_version_id = settings.id
FROM workspace_settings_versions settings
WHERE settings.workspace_id = spec.workspace_id
  AND settings.generation = spec.generation
  AND settings.org_id = spec.org_id;
CREATE TRIGGER cloud_workspace_setup_specs_immutable
  BEFORE UPDATE ON cloud_workspace_setup_specs
  FOR EACH ROW EXECUTE FUNCTION reject_cloud_workspace_setup_spec_update();
SET CONSTRAINTS cloud_workspace_setup_settings_version_fkey IMMEDIATE;
SET CONSTRAINTS cloud_workspace_setup_settings_version_fkey DEFERRED;
ALTER TABLE cloud_workspace_setup_specs
  ALTER COLUMN workspace_settings_version_id SET NOT NULL;

CREATE TABLE devices (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label                      text NOT NULL CHECK (
                               char_length(label) BETWEEN 1 AND 120
                             ),
  platform                   text NOT NULL CHECK (
                               platform IN ('macos', 'windows', 'linux')
                             ),
  public_key                 bytea NOT NULL CHECK (
                               octet_length(public_key) BETWEEN 32 AND 4096
                             ),
  key_fingerprint            bytea NOT NULL UNIQUE CHECK (
                               octet_length(key_fingerprint) = 32
                             ),
  trust_state                text NOT NULL DEFAULT 'trusted' CHECK (
                               trust_state IN ('pending', 'trusted', 'revoked')
                             ),
  key_version                bigint NOT NULL DEFAULT 1 CHECK (key_version > 0),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  last_seen_at               timestamptz,
  revoked_at                 timestamptz,
  UNIQUE (id, user_id),
  CHECK (
    (trust_state = 'revoked' AND revoked_at IS NOT NULL)
    OR (trust_state <> 'revoked' AND revoked_at IS NULL)
  )
);
CREATE INDEX devices_user_idx ON devices(user_id, created_at DESC, id);

CREATE TABLE workspace_replicas (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id               uuid NOT NULL,
  org_id                     uuid NOT NULL,
  user_id                    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id                  uuid NOT NULL,
  mode                       text NOT NULL DEFAULT 'receive_only' CHECK (
                               mode = 'receive_only'
                             ),
  desired_state              text NOT NULL DEFAULT 'active' CHECK (
                               desired_state IN ('active', 'paused', 'removed')
                             ),
  observed_state             text NOT NULL DEFAULT 'pending' CHECK (
                               observed_state IN (
                                 'pending', 'bootstrapping', 'syncing', 'in_sync',
                                 'diverged', 'paused', 'detached', 'failed', 'removed'
                               )
                             ),
  path_label                 text CHECK (
                               path_label IS NULL OR char_length(path_label) <= 120
                             ),
  authority_epoch            bigint NOT NULL CHECK (authority_epoch > 0),
  checkpoint_id              uuid,
  manifest_revision          bigint CHECK (manifest_revision IS NULL OR manifest_revision >= 0),
  event_cursor               bigint NOT NULL DEFAULT 0 CHECK (event_cursor >= 0),
  ignore_policy_sha256       bytea CHECK (
                               ignore_policy_sha256 IS NULL
                               OR octet_length(ignore_policy_sha256) = 32
                             ),
  version                    bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  removed_at                 timestamptz,
  UNIQUE (id, org_id),
  FOREIGN KEY (workspace_id, org_id)
    REFERENCES cloud_workspaces(id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (device_id, user_id)
    REFERENCES devices(id, user_id) ON DELETE CASCADE,
  CHECK (
    (desired_state = 'removed' AND removed_at IS NOT NULL)
    OR (desired_state <> 'removed' AND removed_at IS NULL)
  )
);
CREATE UNIQUE INDEX workspace_replicas_one_live_device_unique
  ON workspace_replicas(workspace_id, user_id, device_id)
  WHERE desired_state <> 'removed';
CREATE INDEX workspace_replicas_device_idx
  ON workspace_replicas(device_id, updated_at DESC, id)
  WHERE desired_state <> 'removed';

CREATE TABLE workspace_replica_events (
  replica_id                 uuid NOT NULL,
  sequence                   bigint GENERATED ALWAYS AS IDENTITY,
  org_id                     uuid NOT NULL,
  event_type                 text NOT NULL CHECK (
                               event_type ~ '^[a-z][a-z0-9_.-]{2,127}$'
                             ),
  metadata                   jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
                               jsonb_typeof(metadata) = 'object'
                               AND octet_length(metadata::text) <= 16384
                             ),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (replica_id, sequence),
  FOREIGN KEY (replica_id, org_id)
    REFERENCES workspace_replicas(id, org_id) ON DELETE CASCADE
);

CREATE TABLE workspace_fork_intents (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                     uuid NOT NULL REFERENCES organizations(id)
                             ON DELETE CASCADE,
  requested_by               uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  operation                  text NOT NULL CHECK (
                               operation IN ('local_to_cloud', 'cloud_to_local')
                             ),
  source_cloud_workspace_id  uuid,
  source_local_workspace_id  uuid,
  target_cloud_workspace_id  uuid,
  target_local_workspace_id  uuid,
  source_revision            bigint NOT NULL CHECK (source_revision >= 0),
  source_checkpoint_id       uuid,
  include_chats              boolean NOT NULL DEFAULT false,
  include_settings           boolean NOT NULL DEFAULT true,
  idempotency_key            text NOT NULL CHECK (
                               char_length(idempotency_key) BETWEEN 8 AND 128
                             ),
  request_sha256             bytea NOT NULL CHECK (octet_length(request_sha256) = 32),
  state                      text NOT NULL DEFAULT 'requested' CHECK (
                               state IN (
                                 'requested', 'exporting', 'ready_to_import',
                                 'importing', 'succeeded', 'failed', 'cancelled'
                               )
                             ),
  lease_owner                text,
  lease_expires_at           timestamptz,
  attempt_count              integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  error_code                 text CHECK (
                               error_code IS NULL OR char_length(error_code) <= 128
                             ),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  completed_at               timestamptz,
  UNIQUE (org_id, requested_by, idempotency_key),
  FOREIGN KEY (source_cloud_workspace_id, org_id)
    REFERENCES cloud_workspaces(id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (target_cloud_workspace_id, org_id)
    REFERENCES cloud_workspaces(id, org_id) ON DELETE RESTRICT,
  CHECK (
    (operation = 'local_to_cloud'
      AND source_local_workspace_id IS NOT NULL
      AND source_cloud_workspace_id IS NULL
      AND target_cloud_workspace_id IS NOT NULL
      AND target_local_workspace_id IS NULL)
    OR
    (operation = 'cloud_to_local'
      AND source_cloud_workspace_id IS NOT NULL
      AND source_local_workspace_id IS NULL
      AND target_cloud_workspace_id IS NULL
      AND target_local_workspace_id IS NOT NULL)
  ),
  CHECK (
    (state IN ('exporting', 'importing')
      AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (state NOT IN ('exporting', 'importing')
      AND lease_owner IS NULL AND lease_expires_at IS NULL)
  ),
  CHECK (
    (state IN ('succeeded', 'failed', 'cancelled') AND completed_at IS NOT NULL)
    OR (state NOT IN ('succeeded', 'failed', 'cancelled') AND completed_at IS NULL)
  )
);
CREATE INDEX workspace_fork_intents_claim_idx
  ON workspace_fork_intents(created_at, id)
  WHERE state IN ('requested', 'ready_to_import', 'exporting', 'importing');

CREATE TABLE workspace_ports (
  workspace_id               uuid NOT NULL,
  generation                 integer NOT NULL,
  org_id                     uuid NOT NULL,
  port                       integer NOT NULL CHECK (port BETWEEN 1024 AND 65535),
  protocol                   text NOT NULL CHECK (protocol IN ('http', 'tcp')),
  process_label              text CHECK (
                               process_label IS NULL OR char_length(process_label) <= 120
                             ),
  health                     text NOT NULL DEFAULT 'observed' CHECK (
                               health IN ('observed', 'healthy', 'unhealthy', 'closed')
                             ),
  observed_at                timestamptz NOT NULL DEFAULT now(),
  closed_at                  timestamptz,
  PRIMARY KEY (workspace_id, generation, port),
  FOREIGN KEY (workspace_id, generation, org_id)
    REFERENCES cloud_workspace_generations(workspace_id, generation, org_id)
    ON DELETE CASCADE
);

ALTER TABLE cloud_workspace_client_access_grants
  ADD CONSTRAINT cloud_workspace_client_access_scope_unique
  UNIQUE (id, workspace_id, generation, org_id);

CREATE TABLE port_forward_sessions (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id               uuid NOT NULL,
  generation                 integer NOT NULL,
  org_id                     uuid NOT NULL,
  user_id                    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id                  uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  access_grant_id            uuid NOT NULL,
  remote_port                integer NOT NULL CHECK (remote_port BETWEEN 1024 AND 65535),
  requested_local_port       integer CHECK (
                               requested_local_port IS NULL
                               OR requested_local_port BETWEEN 1024 AND 65535
                             ),
  observed_local_port        integer CHECK (
                               observed_local_port IS NULL
                               OR observed_local_port BETWEEN 1024 AND 65535
                             ),
  bind_address               inet NOT NULL DEFAULT '127.0.0.1'::inet CHECK (
                               bind_address = '127.0.0.1'::inet
                             ),
  state                      text NOT NULL DEFAULT 'starting' CHECK (
                               state IN ('starting', 'active', 'stopped', 'failed', 'expired')
                             ),
  expires_at                 timestamptz NOT NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  stopped_at                 timestamptz,
  FOREIGN KEY (workspace_id, generation, org_id)
    REFERENCES cloud_workspace_generations(workspace_id, generation, org_id)
    ON DELETE CASCADE,
  FOREIGN KEY (access_grant_id, workspace_id, generation, org_id)
    REFERENCES cloud_workspace_client_access_grants(
      id, workspace_id, generation, org_id
    ) ON DELETE CASCADE,
  CHECK (expires_at > created_at)
);
CREATE INDEX port_forward_sessions_device_live_idx
  ON port_forward_sessions(device_id, created_at DESC, id)
  WHERE state IN ('starting', 'active');

CREATE FUNCTION reject_immutable_cloud_record_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable cloud record cannot be updated or deleted'
    USING ERRCODE = '55000';
END
$$;
CREATE TRIGGER repository_settings_versions_immutable
  BEFORE UPDATE ON repository_settings_versions
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_cloud_record_mutation();
CREATE TRIGGER environment_profile_versions_immutable
  BEFORE UPDATE ON environment_profile_versions
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_cloud_record_mutation();
CREATE TRIGGER organization_cloud_policy_versions_immutable
  BEFORE UPDATE ON organization_cloud_policy_versions
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_cloud_record_mutation();
CREATE TRIGGER workspace_settings_versions_immutable
  BEFORE UPDATE ON workspace_settings_versions
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_cloud_record_mutation();
CREATE TRIGGER workspace_replica_events_immutable
  BEFORE UPDATE ON workspace_replica_events
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_cloud_record_mutation();
REVOKE ALL ON FUNCTION reject_immutable_cloud_record_mutation() FROM PUBLIC;

ALTER TABLE repository_settings_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE repository_settings_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE environment_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE environment_profile_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_cloud_policy_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_cloud_policy_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE personal_profile_inheritance_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE secret_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE secret_binding_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_connection_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_settings_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_replicas ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_replica_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_fork_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_ports ENABLE ROW LEVEL SECURITY;
ALTER TABLE port_forward_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY repository_settings_versions_read ON repository_settings_versions
  FOR SELECT USING (app_is_system() OR org_id IN (SELECT app_user_org_ids()));
CREATE POLICY repository_settings_versions_system ON repository_settings_versions
  FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY repository_settings_heads_read ON repository_settings_heads
  FOR SELECT USING (app_is_system() OR org_id IN (SELECT app_user_org_ids()));
CREATE POLICY repository_settings_heads_system ON repository_settings_heads
  FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY environment_profiles_read ON environment_profiles
  FOR SELECT USING (
    app_is_system() OR (
      org_id IN (SELECT app_user_org_ids())
      AND (owner_kind = 'organization' OR owner_user_id = app_current_user())
    )
  );
CREATE POLICY environment_profiles_system ON environment_profiles
  FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY environment_profile_versions_read ON environment_profile_versions
  FOR SELECT USING (
    app_is_system() OR EXISTS (
      SELECT 1 FROM environment_profiles profile
      WHERE profile.id = profile_id AND profile.org_id = org_id
        AND profile.org_id IN (SELECT app_user_org_ids())
        AND (profile.owner_kind = 'organization'
             OR profile.owner_user_id = app_current_user())
    )
  );
CREATE POLICY environment_profile_versions_system ON environment_profile_versions
  FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY organization_cloud_policy_versions_read
  ON organization_cloud_policy_versions FOR SELECT
  USING (app_is_system() OR org_id IN (SELECT app_user_org_ids()));
CREATE POLICY organization_cloud_policy_versions_system
  ON organization_cloud_policy_versions FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY organization_cloud_policy_heads_read
  ON organization_cloud_policy_heads FOR SELECT
  USING (app_is_system() OR org_id IN (SELECT app_user_org_ids()));
CREATE POLICY organization_cloud_policy_heads_system
  ON organization_cloud_policy_heads FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY personal_profile_consents_read
  ON personal_profile_inheritance_consents FOR SELECT
  USING (
    app_is_system() OR (
      user_id = app_current_user() AND org_id IN (SELECT app_user_org_ids())
    )
  );
CREATE POLICY personal_profile_consents_system
  ON personal_profile_inheritance_consents FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY secret_bindings_metadata_read ON secret_bindings FOR SELECT
  USING (
    app_is_system() OR (
      org_id IN (SELECT app_user_org_ids())
      AND (owner_kind = 'organization' OR owner_user_id = app_current_user())
    )
  );
CREATE POLICY secret_bindings_system ON secret_bindings FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
-- Ciphertext is coordinator-only even for its semantic owner.
CREATE POLICY secret_binding_versions_system ON secret_binding_versions FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY provider_connections_metadata_read ON provider_connections
  FOR SELECT USING (
    app_is_system() OR (
      org_id IN (SELECT app_user_org_ids())
      AND (owner_kind = 'organization' OR owner_user_id = app_current_user())
    )
  );
CREATE POLICY provider_connections_system ON provider_connections FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY provider_connection_versions_system ON provider_connection_versions
  FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY workspace_settings_versions_read ON workspace_settings_versions
  FOR SELECT USING (app_is_system() OR org_id IN (SELECT app_user_org_ids()));
CREATE POLICY workspace_settings_versions_system ON workspace_settings_versions
  FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY devices_owner_read ON devices FOR SELECT
  USING (app_is_system() OR user_id = app_current_user());
CREATE POLICY devices_system ON devices FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY workspace_replicas_owner_read ON workspace_replicas FOR SELECT
  USING (
    app_is_system() OR (
      user_id = app_current_user() AND org_id IN (SELECT app_user_org_ids())
    )
  );
CREATE POLICY workspace_replicas_system ON workspace_replicas FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY workspace_replica_events_owner_read ON workspace_replica_events
  FOR SELECT USING (
    app_is_system() OR EXISTS (
      SELECT 1 FROM workspace_replicas replica
      WHERE replica.id = replica_id AND replica.org_id = org_id
        AND replica.user_id = app_current_user()
    )
  );
CREATE POLICY workspace_replica_events_system ON workspace_replica_events FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY workspace_fork_intents_owner_read ON workspace_fork_intents
  FOR SELECT USING (
    app_is_system() OR (
      requested_by = app_current_user() AND org_id IN (SELECT app_user_org_ids())
    )
  );
CREATE POLICY workspace_fork_intents_system ON workspace_fork_intents FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY workspace_ports_read ON workspace_ports FOR SELECT
  USING (app_is_system() OR org_id IN (SELECT app_user_org_ids()));
CREATE POLICY workspace_ports_system ON workspace_ports FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY port_forward_sessions_owner_read ON port_forward_sessions FOR SELECT
  USING (
    app_is_system() OR (
      user_id = app_current_user() AND org_id IN (SELECT app_user_org_ids())
    )
  );
CREATE POLICY port_forward_sessions_system ON port_forward_sessions FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());

ALTER TABLE repository_settings_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE repository_settings_heads FORCE ROW LEVEL SECURITY;
ALTER TABLE environment_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE environment_profile_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE organization_cloud_policy_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE organization_cloud_policy_heads FORCE ROW LEVEL SECURITY;
ALTER TABLE personal_profile_inheritance_consents FORCE ROW LEVEL SECURITY;
ALTER TABLE secret_bindings FORCE ROW LEVEL SECURITY;
ALTER TABLE secret_binding_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE provider_connections FORCE ROW LEVEL SECURITY;
ALTER TABLE provider_connection_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_settings_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE devices FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_replicas FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_replica_events FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_fork_intents FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_ports FORCE ROW LEVEL SECURITY;
ALTER TABLE port_forward_sessions FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  repository_settings_versions, repository_settings_heads,
  environment_profiles, environment_profile_versions,
  organization_cloud_policy_versions, organization_cloud_policy_heads,
  personal_profile_inheritance_consents, secret_bindings,
  secret_binding_versions, provider_connections,
  provider_connection_versions, workspace_settings_versions, devices,
  workspace_replicas, workspace_replica_events, workspace_fork_intents,
  workspace_ports, port_forward_sessions
TO zeros_app;
GRANT USAGE, SELECT ON SEQUENCE workspace_replica_events_sequence_seq
  TO zeros_app;

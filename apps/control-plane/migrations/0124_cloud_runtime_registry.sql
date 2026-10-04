-- zeros-migration: expand
-- V4 identities coexist with untouched v3 contracts. Alpha's control plane is
-- the internal publication/qualification authority (AB-2). The inherited
-- zeros_app DML grants from 0004 are bounded by system-only RLS and immutable
-- row triggers, rather than by changing grants or introducing a finalizer.

CREATE TABLE cloud_runtime_base_contracts (
  base_compatibility_id text PRIMARY KEY CHECK (base_compatibility_id ~ '^bc1-[a-f0-9]{64}$'),
  contract_sha256 text NOT NULL UNIQUE CHECK (contract_sha256 ~ '^[a-f0-9]{64}$'),
  contract jsonb NOT NULL CHECK (
    jsonb_typeof(contract) = 'object' AND octet_length(contract::text) <= 65536
    AND contract @> '{"schema":"zeros.base-compatibility/v1"}'::jsonb
  ),
  revoked_at timestamptz,
  CHECK (base_compatibility_id = 'bc1-' || contract_sha256)
);

CREATE TABLE cloud_runtime_base_images (
  base_image_id text PRIMARY KEY CHECK (base_image_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  provider text NOT NULL CHECK (provider = 'boat'),
  image_ref text NOT NULL UNIQUE CHECK (length(image_ref) BETWEEN 1 AND 1024 AND image_ref !~ '[[:cntrl:]]'),
  base_compatibility_id text NOT NULL REFERENCES cloud_runtime_base_contracts(base_compatibility_id),
  source_commit text NOT NULL CHECK (source_commit ~ '^[a-f0-9]{40}$'),
  image_build_sha256 text NOT NULL CHECK (image_build_sha256 ~ '^[a-f0-9]{64}$'),
  architecture text NOT NULL CHECK (architecture = 'linux/amd64'),
  storage_mib bigint NOT NULL CHECK (storage_mib BETWEEN 1 AND 2147483647),
  approved_at timestamptz NOT NULL,
  revoked_at timestamptz,
  UNIQUE (base_image_id, base_compatibility_id)
);
CREATE INDEX cloud_runtime_base_images_approved ON cloud_runtime_base_images(approved_at DESC, base_image_id) WHERE revoked_at IS NULL;
CREATE INDEX cloud_runtime_base_images_contract ON cloud_runtime_base_images(base_compatibility_id);

CREATE TABLE cloud_runtime_bundles (
  runtime_id text PRIMARY KEY CHECK (runtime_id ~ '^r1-[a-f0-9]{64}$'),
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  archive_sha256 text NOT NULL CHECK (archive_sha256 ~ '^[a-f0-9]{64}$'),
  archive_bytes bigint NOT NULL CHECK (archive_bytes BETWEEN 1 AND 9007199254740991),
  expanded_bytes bigint NOT NULL CHECK (expanded_bytes BETWEEN 1 AND 9007199254740991),
  object_key text NOT NULL UNIQUE CHECK (length(object_key) BETWEEN 1 AND 1024 AND object_key !~ '[[:cntrl:]]'),
  source_commit text NOT NULL CHECK (source_commit ~ '^[a-f0-9]{40}$'),
  architecture text NOT NULL CHECK (architecture = 'linux/amd64'),
  node_version text NOT NULL CHECK (length(node_version) BETWEEN 1 AND 128 AND node_version ~ '^[0-9]+\.[0-9]+\.[0-9]+([-+][A-Za-z0-9.+-]+)?$'),
  node_modules_abi integer NOT NULL CHECK (node_modules_abi > 0),
  bootstrap_protocol_version integer NOT NULL CHECK (bootstrap_protocol_version = 1),
  setup_protocol_version integer NOT NULL CHECK (setup_protocol_version = 2),
  engine_protocol_version integer NOT NULL CHECK (engine_protocol_version BETWEEN 1 AND 65535),
  manifest_header jsonb NOT NULL CHECK (
    jsonb_typeof(manifest_header) = 'object' AND octet_length(manifest_header::text) <= 65536
    AND manifest_header @> '{"schema":"zeros.runtime-manifest/v1"}'::jsonb
  ),
  registered_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CHECK (runtime_id = 'r1-' || manifest_sha256),
  UNIQUE (runtime_id, manifest_sha256)
);

CREATE TABLE cloud_runtime_channel_releases (
  channel text NOT NULL CHECK (channel IN ('alpha', 'beta', 'production')),
  release_order bigint NOT NULL CHECK (release_order BETWEEN 1 AND 9007199254740991),
  runtime_id text NOT NULL REFERENCES cloud_runtime_bundles(runtime_id),
  github_release_run_id bigint NOT NULL CHECK (github_release_run_id BETWEEN 1 AND 9007199254740991),
  github_release_run_attempt integer NOT NULL CHECK (github_release_run_attempt > 0),
  confirmed_at timestamptz,
  revoked_at timestamptz,
  PRIMARY KEY (channel, release_order)
);
CREATE INDEX cloud_runtime_channel_releases_runtime ON cloud_runtime_channel_releases(runtime_id);

CREATE TABLE cloud_runtime_qualifications (
  runtime_id text NOT NULL REFERENCES cloud_runtime_bundles(runtime_id),
  base_compatibility_id text NOT NULL REFERENCES cloud_runtime_base_contracts(base_compatibility_id),
  credential_kind text NOT NULL CHECK (credential_kind IN (
    'claude-api-key', 'claude-setup-token', 'codex-api-key', 'codex-chatgpt', 'cursor-api-key'
  )),
  profile text NOT NULL CHECK (profile = 'zeros-cloud-worker-v4'),
  enabled boolean NOT NULL DEFAULT false,
  mcp_qualified boolean NOT NULL DEFAULT false,
  native_capabilities jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(native_capabilities) = 'object' AND octet_length(native_capabilities::text) <= 16384
  ),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object' AND octet_length(evidence::text) <= 65536),
  qualified_at timestamptz NOT NULL,
  revoked_at timestamptz,
  PRIMARY KEY (runtime_id, base_compatibility_id, credential_kind, profile),
  CHECK (revoked_at IS NULL OR (NOT enabled AND NOT mcp_qualified))
);
CREATE INDEX cloud_runtime_qualifications_contract ON cloud_runtime_qualifications(base_compatibility_id) WHERE revoked_at IS NULL;

-- Revocation and confirmation are one-way. A qualification can disable its
-- approval bits only while setting/retaining revoked_at; a fresh approval
-- needs a new immutable identity/evidence row. Native capabilities never mutate.
CREATE FUNCTION preserve_cloud_runtime_registry_row() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  mutable_columns text[] := ARRAY['revoked_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'cloud runtime registry rows cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF TG_TABLE_NAME = 'cloud_runtime_channel_releases' THEN
    mutable_columns := ARRAY['revoked_at', 'confirmed_at'];
    IF OLD.confirmed_at IS NOT NULL AND NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at THEN
      RAISE EXCEPTION 'cloud runtime release confirmation is immutable' USING ERRCODE = '55000';
    END IF;
  ELSIF TG_TABLE_NAME = 'cloud_runtime_qualifications' THEN
    mutable_columns := ARRAY['revoked_at', 'enabled', 'mcp_qualified'];
    IF (NOT OLD.enabled AND NEW.enabled) OR (NOT OLD.mcp_qualified AND NEW.mcp_qualified)
       OR ((NEW.enabled IS DISTINCT FROM OLD.enabled OR NEW.mcp_qualified IS DISTINCT FROM OLD.mcp_qualified)
           AND NEW.revoked_at IS NULL) THEN
      RAISE EXCEPTION 'cloud runtime qualification updates may only revoke approval' USING ERRCODE = '55000';
    END IF;
  END IF;
  IF (to_jsonb(NEW) - mutable_columns) IS DISTINCT FROM (to_jsonb(OLD) - mutable_columns) THEN
    RAISE EXCEPTION 'cloud runtime registry identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'cloud runtime revocation is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cloud_runtime_base_contracts_immutable BEFORE UPDATE OR DELETE ON cloud_runtime_base_contracts
  FOR EACH ROW EXECUTE FUNCTION preserve_cloud_runtime_registry_row();
CREATE TRIGGER cloud_runtime_base_images_immutable BEFORE UPDATE OR DELETE ON cloud_runtime_base_images
  FOR EACH ROW EXECUTE FUNCTION preserve_cloud_runtime_registry_row();
CREATE TRIGGER cloud_runtime_bundles_immutable BEFORE UPDATE OR DELETE ON cloud_runtime_bundles
  FOR EACH ROW EXECUTE FUNCTION preserve_cloud_runtime_registry_row();
CREATE TRIGGER cloud_runtime_channel_releases_immutable BEFORE UPDATE OR DELETE ON cloud_runtime_channel_releases
  FOR EACH ROW EXECUTE FUNCTION preserve_cloud_runtime_registry_row();
CREATE TRIGGER cloud_runtime_qualifications_immutable BEFORE UPDATE OR DELETE ON cloud_runtime_qualifications
  FOR EACH ROW EXECUTE FUNCTION preserve_cloud_runtime_registry_row();

ALTER TABLE cloud_runtime_base_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_runtime_base_contracts FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_runtime_base_contracts_system ON cloud_runtime_base_contracts
  FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());
ALTER TABLE cloud_runtime_base_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_runtime_base_images FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_runtime_base_images_system ON cloud_runtime_base_images
  FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());
ALTER TABLE cloud_runtime_bundles ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_runtime_bundles FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_runtime_bundles_system ON cloud_runtime_bundles
  FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());
ALTER TABLE cloud_runtime_channel_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_runtime_channel_releases FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_runtime_channel_releases_system ON cloud_runtime_channel_releases
  FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());
ALTER TABLE cloud_runtime_qualifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_runtime_qualifications FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_runtime_qualifications_system ON cloud_runtime_qualifications
  FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());

ALTER TABLE cloud_workspace_generations
  ADD COLUMN runtime_id text CHECK (runtime_id ~ '^r1-[a-f0-9]{64}$'),
  ADD COLUMN runtime_manifest_sha256 text CHECK (runtime_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  ADD COLUMN runtime_base_image_id text CHECK (runtime_base_image_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  ADD COLUMN runtime_base_compatibility_id text CHECK (runtime_base_compatibility_id ~ '^bc1-[a-f0-9]{64}$'),
  ADD COLUMN runtime_profile text CHECK (runtime_profile = 'zeros-cloud-worker-v4'),
  ADD COLUMN runtime_engine_protocol_version integer CHECK (runtime_engine_protocol_version BETWEEN 1 AND 65535),
  ADD CONSTRAINT cloud_generation_runtime_complete CHECK (num_nonnulls(
    runtime_id, runtime_manifest_sha256, runtime_base_image_id, runtime_base_compatibility_id,
    runtime_profile, runtime_engine_protocol_version
  ) IN (0, 6)),
  ADD CONSTRAINT cloud_generation_runtime_bundle_fkey FOREIGN KEY (runtime_id, runtime_manifest_sha256)
    REFERENCES cloud_runtime_bundles(runtime_id, manifest_sha256),
  ADD CONSTRAINT cloud_generation_runtime_base_fkey FOREIGN KEY (runtime_base_image_id, runtime_base_compatibility_id)
    REFERENCES cloud_runtime_base_images(base_image_id, base_compatibility_id);
CREATE INDEX cloud_generation_runtime_bundle ON cloud_workspace_generations(runtime_id) WHERE runtime_id IS NOT NULL;
CREATE INDEX cloud_generation_runtime_base ON cloud_workspace_generations(runtime_base_image_id, runtime_base_compatibility_id) WHERE runtime_base_image_id IS NOT NULL;

CREATE FUNCTION preserve_cloud_generation_runtime_pin() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(
    NEW.runtime_id, NEW.runtime_manifest_sha256, NEW.runtime_base_image_id, NEW.runtime_base_compatibility_id,
    NEW.runtime_profile, NEW.runtime_engine_protocol_version
  ) IS DISTINCT FROM ROW(
    OLD.runtime_id, OLD.runtime_manifest_sha256, OLD.runtime_base_image_id, OLD.runtime_base_compatibility_id,
    OLD.runtime_profile, OLD.runtime_engine_protocol_version
  ) THEN
    RAISE EXCEPTION 'cloud generation runtime pin is immutable after insert' USING ERRCODE = '55000';
  END IF;
  IF NEW.runtime_id IS NULL THEN
    IF EXISTS (SELECT 1 FROM cloud_runtime_base_images base
      WHERE base.provider = NEW.provider AND base.image_ref = NEW.image_ref) THEN
      RAISE EXCEPTION 'registered v4 bases require a complete runtime pin' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM cloud_runtime_base_images base JOIN cloud_runtime_bundles bundle ON bundle.runtime_id = NEW.runtime_id
    WHERE base.base_image_id = NEW.runtime_base_image_id AND base.base_compatibility_id = NEW.runtime_base_compatibility_id
      AND base.provider = NEW.provider AND base.image_ref = NEW.image_ref AND base.source_commit = NEW.source_commit
      AND base.architecture = NEW.architecture AND base.storage_mib = NEW.storage_mib
      AND bundle.manifest_sha256 = NEW.runtime_manifest_sha256
      AND bundle.engine_protocol_version = NEW.runtime_engine_protocol_version
  ) THEN
    RAISE EXCEPTION 'cloud generation runtime pin does not match its registered base and bundle' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cloud_generation_runtime_pin BEFORE INSERT OR UPDATE ON cloud_workspace_generations
  FOR EACH ROW EXECUTE FUNCTION preserve_cloud_generation_runtime_pin();

ALTER TABLE cloud_workspace_engine_instances
  ADD COLUMN runtime_id text CHECK (runtime_id ~ '^r1-[a-f0-9]{64}$'),
  ADD COLUMN runtime_manifest_sha256 text CHECK (runtime_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  ADD COLUMN runtime_base_image_id text CHECK (runtime_base_image_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  ADD COLUMN runtime_base_compatibility_id text CHECK (runtime_base_compatibility_id ~ '^bc1-[a-f0-9]{64}$'),
  ADD COLUMN runtime_profile text CHECK (runtime_profile = 'zeros-cloud-worker-v4'),
  ADD COLUMN runtime_engine_protocol_version integer CHECK (runtime_engine_protocol_version BETWEEN 1 AND 65535),
  ADD COLUMN runtime_installer_receipt_sha256 text CHECK (runtime_installer_receipt_sha256 ~ '^[a-f0-9]{64}$'),
  ADD COLUMN runtime_boot_id uuid,
  ADD COLUMN runtime_supervisor_session_id uuid,
  ADD CONSTRAINT cloud_engine_runtime_complete CHECK (num_nonnulls(
    runtime_id, runtime_manifest_sha256, runtime_base_image_id, runtime_base_compatibility_id, runtime_profile,
    runtime_engine_protocol_version, runtime_installer_receipt_sha256, runtime_boot_id, runtime_supervisor_session_id
  ) IN (0, 9)),
  ADD CONSTRAINT cloud_engine_runtime_bundle_fkey FOREIGN KEY (runtime_id, runtime_manifest_sha256)
    REFERENCES cloud_runtime_bundles(runtime_id, manifest_sha256),
  ADD CONSTRAINT cloud_engine_runtime_base_fkey FOREIGN KEY (runtime_base_image_id, runtime_base_compatibility_id)
    REFERENCES cloud_runtime_base_images(base_image_id, base_compatibility_id);

CREATE FUNCTION enforce_cloud_engine_runtime_binding() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(
    NEW.runtime_id, NEW.runtime_manifest_sha256, NEW.runtime_base_image_id, NEW.runtime_base_compatibility_id,
    NEW.runtime_profile, NEW.runtime_engine_protocol_version, NEW.runtime_installer_receipt_sha256,
    NEW.runtime_boot_id, NEW.runtime_supervisor_session_id
  ) IS DISTINCT FROM ROW(
    OLD.runtime_id, OLD.runtime_manifest_sha256, OLD.runtime_base_image_id, OLD.runtime_base_compatibility_id,
    OLD.runtime_profile, OLD.runtime_engine_protocol_version, OLD.runtime_installer_receipt_sha256,
    OLD.runtime_boot_id, OLD.runtime_supervisor_session_id
  ) THEN
    RAISE EXCEPTION 'cloud engine runtime identity is immutable after insert' USING ERRCODE = '55000';
  END IF;
  IF NEW.runtime_id IS NOT NULL AND num_nonnulls(NEW.agent_runtime_profile, NEW.agent_runtime_contract_sha256) <> 0 THEN
    RAISE EXCEPTION 'v4 engines cannot claim legacy agent runtime fields' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM cloud_workspace_generations generation
    WHERE generation.workspace_id = NEW.workspace_id AND generation.org_id = NEW.org_id AND generation.generation = NEW.generation
      AND ROW(generation.runtime_id, generation.runtime_manifest_sha256, generation.runtime_base_image_id,
        generation.runtime_base_compatibility_id, generation.runtime_profile, generation.runtime_engine_protocol_version)
        IS NOT DISTINCT FROM ROW(NEW.runtime_id, NEW.runtime_manifest_sha256, NEW.runtime_base_image_id,
        NEW.runtime_base_compatibility_id, NEW.runtime_profile, NEW.runtime_engine_protocol_version)
  ) THEN
    RAISE EXCEPTION 'cloud engine runtime identity does not match its generation' USING ERRCODE = '23514';
  END IF;
  IF NEW.runtime_id IS NOT NULL THEN
    IF NEW.protocol_version IS DISTINCT FROM NEW.runtime_engine_protocol_version THEN
      RAISE EXCEPTION 'v4 engine protocol does not match its runtime pin' USING ERRCODE = '23514';
    END IF;
    -- Existing engine-connect grants deliberately have no setup columns
    -- (0021). The engine's exact setup/fence FK owns that binding. Starting
    -- rows precede grant consumption; INSERT-ready and transitions to ready
    -- require consumption. Later heartbeats/retirement retain their authority
    -- even after the short-lived registration capability expires.
    IF TG_OP = 'INSERT' OR (NEW.state = 'ready' AND (
      OLD.state IS DISTINCT FROM NEW.state
      OR ROW(OLD.registration_grant_id, OLD.workspace_id, OLD.org_id, OLD.generation, OLD.account_user_id,
        OLD.setup_run_id, OLD.setup_execution_fence) IS DISTINCT FROM
        ROW(NEW.registration_grant_id, NEW.workspace_id, NEW.org_id, NEW.generation, NEW.account_user_id,
        NEW.setup_run_id, NEW.setup_execution_fence)
    )) THEN
      IF NOT EXISTS (
        SELECT 1 FROM cloud_workspace_endpoint_grants grant_row
        WHERE grant_row.id = NEW.registration_grant_id AND grant_row.workspace_id = NEW.workspace_id
          AND grant_row.org_id = NEW.org_id AND grant_row.generation = NEW.generation AND grant_row.account_user_id = NEW.account_user_id
          AND grant_row.purpose = 'engine-connect' AND (NEW.state <> 'ready' OR grant_row.consumed_at IS NOT NULL)
          AND grant_row.revoked_at IS NULL AND grant_row.expires_at > now()
      ) THEN
        RAISE EXCEPTION 'v4 engine requires its live registration grant, consumed before ready' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cloud_engine_runtime_binding BEFORE INSERT OR UPDATE ON cloud_workspace_engine_instances
  FOR EACH ROW EXECUTE FUNCTION enforce_cloud_engine_runtime_binding();

ALTER TABLE cloud_workspace_setup_attestations
  ADD COLUMN runtime_id text CHECK (runtime_id ~ '^r1-[a-f0-9]{64}$'),
  ADD COLUMN runtime_manifest_sha256 text CHECK (runtime_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  ADD COLUMN runtime_base_image_id text CHECK (runtime_base_image_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  ADD COLUMN runtime_base_compatibility_id text CHECK (runtime_base_compatibility_id ~ '^bc1-[a-f0-9]{64}$'),
  ADD COLUMN runtime_profile text CHECK (runtime_profile = 'zeros-cloud-worker-v4'),
  ADD COLUMN runtime_engine_protocol_version integer CHECK (runtime_engine_protocol_version BETWEEN 1 AND 65535),
  ADD COLUMN runtime_installer_receipt_sha256 text CHECK (runtime_installer_receipt_sha256 ~ '^[a-f0-9]{64}$'),
  ADD COLUMN runtime_boot_id uuid,
  ADD COLUMN runtime_supervisor_session_id uuid,
  ADD CONSTRAINT cloud_attestation_runtime_complete CHECK (num_nonnulls(
    runtime_id, runtime_manifest_sha256, runtime_base_image_id, runtime_base_compatibility_id, runtime_profile,
    runtime_engine_protocol_version, runtime_installer_receipt_sha256, runtime_boot_id, runtime_supervisor_session_id
  ) IN (0, 9)),
  ADD CONSTRAINT cloud_attestation_runtime_bundle_fkey FOREIGN KEY (runtime_id, runtime_manifest_sha256)
    REFERENCES cloud_runtime_bundles(runtime_id, manifest_sha256),
  ADD CONSTRAINT cloud_attestation_runtime_base_fkey FOREIGN KEY (runtime_base_image_id, runtime_base_compatibility_id)
    REFERENCES cloud_runtime_base_images(base_image_id, base_compatibility_id);

-- 0021 already rejects every attestation UPDATE. This additive INSERT guard
-- retains 0021/0022's live setup/engine checks and binds the v4 installation
-- witness to that exact engine and setup fence. Legacy attestations have no
-- agent-runtime columns; a v4 attestation's linked engine must leave them NULL.
CREATE FUNCTION enforce_cloud_attestation_runtime_binding() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM cloud_workspace_engine_instances engine
    WHERE engine.id = NEW.engine_instance_id AND engine.workspace_id = NEW.workspace_id AND engine.org_id = NEW.org_id
      AND engine.generation = NEW.generation AND engine.setup_run_id = NEW.setup_run_id AND engine.setup_execution_fence = NEW.execution_fence
      AND ROW(engine.runtime_id, engine.runtime_manifest_sha256, engine.runtime_base_image_id,
        engine.runtime_base_compatibility_id, engine.runtime_profile, engine.runtime_engine_protocol_version,
        engine.runtime_installer_receipt_sha256, engine.runtime_boot_id, engine.runtime_supervisor_session_id)
        IS NOT DISTINCT FROM ROW(NEW.runtime_id, NEW.runtime_manifest_sha256, NEW.runtime_base_image_id,
        NEW.runtime_base_compatibility_id, NEW.runtime_profile, NEW.runtime_engine_protocol_version,
        NEW.runtime_installer_receipt_sha256, NEW.runtime_boot_id, NEW.runtime_supervisor_session_id)
      AND (NEW.runtime_id IS NULL OR num_nonnulls(engine.agent_runtime_profile, engine.agent_runtime_contract_sha256) = 0)
  ) THEN
    RAISE EXCEPTION 'cloud setup runtime attestation does not match its exact engine witness' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cloud_workspace_setup_attestations_runtime_binding BEFORE INSERT ON cloud_workspace_setup_attestations
  FOR EACH ROW EXECUTE FUNCTION enforce_cloud_attestation_runtime_binding();

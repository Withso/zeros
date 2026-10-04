-- zeros-migration: expand
-- V2 recipes and requests are separate from the legacy named-image worker.
-- Runtime/base registry foreign keys are deliberately deferred to C3.
CREATE TABLE cloud_computer_v2_configs (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES cloud_computers(org_id) ON DELETE RESTRICT,
  install_script text NOT NULL CHECK(octet_length(install_script)<=16384),
  timeout_seconds integer NOT NULL CHECK(timeout_seconds BETWEEN 1 AND 900),
  metadata_digest bytea NOT NULL CHECK(octet_length(metadata_digest)=32),
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,org_id)
);
CREATE TABLE cloud_computer_v2_config_repositories (
  config_id uuid NOT NULL,
  org_id uuid NOT NULL,
  position integer NOT NULL CHECK(position BETWEEN 0 AND 19),
  -- GitHub's canonical numeric repository identity, as in source proofs.
  repository_id text NOT NULL CHECK(repository_id ~ '^[1-9][0-9]{0,39}$'),
  repository_owner text NOT NULL CHECK(repository_owner ~ '^[a-z0-9_.-]{1,100}$'),
  repository_name text NOT NULL CHECK(repository_name ~ '^[a-z0-9_.-]{1,100}$'),
  -- Historical recipes survive disconnection of the approving installation.
  installation_id uuid NOT NULL,
  requested_ref text CHECK(length(requested_ref) BETWEEN 1 AND 512),
  PRIMARY KEY(config_id,position),
  UNIQUE(config_id,repository_id),
  UNIQUE(config_id,repository_owner,repository_name),
  FOREIGN KEY(config_id,org_id) REFERENCES cloud_computer_v2_configs(id,org_id) ON DELETE RESTRICT
);
CREATE TABLE cloud_computer_environment_refs (
  config_id uuid NOT NULL,
  org_id uuid NOT NULL,
  name text NOT NULL CHECK(name ~ '^[A-Z_][A-Z0-9_]{0,127}$'),
  binding_id uuid NOT NULL,
  binding_version bigint NOT NULL CHECK(binding_version>0),
  PRIMARY KEY(config_id,name),
  FOREIGN KEY(config_id,org_id) REFERENCES cloud_computer_v2_configs(id,org_id) ON DELETE RESTRICT,
  FOREIGN KEY(binding_id,binding_version,org_id)
    REFERENCES secret_binding_versions(binding_id,version,org_id) ON DELETE RESTRICT
);
CREATE INDEX cloud_computer_environment_binding_refs
  ON cloud_computer_environment_refs(binding_id,binding_version);

CREATE TABLE cloud_computer_v2_heads (
  org_id uuid PRIMARY KEY REFERENCES cloud_computers(org_id) ON DELETE RESTRICT,
  revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
  next_version bigint NOT NULL DEFAULT 1 CHECK(next_version>0),
  draft_config_id uuid,
  active_build_id uuid,
  previous_build_id uuid,
  latest_build_id uuid,
  enabled_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(draft_config_id,org_id) REFERENCES cloud_computer_v2_configs(id,org_id)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE cloud_computer_v2_builds (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES cloud_computer_v2_heads(org_id) ON DELETE RESTRICT,
  version bigint NOT NULL CHECK(version>0),
  config_id uuid NOT NULL,
  accepted_revision bigint NOT NULL CHECK(accepted_revision>0),
  state text NOT NULL DEFAULT 'queued'
    CHECK(state IN ('queued','running','succeeded','failed','cancelled','superseded')),
  stage text NOT NULL DEFAULT 'queued'
    CHECK(stage IN ('queued','allocating','runtime','repositories','install','integrity','sanitation','stopping','capture_confirmed','done')),
  error_code text CHECK(error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  requested_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  operation_id uuid NOT NULL,
  rebuilt_from_build_id uuid,
  base_image_id text CHECK(length(base_image_id) BETWEEN 1 AND 512),
  runtime_id text CHECK(length(runtime_id) BETWEEN 1 AND 512),
  repository_manifest jsonb CHECK(repository_manifest IS NULL OR
    (jsonb_typeof(repository_manifest)='array' AND jsonb_array_length(repository_manifest)<=20
      AND octet_length(repository_manifest::text)<=32768)),
  worker_fence bigint NOT NULL DEFAULT 0 CHECK(worker_fence>=0),
  deadline_at timestamptz,
  cancel_requested_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  UNIQUE(org_id,version),
  UNIQUE(org_id,operation_id),
  UNIQUE(id,org_id),
  UNIQUE(id,config_id,org_id),
  FOREIGN KEY(config_id,org_id) REFERENCES cloud_computer_v2_configs(id,org_id) ON DELETE RESTRICT,
  FOREIGN KEY(rebuilt_from_build_id,org_id) REFERENCES cloud_computer_v2_builds(id,org_id) ON DELETE RESTRICT,
  CHECK((state IN ('queued','running')) = (completed_at IS NULL))
);
CREATE UNIQUE INDEX cloud_computer_v2_one_pending
  ON cloud_computer_v2_builds(org_id) WHERE state IN ('queued','running');
CREATE INDEX cloud_computer_v2_build_queue
  ON cloud_computer_v2_builds(created_at,id) WHERE state='queued';
ALTER TABLE cloud_computer_v2_heads
  ADD CONSTRAINT cloud_computer_v2_active_build FOREIGN KEY(active_build_id,org_id)
    REFERENCES cloud_computer_v2_builds(id,org_id) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT cloud_computer_v2_previous_build FOREIGN KEY(previous_build_id,org_id)
    REFERENCES cloud_computer_v2_builds(id,org_id) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT cloud_computer_v2_latest_build FOREIGN KEY(latest_build_id,org_id)
    REFERENCES cloud_computer_v2_builds(id,org_id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE cloud_computer_templates (
  build_id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'pending'
    CHECK(state IN ('pending','ready','retiring','retired','quarantined')),
  provider_resource_id text CHECK(length(provider_resource_id) BETWEEN 1 AND 512),
  account_scope text CHECK(length(account_scope) BETWEEN 1 AND 512),
  billing_org text CHECK(length(billing_org) BETWEEN 1 AND 512),
  protected_contract_digest bytea CHECK(octet_length(protected_contract_digest)=32),
  stopped_at timestamptz,
  retired_at timestamptz,
  UNIQUE(build_id,org_id),
  UNIQUE(account_scope,provider_resource_id),
  FOREIGN KEY(build_id,org_id) REFERENCES cloud_computer_v2_builds(id,org_id) ON DELETE RESTRICT,
  CHECK(state<>'ready' OR (stopped_at IS NOT NULL AND protected_contract_digest IS NOT NULL)),
  CHECK(state<>'retired' OR retired_at IS NOT NULL)
);
CREATE TABLE cloud_computer_build_logs (
  build_id uuid NOT NULL,
  org_id uuid NOT NULL,
  seq bigint NOT NULL CHECK(seq>0),
  stream text NOT NULL CHECK(stream IN ('stdout','stderr','system')),
  stage text NOT NULL,
  text text NOT NULL CHECK(octet_length(text)<=8192),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(build_id,seq),
  FOREIGN KEY(build_id,org_id) REFERENCES cloud_computer_v2_builds(id,org_id) ON DELETE RESTRICT
);
CREATE TABLE cloud_workspace_computer_sources (
  workspace_id uuid NOT NULL,
  generation integer NOT NULL CHECK(generation>0),
  org_id uuid NOT NULL,
  build_id uuid NOT NULL,
  template_id uuid NOT NULL,
  config_id uuid NOT NULL,
  PRIMARY KEY(workspace_id,generation),
  CHECK(build_id=template_id),
  FOREIGN KEY(workspace_id,generation,org_id)
    REFERENCES cloud_workspace_generations(workspace_id,generation,org_id) ON DELETE RESTRICT,
  FOREIGN KEY(build_id,config_id,org_id)
    REFERENCES cloud_computer_v2_builds(id,config_id,org_id) ON DELETE RESTRICT,
  FOREIGN KEY(template_id,org_id) REFERENCES cloud_computer_templates(build_id,org_id) ON DELETE RESTRICT
);
CREATE INDEX cloud_workspace_computer_template_refs ON cloud_workspace_computer_sources(template_id);

-- Activation also needs a durable receipt across intervening edits. Build and
-- Rebuild share this operation namespace; secret-bearing requests use a keyed
-- verifier, never a persisted plaintext request or a public value hash.
CREATE TABLE cloud_computer_v2_operations (
  org_id uuid NOT NULL REFERENCES cloud_computer_v2_heads(org_id) ON DELETE RESTRICT,
  operation_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('build','rebuild','activate')),
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  request_sha256 bytea NOT NULL CHECK(octet_length(request_sha256)=32),
  key_version integer CHECK(key_version>0),
  build_id uuid NOT NULL,
  revision bigint NOT NULL CHECK(revision>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(org_id,operation_id),
  FOREIGN KEY(build_id,org_id) REFERENCES cloud_computer_v2_builds(id,org_id) ON DELETE RESTRICT
);

-- Final erasure is the sole exception to immutable-row deletion. The worker
-- sets transaction-local context after locking and checking its durable lease.
-- A system flag alone, or a context from another org/expired worker, cannot
-- authorize deletion; updates remain forbidden even during final erasure.
CREATE FUNCTION cloud_computer_v2_purge_allowed(p_org_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app_is_system() AND EXISTS (
    SELECT 1 FROM organizations organization
    JOIN deletion_requests request ON request.id=organization.deletion_request_id
    WHERE organization.id=p_org_id AND organization.lifecycle_status='purging'
      AND request.target_kind='organization' AND request.target_organization_id=p_org_id
      AND request.state='provider_deleting' AND request.lease_expires_at>clock_timestamp()
      AND request.id::text=current_setting('app.cloud_computer_v2_purge_request_id',true)
      AND request.lease_owner=current_setting('app.cloud_computer_v2_purge_worker_id',true)
      AND request.lease_revision::text=current_setting('app.cloud_computer_v2_purge_lease_revision',true)
  );
$$;
CREATE FUNCTION cloud_computer_v2_config_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND cloud_computer_v2_purge_allowed(OLD.org_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Cloud Computer configuration is immutable' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER cloud_computer_v2_config_immutable BEFORE UPDATE OR DELETE ON cloud_computer_v2_configs
  FOR EACH ROW EXECUTE FUNCTION cloud_computer_v2_config_immutable();
CREATE TRIGGER cloud_computer_v2_repository_immutable BEFORE UPDATE OR DELETE ON cloud_computer_v2_config_repositories
  FOR EACH ROW EXECUTE FUNCTION cloud_computer_v2_config_immutable();
CREATE TRIGGER cloud_computer_v2_environment_immutable BEFORE UPDATE OR DELETE ON cloud_computer_environment_refs
  FOR EACH ROW EXECUTE FUNCTION cloud_computer_v2_config_immutable();
CREATE TRIGGER cloud_computer_v2_operation_immutable BEFORE UPDATE OR DELETE ON cloud_computer_v2_operations
  FOR EACH ROW EXECUTE FUNCTION cloud_computer_v2_config_immutable();
CREATE TRIGGER cloud_computer_v2_source_immutable BEFORE UPDATE OR DELETE ON cloud_workspace_computer_sources
  FOR EACH ROW EXECUTE FUNCTION cloud_computer_v2_config_immutable();
-- Default privileges grant all DML to zeros_app. These guards enforce the
-- narrower verbs advertised below without revoking inherited privileges.
CREATE TRIGGER cloud_computer_v2_head_delete_guard BEFORE DELETE ON cloud_computer_v2_heads
  FOR EACH ROW EXECUTE FUNCTION cloud_computer_v2_config_immutable();
CREATE TRIGGER cloud_computer_v2_build_delete_guard BEFORE DELETE ON cloud_computer_v2_builds
  FOR EACH ROW EXECUTE FUNCTION cloud_computer_v2_config_immutable();
CREATE TRIGGER cloud_computer_v2_template_delete_guard BEFORE DELETE ON cloud_computer_templates
  FOR EACH ROW EXECUTE FUNCTION cloud_computer_v2_config_immutable();
CREATE TRIGGER cloud_computer_v2_log_update_guard BEFORE UPDATE ON cloud_computer_build_logs
  FOR EACH ROW EXECUTE FUNCTION cloud_computer_v2_config_immutable();

-- Children are authored in the same transaction as their immutable parent.
-- xmin is the parent's inserting xid; reduce the full xid to its 32-bit value
-- so this check continues working after PostgreSQL transaction-ID wraparound.
CREATE FUNCTION cloud_computer_v2_config_child_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_xid bigint;
BEGIN
  SELECT xmin::text::bigint INTO parent_xid FROM cloud_computer_v2_configs
    WHERE id=NEW.config_id AND org_id=NEW.org_id FOR SHARE;
  IF parent_xid IS DISTINCT FROM (pg_current_xact_id()::text::numeric % 4294967296)::bigint THEN
    RAISE EXCEPTION 'Cloud Computer configuration is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cloud_computer_v2_repository_insert_guard BEFORE INSERT ON cloud_computer_v2_config_repositories
  FOR EACH ROW EXECUTE FUNCTION cloud_computer_v2_config_child_guard();
CREATE TRIGGER cloud_computer_v2_environment_insert_guard BEFORE INSERT ON cloud_computer_environment_refs
  FOR EACH ROW EXECUTE FUNCTION cloud_computer_v2_config_child_guard();

CREATE FUNCTION cloud_computer_v2_build_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.org_id,NEW.version,NEW.config_id,NEW.accepted_revision,NEW.requested_by,
      NEW.operation_id,NEW.rebuilt_from_build_id,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.org_id,OLD.version,OLD.config_id,OLD.accepted_revision,OLD.requested_by,
      OLD.operation_id,OLD.rebuilt_from_build_id,OLD.created_at)
    OR (OLD.base_image_id IS NOT NULL AND NEW.base_image_id IS DISTINCT FROM OLD.base_image_id)
    OR (OLD.runtime_id IS NOT NULL AND NEW.runtime_id IS DISTINCT FROM OLD.runtime_id)
    OR (OLD.repository_manifest IS NOT NULL AND NEW.repository_manifest IS DISTINCT FROM OLD.repository_manifest)
    OR (OLD.cancel_requested_at IS NOT NULL AND NEW.cancel_requested_at IS DISTINCT FROM OLD.cancel_requested_at)
    OR NEW.worker_fence<OLD.worker_fence
    OR (OLD.state NOT IN ('queued','running') AND NEW.state IS DISTINCT FROM OLD.state) THEN
    RAISE EXCEPTION 'Cloud Computer accepted build identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cloud_computer_v2_build_identity_guard BEFORE UPDATE ON cloud_computer_v2_builds
  FOR EACH ROW EXECUTE FUNCTION cloud_computer_v2_build_identity_guard();

-- Add guards without rewriting the historical 0108/0117 definitions. An old
-- API writer serializes with enrollment, so it cannot insert a legacy build
-- after the new head has been published. Existing legacy cleanup may finish.
CREATE FUNCTION cloud_computer_v2_fence_legacy_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.org_id::text,62171));
  IF EXISTS(SELECT 1 FROM cloud_computer_v2_heads WHERE org_id=NEW.org_id) THEN
    RAISE EXCEPTION 'cloud_computer_v2_enabled' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cloud_computer_v2_legacy_computer_guard BEFORE UPDATE ON cloud_computers
  FOR EACH ROW EXECUTE FUNCTION cloud_computer_v2_fence_legacy_write();
CREATE TRIGGER cloud_computer_v2_legacy_build_guard BEFORE INSERT ON cloud_computer_builds
  FOR EACH ROW EXECUTE FUNCTION cloud_computer_v2_fence_legacy_write();
CREATE FUNCTION cloud_computer_v2_enable_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.org_id::text,62171));
  IF EXISTS(SELECT 1 FROM cloud_computer_builds WHERE org_id=NEW.org_id AND state='building') THEN
    RAISE EXCEPTION 'Legacy Cloud Computer build is still running' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cloud_computer_v2_enable_guard BEFORE INSERT ON cloud_computer_v2_heads
  FOR EACH ROW EXECUTE FUNCTION cloud_computer_v2_enable_guard();

ALTER TABLE cloud_computer_v2_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_computer_v2_configs FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_computer_v2_configs_system ON cloud_computer_v2_configs
  FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
ALTER TABLE cloud_computer_v2_config_repositories ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_computer_v2_config_repositories FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_computer_v2_repositories_system ON cloud_computer_v2_config_repositories
  FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
ALTER TABLE cloud_computer_environment_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_computer_environment_refs FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_computer_environment_refs_system ON cloud_computer_environment_refs
  FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
ALTER TABLE cloud_computer_v2_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_computer_v2_heads FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_computer_v2_heads_system ON cloud_computer_v2_heads
  FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
ALTER TABLE cloud_computer_v2_builds ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_computer_v2_builds FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_computer_v2_builds_system ON cloud_computer_v2_builds
  FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
ALTER TABLE cloud_computer_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_computer_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_computer_templates_system ON cloud_computer_templates
  FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
ALTER TABLE cloud_computer_build_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_computer_build_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_computer_build_logs_system ON cloud_computer_build_logs
  FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
ALTER TABLE cloud_workspace_computer_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_computer_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_workspace_computer_sources_system ON cloud_workspace_computer_sources
  FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
ALTER TABLE cloud_computer_v2_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_computer_v2_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_computer_v2_operations_system ON cloud_computer_v2_operations
  FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
GRANT SELECT,INSERT ON cloud_computer_v2_configs,cloud_computer_v2_config_repositories,
  cloud_computer_environment_refs,cloud_workspace_computer_sources,cloud_computer_v2_operations TO zeros_app;
GRANT SELECT,INSERT,UPDATE ON cloud_computer_v2_heads,cloud_computer_v2_builds,cloud_computer_templates TO zeros_app;
GRANT SELECT,INSERT,DELETE ON cloud_computer_build_logs TO zeros_app;
GRANT EXECUTE ON FUNCTION cloud_computer_v2_purge_allowed(uuid) TO zeros_app;

-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- An explicit exception to sealed-predecessor custody, never a bearer or an
-- assertion of complete history. Only the authenticated new engine can use it.
CREATE TABLE cloud_agent_history_recoveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  org_id uuid NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  engine_instance_id uuid NOT NULL UNIQUE,
  boot_id uuid NOT NULL,
  funding_owner_user_id uuid NOT NULL REFERENCES users(id),
  funding_owner_epoch bigint NOT NULL CHECK (funding_owner_epoch BETWEEN 1 AND 9007199254740991),
  predecessor_binding_id uuid NOT NULL,
  predecessor_writer_epoch uuid NOT NULL,
  predecessor_retired_at timestamptz NOT NULL,
  ancestor_writer_epoch uuid NOT NULL,
  ancestor_seal_sha256 text NOT NULL CHECK (ancestor_seal_sha256 ~ '^[a-f0-9]{64}$'),
  mirrored_sequence bigint NOT NULL CHECK (mirrored_sequence BETWEEN 0 AND 9007199254740991),
  prepared_custody jsonb NOT NULL DEFAULT '[]'::jsonb CHECK
    (jsonb_typeof(prepared_custody)='array' AND jsonb_array_length(prepared_custody)<=2),
  coverage text NOT NULL DEFAULT 'unknown' CHECK (coverage = 'unknown'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  successor_writer_epoch uuid,
  activated_at timestamptz,
  custody_sha256 text CHECK (custody_sha256 ~ '^[a-f0-9]{64}$'),
  FOREIGN KEY (workspace_id,org_id) REFERENCES cloud_workspaces(id,org_id) ON DELETE CASCADE,
  FOREIGN KEY (engine_instance_id,workspace_id,generation,org_id)
    REFERENCES cloud_workspace_engine_instances(id,workspace_id,generation,org_id) ON DELETE CASCADE,
  FOREIGN KEY (predecessor_binding_id,workspace_id,org_id)
    REFERENCES cloud_agent_boot_bindings(id,workspace_id,org_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id,predecessor_writer_epoch,org_id)
    REFERENCES cloud_workspace_local_command_writers(workspace_id,writer_epoch,org_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id,ancestor_writer_epoch,org_id)
    REFERENCES cloud_workspace_local_command_writers(workspace_id,writer_epoch,org_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id,successor_writer_epoch,org_id)
    REFERENCES cloud_workspace_local_command_writers(workspace_id,writer_epoch,org_id) ON DELETE CASCADE,
  CHECK (predecessor_writer_epoch <> ancestor_writer_epoch),
  CHECK (num_nonnulls(successor_writer_epoch,activated_at,custody_sha256) IN (0,3))
);
CREATE INDEX cloud_agent_history_recoveries_visible ON cloud_agent_history_recoveries(workspace_id,activated_at DESC,id)
  WHERE activated_at IS NOT NULL;
CREATE UNIQUE INDEX cloud_agent_history_recoveries_successor ON cloud_agent_history_recoveries(workspace_id,successor_writer_epoch)
  WHERE activated_at IS NOT NULL;

CREATE FUNCTION preserve_cloud_agent_history_recovery() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE custody jsonb;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.activated_at IS NOT NULL OR NEW.successor_writer_epoch IS NOT NULL OR NEW.custody_sha256 IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM cloud_workspaces workspace
      JOIN cloud_workspace_engine_instances target ON target.workspace_id=workspace.id AND target.org_id=workspace.org_id
      JOIN cloud_agent_boot_bindings source ON source.id=workspace.agent_boot_id
        AND source.workspace_id=workspace.id AND source.org_id=workspace.org_id
      JOIN cloud_workspace_local_command_writers predecessor ON predecessor.workspace_id=source.workspace_id
        AND predecessor.org_id=source.org_id AND predecessor.writer_epoch=source.writer_epoch
      JOIN cloud_workspace_engine_instances source_engine ON source_engine.id=source.engine_instance_id
      JOIN cloud_workspace_local_command_writers ancestor ON ancestor.workspace_id=workspace.id AND ancestor.org_id=workspace.org_id
      JOIN cloud_workspace_engine_instances ancestor_engine ON ancestor_engine.id=ancestor.engine_instance_id
      WHERE workspace.id=NEW.workspace_id AND workspace.org_id=NEW.org_id
        AND workspace.agent_command_mode='boot-owner-v1' AND workspace.deleted_at IS NULL
        AND workspace.current_generation=NEW.generation AND workspace.desired_state='running'
        AND workspace.owner_user_id=NEW.funding_owner_user_id AND workspace.agent_funding_owner_epoch=NEW.funding_owner_epoch
        AND target.id=NEW.engine_instance_id AND target.generation=NEW.generation AND target.runtime_boot_id=NEW.boot_id
        AND target.cloud_local_commands_version=1 AND target.state='ready' AND target.revoked_at IS NULL
        AND target.lease_expires_at>clock_timestamp() AND target.enrollment_order>source_engine.enrollment_order
        AND source.id=NEW.predecessor_binding_id AND source.retired_at IS NOT NULL
        AND source.generation<=NEW.generation AND source.credentials_initialized
        AND predecessor.writer_epoch=NEW.predecessor_writer_epoch AND predecessor.state='retired'
        AND predecessor.retired_at=NEW.predecessor_retired_at AND predecessor.seal IS NULL
        AND predecessor.mirrored_sequence=NEW.mirrored_sequence
        AND ancestor.writer_epoch=NEW.ancestor_writer_epoch AND ancestor.state='retired'
        AND ancestor.seal_ack IS NOT NULL AND ancestor.seal->>'sha256'=NEW.ancestor_seal_sha256
        AND ancestor.generation<=predecessor.generation
        AND ancestor.retired_at<=predecessor.activated_at
        AND ancestor_engine.enrollment_order<source_engine.enrollment_order
    ) THEN
      RAISE EXCEPTION 'recovery requires exact retired unsealed source and current target' USING ERRCODE='23514';
    END IF;
    FOR custody IN SELECT value FROM jsonb_array_elements(NEW.prepared_custody) LOOP
      IF NOT EXISTS (
        SELECT 1 FROM cloud_agent_history_recoveries prepared
        JOIN cloud_agent_boot_bindings binding ON binding.engine_instance_id=prepared.engine_instance_id
          AND binding.workspace_id=prepared.workspace_id AND binding.org_id=prepared.org_id
        JOIN cloud_workspace_local_command_writers writer ON writer.workspace_id=binding.workspace_id
          AND writer.org_id=binding.org_id AND writer.writer_epoch=binding.writer_epoch
        JOIN cloud_workspace_engine_instances prepared_engine ON prepared_engine.id=prepared.engine_instance_id
        JOIN cloud_workspace_engine_instances target ON target.id=NEW.engine_instance_id
        WHERE prepared.id=(custody->>'recoveryId')::uuid AND prepared.activated_at IS NULL
          AND prepared.workspace_id=NEW.workspace_id AND prepared.org_id=NEW.org_id
          AND prepared.predecessor_binding_id=NEW.predecessor_binding_id
          AND prepared.predecessor_writer_epoch=NEW.predecessor_writer_epoch
          AND prepared.predecessor_retired_at=NEW.predecessor_retired_at
          AND prepared.ancestor_writer_epoch=NEW.ancestor_writer_epoch AND prepared.ancestor_seal_sha256=NEW.ancestor_seal_sha256
          AND prepared.mirrored_sequence=NEW.mirrored_sequence
          AND prepared.funding_owner_user_id=NEW.funding_owner_user_id AND prepared.funding_owner_epoch=NEW.funding_owner_epoch
          AND writer.state='reserved' AND writer.activated_at IS NULL AND writer.seal IS NULL
          AND binding.credentials_initialized AND binding.retired_at=(custody->>'retiredAt')::timestamptz
          AND binding.writer_epoch=(custody->'scope'->>'writerEpoch')::uuid
          AND binding.engine_instance_id=(custody->'scope'->>'engineInstanceId')::uuid
          AND binding.boot_id=prepared.boot_id AND binding.generation=prepared.generation
          AND prepared_engine.enrollment_order<target.enrollment_order
      ) THEN RAISE EXCEPTION 'prepared custody requires exact positive binding retirement' USING ERRCODE='23514'; END IF;
    END LOOP;
  ELSE
    IF (to_jsonb(NEW)-ARRAY['successor_writer_epoch','activated_at','custody_sha256']) IS DISTINCT FROM
       (to_jsonb(OLD)-ARRAY['successor_writer_epoch','activated_at','custody_sha256'])
       OR (OLD.activated_at IS NOT NULL AND ROW(NEW.successor_writer_epoch,NEW.activated_at,NEW.custody_sha256)
           IS DISTINCT FROM ROW(OLD.successor_writer_epoch,OLD.activated_at,OLD.custody_sha256)) THEN
      RAISE EXCEPTION 'history recovery identity is immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.activated_at IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM cloud_workspaces workspace
      JOIN cloud_agent_boot_bindings binding ON binding.id=workspace.agent_boot_id
        AND binding.workspace_id=workspace.id AND binding.org_id=workspace.org_id
      JOIN cloud_workspace_local_command_writers writer ON writer.workspace_id=binding.workspace_id
        AND writer.org_id=binding.org_id AND writer.writer_epoch=binding.writer_epoch
      WHERE workspace.id=NEW.workspace_id AND workspace.org_id=NEW.org_id
        AND workspace.current_generation=NEW.generation AND workspace.owner_user_id=NEW.funding_owner_user_id
        AND workspace.agent_funding_owner_epoch=NEW.funding_owner_epoch
        AND binding.engine_instance_id=NEW.engine_instance_id AND binding.boot_id=NEW.boot_id
        AND binding.funding_owner_user_id=NEW.funding_owner_user_id AND binding.funding_owner_epoch=NEW.funding_owner_epoch
        AND writer.writer_epoch=NEW.successor_writer_epoch AND writer.state='active'
    ) THEN
      RAISE EXCEPTION 'history gap requires exact activated successor' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_agent_history_recovery_identity BEFORE INSERT OR UPDATE ON cloud_agent_history_recoveries
  FOR EACH ROW EXECUTE FUNCTION preserve_cloud_agent_history_recovery();
ALTER TABLE cloud_agent_history_recoveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_agent_history_recoveries FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_agent_history_recoveries FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_agent_history_recoveries TO zeros_app;

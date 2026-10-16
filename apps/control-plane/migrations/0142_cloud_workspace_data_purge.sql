-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- Erasure is an explicit, transaction-local worker capability. A runtime
-- transition and boot pointer remain protected outside a live, scoped purge.
CREATE FUNCTION cloud_workspace_data_purge_authorized(target_workspace_id uuid, target_org_id uuid)
RETURNS boolean LANGUAGE sql VOLATILE SET search_path=pg_catalog,public,pg_temp
AS $$
  SELECT app_is_system() AND EXISTS (
    SELECT 1 FROM workspace_deletion_jobs job
    JOIN cloud_workspaces workspace ON workspace.id=job.workspace_id AND workspace.org_id=job.org_id
    WHERE job.workspace_id=target_workspace_id AND job.org_id=target_org_id
      AND job.id::text=nullif(current_setting('app.workspace_deletion_job_id',true),'')
      AND job.lease_owner=nullif(current_setting('app.workspace_deletion_lease_owner',true),'')
      AND job.state='deleting_records' AND job.lease_expires_at>clock_timestamp()
      AND workspace.status='deleted' AND workspace.desired_state='deleted' AND workspace.data_deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM workspace_deletion_blob_targets target
        JOIN workspace_blobs blob ON blob.id=target.blob_id AND blob.org_id=target.org_id
        WHERE target.job_id=job.id AND target.org_id=job.org_id AND (target.completed_at IS NULL OR blob.legal_hold))
      AND NOT EXISTS (SELECT 1 FROM workspace_blob_references reference
        WHERE reference.workspace_id=job.workspace_id AND reference.org_id=job.org_id)
      AND NOT EXISTS (SELECT 1 FROM workspace_retention_policies policy
        WHERE policy.workspace_id=job.workspace_id AND policy.org_id=job.org_id AND policy.legal_hold)
      AND NOT EXISTS (SELECT 1 FROM workspace_checkpoints checkpoint
        WHERE checkpoint.workspace_id=job.workspace_id AND checkpoint.org_id=job.org_id AND checkpoint.legal_hold)
      AND NOT EXISTS (SELECT 1 FROM cloud_workspace_generations generation
        LEFT JOIN cloud_workspace_provider_bindings binding ON binding.workspace_id=generation.workspace_id
          AND binding.generation=generation.generation AND binding.org_id=generation.org_id
        WHERE generation.workspace_id=job.workspace_id AND generation.org_id=job.org_id
          AND binding.deletion_verified_at IS NULL)
  )
$$;

-- All legacy/active binding checks remain identical. The one additional
-- branch clears a deleted workspace's pointer without reverting command mode.
-- zeros-expand-exception: deleted-boot-pointer The exact reviewed guard adds only lease-bound erasure and retains every live binding and legacy-mode rule.
CREATE OR REPLACE FUNCTION verify_cloud_agent_boot_pointer() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp
AS $$
BEGIN
  IF NEW.agent_command_mode='legacy' THEN
    IF NEW.agent_boot_id IS NOT NULL OR (TG_OP='UPDATE' AND OLD.agent_command_mode<>'legacy') THEN
      RAISE EXCEPTION 'local command authority cannot fall back to legacy' USING ERRCODE='23514';
    END IF;
  ELSIF TG_OP='UPDATE' AND NEW.agent_boot_id IS NULL
    AND NEW.agent_command_mode=OLD.agent_command_mode
    AND ROW(NEW.id,NEW.org_id,NEW.status,NEW.desired_state) = ROW(OLD.id,OLD.org_id,OLD.status,OLD.desired_state)
    AND cloud_workspace_data_purge_authorized(OLD.id,OLD.org_id) THEN
    RETURN NEW;
  ELSIF NOT EXISTS (
    SELECT 1 FROM cloud_agent_boot_bindings binding
    JOIN cloud_workspace_local_command_writers writer ON writer.workspace_id=binding.workspace_id
      AND writer.org_id=binding.org_id AND writer.writer_epoch=binding.writer_epoch
    WHERE binding.id=NEW.agent_boot_id AND binding.workspace_id=NEW.id AND binding.org_id=NEW.org_id
      AND binding.engine_instance_id=writer.engine_instance_id AND binding.generation=writer.generation
      AND binding.boot_id=writer.boot_id AND binding.funding_owner_user_id=writer.funding_owner_user_id
      AND binding.funding_owner_epoch=writer.funding_owner_epoch
      AND binding.credentials_initialized AND binding.cache_revision=binding.desired_cache_revision
      AND writer.state IN ('active','retired')
  ) THEN
    RAISE EXCEPTION 'activated local binding is required' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

-- Allocation transfers are permanent audit evidence. Anchor their unchanged
-- identity to the retained generation-transition tombstone, while requiring a
-- live runtime transition at insertion exactly as the original FK did.
CREATE FUNCTION verify_cloud_allocation_transfer_runtime() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp
AS $$
BEGIN
  PERFORM 1 FROM cloud_workspace_runtime_transitions runtime
    WHERE runtime.transition_id=NEW.transition_id AND runtime.workspace_id=NEW.workspace_id AND runtime.org_id=NEW.org_id
    FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'allocation transfer requires its runtime transition' USING ERRCODE='23503';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_allocation_transfer_runtime BEFORE INSERT OR UPDATE OF transition_id,workspace_id,org_id
  ON cloud_workspace_allocation_transfers FOR EACH ROW EXECUTE FUNCTION verify_cloud_allocation_transfer_runtime();
ALTER TABLE cloud_workspace_allocation_transfers
  ADD CONSTRAINT cloud_allocation_transfer_transition_tombstone FOREIGN KEY(transition_id,workspace_id,org_id)
    REFERENCES cloud_workspace_generation_transitions(id,workspace_id,org_id) NOT VALID;
ALTER TABLE cloud_workspace_allocation_transfers VALIDATE CONSTRAINT cloud_allocation_transfer_transition_tombstone;
-- zeros-expand-exception: retain-transfer-audit The validated tombstone FK and runtime-insert guard retain all old writers and preserve every allocation-transfer audit row during erasure.
ALTER TABLE cloud_workspace_allocation_transfers DROP CONSTRAINT cloud_workspace_allocation_tr_transition_id_workspace_id_o_fkey;

CREATE POLICY system_data_purge ON cloud_workspace_runtime_transitions FOR DELETE
  USING(cloud_workspace_data_purge_authorized(workspace_id,org_id));
GRANT DELETE ON cloud_workspace_runtime_transitions TO zeros_app;

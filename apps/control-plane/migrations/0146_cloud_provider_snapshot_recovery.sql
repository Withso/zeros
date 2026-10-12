-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- A resume can fail before setup exists. Preserve the original setup evidence
-- contract, and admit only the explicit missing-snapshot lifecycle evidence.
-- The incident remains system-only and bound to its original wake/generation.
-- zeros-expand-exception: provider-recovery-evidence Widen setup-only evidence while retaining its complete non-null and code contract.
ALTER TABLE cloud_workspace_restore_incidents
  ALTER COLUMN setup_run_id DROP NOT NULL,
  ALTER COLUMN last_successful_setup_id DROP NOT NULL,
  ALTER COLUMN last_execution_fence DROP NOT NULL,
  DROP CONSTRAINT cloud_workspace_restore_incidents_evidence_code_check,
  ADD CONSTRAINT cloud_workspace_restore_incidents_evidence_code_check CHECK (
    (evidence_code IN ('setup_immutable_runtime_missing','setup_immutable_inventory_invalid')
      AND setup_run_id IS NOT NULL AND last_successful_setup_id IS NOT NULL AND last_execution_fence IS NOT NULL)
    OR (evidence_code='provider_snapshot_missing' AND setup_run_id IS NULL
      AND last_successful_setup_id IS NULL AND last_execution_fence IS NULL AND evidence_count=1));

-- Older workers can read an expanded incident but still copy the old template.
-- Fence that admission at commit, after the candidate and source are pinned.
-- Later activations never change the accepted generation's immutable source.
CREATE FUNCTION require_cloud_snapshot_recovery_computer() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NEW.operation='recover' AND EXISTS (
    SELECT 1 FROM cloud_workspace_restore_incidents incident
    WHERE incident.workspace_id=NEW.workspace_id AND incident.org_id=NEW.org_id
      AND incident.source_generation=NEW.source_generation AND incident.evidence_code='provider_snapshot_missing'
  ) AND NOT EXISTS (
    SELECT 1 FROM cloud_workspace_computer_sources source
    JOIN cloud_computer_v2_heads head ON head.org_id=source.org_id AND head.active_build_id=source.build_id
    JOIN cloud_computer_templates template ON template.build_id=source.template_id AND template.org_id=source.org_id
    JOIN cloud_computer_template_snapshots snapshot ON snapshot.build_id=template.build_id AND snapshot.org_id=template.org_id
    JOIN cloud_workspace_generations generation ON generation.workspace_id=source.workspace_id
      AND generation.generation=source.generation AND generation.org_id=source.org_id
    WHERE source.workspace_id=NEW.workspace_id AND source.org_id=NEW.org_id AND source.generation=NEW.candidate_generation
      AND template.state='ready' AND snapshot.state='ready' AND snapshot.verified_at IS NOT NULL
      AND snapshot.source_sandbox_id=template.provider_resource_id AND snapshot.account_scope=template.account_scope
      AND snapshot.billing_org=template.billing_org AND snapshot.manifest_sha256=template.manifest_sha256
      AND generation.image_ref=snapshot.image_ref AND generation.recovery_checkpoint_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Snapshot recovery requires the current durable Computer' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER cloud_snapshot_recovery_current_computer
AFTER INSERT ON cloud_workspace_generation_transitions DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION require_cloud_snapshot_recovery_computer();

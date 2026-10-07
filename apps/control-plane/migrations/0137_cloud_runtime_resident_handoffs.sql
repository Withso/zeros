-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- A live resident host is a third runtime, independent of controller/engine.
-- Publication remains operator-owned; ordinary transfer qualification alone
-- never authorizes retaining resident workloads across a switch.
CREATE TABLE cloud_runtime_resident_transfer_qualifications (
  source_runtime_id text NOT NULL,
  target_runtime_id text NOT NULL,
  controller_runtime_id text NOT NULL,
  base_compatibility_id text NOT NULL,
  mode text NOT NULL CHECK (mode='engine'),
  qualification_mode text NOT NULL,
  resident_runtime_id text NOT NULL REFERENCES cloud_runtime_bundles(runtime_id),
  protocol text NOT NULL DEFAULT 'zeros.resident-pty/v1' CHECK (protocol='zeros.resident-pty/v1'),
  enabled boolean NOT NULL DEFAULT false,
  qualified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  evidence_sha256 bytea NOT NULL CHECK (octet_length(evidence_sha256)=32),
  PRIMARY KEY (source_runtime_id,target_runtime_id,controller_runtime_id,base_compatibility_id,mode,qualification_mode,resident_runtime_id),
  FOREIGN KEY (source_runtime_id,target_runtime_id,controller_runtime_id,base_compatibility_id,mode,qualification_mode)
    REFERENCES cloud_runtime_transfer_qualifications(source_runtime_id,target_runtime_id,controller_runtime_id,base_compatibility_id,mode,qualification_mode)
);
ALTER TABLE cloud_runtime_resident_transfer_qualifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_runtime_resident_transfer_qualifications FORCE ROW LEVEL SECURITY;
CREATE POLICY system_read ON cloud_runtime_resident_transfer_qualifications FOR SELECT USING(app_is_system());
CREATE POLICY system_lock ON cloud_runtime_resident_transfer_qualifications FOR UPDATE USING(app_is_system()) WITH CHECK(false);
GRANT SELECT,UPDATE ON cloud_runtime_resident_transfer_qualifications TO zeros_app;

-- A committed authorization may already have consumed the VM writer even if
-- its reply was lost. Never interpret this row as harmless unactivated staging.
CREATE TABLE cloud_workspace_runtime_handoffs (
  transition_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  org_id uuid NOT NULL,
  execution_fence uuid NOT NULL,
  phase text NOT NULL CHECK (phase IN ('consumption_authorized','consumed','source_retired','uncertain','cancelled')),
  request jsonb NOT NULL CHECK (jsonb_typeof(request)='object' AND octet_length(request::text)<=4096),
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt)='object' AND octet_length(receipt::text)<=4096),
  source_resident jsonb NOT NULL CHECK (jsonb_typeof(source_resident)='object' AND octet_length(source_resident::text)<=4096),
  consumed_resident jsonb CHECK (jsonb_typeof(consumed_resident)='object' AND octet_length(consumed_resident::text)<=4096),
  authorized_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deadline_at timestamptz NOT NULL,
  consumed_at timestamptz,
  source_retired_at timestamptz,
  cancelled_at timestamptz,
  FOREIGN KEY (transition_id,workspace_id,org_id)
    REFERENCES cloud_workspace_runtime_transitions(transition_id,workspace_id,org_id) ON DELETE CASCADE,
  CHECK (deadline_at<=authorized_at+interval '15 minutes'),
  CHECK (num_nonnulls(consumed_at,consumed_resident) IN (0,2)),
  CHECK ((phase='cancelled')=(cancelled_at IS NOT NULL)),
  CHECK ((phase IN ('consumption_authorized','cancelled') AND consumed_at IS NULL AND source_retired_at IS NULL)
    OR (phase='consumed' AND consumed_at IS NOT NULL AND source_retired_at IS NULL)
    OR (phase='source_retired' AND consumed_at IS NOT NULL AND source_retired_at IS NOT NULL)
    OR (phase='uncertain' AND source_retired_at IS NULL))
);
ALTER TABLE cloud_workspace_runtime_handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_runtime_handoffs FORCE ROW LEVEL SECURITY;
CREATE POLICY system_read ON cloud_workspace_runtime_handoffs FOR SELECT USING(app_is_system());
CREATE POLICY system_insert ON cloud_workspace_runtime_handoffs FOR INSERT WITH CHECK(app_is_system());
CREATE POLICY system_update ON cloud_workspace_runtime_handoffs FOR UPDATE USING(app_is_system()) WITH CHECK(app_is_system());
GRANT SELECT,INSERT,UPDATE ON cloud_workspace_runtime_handoffs TO zeros_app;

CREATE FUNCTION preserve_cloud_runtime_handoff() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF ROW(NEW.transition_id,NEW.workspace_id,NEW.org_id,NEW.execution_fence,NEW.request,NEW.receipt,NEW.source_resident,NEW.authorized_at)
    IS DISTINCT FROM ROW(OLD.transition_id,OLD.workspace_id,OLD.org_id,OLD.execution_fence,OLD.request,OLD.receipt,OLD.source_resident,OLD.authorized_at)
    OR NEW.deadline_at>OLD.deadline_at
    OR (OLD.consumed_at IS NOT NULL AND ROW(NEW.consumed_at,NEW.consumed_resident) IS DISTINCT FROM ROW(OLD.consumed_at,OLD.consumed_resident))
    OR (OLD.source_retired_at IS NOT NULL AND NEW.source_retired_at IS DISTINCT FROM OLD.source_retired_at)
    OR (OLD.cancelled_at IS NOT NULL AND NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at)
    OR NOT (NEW.phase=OLD.phase
      OR (OLD.phase='consumption_authorized' AND NEW.phase IN ('consumed','uncertain','cancelled'))
      OR (OLD.phase='consumed' AND NEW.phase IN ('source_retired','uncertain'))) THEN
    RAISE EXCEPTION 'runtime handoff identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_runtime_handoff_identity BEFORE UPDATE ON cloud_workspace_runtime_handoffs
  FOR EACH ROW EXECUTE FUNCTION preserve_cloud_runtime_handoff();

-- Nullable: pre-resident enrollment writers retain their exact behavior.
ALTER TABLE cloud_workspace_runtime_enrollments ADD COLUMN resident_witness jsonb
  CHECK (jsonb_typeof(resident_witness)='object' AND octet_length(resident_witness::text)<=4096);

-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- Behavioral evidence is scoped to one immutable Computer build. Publication
-- still requires that build's sanitation and verified named snapshot. This
-- relation alone never authorizes a workspace or skips a per-boot check.
ALTER TABLE cloud_computer_v2_builds ADD CONSTRAINT cloud_computer_build_qualification_identity
  UNIQUE(id,config_id,org_id,runtime_id,base_image_id);

CREATE TABLE cloud_computer_build_qualifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  build_id uuid NOT NULL UNIQUE,
  config_id uuid NOT NULL,
  org_id uuid NOT NULL,
  runtime_id text NOT NULL,
  runtime_manifest_sha256 text NOT NULL,
  base_image_id text NOT NULL,
  base_compatibility_id text NOT NULL,
  canonical_evidence text NOT NULL CHECK(octet_length(canonical_evidence) BETWEEN 1 AND 65536),
  evidence_sha256 bytea NOT NULL CHECK(octet_length(evidence_sha256)=32
    AND evidence_sha256=sha256(convert_to(canonical_evidence,'UTF8'))),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  revocation_reason text CHECK(revocation_reason IN ('integrity_failed','policy_withdrawn','qualification_withdrawn')),
  UNIQUE(id,build_id,org_id),
  FOREIGN KEY(build_id,config_id,org_id,runtime_id,base_image_id)
    REFERENCES cloud_computer_v2_builds(id,config_id,org_id,runtime_id,base_image_id),
  -- Existing organization erasure deletes templates before builds. Cascading
  -- here also keeps the N-1 eraser correct; our trigger still checks its lease.
  FOREIGN KEY(build_id,org_id) REFERENCES cloud_computer_templates(build_id,org_id) ON DELETE CASCADE,
  FOREIGN KEY(runtime_id,runtime_manifest_sha256) REFERENCES cloud_runtime_bundles(runtime_id,manifest_sha256),
  FOREIGN KEY(base_image_id,base_compatibility_id) REFERENCES cloud_runtime_base_images(base_image_id,base_compatibility_id),
  CHECK((revoked_at IS NULL)=(revocation_reason IS NULL)),
  CHECK(canonical_evidence::jsonb @> jsonb_build_object(
    'schema','zeros.computer-build-qualification/v1',
    'scope',jsonb_build_object('buildId',build_id,'configId',config_id,'organizationId',org_id,'provider','boat'),
    'runtime',jsonb_build_object('runtimeId',runtime_id,'manifestSha256',runtime_manifest_sha256),
    'base',jsonb_build_object('baseImageId',base_image_id,'baseCompatibilityId',base_compatibility_id),
    'policy',jsonb_build_object('version',1),
    'results',jsonb_build_object('runtime',true,'identity',true,'resources',true,'mounts',true,'credentials',true,
      'actorTools',true,'lsps',true,'capture',true,'humanServices',true,'setupProcess',true,'retirement',true,'census',true)))
);
CREATE INDEX cloud_computer_build_qualifications_org ON cloud_computer_build_qualifications(org_id);
CREATE INDEX cloud_computer_build_qualifications_runtime ON cloud_computer_build_qualifications(runtime_id,runtime_manifest_sha256);
CREATE INDEX cloud_computer_build_qualifications_base ON cloud_computer_build_qualifications(base_image_id,base_compatibility_id);

CREATE FUNCTION preserve_cloud_computer_build_qualification() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF cloud_computer_v2_purge_allowed(OLD.org_id) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Computer qualification erasure requires organization purge authority' USING ERRCODE='55000';
  END IF;
  IF (to_jsonb(NEW)-ARRAY['revoked_at','revocation_reason'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['revoked_at','revocation_reason'])
    OR (OLD.revoked_at IS NOT NULL AND ROW(NEW.revoked_at,NEW.revocation_reason)
      IS DISTINCT FROM ROW(OLD.revoked_at,OLD.revocation_reason)) THEN
    RAISE EXCEPTION 'Computer qualification identity and revocation are immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cloud_computer_build_qualification_immutable
  BEFORE UPDATE OR DELETE ON cloud_computer_build_qualifications
  FOR EACH ROW EXECUTE FUNCTION preserve_cloud_computer_build_qualification();

ALTER TABLE cloud_computer_build_qualifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_computer_build_qualifications FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_computer_build_qualifications_system ON cloud_computer_build_qualifications
  FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_computer_build_qualifications TO zeros_app;

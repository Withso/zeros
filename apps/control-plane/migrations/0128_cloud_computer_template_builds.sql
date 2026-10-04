-- zeros-migration: expand
-- A terminal logical request still occupies capacity until its builder has
-- positively stopped or been deleted. Provider-operation journaling belongs
-- to the shared builder adapter; these fields bind that operation to C1's CAS.
ALTER TABLE cloud_computer_templates
  ADD COLUMN builder_operation_key text UNIQUE,
  ADD COLUMN builder_name text,
  ADD COLUMN allocation_requested_at timestamptz,
  ADD COLUMN manifest_sha256 bytea CHECK(octet_length(manifest_sha256)=32),
  ADD COLUMN cleanup_fence bigint NOT NULL DEFAULT 0 CHECK(cleanup_fence>=0),
  ADD COLUMN cleanup_lease_until timestamptz,
  ADD COLUMN cleanup_retry_at timestamptz,
  ADD COLUMN cleanup_confirmed_at timestamptz,
  ADD COLUMN image_ref text GENERATED ALWAYS AS (
    CASE WHEN provider_resource_id IS NULL THEN NULL ELSE 'boat-template:' || provider_resource_id END
  ) STORED,
  ADD CONSTRAINT cloud_computer_template_builder_identity CHECK(builder_operation_key IS NULL OR (
    builder_operation_key='computer-build:' || build_id::text AND
    builder_name IS DISTINCT FROM NULL AND builder_name ~ '^[A-Za-z0-9_-]{1,128}$' AND
    allocation_requested_at IS DISTINCT FROM NULL AND account_scope IS DISTINCT FROM NULL AND billing_org IS DISTINCT FROM NULL AND
    (provider_resource_id IS NULL OR provider_resource_id ~ '^[A-Za-z0-9_-]{1,128}$'))),
  ADD CONSTRAINT cloud_computer_template_builder_ready CHECK(builder_operation_key IS NULL OR state<>'ready' OR (
    provider_resource_id IS DISTINCT FROM NULL AND manifest_sha256 IS DISTINCT FROM NULL AND cleanup_confirmed_at IS NULL));
ALTER TABLE cloud_computer_v2_builds
  ADD CONSTRAINT cloud_computer_build_base FOREIGN KEY(base_image_id)
    REFERENCES cloud_runtime_base_images(base_image_id) NOT VALID,
  ADD CONSTRAINT cloud_computer_build_runtime FOREIGN KEY(runtime_id)
    REFERENCES cloud_runtime_bundles(runtime_id) NOT VALID;
CREATE INDEX cloud_computer_template_cleanup ON cloud_computer_templates(cleanup_retry_at,build_id)
  WHERE builder_operation_key IS NOT NULL AND cleanup_confirmed_at IS NULL AND state IN ('pending','quarantined');
CREATE INDEX cloud_computer_build_deadlines ON cloud_computer_v2_builds(deadline_at,id) WHERE state='running';

CREATE FUNCTION cloud_computer_template_builder_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.builder_operation_key IS NOT NULL AND (
    (NEW.build_id,NEW.org_id,NEW.builder_operation_key,NEW.builder_name,NEW.allocation_requested_at,NEW.account_scope,NEW.billing_org)
      IS DISTINCT FROM
    (OLD.build_id,OLD.org_id,OLD.builder_operation_key,OLD.builder_name,OLD.allocation_requested_at,OLD.account_scope,OLD.billing_org)
    OR (OLD.provider_resource_id IS NOT NULL AND NEW.provider_resource_id IS DISTINCT FROM OLD.provider_resource_id)
    OR (OLD.protected_contract_digest IS NOT NULL AND NEW.protected_contract_digest IS DISTINCT FROM OLD.protected_contract_digest)
    OR (OLD.manifest_sha256 IS NOT NULL AND NEW.manifest_sha256 IS DISTINCT FROM OLD.manifest_sha256)
    OR (OLD.cleanup_confirmed_at IS NOT NULL AND NEW.cleanup_confirmed_at IS DISTINCT FROM OLD.cleanup_confirmed_at)
    OR NEW.cleanup_fence<OLD.cleanup_fence) THEN
    RAISE EXCEPTION 'Cloud Computer builder identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cloud_computer_template_builder_guard BEFORE UPDATE ON cloud_computer_templates
  FOR EACH ROW EXECUTE FUNCTION cloud_computer_template_builder_guard();
GRANT EXECUTE ON FUNCTION cloud_computer_template_builder_guard() TO zeros_app;

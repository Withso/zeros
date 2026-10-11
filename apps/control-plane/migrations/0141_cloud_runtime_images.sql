-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- A runtime image is a provider named snapshot of an approved base with one
-- qualified runtime installed and current. Each control plane produces images
-- for its own deployment channel. Images only accelerate allocation: the base,
-- runtime and qualification registry rows remain the authority, and every
-- consumer re-verifies the runtime it boots.
CREATE TABLE cloud_runtime_images (
  image_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel text NOT NULL CHECK (channel IN ('alpha', 'beta', 'production')),
  runtime_id text NOT NULL REFERENCES cloud_runtime_bundles(runtime_id),
  base_image_id text NOT NULL,
  base_compatibility_id text NOT NULL,
  account_scope text NOT NULL CHECK (account_scope ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  billing_org text NOT NULL CHECK (length(billing_org) BETWEEN 1 AND 512 AND billing_org !~ '[[:cntrl:]]'),
  -- Never reused: a retry is a new row with a new nonce, so no save can
  -- replace a name that a create journal may still reference. The prefix
  -- stays outside the release worker's zeros-<channel>- snapshot namespace.
  snapshot_name text NOT NULL UNIQUE CHECK (snapshot_name ~ '^zeros-rtimg-(alpha|beta|production)-[a-f0-9]{12}-[a-f0-9]{8}$'),
  state text NOT NULL DEFAULT 'building' CHECK (state IN ('building', 'ready', 'failed', 'retiring', 'retired')),
  builder_sandbox_id text CHECK (builder_sandbox_id ~ '^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$'),
  probe_sandbox_id text CHECK (probe_sandbox_id ~ '^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$'),
  snapshot_requested_at timestamptz,
  snapshot_id text CHECK (snapshot_id ~ '^[A-Za-z0-9_-]{1,160}$'),
  size_bytes bigint CHECK (size_bytes BETWEEN 1 AND 9007199254740991),
  diagnostic jsonb CHECK (jsonb_typeof(diagnostic) = 'object' AND octet_length(diagnostic::text) <= 4096
    AND diagnostic @> '{"schema":"zeros.diagnostic/v1"}'::jsonb),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deadline_at timestamptz NOT NULL,
  verified_at timestamptz,
  ready_at timestamptz,
  finished_at timestamptz,
  cleanup_confirmed_at timestamptz,
  cleanup_lease_until timestamptz,
  retire_requested_at timestamptz,
  retired_at timestamptz,
  FOREIGN KEY (base_image_id, base_compatibility_id)
    REFERENCES cloud_runtime_base_images(base_image_id, base_compatibility_id),
  CHECK (snapshot_name LIKE 'zeros-rtimg-' || channel || '-' || substr(runtime_id, 4, 12) || '-%'),
  CHECK (snapshot_requested_at IS NULL OR builder_sandbox_id IS NOT NULL),
  CHECK (snapshot_id IS NULL OR snapshot_requested_at IS NOT NULL),
  CHECK (num_nonnulls(snapshot_id, size_bytes) IN (0, 2)),
  CHECK (verified_at IS NULL OR (snapshot_id IS NOT NULL AND probe_sandbox_id IS NOT NULL)),
  -- Builder and probe deletion precede publication and failure alike.
  CHECK (state = 'building' OR cleanup_confirmed_at IS NOT NULL),
  CHECK ((state IN ('ready', 'retiring', 'retired')) = (ready_at IS NOT NULL)),
  CHECK (ready_at IS NULL OR verified_at IS NOT NULL),
  CHECK ((state = 'failed') = (finished_at IS NOT NULL)),
  CHECK ((state IN ('retiring', 'retired')) = (retire_requested_at IS NOT NULL)),
  CHECK ((state = 'retired') = (retired_at IS NOT NULL))
);
-- A producer owns only its own provider account and wallet's rows and
-- journals. A wallet rotation keeps the account scope, so slots include it.
CREATE UNIQUE INDEX cloud_runtime_images_one_building ON cloud_runtime_images(channel, account_scope, lower(billing_org))
  WHERE state = 'building';
CREATE UNIQUE INDEX cloud_runtime_images_ready ON cloud_runtime_images(channel, account_scope, lower(billing_org), runtime_id, base_image_id)
  WHERE state = 'ready';
CREATE INDEX cloud_runtime_images_attempts ON cloud_runtime_images(channel, account_scope, runtime_id, base_image_id, created_at DESC);
CREATE INDEX cloud_runtime_images_base ON cloud_runtime_images(base_image_id, base_compatibility_id);

-- Identity and every recorded provider observation are write-once. State only
-- moves forward: building -> ready|failed, ready -> retiring -> retired.
-- Retiring withdraws an image from selection; its name is deleted only after
-- no Computer builder that recorded it can still create from it.
CREATE FUNCTION preserve_cloud_runtime_image() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'cloud runtime images cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF ROW(NEW.image_id, NEW.channel, NEW.runtime_id, NEW.base_image_id, NEW.base_compatibility_id,
         NEW.account_scope, NEW.billing_org, NEW.snapshot_name, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.image_id, OLD.channel, OLD.runtime_id, OLD.base_image_id, OLD.base_compatibility_id,
         OLD.account_scope, OLD.billing_org, OLD.snapshot_name, OLD.created_at)
     -- An unconfirmed cleanup may only hand the attempt to reconciliation sooner.
     OR NEW.deadline_at > OLD.deadline_at
     OR (OLD.builder_sandbox_id IS NOT NULL AND NEW.builder_sandbox_id IS DISTINCT FROM OLD.builder_sandbox_id)
     OR (OLD.probe_sandbox_id IS NOT NULL AND NEW.probe_sandbox_id IS DISTINCT FROM OLD.probe_sandbox_id)
     OR (OLD.snapshot_requested_at IS NOT NULL AND NEW.snapshot_requested_at IS DISTINCT FROM OLD.snapshot_requested_at)
     OR (OLD.snapshot_id IS NOT NULL AND NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id)
     OR (OLD.size_bytes IS NOT NULL AND NEW.size_bytes IS DISTINCT FROM OLD.size_bytes)
     OR (OLD.verified_at IS NOT NULL AND NEW.verified_at IS DISTINCT FROM OLD.verified_at)
     OR (OLD.ready_at IS NOT NULL AND NEW.ready_at IS DISTINCT FROM OLD.ready_at)
     OR (OLD.finished_at IS NOT NULL AND NEW.finished_at IS DISTINCT FROM OLD.finished_at)
     OR (OLD.cleanup_confirmed_at IS NOT NULL AND NEW.cleanup_confirmed_at IS DISTINCT FROM OLD.cleanup_confirmed_at)
     OR (OLD.retire_requested_at IS NOT NULL AND NEW.retire_requested_at IS DISTINCT FROM OLD.retire_requested_at)
     OR (OLD.retired_at IS NOT NULL AND NEW.retired_at IS DISTINCT FROM OLD.retired_at)
     OR (NEW.state IS DISTINCT FROM OLD.state AND NOT (
       (OLD.state = 'building' AND NEW.state IN ('ready', 'failed'))
       OR (OLD.state = 'ready' AND NEW.state = 'retiring')
       OR (OLD.state = 'retiring' AND NEW.state = 'retired'))) THEN
    RAISE EXCEPTION 'cloud runtime image identity or lifecycle is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cloud_runtime_image_immutable BEFORE UPDATE OR DELETE ON cloud_runtime_images
  FOR EACH ROW EXECUTE FUNCTION preserve_cloud_runtime_image();

ALTER TABLE cloud_runtime_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_runtime_images FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_runtime_images_system ON cloud_runtime_images
  FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());

-- Image builders and boot probes need provider snapshots, like Computer
-- builders. Widening the closed purpose set is compatible with older code,
-- which never writes the new value.
-- zeros-expand-exception: widen-check builder purposes gain runtime-image
ALTER TABLE cloud_builder_vm_operations DROP CONSTRAINT cloud_builder_vm_operations_purpose_check;
ALTER TABLE cloud_builder_vm_operations ADD CONSTRAINT cloud_builder_vm_operations_purpose_check
  CHECK (purpose IN ('runtime-qualification', 'computer-build', 'runtime-image'));

-- A Computer builder may start from an image instead of the bare base. The
-- claim records the choice with the builder intent; replays rebuild the same
-- intent from it, so it is fixed once the builder operation exists.
ALTER TABLE cloud_computer_templates
  ADD COLUMN builder_source_image_id uuid REFERENCES cloud_runtime_images(image_id),
  ADD CONSTRAINT cloud_computer_template_source_image CHECK (
    builder_source_image_id IS NULL OR builder_operation_key IS DISTINCT FROM NULL);
CREATE INDEX cloud_computer_templates_source_image ON cloud_computer_templates(builder_source_image_id)
  WHERE builder_source_image_id IS NOT NULL;

CREATE FUNCTION cloud_computer_template_source_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.builder_operation_key IS NOT NULL
     AND NEW.builder_source_image_id IS DISTINCT FROM OLD.builder_source_image_id THEN
    RAISE EXCEPTION 'computer builder source is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cloud_computer_template_source_immutable BEFORE UPDATE ON cloud_computer_templates
  FOR EACH ROW EXECUTE FUNCTION cloud_computer_template_source_guard();

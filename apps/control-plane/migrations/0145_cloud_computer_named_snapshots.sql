-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- A single database owns each shared-account/channel allocator. These
-- sequences outlive organization deletion and never rewind on rollback.
-- Preserve them through restore/moves; never reset or recycle a version.
CREATE SEQUENCE cloud_computer_snapshot_development_version AS bigint MINVALUE 1 NO CYCLE;
CREATE SEQUENCE cloud_computer_snapshot_alpha_version AS bigint MINVALUE 1 NO CYCLE;
CREATE SEQUENCE cloud_computer_snapshot_beta_version AS bigint MINVALUE 1 NO CYCLE;
CREATE SEQUENCE cloud_computer_snapshot_production_version AS bigint MINVALUE 1 NO CYCLE;
GRANT USAGE,SELECT ON SEQUENCE cloud_computer_snapshot_development_version,cloud_computer_snapshot_alpha_version,
  cloud_computer_snapshot_beta_version,cloud_computer_snapshot_production_version TO zeros_app;

-- Stopped builder sandboxes are temporary provider storage. Each durable
-- Computer name has a write-once save intent, exact captured identity and a
-- complete saved-tree proof. Historical generation pins remain immutable.
CREATE TABLE cloud_computer_template_snapshots (
  build_id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  channel text NOT NULL CHECK(channel IN ('development','alpha','beta','production')),
  account_scope text NOT NULL CHECK(length(account_scope) BETWEEN 1 AND 128),
  billing_org text NOT NULL CHECK(length(billing_org) BETWEEN 1 AND 512),
  source_sandbox_id text NOT NULL CHECK(source_sandbox_id ~ '^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$'),
  snapshot_name text NOT NULL UNIQUE CHECK(length(snapshot_name)<=63
    AND snapshot_name ~ ('^[a-z0-9][a-z0-9-]*-' || channel || '-computer-v[1-9][0-9]{0,18}$')),
  manifest_sha256 bytea NOT NULL CHECK(octet_length(manifest_sha256)=32),
  image_ref text GENERATED ALWAYS AS ('boat-computer:' || snapshot_name || '@sha256:' || encode(manifest_sha256,'hex')) STORED,
  state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','saving','ready','retiring','retired')),
  save_requested_at timestamptz,
  snapshot_id text CHECK(snapshot_id ~ '^[A-Za-z0-9_-]{1,160}$'),
  size_bytes bigint CHECK(size_bytes BETWEEN 1 AND 9007199254740991),
  tree_sha256 bytea CHECK(octet_length(tree_sha256)=32),
  verified_at timestamptz,
  ready_at timestamptz,
  retire_requested_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(build_id,org_id) REFERENCES cloud_computer_templates(build_id,org_id) ON DELETE CASCADE,
  CHECK(snapshot_id IS NULL OR save_requested_at IS NOT NULL),
  CHECK(num_nonnulls(tree_sha256,verified_at,ready_at) IN (0,3)),
  CHECK(verified_at IS NULL OR (snapshot_id IS NOT NULL AND size_bytes IS NOT NULL)),
  CHECK(state<>'ready' OR ready_at IS NOT NULL),
  CHECK((state IN ('retiring','retired')) = (retire_requested_at IS NOT NULL)),
  CHECK((state='retired') = (retired_at IS NOT NULL))
);
CREATE INDEX cloud_computer_named_retention ON cloud_computer_template_snapshots(channel,account_scope,billing_org,state,created_at);
ALTER TABLE cloud_computer_template_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_computer_template_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_computer_named_system ON cloud_computer_template_snapshots
  FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_computer_template_snapshots TO zeros_app;

CREATE FUNCTION preserve_cloud_computer_named_snapshot() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.state='retired' AND cloud_computer_v2_purge_allowed(OLD.org_id) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Computer snapshot retirement must be confirmed before erasure' USING ERRCODE='55000';
  END IF;
  IF ROW(NEW.build_id,NEW.org_id,NEW.channel,NEW.account_scope,NEW.billing_org,NEW.source_sandbox_id,
         NEW.snapshot_name,NEW.manifest_sha256,NEW.created_at)
     IS DISTINCT FROM ROW(OLD.build_id,OLD.org_id,OLD.channel,OLD.account_scope,OLD.billing_org,OLD.source_sandbox_id,
         OLD.snapshot_name,OLD.manifest_sha256,OLD.created_at)
     OR (OLD.save_requested_at IS NOT NULL AND NEW.save_requested_at IS DISTINCT FROM OLD.save_requested_at)
     OR (OLD.snapshot_id IS NOT NULL AND NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id)
     OR (OLD.size_bytes IS NOT NULL AND NEW.size_bytes IS DISTINCT FROM OLD.size_bytes)
     OR (OLD.tree_sha256 IS NOT NULL AND NEW.tree_sha256 IS DISTINCT FROM OLD.tree_sha256)
     OR (OLD.verified_at IS NOT NULL AND NEW.verified_at IS DISTINCT FROM OLD.verified_at)
     OR (OLD.ready_at IS NOT NULL AND NEW.ready_at IS DISTINCT FROM OLD.ready_at)
     OR (OLD.retire_requested_at IS NOT NULL AND NEW.retire_requested_at IS DISTINCT FROM OLD.retire_requested_at)
     OR (OLD.retired_at IS NOT NULL AND NEW.retired_at IS DISTINCT FROM OLD.retired_at)
     OR (NEW.state IS DISTINCT FROM OLD.state AND NOT (
       (OLD.state='prepared' AND NEW.state IN ('saving','retiring')) OR
       (OLD.state='saving' AND NEW.state IN ('ready','retiring')) OR
       (OLD.state='ready' AND NEW.state='retiring') OR (OLD.state='retiring' AND NEW.state='retired'))) THEN
    RAISE EXCEPTION 'Computer snapshot identity and evidence are immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cloud_computer_named_immutable BEFORE UPDATE OR DELETE ON cloud_computer_template_snapshots
  FOR EACH ROW EXECUTE FUNCTION preserve_cloud_computer_named_snapshot();

-- False only represents existing, unmigrated sandbox templates. New worker
-- claims set this true; the operator promotes legacy rows after named proof.
ALTER TABLE cloud_computer_templates ADD COLUMN named_snapshot_required boolean NOT NULL DEFAULT false;
CREATE FUNCTION require_cloud_computer_named_publication() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.named_snapshot_required AND NOT NEW.named_snapshot_required THEN
    RAISE EXCEPTION 'Computer durable publication cannot be downgraded' USING ERRCODE='55000';
  END IF;
  IF NEW.state='ready' AND NEW.named_snapshot_required AND NOT EXISTS (
    SELECT 1 FROM cloud_computer_template_snapshots snapshot WHERE snapshot.build_id=NEW.build_id AND snapshot.org_id=NEW.org_id
      AND snapshot.state='ready' AND snapshot.source_sandbox_id=NEW.provider_resource_id
      AND snapshot.account_scope=NEW.account_scope AND snapshot.billing_org=NEW.billing_org
      AND snapshot.manifest_sha256=NEW.manifest_sha256 AND snapshot.verified_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Computer named snapshot publication is unconfirmed' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cloud_computer_named_publication BEFORE INSERT OR UPDATE ON cloud_computer_templates
  FOR EACH ROW EXECUTE FUNCTION require_cloud_computer_named_publication();

-- Widen the image format while retaining every original runtime/base check.
-- The named row binds organization, Computer base and immutable proof; it is
-- ready at admission. Updates keep working after a historical name retires.
-- zeros-expand-exception: computer-named-pin preserve runtime authority while admitting exact named Computer pins
CREATE OR REPLACE FUNCTION preserve_cloud_generation_runtime_pin() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_OP='UPDATE' AND ROW(
    NEW.runtime_id,NEW.runtime_manifest_sha256,NEW.runtime_base_image_id,NEW.runtime_base_compatibility_id,
    NEW.runtime_profile,NEW.runtime_engine_protocol_version
  ) IS DISTINCT FROM ROW(
    OLD.runtime_id,OLD.runtime_manifest_sha256,OLD.runtime_base_image_id,OLD.runtime_base_compatibility_id,
    OLD.runtime_profile,OLD.runtime_engine_protocol_version
  ) THEN
    RAISE EXCEPTION 'cloud generation runtime pin is immutable after insert' USING ERRCODE='55000';
  END IF;
  IF NEW.runtime_id IS NULL THEN
    IF NEW.image_ref LIKE 'boat-computer:%' OR EXISTS (SELECT 1 FROM cloud_runtime_base_images base
      WHERE base.provider=NEW.provider AND base.image_ref=NEW.image_ref) THEN
      RAISE EXCEPTION 'registered v4 bases require a complete runtime pin' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM cloud_runtime_base_images base JOIN cloud_runtime_bundles bundle ON bundle.runtime_id=NEW.runtime_id
    WHERE base.base_image_id=NEW.runtime_base_image_id AND base.base_compatibility_id=NEW.runtime_base_compatibility_id
      AND base.provider=NEW.provider AND base.source_commit=NEW.source_commit
      AND (base.image_ref=NEW.image_ref OR NEW.image_ref ~ '^boat-template:[A-Za-z0-9_-]{1,128}$' OR EXISTS (
        SELECT 1 FROM cloud_computer_template_snapshots snapshot
        JOIN cloud_computer_v2_builds build ON build.id=snapshot.build_id AND build.org_id=snapshot.org_id
        WHERE snapshot.image_ref=NEW.image_ref AND snapshot.org_id=NEW.org_id AND snapshot.verified_at IS NOT NULL
          AND build.base_image_id=NEW.runtime_base_image_id AND (TG_OP='UPDATE' OR snapshot.state='ready')
      ))
      AND base.architecture=NEW.architecture AND base.storage_mib=NEW.storage_mib
      AND bundle.manifest_sha256=NEW.runtime_manifest_sha256 AND bundle.engine_protocol_version=NEW.runtime_engine_protocol_version
  ) THEN
    RAISE EXCEPTION 'cloud generation runtime pin does not match its registered base and bundle' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION bind_cloud_generation_named_computer() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NEW.image_ref LIKE 'boat-computer:%' AND NOT EXISTS (
    SELECT 1 FROM cloud_workspace_computer_sources source
    JOIN cloud_computer_template_snapshots snapshot ON snapshot.build_id=source.template_id AND snapshot.org_id=source.org_id
    WHERE source.workspace_id=NEW.workspace_id AND source.generation=NEW.generation AND source.org_id=NEW.org_id
      AND snapshot.image_ref=NEW.image_ref AND snapshot.verified_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'named Computer generation has no exact source pin' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER cloud_generation_named_computer_binding AFTER INSERT ON cloud_workspace_generations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bind_cloud_generation_named_computer();

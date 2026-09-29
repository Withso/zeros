-- Additive: legacy builds remain readable, but cannot become image artifacts.
CREATE TABLE cloud_computer_images (
  id uuid PRIMARY KEY REFERENCES cloud_computer_builds(id) ON DELETE RESTRICT,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  account_scope text NOT NULL,
  snapshot_name text NOT NULL CHECK(snapshot_name ~ '^zeros-org-[a-f0-9]{32}$'),
  snapshot_id text,
  image_ref text UNIQUE,
  base_image_ref text NOT NULL,
  base_source_commit text NOT NULL,
  recipe_sha256 text NOT NULL CHECK(recipe_sha256 ~ '^[a-f0-9]{64}$'),
  build_sha256 text CHECK(build_sha256 ~ '^[a-f0-9]{64}$'),
  source_contract text CHECK(source_contract ~ '^[a-f0-9]{64}$'),
  image_contract text CHECK(image_contract ~ '^[a-f0-9]{64}$'),
  profile jsonb NOT NULL,
  state text NOT NULL DEFAULT 'reserved' CHECK(state IN
    ('reserved','creating','installing','sanitizing','capturing','verifying','attested','failed','cancelled','retiring','retired')),
  builder_id text,
  verifier_id text,
  builder_dispatched_at timestamptz,
  verifier_dispatched_at timestamptz,
  builder_deletion_operation text,
  verifier_deletion_operation text,
  builder_deleted boolean NOT NULL DEFAULT false,
  verifier_deleted boolean NOT NULL DEFAULT false,
  snapshot_deletion_requested_at timestamptz,
  capture_dispatched_at timestamptz,
  attested_at timestamptz,
  attestation_sha256 text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_scope,snapshot_name),
  UNIQUE(id,org_id),
  CHECK(state <> 'attested' OR (snapshot_id IS NOT NULL AND image_ref IS NOT NULL
    AND build_sha256 IS NOT NULL AND source_contract IS NOT NULL AND image_contract IS NOT NULL
    AND attested_at IS NOT NULL AND attestation_sha256 IS NOT NULL))
);
ALTER TABLE cloud_computers ADD COLUMN active_image_id uuid,
  ADD COLUMN previous_image_id uuid,
  ADD CONSTRAINT cloud_computer_active_image FOREIGN KEY(active_image_id,org_id) REFERENCES cloud_computer_images(id,org_id),
  ADD CONSTRAINT cloud_computer_previous_image FOREIGN KEY(previous_image_id,org_id) REFERENCES cloud_computer_images(id,org_id);
ALTER TABLE cloud_workspace_generations ADD COLUMN computer_image_id uuid,
  ADD CONSTRAINT cloud_generation_computer_image FOREIGN KEY(computer_image_id,org_id) REFERENCES cloud_computer_images(id,org_id);
CREATE INDEX cloud_generation_computer_image_refs ON cloud_workspace_generations(computer_image_id) WHERE computer_image_id IS NOT NULL;
CREATE INDEX cloud_computer_image_reconcile ON cloud_computer_images(account_scope,state,created_at);

-- A certified refusal applies only to its dispatch, never an earlier lost reply.
CREATE TABLE cloud_computer_image_create_attempts (
  id uuid PRIMARY KEY,
  image_id uuid NOT NULL REFERENCES cloud_computer_images(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK(role IN ('builder','verifier')),
  state text NOT NULL CHECK(state IN ('dispatched','rejected','confirmed')),
  rejection_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK((state='rejected') = (rejection_code IS NOT NULL))
);
CREATE INDEX cloud_computer_image_attempts_owner ON cloud_computer_image_create_attempts(image_id,role);
ALTER TABLE cloud_computer_image_create_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_computer_image_create_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_computer_image_attempts_system ON cloud_computer_image_create_attempts
  FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
REVOKE ALL ON cloud_computer_image_create_attempts FROM zeros_app;
GRANT SELECT,INSERT,UPDATE ON cloud_computer_image_create_attempts TO zeros_app;

-- Monotonic pins deliberately outlive deployments: a configured base is also
-- a rollback/release dependency. Runtime workers cannot remove these pins.
CREATE TABLE cloud_computer_image_base_references (
  account_scope text NOT NULL,
  snapshot_name text NOT NULL,
  image_ref text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(account_scope,snapshot_name)
);
ALTER TABLE cloud_computer_image_base_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_computer_image_base_references FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_computer_image_base_references_system ON cloud_computer_image_base_references
  FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
REVOKE ALL ON cloud_computer_image_base_references FROM zeros_app;
GRANT SELECT,INSERT ON cloud_computer_image_base_references TO zeros_app;

CREATE FUNCTION protect_cloud_computer_base_reference() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE artifact cloud_computer_images%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.account_scope,62172));
  SELECT * INTO artifact FROM cloud_computer_images
    WHERE account_scope=NEW.account_scope AND snapshot_name=NEW.snapshot_name FOR SHARE;
  IF FOUND AND (artifact.state<>'attested' OR artifact.image_ref<>NEW.image_ref) THEN
    RAISE EXCEPTION 'Configured base image is unavailable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cloud_computer_base_reference_guard BEFORE INSERT ON cloud_computer_image_base_references
  FOR EACH ROW EXECUTE FUNCTION protect_cloud_computer_base_reference();

CREATE FUNCTION protect_cloud_computer_base_retirement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IN ('retiring','retired') AND NEW.state IS DISTINCT FROM OLD.state AND EXISTS(
    SELECT 1 FROM cloud_computer_image_base_references
    WHERE account_scope=NEW.account_scope AND snapshot_name=NEW.snapshot_name
  ) THEN
    RAISE EXCEPTION 'Configured base image is protected';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cloud_computer_base_retirement_guard BEFORE UPDATE OF state ON cloud_computer_images
  FOR EACH ROW EXECUTE FUNCTION protect_cloud_computer_base_retirement();

-- Serialize admission/reference creation with retirement. All generations,
-- including recovery and explicit upgrade, retain their exact artifact.
CREATE FUNCTION bind_cloud_computer_image() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE artifact cloud_computer_images%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' AND (NEW.image_ref,NEW.computer_image_id) IS DISTINCT FROM (OLD.image_ref,OLD.computer_image_id) THEN
    RAISE EXCEPTION 'Generation image identity is immutable';
  END IF;
  IF NEW.image_ref LIKE 'boat:zeros-org-%' THEN
    SELECT * INTO artifact FROM cloud_computer_images WHERE image_ref=NEW.image_ref AND org_id=NEW.org_id FOR SHARE;
    IF NOT FOUND OR artifact.state<>'attested' OR NEW.provider<>'boat' THEN
      RAISE EXCEPTION 'Cloud Computer image is unavailable';
    END IF;
    NEW.computer_image_id := artifact.id;
  ELSIF NEW.computer_image_id IS NOT NULL THEN
    RAISE EXCEPTION 'Cloud Computer image identity mismatch';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cloud_generation_computer_image_binding BEFORE INSERT OR UPDATE OF image_ref,computer_image_id
  ON cloud_workspace_generations FOR EACH ROW EXECUTE FUNCTION bind_cloud_computer_image();

-- A previous backend's workspace-readiness worker may coexist during rollout.
-- It must not certify, fail, or falsely finish cleanup of the new builder role.
CREATE FUNCTION fence_cloud_computer_image_build() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE image cloud_computer_images%ROWTYPE;
BEGIN
  SELECT * INTO image FROM cloud_computer_images WHERE id=NEW.id;
  IF FOUND THEN
    IF (NEW.state IS DISTINCT FROM OLD.state AND
        ((NEW.state='succeeded' AND image.state<>'attested') OR
         (NEW.state='failed' AND image.state NOT IN ('failed','retired')))) OR
       (NEW.cleanup_state='complete' AND image.state<>'retired' AND NOT
         ((image.builder_deleted OR image.builder_dispatched_at IS NULL) AND
          (image.verifier_deleted OR image.verifier_dispatched_at IS NULL) AND image.state='attested')) THEN
      RAISE EXCEPTION 'Cloud Computer image worker owns this build';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cloud_computer_image_build_fence BEFORE UPDATE OF state,cleanup_state ON cloud_computer_builds
  FOR EACH ROW EXECUTE FUNCTION fence_cloud_computer_image_build();
ALTER TABLE cloud_computer_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_computer_images FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_computer_images_system ON cloud_computer_images FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_computer_images TO zeros_app;

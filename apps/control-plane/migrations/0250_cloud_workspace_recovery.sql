-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

ALTER TABLE cloud_v2_workspaces
  ADD COLUMN worker_recovery_boot_id uuid,
  ADD COLUMN recovery_attempt_id uuid;

-- Provider receipts survive deletion of the product row until both VMs and
-- any uncertain checkpoint upload have been reconciled. No cascading FK.
CREATE TABLE cloud_v2_recovery_attempts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  org_id uuid NOT NULL,
  phase text NOT NULL CHECK (phase IN ('waiting','sealing','sealed','capturing','restoring','booting','verifying','succeeded','failed','cancelled')),
  source_sandbox_id text NOT NULL CHECK (length(source_sandbox_id) BETWEEN 1 AND 128),
  source_boot_id uuid NOT NULL,
  source_token_hash bytea NOT NULL CHECK (octet_length(source_token_hash)=32),
  source_runtime_sha256 text NOT NULL CHECK (source_runtime_sha256 ~ '^[a-f0-9]{64}$'),
  source_route_url text NOT NULL CHECK (length(source_route_url) BETWEEN 1 AND 4096),
  source_port_token jsonb NOT NULL CHECK (coalesce(jsonb_typeof(source_port_token)='object'
    AND source_port_token ?& ARRAY['version','keyVersion','nonce','ciphertext','authTag']
    AND source_port_token-ARRAY['version','keyVersion','nonce','ciphertext','authTag']='{}'::jsonb
    AND source_port_token->'version'='1'::jsonb AND jsonb_typeof(source_port_token->'keyVersion')='number'
    AND source_port_token->>'keyVersion' ~ '^[1-9][0-9]{0,8}$'
    AND jsonb_typeof(source_port_token->'nonce')='string' AND source_port_token->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
    AND jsonb_typeof(source_port_token->'authTag')='string' AND source_port_token->>'authTag' ~ '^[A-Za-z0-9_-]{22}$'
    AND jsonb_typeof(source_port_token->'ciphertext')='string' AND source_port_token->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
    AND length(source_port_token->>'ciphertext') BETWEEN 22 AND 12000,false)),
  access_epoch bigint NOT NULL CHECK (access_epoch>=0),
  stop_generation bigint NOT NULL CHECK (stop_generation>=0),
  initiator_user_id uuid NOT NULL,
  execution_intent_id uuid NOT NULL,
  authority jsonb NOT NULL CHECK (jsonb_typeof(authority)='object' AND pg_column_size(authority)<=65536),
  worker_generation bigint CHECK (worker_generation BETWEEN 0 AND 9007199254740991),
  sealed_at timestamptz,
  source_stopped_at timestamptz,
  checkpoint_object text,
  checkpoint_key jsonb CHECK (checkpoint_key IS NULL OR coalesce(jsonb_typeof(checkpoint_key)='object'
    AND checkpoint_key ?& ARRAY['version','keyVersion','nonce','ciphertext','authTag']
    AND checkpoint_key-ARRAY['version','keyVersion','nonce','ciphertext','authTag']='{}'::jsonb
    AND checkpoint_key->'version'='1'::jsonb AND jsonb_typeof(checkpoint_key->'keyVersion')='number'
    AND checkpoint_key->>'keyVersion' ~ '^[1-9][0-9]{0,8}$'
    AND jsonb_typeof(checkpoint_key->'nonce')='string' AND checkpoint_key->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
    AND jsonb_typeof(checkpoint_key->'authTag')='string' AND checkpoint_key->>'authTag' ~ '^[A-Za-z0-9_-]{22}$'
    AND jsonb_typeof(checkpoint_key->'ciphertext')='string' AND checkpoint_key->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
    AND length(checkpoint_key->>'ciphertext') BETWEEN 43 AND 43,false)),
  checkpoint_sha256 text CHECK (checkpoint_sha256 ~ '^[a-f0-9]{64}$'),
  checkpoint_bytes bigint CHECK (checkpoint_bytes>0),
  checkpoint_upload_until timestamptz,
  checkpoint_saved_at timestamptz,
  replacement_create jsonb CHECK (jsonb_typeof(replacement_create)='object' AND pg_column_size(replacement_create)<=65536),
  replacement_sandbox_id text CHECK (length(replacement_sandbox_id) BETWEEN 1 AND 128),
  replacement_token_hash bytea CHECK (octet_length(replacement_token_hash)=32),
  replacement_token jsonb CHECK (replacement_token IS NULL OR coalesce(jsonb_typeof(replacement_token)='object'
    AND replacement_token ?& ARRAY['version','keyVersion','nonce','ciphertext','authTag']
    AND replacement_token-ARRAY['version','keyVersion','nonce','ciphertext','authTag']='{}'::jsonb
    AND replacement_token->'version'='1'::jsonb AND jsonb_typeof(replacement_token->'keyVersion')='number'
    AND replacement_token->>'keyVersion' ~ '^[1-9][0-9]{0,8}$'
    AND jsonb_typeof(replacement_token->'nonce')='string' AND replacement_token->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
    AND jsonb_typeof(replacement_token->'authTag')='string' AND replacement_token->>'authTag' ~ '^[A-Za-z0-9_-]{22}$'
    AND jsonb_typeof(replacement_token->'ciphertext')='string' AND replacement_token->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
    AND length(replacement_token->>'ciphertext') BETWEEN 64 AND 64,false)),
  replacement_runtime_sha256 text CHECK (replacement_runtime_sha256 ~ '^[a-f0-9]{64}$'),
  replacement_boot_id uuid,
  replacement_route_url text CHECK (length(replacement_route_url) BETWEEN 1 AND 4096),
  replacement_port_token jsonb CHECK (replacement_port_token IS NULL OR coalesce(jsonb_typeof(replacement_port_token)='object'
    AND replacement_port_token ?& ARRAY['version','keyVersion','nonce','ciphertext','authTag']
    AND replacement_port_token-ARRAY['version','keyVersion','nonce','ciphertext','authTag']='{}'::jsonb
    AND replacement_port_token->'version'='1'::jsonb AND jsonb_typeof(replacement_port_token->'keyVersion')='number'
    AND replacement_port_token->>'keyVersion' ~ '^[1-9][0-9]{0,8}$'
    AND jsonb_typeof(replacement_port_token->'nonce')='string' AND replacement_port_token->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
    AND jsonb_typeof(replacement_port_token->'authTag')='string' AND replacement_port_token->>'authTag' ~ '^[A-Za-z0-9_-]{22}$'
    AND jsonb_typeof(replacement_port_token->'ciphertext')='string' AND replacement_port_token->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
    AND length(replacement_port_token->>'ciphertext') BETWEEN 22 AND 12000,false)),
  disk_verified_at timestamptz,
  worker_ready_at timestamptz,
  setup_succeeded_at timestamptz,
  published_at timestamptz,
  source_deleted_at timestamptz,
  replacement_deleted_at timestamptz,
  first_error_code text CHECK (first_error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  lease_id uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deadline_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(id,workspace_id,org_id),
  CHECK (replacement_sandbox_id IS DISTINCT FROM source_sandbox_id),
  CHECK (replacement_boot_id IS DISTINCT FROM source_boot_id),
  CHECK (deadline_at>created_at),
  CHECK ((lease_id IS NULL)=(lease_until IS NULL)),
  CHECK ((phase IN ('succeeded','failed','cancelled'))=(completed_at IS NOT NULL)),
  CHECK (phase NOT IN ('sealed','capturing','restoring','booting','verifying','succeeded')
    OR (worker_generation IS NOT NULL AND sealed_at IS NOT NULL)),
  CHECK (source_stopped_at IS NULL OR (sealed_at IS NOT NULL AND source_stopped_at>=sealed_at)),
  CHECK (checkpoint_saved_at IS NULL OR (source_stopped_at IS NOT NULL AND checkpoint_saved_at>=source_stopped_at
    AND checkpoint_object IS NOT NULL AND checkpoint_key IS NOT NULL AND checkpoint_sha256 IS NOT NULL AND checkpoint_bytes IS NOT NULL)),
  CHECK (phase NOT IN ('restoring','booting','verifying','succeeded') OR checkpoint_saved_at IS NOT NULL),
  CHECK (phase NOT IN ('booting','verifying','succeeded') OR (source_stopped_at IS NOT NULL
    AND replacement_sandbox_id IS NOT NULL AND replacement_create IS NOT NULL AND disk_verified_at IS NOT NULL
    AND replacement_token_hash IS NOT NULL AND replacement_token IS NOT NULL AND replacement_runtime_sha256 IS NOT NULL)),
  CHECK (phase NOT IN ('verifying','succeeded') OR (replacement_boot_id IS NOT NULL AND published_at IS NOT NULL)),
  CHECK (phase<>'succeeded' OR (worker_ready_at IS NOT NULL AND setup_succeeded_at IS NOT NULL))
);
CREATE UNIQUE INDEX cloud_v2_recovery_current ON cloud_v2_recovery_attempts(workspace_id)
  WHERE phase IN ('waiting','sealing','sealed','capturing','restoring','booting','verifying');
CREATE INDEX cloud_v2_recovery_cooldown ON cloud_v2_recovery_attempts(workspace_id,created_at DESC);
CREATE INDEX cloud_v2_recovery_due ON cloud_v2_recovery_attempts(next_attempt_at,id)
  WHERE phase IN ('waiting','sealing','sealed','capturing','restoring','booting','verifying');
CREATE INDEX cloud_v2_recovery_retention ON cloud_v2_recovery_attempts(completed_at,id)
  WHERE phase IN ('succeeded','failed','cancelled');

ALTER TABLE cloud_v2_recovery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_v2_recovery_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_v2_recovery_attempts USING(app_is_system()) WITH CHECK(app_is_system());
GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_v2_recovery_attempts TO zeros_app;
ALTER TABLE cloud_v2_workspaces ADD CONSTRAINT cloud_v2_recovery_scope
  FOREIGN KEY(recovery_attempt_id,id,org_id) REFERENCES cloud_v2_recovery_attempts(id,workspace_id,org_id)
  ON DELETE SET NULL(recovery_attempt_id);

-- A pre-recovery replica must not restart the sealed source or replace the
-- prepared disk with a runtime that cannot enforce the restored turn hold.
CREATE FUNCTION guard_cloud_v2_recovery_workspace() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE recovery public.cloud_v2_recovery_attempts%ROWTYPE;
BEGIN
  IF OLD.recovery_attempt_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO recovery FROM public.cloud_v2_recovery_attempts
    WHERE id=OLD.recovery_attempt_id AND workspace_id=OLD.id AND org_id=OLD.org_id;
  -- Invisible is not inactive. Keep the fence if a future writer can update
  -- the workspace without the system context needed to read this journal.
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='cloud_recovery_binding_changed', CONSTRAINT='cloud_recovery_binding_changed';
  END IF;
  IF NEW.state NOT IN ('creating','starting','running') OR NEW.stop_generation IS DISTINCT FROM OLD.stop_generation THEN
    NEW.recovery_attempt_id:=NULL;
    RETURN NEW;
  END IF;
  IF recovery.phase IN ('succeeded','failed','cancelled') THEN RETURN NEW; END IF;
  IF recovery.stop_generation IS DISTINCT FROM OLD.stop_generation THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='cloud_recovery_binding_changed', CONSTRAINT='cloud_recovery_binding_changed';
  END IF;
  IF recovery.phase IN ('waiting','sealing') THEN
    IF recovery.deadline_at<=clock_timestamp() THEN
      NEW.error_code:='live_connection_unavailable'; NEW.recovery_attempt_id:=NULL;
    ELSIF NEW.error_code='live_connection_unavailable' THEN
      NEW.error_code:=NULL;
    END IF;
    RETURN NEW;
  END IF;
  IF recovery.deadline_at<=clock_timestamp() THEN
    NEW.state:='failed'; NEW.error_code:='live_connection_unavailable'; NEW.recovery_attempt_id:=NULL;
    NEW.next_attempt_at:=NULL; NEW.updated_at:=clock_timestamp();
    RETURN NEW;
  END IF;
  IF NEW.error_code='live_connection_unavailable' THEN NEW.error_code:=NULL; END IF;
  IF NEW.state=OLD.state AND NEW.attempts>OLD.attempts THEN RETURN NULL; END IF;
  NEW.next_attempt_at:=greatest(NEW.next_attempt_at,recovery.deadline_at);
  IF NEW.boat_sandbox_id=recovery.source_sandbox_id AND NEW.worker_boot_id=recovery.source_boot_id
    AND NEW.worker_token_hash=recovery.source_token_hash AND recovery.published_at IS NULL THEN RETURN NEW; END IF;
  IF recovery.phase IN ('booting','verifying') AND NEW.boat_sandbox_id=recovery.replacement_sandbox_id
    AND NEW.worker_token_hash=recovery.replacement_token_hash
    AND ((NEW.worker_boot_id IS NULL AND OLD.boat_sandbox_id=recovery.source_sandbox_id)
      OR NEW.worker_boot_id=recovery.replacement_boot_id) THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='cloud_recovery_binding_changed', CONSTRAINT='cloud_recovery_binding_changed';
END;
$$;
-- zeros-expand-exception: privilege-tightening The trigger is not a callable application operation
REVOKE ALL ON FUNCTION guard_cloud_v2_recovery_workspace() FROM PUBLIC;
CREATE TRIGGER cloud_v2_recovery_workspace BEFORE UPDATE OF state,error_code,attempts,boat_sandbox_id,worker_boot_id,worker_token_hash,stop_generation ON cloud_v2_workspaces
  FOR EACH ROW WHEN (OLD.recovery_attempt_id IS NOT NULL) EXECUTE FUNCTION guard_cloud_v2_recovery_workspace();

CREATE FUNCTION notify_cloud_v2_recovery() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM pg_notify('zeros_cloud_v2_recovery',NEW.workspace_id::text);
  RETURN NEW;
END;
$$;
-- zeros-expand-exception: privilege-tightening The trigger publishes only the recovery workspace identity
REVOKE ALL ON FUNCTION notify_cloud_v2_recovery() FROM PUBLIC;
CREATE TRIGGER cloud_v2_recovery_insert AFTER INSERT ON cloud_v2_recovery_attempts
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_v2_recovery();
CREATE TRIGGER cloud_v2_recovery_update AFTER UPDATE OF phase,next_attempt_at ON cloud_v2_recovery_attempts
  FOR EACH ROW WHEN (OLD.phase IS DISTINCT FROM NEW.phase OR OLD.next_attempt_at IS DISTINCT FROM NEW.next_attempt_at)
  EXECUTE FUNCTION notify_cloud_v2_recovery();

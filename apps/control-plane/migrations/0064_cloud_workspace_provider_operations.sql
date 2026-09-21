-- Allocation and asynchronous deletion evidence survives worker crashes and
-- generation retirement. This journal contains identities and digests only.
-- Never cascade it away while the provider may still retain tenant data.
CREATE TABLE cloud_workspace_provider_operations (
  provider text NOT NULL CHECK (provider IN ('daytona', 'boat')),
  account_scope text NOT NULL CHECK (account_scope ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$'),
  workspace_id uuid NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[a-zA-Z0-9._:-]{1,255}$'),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  resource_id text CHECK (char_length(resource_id) BETWEEN 1 AND 512 AND resource_id ~ '^[a-zA-Z0-9._:-]+$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  deletion_requested_at timestamptz,
  deletion_operation_id text CHECK (char_length(deletion_operation_id) BETWEEN 1 AND 512 AND deletion_operation_id ~ '^[a-zA-Z0-9._:-]+$'),
  deleted_at timestamptz,
  PRIMARY KEY (provider, account_scope, workspace_id, generation),
  UNIQUE (provider, workspace_id, generation),
  UNIQUE (provider, account_scope, idempotency_key),
  UNIQUE (provider, account_scope, resource_id),
  CHECK (deletion_requested_at IS NULL OR resource_id IS NOT NULL),
  CHECK (deletion_operation_id IS NULL OR deletion_requested_at IS NOT NULL),
  CHECK (deleted_at IS NULL OR deletion_operation_id IS NOT NULL)
);
CREATE INDEX cloud_workspace_provider_operations_active_idx
  ON cloud_workspace_provider_operations (provider, account_scope, workspace_id, generation)
  WHERE resource_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX cloud_workspace_provider_operations_org_idx
  ON cloud_workspace_provider_operations (org_id);

ALTER TABLE cloud_workspace_provider_operations ENABLE ROW LEVEL SECURITY;
CREATE POLICY cloud_workspace_provider_operations_system
  ON cloud_workspace_provider_operations FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
ALTER TABLE cloud_workspace_provider_operations FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON cloud_workspace_provider_operations TO zeros_app;

CREATE FUNCTION guard_cloud_workspace_provider_operation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.deleted_at IS NULL THEN
      RAISE EXCEPTION 'Unconfirmed cloud provider operations must be retained';
    END IF;
    RETURN OLD;
  END IF;
  IF ROW(NEW.provider, NEW.account_scope, NEW.workspace_id, NEW.generation,
         NEW.org_id, NEW.idempotency_key, NEW.request_sha256, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.provider, OLD.account_scope, OLD.workspace_id, OLD.generation,
         OLD.org_id, OLD.idempotency_key, OLD.request_sha256, OLD.created_at)
     OR (OLD.resource_id IS NOT NULL AND NEW.resource_id IS DISTINCT FROM OLD.resource_id)
     OR (OLD.deletion_requested_at IS NOT NULL AND NEW.deletion_requested_at IS DISTINCT FROM OLD.deletion_requested_at)
     OR (OLD.deletion_operation_id IS NOT NULL AND NEW.deletion_operation_id IS DISTINCT FROM OLD.deletion_operation_id)
     OR (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at)
  THEN
    RAISE EXCEPTION 'Cloud provider operation identity and accepted evidence are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cloud_workspace_provider_operation_immutable
  BEFORE UPDATE OR DELETE ON cloud_workspace_provider_operations
  FOR EACH ROW EXECUTE FUNCTION guard_cloud_workspace_provider_operation();

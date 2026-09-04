-- ───────────────────────────────────────────────────────────
-- 0047 — immutable provider qualification and expiry authority
--
-- A generation is bound to one exact provider credential version. The
-- qualification evidence and expiry that authorize that credential must be
-- versioned with it; reading those fields from the mutable connection head
-- lets a rotation accidentally lend the new key's authority to an old key.
-- Known expiries also enqueue the existing execution-authority controller so
-- provider compute is stopped while the credential can still perform cleanup.
-- ───────────────────────────────────────────────────────────

ALTER TABLE provider_connection_versions
  ADD COLUMN capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN credential_expires_at timestamptz,
  ADD CONSTRAINT provider_connection_versions_capabilities_check CHECK (
    jsonb_typeof(capabilities) = 'object'
    AND octet_length(capabilities::text) <= 32768
  );

-- Earlier builds projected qualification only onto the connection head. There
-- is no honest way to reconstruct different historic values, so preserve the
-- last known evidence for upgrade compatibility. Every subsequent rotation
-- writes exact per-version evidence below.
CREATE FUNCTION parse_legacy_cloud_provider_expiry(raw_value text)
RETURNS timestamptz
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF raw_value IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN raw_value::timestamptz;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

UPDATE provider_connection_versions version
SET capabilities = connection.capabilities,
    credential_expires_at = parse_legacy_cloud_provider_expiry(
      connection.capabilities ->> 'credentialExpiresAt'
    )
FROM provider_connections connection
WHERE connection.id = version.connection_id
  AND connection.org_id = version.org_id;

DROP FUNCTION parse_legacy_cloud_provider_expiry(text);

CREATE INDEX provider_connection_versions_expiry_idx
  ON provider_connection_versions (credential_expires_at, connection_id, version)
  WHERE credential_source = 'delegated'
    AND credential_expires_at IS NOT NULL;

-- Keep the boolean grouping explicit: a delegated version needs qualification
-- and lifecycle authority whether or not it has a finite expiry.
CREATE FUNCTION cloud_workspace_generation_provider_authority_live(
  target_workspace_id uuid,
  target_generation integer,
  minimum_remaining_seconds integer
) RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT minimum_remaining_seconds BETWEEN 0 AND 3600
    AND EXISTS (
      SELECT 1
      FROM cloud_workspace_generations generation
      JOIN provider_connections connection
        ON connection.id = generation.provider_connection_id
       AND connection.org_id = generation.org_id
       AND connection.provider = generation.provider
      JOIN provider_connection_versions version
        ON version.connection_id = generation.provider_connection_id
       AND version.org_id = generation.org_id
       AND version.version = generation.provider_connection_version
      WHERE generation.workspace_id = target_workspace_id
        AND generation.generation = target_generation
        AND connection.state = 'active'
        AND connection.credential_source = version.credential_source
        AND version.retired_at IS NULL
        AND (
          version.credential_source = 'hosted'
          OR (
            version.capabilities ->> 'qualified' = 'true'
            AND version.capabilities ->> 'lifecycle' = 'true'
            AND (
              version.credential_expires_at IS NULL
              OR version.credential_expires_at >
                now() + make_interval(secs => minimum_remaining_seconds)
            )
          )
        )
    )
$$;

CREATE FUNCTION cloud_workspace_runtime_authority_live(
  target_workspace_id uuid,
  target_generation integer,
  target_user_id uuid,
  require_workos boolean
) RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT cloud_workspace_paid_authority_live(
           target_workspace_id, target_user_id, require_workos
         )
     AND cloud_workspace_generation_provider_authority_live(
           target_workspace_id, target_generation, 300
         )
$$;

CREATE FUNCTION enqueue_cloud_provider_version_authority_check()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  INSERT INTO cloud_workspace_paid_authority_checks (
    workspace_id, org_id, next_check_at, reason, enqueued_at, updated_at
  )
  SELECT workspace.id, workspace.org_id, now(),
         'provider_credential_authority_changed', now(), now()
  FROM cloud_workspace_generations generation
  JOIN cloud_workspaces workspace
    ON workspace.id = generation.workspace_id
   AND workspace.org_id = generation.org_id
   AND workspace.current_generation = generation.generation
  WHERE generation.provider_connection_id = NEW.connection_id
    AND generation.provider_connection_version = NEW.version
    AND generation.org_id = NEW.org_id
    AND workspace.status <> 'deleted'
  ON CONFLICT (workspace_id) DO UPDATE
  SET next_check_at = now(), reason = EXCLUDED.reason,
      enqueued_at = now(), updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER provider_version_authority_check
  AFTER INSERT OR UPDATE OF capabilities, credential_expires_at, retired_at
  ON provider_connection_versions
  FOR EACH ROW EXECUTE FUNCTION enqueue_cloud_provider_version_authority_check();

CREATE FUNCTION enqueue_cloud_generation_provider_authority_check()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  INSERT INTO cloud_workspace_paid_authority_checks (
    workspace_id, org_id, next_check_at, reason, enqueued_at, updated_at
  )
  SELECT workspace.id, workspace.org_id, now(),
         'provider_generation_changed', now(), now()
  FROM cloud_workspaces workspace
  WHERE workspace.id = NEW.workspace_id AND workspace.org_id = NEW.org_id
    AND workspace.current_generation = NEW.generation
    AND workspace.status <> 'deleted'
  ON CONFLICT (workspace_id) DO UPDATE
  SET next_check_at = now(), reason = EXCLUDED.reason,
      enqueued_at = now(), updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER cloud_generation_provider_authority_check
  AFTER INSERT OR UPDATE OF provider_connection_id, provider_connection_version
  ON cloud_workspace_generations
  FOR EACH ROW EXECUTE FUNCTION enqueue_cloud_generation_provider_authority_check();

CREATE FUNCTION enqueue_cloud_provider_connection_authority_check()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF OLD.state IS DISTINCT FROM NEW.state THEN
    INSERT INTO cloud_workspace_paid_authority_checks (
      workspace_id, org_id, next_check_at, reason, enqueued_at, updated_at
    )
    SELECT workspace.id, workspace.org_id, now(),
           'provider_connection_authority_changed', now(), now()
    FROM cloud_workspace_generations generation
    JOIN cloud_workspaces workspace
      ON workspace.id = generation.workspace_id
     AND workspace.org_id = generation.org_id
     AND workspace.current_generation = generation.generation
    WHERE generation.provider_connection_id = NEW.id
      AND generation.org_id = NEW.org_id
      AND workspace.status <> 'deleted'
    ON CONFLICT (workspace_id) DO UPDATE
    SET next_check_at = now(), reason = EXCLUDED.reason,
        enqueued_at = now(), updated_at = now();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER provider_connection_execution_authority_check
  AFTER UPDATE OF state ON provider_connections
  FOR EACH ROW EXECUTE FUNCTION enqueue_cloud_provider_connection_authority_check();

REVOKE ALL ON FUNCTION cloud_workspace_generation_provider_authority_live(
  uuid, integer, integer
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cloud_workspace_generation_provider_authority_live(
  uuid, integer, integer
) TO zeros_app;
REVOKE ALL ON FUNCTION cloud_workspace_runtime_authority_live(
  uuid, integer, uuid, boolean
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cloud_workspace_runtime_authority_live(
  uuid, integer, uuid, boolean
) TO zeros_app;
REVOKE ALL ON FUNCTION enqueue_cloud_provider_version_authority_check()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION enqueue_cloud_generation_provider_authority_check()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION enqueue_cloud_provider_connection_authority_check()
  FROM PUBLIC;

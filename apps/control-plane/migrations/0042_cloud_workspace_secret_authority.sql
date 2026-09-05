-- ───────────────────────────────────────────────────────────
-- 0042 — immutable generation-to-secret authority
--
-- Effective settings snapshots intentionally contain one-use setup-secret ids,
-- not their source binding ids. Materialize that security relationship so a
-- binding revocation can fence every engine/capability that received its value
-- without searching untyped JSON or weakening immutable generation history.
-- Rotation does not rewrite an existing generation: it remains pinned to the
-- old binding version until an explicit generation replacement.
-- ───────────────────────────────────────────────────────────

CREATE TABLE cloud_workspace_generation_secret_bindings (
  workspace_id              uuid NOT NULL,
  generation                integer NOT NULL CHECK (generation > 0),
  org_id                    uuid NOT NULL,
  binding_id                uuid NOT NULL,
  binding_version           bigint NOT NULL CHECK (binding_version > 0),
  environment_name          text NOT NULL CHECK (
                              environment_name ~ '^[A-Z_][A-Z0-9_]{0,127}$'
                            ),
  created_at                timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, generation, environment_name),
  UNIQUE (workspace_id, generation, binding_id),
  FOREIGN KEY (workspace_id, generation, org_id)
    REFERENCES cloud_workspace_generations(workspace_id, generation, org_id)
    ON DELETE CASCADE,
  FOREIGN KEY (binding_id, binding_version, org_id)
    REFERENCES secret_binding_versions(binding_id, version, org_id)
    ON DELETE RESTRICT
);
CREATE INDEX cloud_workspace_generation_secret_binding_lookup_idx
  ON cloud_workspace_generation_secret_bindings(
    binding_id, binding_version, workspace_id, generation
  );

-- Backfill snapshots produced since 0025. Invalid pre-production JSON is not
-- guessed: only exact ids/versions that still satisfy the normalized foreign
-- keys are materialized.
INSERT INTO cloud_workspace_generation_secret_bindings (
  workspace_id, generation, org_id, binding_id, binding_version,
  environment_name
)
SELECT settings.workspace_id, settings.generation, settings.org_id,
       parsed.binding_id,
       parsed.binding_version,
       source.key
FROM workspace_settings_versions settings
CROSS JOIN LATERAL jsonb_each(
  CASE
    WHEN jsonb_typeof(settings.source_versions->'secretBindings') = 'object'
      THEN settings.source_versions->'secretBindings'
    ELSE '{}'::jsonb
  END
) source
CROSS JOIN LATERAL (
  SELECT
    CASE WHEN source.value->>'id' ~
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
      THEN (source.value->>'id')::uuid ELSE NULL END AS binding_id,
    CASE WHEN source.value->>'version' ~ '^[1-9][0-9]{0,17}$'
      THEN (source.value->>'version')::bigint ELSE NULL END AS binding_version
) parsed
JOIN secret_binding_versions version
  ON version.binding_id = parsed.binding_id
 AND version.version = parsed.binding_version
 AND version.org_id = settings.org_id
WHERE source.key ~ '^[A-Z_][A-Z0-9_]{0,127}$'
  AND parsed.binding_id IS NOT NULL
  AND parsed.binding_version IS NOT NULL
ON CONFLICT DO NOTHING;

CREATE FUNCTION retire_cloud_workspace_secret_binding_authority()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF OLD.state = 'active' AND NEW.state = 'revoked' THEN
    UPDATE cloud_workspace_client_access_grants access
    SET state = 'revocation_pending',
        revocation_reason = 'secret_binding_revoked',
        next_revocation_at = now(), updated_at = now()
    FROM cloud_workspace_generation_secret_bindings link
    WHERE link.workspace_id = access.workspace_id
      AND link.generation = access.generation
      AND link.org_id = access.org_id
      AND link.binding_id = NEW.id
      AND access.state IN ('issuing', 'active');

    UPDATE cloud_workspace_endpoint_grants grant_row
    SET revoked_at = coalesce(grant_row.revoked_at, now())
    FROM cloud_workspace_generation_secret_bindings link
    WHERE link.workspace_id = grant_row.workspace_id
      AND link.generation = grant_row.generation
      AND link.org_id = grant_row.org_id
      AND link.binding_id = NEW.id
      AND grant_row.revoked_at IS NULL;

    UPDATE cloud_workspace_setup_runs setup
    SET state = 'cancelled', completed_at = now(),
        lease_owner = NULL, lease_expires_at = NULL,
        error_code = 'secret_binding_revoked', updated_at = now()
    FROM cloud_workspace_generation_secret_bindings link
    WHERE link.workspace_id = setup.workspace_id
      AND link.generation = setup.generation
      AND link.org_id = setup.org_id
      AND link.binding_id = NEW.id
      AND setup.state IN ('queued', 'running');

    UPDATE cloud_workspace_engine_instances engine
    SET state = 'revoked', revoked_at = coalesce(engine.revoked_at, now()),
        updated_at = now()
    FROM cloud_workspace_generation_secret_bindings link
    WHERE link.workspace_id = engine.workspace_id
      AND link.generation = engine.generation
      AND link.org_id = engine.org_id
      AND link.binding_id = NEW.id
      AND engine.state IN ('starting', 'ready');
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER secret_binding_authority_retirement
  AFTER UPDATE OF state ON secret_bindings
  FOR EACH ROW
  WHEN (OLD.state = 'active' AND NEW.state = 'revoked')
  EXECUTE FUNCTION retire_cloud_workspace_secret_binding_authority();

REVOKE ALL ON FUNCTION retire_cloud_workspace_secret_binding_authority()
  FROM PUBLIC;

ALTER TABLE cloud_workspace_generation_secret_bindings ENABLE ROW LEVEL SECURITY;
CREATE POLICY cloud_workspace_generation_secret_bindings_system
  ON cloud_workspace_generation_secret_bindings FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
ALTER TABLE cloud_workspace_generation_secret_bindings FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON cloud_workspace_generation_secret_bindings TO zeros_app;

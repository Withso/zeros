-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- A mutable owner/name cannot identify the repository that a secret was
-- configured for. Record only IDs observed by an admitted GitHub connection;
-- never backfill historical definitions by looking up today's reusable name.
ALTER TABLE organization_extensions ADD COLUMN repository_id bigint
  CHECK (repository_id IS NULL OR (repository_id BETWEEN 1 AND 9007199254740991 AND repository IS NOT NULL));
ALTER TABLE organization_extensions ADD COLUMN repository_identity_revision integer
  CHECK (repository_identity_revision IS NULL OR (repository_identity_revision > 0 AND repository_id IS NOT NULL));
-- Old APIs can save a new config revision without affirming its repository ID.
-- Only the revision explicitly bound by a new writer can release scoped tools.
ALTER TABLE organization_mcp_repositories ADD COLUMN repository_id bigint
  CHECK (repository_id BETWEEN 1 AND 9007199254740991);
ALTER TABLE organization_mcp_repositories ADD COLUMN identity_expires_at timestamptz;
-- Older APIs can renew expires_at without observing an ID. Equality with this
-- separate observation expiry fences those name-only writes during rollout.
CREATE UNIQUE INDEX organization_extensions_repository_identity_name
  ON organization_extensions (org_id,owner_user_id,kind,repository_id,(config->>'name'))
  NULLS NOT DISTINCT WHERE repository_id IS NOT NULL;

-- A rename may leave the checkout's original path and the definition's display
-- name different. Notify by recorded identity; a replacement at the old name
-- must not receive the definition or its refresh. Legacy Local definitions keep
-- their old notification behavior until an authorized save records an ID.
-- zeros-expand-exception: mcp-identity-notifications Retains legacy notification behavior and adds immutable-ID scope; signatures and execute privileges stay unchanged.
CREATE OR REPLACE FUNCTION organization_mcp_changed() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE previous public.organization_extensions; following public.organization_extensions;
BEGIN
  IF TG_OP <> 'INSERT' THEN previous := OLD; END IF;
  IF TG_OP <> 'DELETE' THEN following := NEW; END IF;
  UPDATE public.cloud_v2_workspaces w SET login_revision = login_revision + 1
    WHERE w.state <> 'deleted' AND (
      (w.org_id = previous.org_id AND (previous.owner_user_id IS NULL OR w.creator_user_id = previous.owner_user_id)
        AND (previous.repository IS NULL
          OR (previous.repository_id IS NULL AND lower(w.repository) = previous.repository)
          OR EXISTS (SELECT 1 FROM public.cloud_v2_github_sources s WHERE s.workspace_id=w.id
            AND s.source_repository=lower(w.repository) AND s.repository_id=previous.repository_id))) OR
      (w.org_id = following.org_id AND (following.owner_user_id IS NULL OR w.creator_user_id = following.owner_user_id)
        AND (following.repository IS NULL
          OR (following.repository_id IS NULL AND lower(w.repository) = following.repository)
          OR EXISTS (SELECT 1 FROM public.cloud_v2_github_sources s WHERE s.workspace_id=w.id
            AND s.source_repository=lower(w.repository) AND s.repository_id=following.repository_id))));
  IF FOUND THEN
    PERFORM pg_notify('zeros_cloud_v2_logins', json_build_object('ownerUserId', NULL, 'organizationId', coalesce(following.org_id, previous.org_id))::text);
  END IF;
  RETURN NULL;
END;
$$;

-- zeros-expand-exception: mcp-identity-sign-in Retains personal OAuth notification behavior and adds immutable-ID scope; signatures and execute privileges stay unchanged.
CREATE OR REPLACE FUNCTION organization_mcp_sign_in_changed() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE target public.organization_mcp_oauth; server public.organization_extensions;
BEGIN
  IF TG_OP = 'DELETE' THEN target := OLD; ELSE target := NEW; END IF;
  SELECT * INTO server FROM public.organization_extensions WHERE id = target.extension_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE public.cloud_v2_workspaces w SET login_revision = login_revision + 1
    WHERE w.org_id = target.org_id AND w.creator_user_id = target.owner_user_id AND w.state <> 'deleted'
      AND (server.repository IS NULL
        OR (server.repository_id IS NULL AND lower(w.repository) = server.repository)
        OR EXISTS (SELECT 1 FROM public.cloud_v2_github_sources s WHERE s.workspace_id=w.id
          AND s.source_repository=lower(w.repository) AND s.repository_id=server.repository_id));
  IF FOUND THEN
    PERFORM pg_notify('zeros_cloud_v2_logins', json_build_object('ownerUserId', target.owner_user_id, 'organizationId', target.org_id)::text);
  END IF;
  RETURN NULL;
END;
$$;

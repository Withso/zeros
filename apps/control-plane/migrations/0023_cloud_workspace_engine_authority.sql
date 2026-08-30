-- ───────────────────────────────────────────────────────────
-- 0023 — Engine membership retirement and repository-refresh fencing
--
-- A registered engine is account authority, not merely a process liveness
-- record. Membership removal must therefore retire the engine as well as
-- client access. Repository refresh requests are durably rate-fenced so a
-- lost response or compromised engine cannot mint once per heartbeat across
-- multiple control-plane replicas. No repository bearer is stored here.
-- ───────────────────────────────────────────────────────────
-- zeros:requires-controlled-downtime

-- Runtime transactions lock a workspace before touching its engine, setup, or
-- credential children. Acquire the corresponding table boundary before the
-- engine ALTER below; taking that schema lock first can deadlock a live
-- workspace-first transaction during a rolling deploy. EXCLUSIVE still permits
-- ordinary reads, but intentionally drains and blocks workspace row lockers for
-- the duration of this forward migration.
LOCK TABLE cloud_workspaces IN EXCLUSIVE MODE;

ALTER TABLE cloud_workspace_engine_instances
  ADD COLUMN repository_refresh_generation text CHECK (
    repository_refresh_generation IS NULL
    OR repository_refresh_generation ~ '^[A-Za-z0-9_-]{20,64}$'
  ),
  ADD COLUMN repository_refresh_claimed_at timestamptz,
  ADD CONSTRAINT cloud_workspace_engine_refresh_claim_check CHECK (
    (repository_refresh_generation IS NULL) =
    (repository_refresh_claimed_at IS NULL)
  );

-- Replace the Phase-2 membership triggers with the complete authority drain.
-- An `issuing` client grant can race the DELETE, so move it to the same durable
-- provider-wide revocation queue instead of relying only on the post-provider
-- publication check.
CREATE OR REPLACE FUNCTION revoke_cloud_workspace_access_for_org_member()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE cloud_workspace_client_access_grants
  SET state = 'revocation_pending',
      revocation_reason = 'organization_membership_removed',
      next_revocation_at = now(), updated_at = now()
  WHERE org_id = OLD.org_id AND account_user_id = OLD.user_id
    AND state IN ('issuing', 'active');

  UPDATE cloud_workspace_endpoint_grants
  SET revoked_at = coalesce(revoked_at, now())
  WHERE org_id = OLD.org_id AND account_user_id = OLD.user_id
    AND revoked_at IS NULL;

  UPDATE cloud_workspace_engine_instances
  SET state = 'revoked', revoked_at = coalesce(revoked_at, now()),
      updated_at = now()
  WHERE org_id = OLD.org_id AND account_user_id = OLD.user_id
    AND state IN ('starting', 'ready');
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION revoke_cloud_workspace_access_for_team_member()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE cloud_workspace_client_access_grants access
  SET state = 'revocation_pending',
      revocation_reason = 'team_membership_removed',
      next_revocation_at = now(), updated_at = now()
  FROM cloud_workspaces workspace
  WHERE workspace.id = access.workspace_id
    AND workspace.org_id = access.org_id
    AND workspace.team_id = OLD.team_id
    AND access.org_id = OLD.org_id
    AND access.account_user_id = OLD.user_id
    AND access.state IN ('issuing', 'active');

  UPDATE cloud_workspace_endpoint_grants grant_row
  SET revoked_at = coalesce(grant_row.revoked_at, now())
  FROM cloud_workspaces workspace
  WHERE workspace.id = grant_row.workspace_id
    AND workspace.org_id = grant_row.org_id
    AND workspace.team_id = OLD.team_id
    AND grant_row.org_id = OLD.org_id
    AND grant_row.account_user_id = OLD.user_id
    AND grant_row.revoked_at IS NULL;

  UPDATE cloud_workspace_engine_instances engine
  SET state = 'revoked', revoked_at = coalesce(engine.revoked_at, now()),
      updated_at = now()
  FROM cloud_workspaces workspace
  WHERE workspace.id = engine.workspace_id
    AND workspace.org_id = engine.org_id
    AND workspace.team_id = OLD.team_id
    AND engine.org_id = OLD.org_id
    AND engine.account_user_id = OLD.user_id
    AND engine.state IN ('starting', 'ready');
  RETURN OLD;
END;
$$;

-- Membership removal is intentionally permitted in a user-context
-- transaction. Once the row is deleted, app_user_org_ids() no longer exposes
-- the tenant, while credential/runtime tables are system-only under FORCE
-- RLS. The trigger functions therefore cross that one boundary as their
-- migration owner with a fixed search path; they are not general application
-- RPCs.
REVOKE ALL ON FUNCTION revoke_cloud_workspace_access_for_org_member()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION revoke_cloud_workspace_access_for_team_member()
  FROM PUBLIC;

-- A soft-deleted organization is deliberately retained for billing and audit
-- history, so its RESTRICT-linked sandboxes do not disappear by cascade. The
-- same is true for a soft-deleted Team. Until the explicit ownership model
-- ships, created_by is also the workspace's billing/authority owner; deleting
-- that account must fail closed instead of leaving paid compute ownerless.
-- Turn each tombstone into a durable, provider-verifiable delete request for
-- every generation; merely hiding it in RLS would strand remote compute.
CREATE FUNCTION drain_cloud_workspaces_for_deleted_scope(
  scope_org_id uuid,
  scope_team_id uuid,
  scope_owner_user_id uuid,
  retirement_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF retirement_reason NOT IN (
       'organization_deleted', 'team_deleted', 'workspace_owner_deleted'
     )
     OR (
       scope_org_id IS NULL
       AND scope_team_id IS NULL
       AND scope_owner_user_id IS NULL
     )
     OR (scope_team_id IS NOT NULL AND scope_org_id IS NULL) THEN
    RAISE EXCEPTION 'invalid cloud workspace retirement reason'
      USING ERRCODE = '22023';
  END IF;

  -- Scope tombstones and lifecycle/setup entry paths acquire the workspace
  -- before child rows. Lock the complete scope deterministically before
  -- touching grants, engines, runs, or intents so this function cannot
  -- introduce the inverse wait edge. Membership-only drains intentionally
  -- acquire no workspace row and follow the shared child-table order instead.
  PERFORM workspace.id
  FROM cloud_workspaces workspace
  WHERE (scope_org_id IS NULL OR workspace.org_id = scope_org_id)
    AND (scope_team_id IS NULL OR workspace.team_id = scope_team_id)
    AND (
      scope_owner_user_id IS NULL
      OR workspace.created_by = scope_owner_user_id
    )
  ORDER BY workspace.id
  FOR UPDATE;

  UPDATE cloud_workspace_client_access_grants access
  SET state = 'revocation_pending', revocation_reason = retirement_reason,
      next_revocation_at = now(), updated_at = now()
  FROM cloud_workspaces workspace
  WHERE workspace.id = access.workspace_id
    AND workspace.org_id = access.org_id
    AND (scope_org_id IS NULL OR workspace.org_id = scope_org_id)
    AND (scope_team_id IS NULL OR workspace.team_id = scope_team_id)
    AND (
      scope_owner_user_id IS NULL
      OR workspace.created_by = scope_owner_user_id
    )
    AND access.state IN ('issuing', 'active');

  UPDATE cloud_workspace_endpoint_grants grant_row
  SET revoked_at = coalesce(grant_row.revoked_at, now())
  FROM cloud_workspaces workspace
  WHERE workspace.id = grant_row.workspace_id
    AND workspace.org_id = grant_row.org_id
    AND (scope_org_id IS NULL OR workspace.org_id = scope_org_id)
    AND (scope_team_id IS NULL OR workspace.team_id = scope_team_id)
    AND (
      scope_owner_user_id IS NULL
      OR workspace.created_by = scope_owner_user_id
    )
    AND grant_row.revoked_at IS NULL;

  UPDATE cloud_workspace_engine_instances engine
  SET state = 'revoked', revoked_at = coalesce(engine.revoked_at, now()),
      updated_at = now()
  FROM cloud_workspaces workspace
  WHERE workspace.id = engine.workspace_id
    AND workspace.org_id = engine.org_id
    AND (scope_org_id IS NULL OR workspace.org_id = scope_org_id)
    AND (scope_team_id IS NULL OR workspace.team_id = scope_team_id)
    AND (
      scope_owner_user_id IS NULL
      OR workspace.created_by = scope_owner_user_id
    )
    AND engine.state IN ('starting', 'ready');

  UPDATE cloud_workspace_setup_runs setup
  SET state = 'cancelled', completed_at = now(),
      lease_owner = NULL, lease_expires_at = NULL,
      error_code = retirement_reason, updated_at = now()
  FROM cloud_workspaces workspace
  WHERE workspace.id = setup.workspace_id
    AND workspace.org_id = setup.org_id
    AND (scope_org_id IS NULL OR workspace.org_id = scope_org_id)
    AND (scope_team_id IS NULL OR workspace.team_id = scope_team_id)
    AND (
      scope_owner_user_id IS NULL
      OR workspace.created_by = scope_owner_user_id
    )
    AND setup.state IN ('queued', 'running');

  UPDATE cloud_workspace_generation_transitions transition
  SET state = 'cancelled', completed_at = now(),
      error_code = retirement_reason,
      error_message = 'Owning authority scope was deleted',
      updated_at = now()
  FROM cloud_workspaces workspace
  WHERE workspace.id = transition.workspace_id
    AND workspace.org_id = transition.org_id
    AND (scope_org_id IS NULL OR workspace.org_id = scope_org_id)
    AND (scope_team_id IS NULL OR workspace.team_id = scope_team_id)
    AND (
      scope_owner_user_id IS NULL
      OR workspace.created_by = scope_owner_user_id
    )
    AND transition.state IN (
      'draining', 'provisioning', 'setting_up', 'rolling_back'
    );

  -- Leave an already-active delete alone: it is valid cleanup work and may be
  -- waiting on an asynchronous provider deletion. Every other in-flight
  -- operation loses authority atomically with the scope tombstone.
  UPDATE cloud_workspace_lifecycle_intents intent
  SET state = 'superseded', completed_at = now(),
      lease_owner = NULL, lease_expires_at = NULL,
      error_code = retirement_reason,
      error_message = 'Owning authority scope was deleted',
      updated_at = now()
  FROM cloud_workspaces workspace
  WHERE workspace.id = intent.workspace_id
    AND workspace.org_id = intent.org_id
    AND (scope_org_id IS NULL OR workspace.org_id = scope_org_id)
    AND (scope_team_id IS NULL OR workspace.team_id = scope_team_id)
    AND (
      scope_owner_user_id IS NULL
      OR workspace.created_by = scope_owner_user_id
    )
    AND intent.operation <> 'delete'
    AND intent.state IN ('queued', 'dispatching', 'observing');

  UPDATE cloud_workspaces workspace
  SET desired_state = 'deleted', status = 'deleting',
      version = workspace.version + 1, updated_at = now()
  WHERE (scope_org_id IS NULL OR workspace.org_id = scope_org_id)
    AND (scope_team_id IS NULL OR workspace.team_id = scope_team_id)
    AND (
      scope_owner_user_id IS NULL
      OR workspace.created_by = scope_owner_user_id
    )
    AND workspace.status <> 'deleted';

  -- Repair a missing binding defensively. The reconciler can then discover a
  -- provider object by immutable workspace/generation labels before proving
  -- absence, even if an earlier coordinator crashed before binding its id.
  INSERT INTO cloud_workspace_provider_bindings (
    workspace_id, generation, org_id, provider
  )
  SELECT generation.workspace_id, generation.generation,
         generation.org_id, generation.provider
  FROM cloud_workspace_generations generation
  JOIN cloud_workspaces workspace
    ON workspace.id = generation.workspace_id
   AND workspace.org_id = generation.org_id
  WHERE (scope_org_id IS NULL OR workspace.org_id = scope_org_id)
    AND (scope_team_id IS NULL OR workspace.team_id = scope_team_id)
    AND (
      scope_owner_user_id IS NULL
      OR workspace.created_by = scope_owner_user_id
    )
    AND workspace.status <> 'deleted'
  ON CONFLICT (workspace_id, generation) DO NOTHING;

  INSERT INTO cloud_workspace_lifecycle_intents (
    workspace_id, generation, org_id, requested_by, operation,
    idempotency_key, request_sha256, affects_workspace
  )
  SELECT workspace.id, generation.generation, workspace.org_id, NULL,
         'delete'::cloud_workspace_operation,
         'system:' || retirement_reason || ':' || workspace.id::text ||
           ':g' || generation.generation::text,
         digest(
           retirement_reason || ':' || workspace.id::text || ':' ||
             generation.generation::text,
           'sha256'
         ),
         generation.generation = workspace.current_generation
  FROM cloud_workspaces workspace
  JOIN cloud_workspace_generations generation
    ON generation.workspace_id = workspace.id
   AND generation.org_id = workspace.org_id
  WHERE (scope_org_id IS NULL OR workspace.org_id = scope_org_id)
    AND (scope_team_id IS NULL OR workspace.team_id = scope_team_id)
    AND (
      scope_owner_user_id IS NULL
      OR workspace.created_by = scope_owner_user_id
    )
    AND workspace.status <> 'deleted'
    AND NOT EXISTS (
      SELECT 1
      FROM cloud_workspace_lifecycle_intents active_delete
      WHERE active_delete.workspace_id = workspace.id
        AND active_delete.org_id = workspace.org_id
        AND active_delete.generation = generation.generation
        AND active_delete.operation = 'delete'
        AND active_delete.state IN ('queued', 'dispatching', 'observing')
    )
  ON CONFLICT (org_id, idempotency_key) DO UPDATE
  SET state = 'queued', attempt_count = 0,
      lease_owner = NULL, lease_expires_at = NULL,
      next_attempt_at = now(), dispatched_at = NULL, completed_at = NULL,
      error_code = NULL, error_message = NULL, updated_at = now(),
      affects_workspace = EXCLUDED.affects_workspace
  WHERE cloud_workspace_lifecycle_intents.state IN (
    'succeeded', 'failed', 'superseded'
  );
END;
$$;

CREATE FUNCTION drain_cloud_workspaces_for_deleted_organization()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM drain_cloud_workspaces_for_deleted_scope(
    NEW.id, NULL, NULL, 'organization_deleted'
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER organization_cloud_workspace_retirement
  AFTER UPDATE OF deleted_at ON organizations
  FOR EACH ROW
  WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
  EXECUTE FUNCTION drain_cloud_workspaces_for_deleted_organization();

CREATE FUNCTION drain_cloud_workspaces_for_deleted_team()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM drain_cloud_workspaces_for_deleted_scope(
    NEW.org_id, NEW.id, NULL, 'team_deleted'
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER team_cloud_workspace_retirement
  AFTER UPDATE OF deleted_at ON teams
  FOR EACH ROW
  WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
  EXECUTE FUNCTION drain_cloud_workspaces_for_deleted_team();

-- Provider account deletion is both an ownership transition and an
-- authorization loss. Keep it in one trigger so PostgreSQL cannot run an
-- access-first trigger before the workspace-retirement trigger and create a
-- child-row -> workspace lock inversion. Owned workspaces are locked and
-- drained first; credentials the account holds in other workspaces are then
-- retired without acquiring any additional workspace locks.
CREATE FUNCTION retire_cloud_workspace_authority_for_deleted_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM drain_cloud_workspaces_for_deleted_scope(
    NULL, NULL, NEW.id, 'workspace_owner_deleted'
  );

  UPDATE cloud_workspace_client_access_grants
  SET state = 'revocation_pending',
      revocation_reason = 'account_deleted',
      next_revocation_at = now(), updated_at = now()
  WHERE account_user_id = NEW.id AND state IN ('issuing', 'active');

  UPDATE cloud_workspace_endpoint_grants
  SET revoked_at = coalesce(revoked_at, now())
  WHERE account_user_id = NEW.id AND revoked_at IS NULL;

  UPDATE cloud_workspace_engine_instances
  SET state = 'revoked', revoked_at = coalesce(revoked_at, now()),
      updated_at = now()
  WHERE account_user_id = NEW.id AND state IN ('starting', 'ready');

  RETURN NEW;
END;
$$;

CREATE TRIGGER user_cloud_workspace_authority_retirement
  AFTER UPDATE OF deleted_at ON users
  FOR EACH ROW
  WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
  EXECUTE FUNCTION retire_cloud_workspace_authority_for_deleted_user();

REVOKE ALL ON FUNCTION drain_cloud_workspaces_for_deleted_scope(
  uuid, uuid, uuid, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION drain_cloud_workspaces_for_deleted_organization()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION drain_cloud_workspaces_for_deleted_team()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION retire_cloud_workspace_authority_for_deleted_user()
  FROM PUBLIC;

-- Upgrade safety for a tombstone written before this trigger existed. An
-- organization-level drain already includes its Teams; avoid redundant work
-- for Team tombstones below a deleted organization.
DO $$
DECLARE
  deleted_scope record;
BEGIN
  FOR deleted_scope IN
    SELECT id FROM organizations WHERE deleted_at IS NOT NULL
  LOOP
    PERFORM drain_cloud_workspaces_for_deleted_scope(
      deleted_scope.id, NULL, NULL, 'organization_deleted'
    );
  END LOOP;

  FOR deleted_scope IN
    SELECT team.id, team.org_id
    FROM teams team
    JOIN organizations organization ON organization.id = team.org_id
    WHERE team.deleted_at IS NOT NULL AND organization.deleted_at IS NULL
  LOOP
    PERFORM drain_cloud_workspaces_for_deleted_scope(
      deleted_scope.org_id, deleted_scope.id, NULL, 'team_deleted'
    );
  END LOOP;

  FOR deleted_scope IN
    SELECT id FROM users WHERE deleted_at IS NOT NULL
  LOOP
    PERFORM drain_cloud_workspaces_for_deleted_scope(
      NULL, NULL, deleted_scope.id, 'workspace_owner_deleted'
    );
  END LOOP;
END;
$$;

-- Drain credentials held by already-deleted accounts only after every owner
-- workspace backfill above has taken its workspace-first locks. Running these
-- updates earlier would let a rolling migration hold a grant while waiting for
-- its workspace, inverting the order used by live lifecycle transactions.
UPDATE cloud_workspace_client_access_grants access
SET state = 'revocation_pending', revocation_reason = 'account_deleted',
    next_revocation_at = now(), updated_at = now()
FROM users account
WHERE account.id = access.account_user_id AND account.deleted_at IS NOT NULL
  AND access.state IN ('issuing', 'active');

UPDATE cloud_workspace_endpoint_grants grant_row
SET revoked_at = coalesce(grant_row.revoked_at, now())
FROM users account
WHERE account.id = grant_row.account_user_id AND account.deleted_at IS NOT NULL
  AND grant_row.revoked_at IS NULL;

UPDATE cloud_workspace_engine_instances engine
SET state = 'revoked', revoked_at = coalesce(engine.revoked_at, now()),
    updated_at = now()
FROM users account
WHERE account.id = engine.account_user_id AND account.deleted_at IS NOT NULL
  AND engine.state IN ('starting', 'ready');

-- ──────────────────────────────────────────────────────────
-- 0026 — canonical cloud identity, ownership, and paid-work authority
--
-- WorkOS proves identity and projects collaborative membership. It is not the
-- plan, seat, repository, quota, or workspace authorization database. This
-- migration adds those Zeros-owned dimensions and binds every paid execution
-- to an immutable billing-owner epoch.
--
-- Local workspaces receive global UUIDs in the device database. Copying local
-- to cloud creates a new row here; this schema never models placement as an
-- in-place move.
-- ──────────────────────────────────────────────────────────

-- Personal remains permanently device-local. Migration 0018 also rejects
-- Personal-owned cloud workspace rows at the database boundary; account
-- entitlements below are used for Pro Organization collaborator checks and do
-- not override that ownership invariant.

CREATE TABLE account_entitlements (
  user_id                    uuid PRIMARY KEY
                             REFERENCES users(id) ON DELETE CASCADE,
  plan                       text NOT NULL CHECK (plan IN ('free', 'pro')),
  status                     text NOT NULL CHECK (status IN (
                               'active', 'trialing', 'past_due', 'paused',
                               'cancelled', 'expired'
                             )),
  cloud_workspaces_allowed   boolean NOT NULL DEFAULT false,
  source                     text NOT NULL CHECK (source IN (
                               'stripe', 'operator', 'migration'
                             )),
  source_reference           text,
  valid_from                 timestamptz NOT NULL DEFAULT now(),
  valid_until                timestamptz,
  revision                   bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CHECK (source_reference IS NULL OR char_length(source_reference) <= 512),
  CHECK (valid_until IS NULL OR valid_until > valid_from),
  CHECK (cloud_workspaces_allowed = false OR plan = 'pro')
);

CREATE TABLE organization_entitlements (
  org_id                     uuid PRIMARY KEY
                             REFERENCES organizations(id) ON DELETE CASCADE,
  plan                       text NOT NULL CHECK (
                               plan IN ('pro', 'business', 'enterprise')
                             ),
  status                     text NOT NULL CHECK (status IN (
                               'active', 'trialing', 'past_due', 'paused',
                               'cancelled', 'expired'
                             )),
  cloud_workspaces_allowed   boolean NOT NULL DEFAULT false,
  seat_limit                 integer CHECK (seat_limit IS NULL OR seat_limit > 0),
  source                     text NOT NULL CHECK (source IN (
                               'stripe', 'contract', 'operator', 'migration'
                             )),
  source_reference           text,
  valid_from                 timestamptz NOT NULL DEFAULT now(),
  valid_until                timestamptz,
  revision                   bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CHECK (source_reference IS NULL OR char_length(source_reference) <= 512),
  CHECK (valid_until IS NULL OR valid_until > valid_from),
  CHECK (
    (plan = 'pro' AND seat_limit IS NULL)
    OR (plan IN ('business', 'enterprise') AND seat_limit IS NOT NULL)
  )
);

CREATE TABLE organization_seat_assignments (
  org_id                     uuid NOT NULL,
  user_id                    uuid NOT NULL,
  state                      text NOT NULL DEFAULT 'active'
                             CHECK (state IN ('active', 'released')),
  assigned_by                uuid REFERENCES users(id) ON DELETE SET NULL,
  assigned_at                timestamptz NOT NULL DEFAULT now(),
  released_at                timestamptz,
  revision                   bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  PRIMARY KEY (org_id, user_id),
  FOREIGN KEY (org_id, user_id)
    REFERENCES organization_members(org_id, user_id) ON DELETE CASCADE,
  CHECK (
    (state = 'active' AND released_at IS NULL)
    OR (state = 'released' AND released_at IS NOT NULL)
  )
);
CREATE INDEX organization_seat_assignments_active_idx
  ON organization_seat_assignments (org_id, assigned_at, user_id)
  WHERE state = 'active';

-- An explicit pre-0024 quota was an operator-approved paid-work gate. Preserve
-- that compatibility contract as a migration-sourced Business entitlement;
-- a billing synchronizer may replace it with Stripe/contract authority later.
INSERT INTO organization_entitlements (
  org_id, plan, status, cloud_workspaces_allowed, seat_limit, source
)
SELECT q.org_id, 'business', 'active', true,
       greatest(1, (
         SELECT count(*)::integer
         FROM organization_members om WHERE om.org_id = q.org_id
       )),
       'migration'
FROM cloud_workspace_quotas q
JOIN organizations o ON o.id = q.org_id AND NOT o.is_personal
ON CONFLICT (org_id) DO NOTHING;

INSERT INTO organization_seat_assignments (org_id, user_id, state)
SELECT oe.org_id, om.user_id, 'active'
FROM organization_entitlements oe
JOIN organization_members om ON om.org_id = oe.org_id
WHERE oe.plan IN ('business', 'enterprise')
ON CONFLICT (org_id, user_id) DO NOTHING;

CREATE TABLE repositories (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                     uuid NOT NULL
                             REFERENCES organizations(id) ON DELETE RESTRICT,
  forge                      text NOT NULL CHECK (
                               forge ~ '^[a-z0-9][a-z0-9.-]{0,254}$'
                             ),
  forge_repository_id        text NOT NULL CHECK (
                               char_length(forge_repository_id) BETWEEN 1 AND 512
                             ),
  identity_state             text NOT NULL DEFAULT 'verified'
                             CHECK (identity_state IN ('verified', 'legacy_unverified')),
  owner_name                 text NOT NULL CHECK (
                               char_length(owner_name) BETWEEN 1 AND 255
                             ),
  repository_name            text NOT NULL CHECK (
                               char_length(repository_name) BETWEEN 1 AND 255
                             ),
  clone_url                  text,
  web_url                    text,
  default_branch             text,
  visibility                 text NOT NULL DEFAULT 'private'
                             CHECK (visibility IN ('private', 'internal', 'public')),
  github_installation_id     uuid REFERENCES github_installations(id)
                             ON DELETE SET NULL,
  metadata_version           bigint NOT NULL DEFAULT 1 CHECK (metadata_version > 0),
  created_by                 uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  deleted_at                 timestamptz,
  UNIQUE (id, org_id),
  CHECK (clone_url IS NULL OR char_length(clone_url) <= 2048),
  CHECK (web_url IS NULL OR char_length(web_url) <= 2048),
  CHECK (default_branch IS NULL OR char_length(default_branch) <= 512)
);
CREATE UNIQUE INDEX repositories_live_forge_identity_unique
  ON repositories (org_id, forge, forge_repository_id)
  WHERE deleted_at IS NULL;
CREATE INDEX repositories_org_name_idx
  ON repositories (org_id, lower(owner_name), lower(repository_name), id)
  WHERE deleted_at IS NULL;

-- Shipped cloud rows predate a verified forge numeric identity. Keep them
-- addressable under a deliberately marked compatibility identity instead of
-- pretending owner/name is a verified GitHub repository id.
INSERT INTO repositories (
  org_id, forge, forge_repository_id, identity_state, owner_name,
  repository_name, github_installation_id, created_by, created_at, updated_at
)
SELECT DISTINCT ON (
         cw.org_id, cw.repository_forge, lower(cw.repository_owner),
         lower(cw.repository_name), coalesce(cw.github_installation_id::text, '')
       )
       cw.org_id,
       lower(cw.repository_forge),
       'legacy:' || encode(digest(
         cw.repository_forge || chr(31) || lower(cw.repository_owner) || chr(31) ||
         lower(cw.repository_name) || chr(31) ||
         coalesce(cw.github_installation_id::text, ''),
         'sha256'
       ), 'hex'),
       'legacy_unverified',
       cw.repository_owner,
       cw.repository_name,
       cw.github_installation_id,
       cw.created_by,
       min(cw.created_at) OVER (
         PARTITION BY cw.org_id, cw.repository_forge,
                      lower(cw.repository_owner), lower(cw.repository_name),
                      coalesce(cw.github_installation_id::text, '')
       ),
       max(cw.updated_at) OVER (
         PARTITION BY cw.org_id, cw.repository_forge,
                      lower(cw.repository_owner), lower(cw.repository_name),
                      coalesce(cw.github_installation_id::text, '')
       )
FROM cloud_workspaces cw
ORDER BY cw.org_id, cw.repository_forge, lower(cw.repository_owner),
         lower(cw.repository_name), coalesce(cw.github_installation_id::text, ''),
         cw.created_at, cw.id;

ALTER TABLE cloud_workspaces
  ADD COLUMN repository_id uuid,
  ADD COLUMN owner_user_id uuid,
  ADD COLUMN assignee_user_id uuid,
  ADD COLUMN visibility text NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'team')),
  ADD COLUMN single_member_mode boolean NOT NULL DEFAULT true,
  ADD COLUMN authority_epoch bigint NOT NULL DEFAULT 1 CHECK (authority_epoch > 0),
  ADD COLUMN current_billing_epoch bigint NOT NULL DEFAULT 1
    CHECK (current_billing_epoch > 0);

UPDATE cloud_workspaces cw
SET repository_id = repository.id,
    owner_user_id = cw.created_by,
    assignee_user_id = cw.created_by
FROM repositories repository
WHERE repository.org_id = cw.org_id
  AND repository.forge = lower(cw.repository_forge)
  AND repository.owner_name = cw.repository_owner
  AND repository.repository_name = cw.repository_name
  AND repository.github_installation_id IS NOT DISTINCT FROM cw.github_installation_id
  AND repository.identity_state = 'legacy_unverified';

ALTER TABLE cloud_workspaces
  ALTER COLUMN repository_id SET NOT NULL,
  ALTER COLUMN owner_user_id SET NOT NULL,
  ALTER COLUMN assignee_user_id SET NOT NULL,
  ADD CONSTRAINT cloud_workspaces_repository_fkey
    FOREIGN KEY (repository_id, org_id)
    REFERENCES repositories(id, org_id) ON DELETE RESTRICT;

-- WorkOS deprovisioning must be able to remove a membership immediately. A
-- permanent composite FK would strand paid compute by blocking that removal.
-- Validate ownership on workspace writes instead; membership-removal triggers
-- then revoke runtime authority while the historical owner UUID remains.
CREATE FUNCTION enforce_cloud_workspace_member_owners() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM organization_members
       WHERE org_id = NEW.org_id AND user_id = NEW.owner_user_id
     ) OR NOT EXISTS (
       SELECT 1 FROM organization_members
       WHERE org_id = NEW.org_id AND user_id = NEW.assignee_user_id
     ) THEN
    RAISE EXCEPTION 'cloud workspace owner and assignee must belong to the organization'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER cloud_workspace_member_owners_enforced
  BEFORE INSERT OR UPDATE OF org_id, owner_user_id, assignee_user_id
  ON cloud_workspaces
  FOR EACH ROW EXECUTE FUNCTION enforce_cloud_workspace_member_owners();
REVOKE ALL ON FUNCTION enforce_cloud_workspace_member_owners() FROM PUBLIC;

CREATE INDEX cloud_workspaces_owner_idx
  ON cloud_workspaces (owner_user_id, updated_at DESC, id)
  WHERE status <> 'deleted';
CREATE INDEX cloud_workspaces_repository_idx
  ON cloud_workspaces (repository_id, created_at DESC, id);

CREATE TABLE cloud_workspace_members (
  workspace_id               uuid NOT NULL,
  org_id                     uuid NOT NULL,
  user_id                    uuid NOT NULL,
  role                       text NOT NULL CHECK (
                               role IN ('viewer', 'prompter', 'developer', 'manager', 'owner')
                             ),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id),
  FOREIGN KEY (workspace_id, org_id)
    REFERENCES cloud_workspaces(id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, user_id)
    REFERENCES organization_members(org_id, user_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX cloud_workspace_one_owner_idx
  ON cloud_workspace_members (workspace_id)
  WHERE role = 'owner';
CREATE INDEX cloud_workspace_members_user_idx
  ON cloud_workspace_members (user_id, workspace_id);

INSERT INTO cloud_workspace_members (workspace_id, org_id, user_id, role)
SELECT workspace.id, workspace.org_id, workspace.owner_user_id, 'owner'
FROM cloud_workspaces workspace
JOIN organization_members member
  ON member.org_id = workspace.org_id
 AND member.user_id = workspace.owner_user_id
JOIN team_members team_member
  ON team_member.team_id = workspace.team_id
 AND team_member.org_id = workspace.org_id
 AND team_member.user_id = workspace.owner_user_id
ON CONFLICT (workspace_id, user_id) DO NOTHING;

CREATE TABLE workspace_billing_epochs (
  workspace_id               uuid NOT NULL,
  billing_epoch              bigint NOT NULL CHECK (billing_epoch > 0),
  org_id                     uuid NOT NULL,
  billing_owner_user_id      uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  entitlement_scope          text NOT NULL CHECK (
                               entitlement_scope IN ('account', 'organization')
                             ),
  entitlement_plan           text NOT NULL CHECK (
                               entitlement_plan IN ('pro', 'business', 'enterprise',
                                                    'legacy_operator')
                             ),
  entitlement_revision       bigint NOT NULL CHECK (entitlement_revision > 0),
  started_at                 timestamptz NOT NULL DEFAULT now(),
  ended_at                   timestamptz,
  created_by                 uuid REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (workspace_id, billing_epoch),
  UNIQUE (workspace_id, billing_epoch, org_id),
  FOREIGN KEY (workspace_id, org_id)
    REFERENCES cloud_workspaces(id, org_id) ON DELETE CASCADE,
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE UNIQUE INDEX workspace_billing_one_live_epoch_idx
  ON workspace_billing_epochs (workspace_id)
  WHERE ended_at IS NULL;

INSERT INTO workspace_billing_epochs (
  workspace_id, billing_epoch, org_id, billing_owner_user_id,
  entitlement_scope, entitlement_plan, entitlement_revision, created_by
)
SELECT cw.id, 1, cw.org_id, cw.owner_user_id,
       CASE WHEN o.is_personal THEN 'account' ELSE 'organization' END,
       CASE
         WHEN o.is_personal THEN 'pro'
         WHEN oe.plan IS NULL THEN 'legacy_operator'
         ELSE oe.plan
       END,
       coalesce(ae.revision, oe.revision, 1),
       cw.created_by
FROM cloud_workspaces cw
JOIN organizations o ON o.id = cw.org_id
LEFT JOIN account_entitlements ae ON ae.user_id = cw.owner_user_id
LEFT JOIN organization_entitlements oe ON oe.org_id = cw.org_id;

ALTER TABLE cloud_workspaces
  ADD CONSTRAINT cloud_workspaces_current_billing_epoch_fkey
  FOREIGN KEY (id, current_billing_epoch, org_id)
  REFERENCES workspace_billing_epochs(workspace_id, billing_epoch, org_id)
  DEFERRABLE INITIALLY DEFERRED;

-- One read-only database predicate protects non-HTTP runtime paths (workers,
-- capability redemption, preview proxying, and engine heartbeats). Mutating
-- routes additionally take the organization lock and return precise errors,
-- but no credential path may accidentally implement a weaker subset.
CREATE FUNCTION cloud_workspace_paid_authority_live(
  target_workspace_id uuid,
  target_user_id uuid,
  require_workos boolean
) RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM cloud_workspaces cw
    JOIN organizations organization
      ON organization.id = cw.org_id
     AND organization.deleted_at IS NULL
     AND organization.cloud_workspaces_allowed
    JOIN users account
      ON account.id = target_user_id
     AND account.deleted_at IS NULL
     AND account.auth_status = 'active'
    JOIN organization_members member
      ON member.org_id = cw.org_id AND member.user_id = account.id
    JOIN teams team
      ON team.id = cw.team_id AND team.org_id = cw.org_id
     AND team.deleted_at IS NULL
    JOIN team_members team_member
      ON team_member.team_id = team.id AND team_member.org_id = cw.org_id
     AND team_member.user_id = account.id
    JOIN workspace_billing_epochs billing
      ON billing.workspace_id = cw.id
     AND billing.billing_epoch = cw.current_billing_epoch
     AND billing.org_id = cw.org_id
     AND billing.ended_at IS NULL
     AND billing.billing_owner_user_id = target_user_id
    WHERE cw.id = target_workspace_id
      AND cw.deleted_at IS NULL
      AND cw.owner_user_id = target_user_id
      AND cw.single_member_mode
      AND (
        (
          organization.is_personal
          AND organization.created_by = target_user_id
          AND (
            SELECT count(*) FROM organization_members personal_member
            WHERE personal_member.org_id = organization.id
          ) = 1
          AND billing.entitlement_scope = 'account'
          AND billing.entitlement_plan = 'pro'
          AND EXISTS (
            SELECT 1 FROM account_entitlements entitlement
            WHERE entitlement.user_id = target_user_id
              AND entitlement.plan = 'pro'
              AND entitlement.status IN ('active', 'trialing')
              AND entitlement.cloud_workspaces_allowed
              AND (
                entitlement.valid_until IS NULL
                OR entitlement.valid_until > now()
              )
              AND entitlement.revision = billing.entitlement_revision
          )
        ) OR (
          NOT organization.is_personal
          AND (
            NOT require_workos OR EXISTS (
              SELECT 1 FROM workos_organization_links workos_link
              WHERE workos_link.organization_id = organization.id
                AND workos_link.state = 'active'
                AND workos_link.workos_organization_id IS NOT NULL
            )
          )
          AND billing.entitlement_scope = 'organization'
          AND EXISTS (
            SELECT 1
            FROM organization_entitlements entitlement
            WHERE entitlement.org_id = organization.id
              AND entitlement.plan::text = billing.entitlement_plan
              AND entitlement.status IN ('active', 'trialing')
              AND entitlement.cloud_workspaces_allowed
              AND (
                entitlement.valid_until IS NULL
                OR entitlement.valid_until > now()
              )
              AND entitlement.revision = billing.entitlement_revision
              AND (
                (
                  entitlement.plan = 'pro'
                  AND (
                    SELECT count(*) FROM organization_members collaborator
                    WHERE collaborator.org_id = organization.id
                  ) <= 5
                  AND NOT EXISTS (
                    SELECT 1
                    FROM organization_members collaborator
                    JOIN users collaborator_account
                      ON collaborator_account.id = collaborator.user_id
                    LEFT JOIN account_entitlements collaborator_entitlement
                      ON collaborator_entitlement.user_id = collaborator.user_id
                    WHERE collaborator.org_id = organization.id
                      AND (
                        collaborator_account.deleted_at IS NOT NULL
                        OR collaborator_account.auth_status <> 'active'
                        OR collaborator_entitlement.plan IS DISTINCT FROM 'pro'
                        OR collaborator_entitlement.status NOT IN (
                          'active', 'trialing'
                        )
                        OR NOT coalesce(
                          collaborator_entitlement.cloud_workspaces_allowed,
                          false
                        )
                        OR (
                          collaborator_entitlement.valid_until IS NOT NULL
                          AND collaborator_entitlement.valid_until <= now()
                        )
                      )
                  )
                ) OR (
                  entitlement.plan IN ('business', 'enterprise')
                  AND EXISTS (
                    SELECT 1 FROM organization_seat_assignments seat
                    WHERE seat.org_id = organization.id
                      AND seat.user_id = target_user_id
                      AND seat.state = 'active'
                  )
                  AND (
                    SELECT count(*) FROM organization_seat_assignments seat
                    WHERE seat.org_id = organization.id
                      AND seat.state = 'active'
                  ) <= entitlement.seat_limit
                )
              )
          )
        )
      )
  )
$$;
REVOKE ALL ON FUNCTION cloud_workspace_paid_authority_live(uuid, uuid, boolean)
  FROM PUBLIC;
GRANT EXECUTE
  ON FUNCTION cloud_workspace_paid_authority_live(uuid, uuid, boolean)
  TO zeros_app;

CREATE TABLE cloud_workspace_ownership_transfers (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id               uuid NOT NULL,
  org_id                     uuid NOT NULL,
  from_owner_user_id         uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  to_owner_user_id           uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  requested_by               uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  state                      text NOT NULL DEFAULT 'pending' CHECK (
                               state IN ('pending', 'accepted', 'cancelled', 'expired', 'failed')
                             ),
  expected_workspace_version bigint NOT NULL CHECK (expected_workspace_version > 0),
  accepted_at                timestamptz,
  completed_at               timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  expires_at                 timestamptz NOT NULL DEFAULT now() + interval '7 days',
  FOREIGN KEY (workspace_id, org_id)
    REFERENCES cloud_workspaces(id, org_id) ON DELETE CASCADE,
  CHECK (from_owner_user_id <> to_owner_user_id),
  CHECK (expires_at > created_at)
);
CREATE UNIQUE INDEX cloud_workspace_one_pending_transfer_idx
  ON cloud_workspace_ownership_transfers (workspace_id)
  WHERE state = 'pending';

CREATE TABLE cloud_workspace_usage_events (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                     uuid NOT NULL,
  workspace_id               uuid NOT NULL,
  generation                 integer NOT NULL,
  authority_epoch            bigint NOT NULL CHECK (authority_epoch > 0),
  actor_user_id              uuid REFERENCES users(id) ON DELETE SET NULL,
  billing_owner_user_id      uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  billing_epoch              bigint NOT NULL CHECK (billing_epoch > 0),
  provider                   text NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 64),
  meter                      text NOT NULL CHECK (
                               meter IN ('cpu_millisecond', 'memory_mib_millisecond',
                                         'storage_mib_hour', 'egress_byte',
                                         'agent_input_token', 'agent_output_token',
                                         'agent_cached_token', 'agent_invocation')
                             ),
  quantity                   numeric(30, 6) NOT NULL CHECK (quantity >= 0),
  source_idempotency_key     text NOT NULL CHECK (
                               char_length(source_idempotency_key) BETWEEN 8 AND 512
                             ),
  occurred_at                timestamptz NOT NULL,
  received_at                timestamptz NOT NULL DEFAULT now(),
  metadata                   jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
                               jsonb_typeof(metadata) = 'object'
                               AND octet_length(metadata::text) <= 8192
                             ),
  FOREIGN KEY (workspace_id, generation, org_id)
    REFERENCES cloud_workspace_generations(workspace_id, generation, org_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, billing_epoch, org_id)
    REFERENCES workspace_billing_epochs(workspace_id, billing_epoch, org_id)
    ON DELETE RESTRICT,
  UNIQUE (provider, source_idempotency_key)
);
CREATE INDEX cloud_workspace_usage_billing_idx
  ON cloud_workspace_usage_events (
    billing_owner_user_id, occurred_at DESC, id
  );
CREATE INDEX cloud_workspace_usage_workspace_idx
  ON cloud_workspace_usage_events (workspace_id, occurred_at DESC, id);

CREATE FUNCTION reject_cloud_workspace_usage_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'cloud workspace usage events are append-only'
    USING ERRCODE = '55000';
END
$$;
CREATE TRIGGER cloud_workspace_usage_append_only
  BEFORE UPDATE OR DELETE ON cloud_workspace_usage_events
  FOR EACH ROW EXECUTE FUNCTION reject_cloud_workspace_usage_mutation();
CREATE TRIGGER cloud_workspace_usage_no_truncate
  BEFORE TRUNCATE ON cloud_workspace_usage_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_cloud_workspace_usage_mutation();

CREATE TABLE workspace_executions (
  workspace_id               uuid NOT NULL,
  execution_id               uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id                     uuid NOT NULL,
  generation                 integer NOT NULL,
  authority_epoch            bigint NOT NULL CHECK (authority_epoch > 0),
  placement                  text NOT NULL CHECK (placement = 'cloud'),
  state                      text NOT NULL CHECK (
                               state IN ('provisioning', 'active', 'stopped', 'archived',
                                         'retired', 'deleted', 'failed')
                             ),
  started_at                 timestamptz NOT NULL DEFAULT now(),
  ended_at                   timestamptz,
  PRIMARY KEY (workspace_id, execution_id),
  UNIQUE (workspace_id, generation),
  FOREIGN KEY (workspace_id, generation, org_id)
    REFERENCES cloud_workspace_generations(workspace_id, generation, org_id)
    ON DELETE CASCADE,
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE UNIQUE INDEX workspace_one_live_execution_idx
  ON workspace_executions (workspace_id, authority_epoch)
  WHERE ended_at IS NULL AND state IN ('provisioning', 'active');

INSERT INTO workspace_executions (
  workspace_id, org_id, generation, authority_epoch, placement, state,
  started_at, ended_at
)
SELECT g.workspace_id, g.org_id, g.generation, cw.authority_epoch, 'cloud',
       CASE
         WHEN g.retired_at IS NOT NULL THEN 'retired'
         WHEN cw.current_generation = g.generation AND cw.status IN ('ready', 'busy')
           THEN 'active'
         WHEN cw.current_generation = g.generation AND cw.status = 'stopped'
           THEN 'stopped'
         WHEN cw.current_generation = g.generation AND cw.status = 'archived'
           THEN 'archived'
         WHEN cw.current_generation = g.generation AND cw.status = 'deleted'
           THEN 'deleted'
         WHEN cw.current_generation = g.generation AND cw.status = 'failed'
           THEN 'failed'
         ELSE 'provisioning'
       END,
       g.created_at,
       CASE
         WHEN g.retired_at IS NOT NULL THEN g.retired_at
         WHEN cw.current_generation <> g.generation THEN coalesce(g.retired_at, cw.updated_at)
         WHEN cw.status = 'deleted' THEN cw.deleted_at
         ELSE NULL
       END
FROM cloud_workspace_generations g
JOIN cloud_workspaces cw ON cw.id = g.workspace_id AND cw.org_id = g.org_id;

CREATE TABLE cloud_workspace_outbox (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence                   bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  org_id                     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id               uuid,
  event_type                 text NOT NULL CHECK (
                               event_type ~ '^[a-z][a-z0-9_.-]{2,127}$'
                             ),
  aggregate_key              text NOT NULL CHECK (
                               char_length(aggregate_key) BETWEEN 3 AND 255
                             ),
  aggregate_revision         bigint NOT NULL CHECK (aggregate_revision > 0),
  idempotency_key            text NOT NULL UNIQUE CHECK (
                               char_length(idempotency_key) BETWEEN 8 AND 255
                             ),
  payload                    jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
                               jsonb_typeof(payload) = 'object'
                               AND octet_length(payload::text) <= 65536
                             ),
  state                      text NOT NULL DEFAULT 'queued' CHECK (
                               state IN ('queued', 'processing', 'succeeded', 'dead')
                             ),
  attempt_count              integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at            timestamptz NOT NULL DEFAULT now(),
  lease_owner                text,
  lease_expires_at           timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  completed_at               timestamptz,
  UNIQUE (aggregate_key, aggregate_revision),
  FOREIGN KEY (workspace_id, org_id)
    REFERENCES cloud_workspaces(id, org_id) ON DELETE CASCADE,
  CHECK (lease_owner IS NULL OR char_length(lease_owner) <= 255),
  CHECK (
    (state = 'processing' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (state <> 'processing' AND lease_owner IS NULL AND lease_expires_at IS NULL)
  ),
  CHECK (
    (state IN ('succeeded', 'dead') AND completed_at IS NOT NULL)
    OR (state IN ('queued', 'processing') AND completed_at IS NULL)
  )
);
CREATE INDEX cloud_workspace_outbox_claim_idx
  ON cloud_workspace_outbox (next_attempt_at, sequence)
  WHERE state IN ('queued', 'processing');

ALTER TABLE account_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_seat_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE repositories ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_billing_epochs ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_ownership_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_outbox ENABLE ROW LEVEL SECURITY;

CREATE POLICY account_entitlements_read ON account_entitlements FOR SELECT
  USING (app_is_system() OR user_id = app_current_user());
CREATE POLICY account_entitlements_system ON account_entitlements FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());

CREATE POLICY organization_entitlements_read ON organization_entitlements FOR SELECT
  USING (app_is_system() OR org_id IN (SELECT app_user_org_ids()));
CREATE POLICY organization_entitlements_system ON organization_entitlements FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());

CREATE POLICY organization_seats_read ON organization_seat_assignments FOR SELECT
  USING (app_is_system() OR org_id IN (SELECT app_user_org_ids()));
CREATE POLICY organization_seats_system ON organization_seat_assignments FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());

CREATE POLICY repositories_read ON repositories FOR SELECT
  USING (app_is_system() OR org_id IN (SELECT app_user_org_ids()));
CREATE POLICY repositories_system ON repositories FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());

CREATE POLICY cloud_workspace_members_read ON cloud_workspace_members FOR SELECT
  USING (app_is_system() OR org_id IN (SELECT app_user_org_ids()));
CREATE POLICY cloud_workspace_members_system ON cloud_workspace_members FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());

CREATE POLICY workspace_billing_epochs_read ON workspace_billing_epochs FOR SELECT
  USING (app_is_system() OR org_id IN (SELECT app_user_org_ids()));
CREATE POLICY workspace_billing_epochs_system ON workspace_billing_epochs FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());

CREATE POLICY cloud_workspace_transfers_read
  ON cloud_workspace_ownership_transfers FOR SELECT
  USING (app_is_system() OR org_id IN (SELECT app_user_org_ids()));
CREATE POLICY cloud_workspace_transfers_system
  ON cloud_workspace_ownership_transfers FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());

CREATE POLICY cloud_workspace_usage_read ON cloud_workspace_usage_events FOR SELECT
  USING (app_is_system() OR org_id IN (SELECT app_user_org_ids()));
CREATE POLICY cloud_workspace_usage_system ON cloud_workspace_usage_events FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());

CREATE POLICY workspace_executions_read ON workspace_executions FOR SELECT
  USING (app_is_system() OR org_id IN (SELECT app_user_org_ids()));
CREATE POLICY workspace_executions_system ON workspace_executions FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());

CREATE POLICY cloud_workspace_outbox_system ON cloud_workspace_outbox FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());

ALTER TABLE account_entitlements FORCE ROW LEVEL SECURITY;
ALTER TABLE organization_entitlements FORCE ROW LEVEL SECURITY;
ALTER TABLE organization_seat_assignments FORCE ROW LEVEL SECURITY;
ALTER TABLE repositories FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_members FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_billing_epochs FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_ownership_transfers FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_usage_events FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_executions FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_outbox FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  account_entitlements, organization_entitlements,
  organization_seat_assignments, repositories, cloud_workspace_members,
  workspace_billing_epochs, cloud_workspace_ownership_transfers,
  cloud_workspace_usage_events, workspace_executions, cloud_workspace_outbox
TO zeros_app;
GRANT USAGE, SELECT ON SEQUENCE cloud_workspace_outbox_sequence_seq TO zeros_app;

REVOKE ALL ON FUNCTION reject_cloud_workspace_usage_mutation() FROM PUBLIC;

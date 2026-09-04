-- ───────────────────────────────────────────────────────────
-- 0046 — paid-authority invalidation and scheduled checks
--
-- Runtime predicates already fail closed immediately when WorkOS identity,
-- membership, seats, or entitlements disappear. Remote provider compute also
-- needs durable cleanup, and time-based entitlement expiry has no row-change
-- event. Persist a small invalidation queue so a coordinator can distinguish a
-- valid entitlement revision (open a new billing epoch) from lost authority
-- (revoke runtime access and stop every provider generation).
-- ───────────────────────────────────────────────────────────

-- Phase 5 is intentionally owner-only. The owner membership projection and
-- assignee equality are authority edges, not presentation metadata.
CREATE OR REPLACE FUNCTION cloud_workspace_paid_authority_live(
  target_workspace_id uuid,
  target_user_id uuid,
  require_workos boolean
) RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
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
    JOIN cloud_workspace_members workspace_member
      ON workspace_member.workspace_id = cw.id
     AND workspace_member.org_id = cw.org_id
     AND workspace_member.user_id = account.id
     AND workspace_member.role = 'owner'
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
      AND cw.assignee_user_id = target_user_id
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

CREATE TABLE cloud_workspace_paid_authority_checks (
  workspace_id               uuid PRIMARY KEY,
  org_id                     uuid NOT NULL,
  next_check_at              timestamptz,
  reason                     text NOT NULL CHECK (
                               char_length(reason) BETWEEN 1 AND 128
                             ),
  enqueued_at                timestamptz NOT NULL DEFAULT now(),
  last_checked_at            timestamptz,
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, org_id)
    REFERENCES cloud_workspaces(id, org_id) ON DELETE CASCADE
);
CREATE INDEX cloud_workspace_paid_authority_checks_due_idx
  ON cloud_workspace_paid_authority_checks (next_check_at, workspace_id)
  WHERE next_check_at IS NOT NULL;

CREATE FUNCTION enqueue_cloud_workspace_paid_authority_checks(
  scope_org_id uuid,
  scope_user_id uuid,
  invalidation_reason text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF (scope_org_id IS NULL AND scope_user_id IS NULL)
     OR invalidation_reason IS NULL
     OR char_length(invalidation_reason) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'invalid cloud workspace authority-check scope'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO cloud_workspace_paid_authority_checks (
    workspace_id, org_id, next_check_at, reason, enqueued_at, updated_at
  )
  SELECT workspace.id, workspace.org_id, now(), invalidation_reason,
         now(), now()
  FROM cloud_workspaces workspace
  WHERE workspace.status <> 'deleted'
    AND (
      (scope_org_id IS NOT NULL AND workspace.org_id = scope_org_id)
      OR (
        scope_user_id IS NOT NULL
        AND (
          workspace.owner_user_id = scope_user_id
          OR EXISTS (
            SELECT 1 FROM organization_members membership
            WHERE membership.org_id = workspace.org_id
              AND membership.user_id = scope_user_id
          )
        )
      )
    )
  ON CONFLICT (workspace_id) DO UPDATE
  SET next_check_at = CASE
        WHEN cloud_workspace_paid_authority_checks.next_check_at IS NULL
          THEN EXCLUDED.next_check_at
        ELSE least(
          cloud_workspace_paid_authority_checks.next_check_at,
          EXCLUDED.next_check_at
        )
      END,
      reason = EXCLUDED.reason,
      enqueued_at = EXCLUDED.enqueued_at,
      updated_at = now();
END;
$$;

CREATE FUNCTION enqueue_cloud_authority_for_account_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  affected_user_id uuid;
BEGIN
  affected_user_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END;
  PERFORM enqueue_cloud_workspace_paid_authority_checks(
    NULL, affected_user_id, 'account_entitlement_changed'
  );
  RETURN coalesce(NEW, OLD);
END;
$$;
CREATE TRIGGER account_entitlement_cloud_authority_check
  AFTER INSERT OR UPDATE OR DELETE ON account_entitlements
  FOR EACH ROW EXECUTE FUNCTION enqueue_cloud_authority_for_account_change();

CREATE FUNCTION enqueue_cloud_authority_for_organization_entitlement_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  affected_org_id uuid;
BEGIN
  affected_org_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.org_id ELSE NEW.org_id END;
  PERFORM enqueue_cloud_workspace_paid_authority_checks(
    affected_org_id, NULL, 'organization_entitlement_changed'
  );
  RETURN coalesce(NEW, OLD);
END;
$$;
CREATE TRIGGER organization_entitlement_cloud_authority_check
  AFTER INSERT OR UPDATE OR DELETE ON organization_entitlements
  FOR EACH ROW
  EXECUTE FUNCTION enqueue_cloud_authority_for_organization_entitlement_change();

CREATE FUNCTION enqueue_cloud_authority_for_seat_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  affected_org_id uuid;
BEGIN
  affected_org_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.org_id ELSE NEW.org_id END;
  PERFORM enqueue_cloud_workspace_paid_authority_checks(
    affected_org_id, NULL, 'organization_seat_changed'
  );
  RETURN coalesce(NEW, OLD);
END;
$$;
CREATE TRIGGER organization_seat_cloud_authority_check
  AFTER INSERT OR UPDATE OR DELETE ON organization_seat_assignments
  FOR EACH ROW EXECUTE FUNCTION enqueue_cloud_authority_for_seat_change();

CREATE FUNCTION enqueue_cloud_authority_for_membership_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  affected_org_id uuid;
BEGIN
  affected_org_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.org_id ELSE NEW.org_id END;
  PERFORM enqueue_cloud_workspace_paid_authority_checks(
    affected_org_id, NULL, 'organization_membership_changed'
  );
  IF TG_OP = 'UPDATE' AND OLD.org_id IS DISTINCT FROM NEW.org_id THEN
    PERFORM enqueue_cloud_workspace_paid_authority_checks(
      OLD.org_id, NULL, 'organization_membership_changed'
    );
  END IF;
  RETURN coalesce(NEW, OLD);
END;
$$;
CREATE TRIGGER organization_membership_cloud_authority_check
  AFTER INSERT OR UPDATE OR DELETE ON organization_members
  FOR EACH ROW EXECUTE FUNCTION enqueue_cloud_authority_for_membership_change();

CREATE FUNCTION enqueue_cloud_authority_for_team_membership_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  affected_org_id uuid;
BEGIN
  affected_org_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.org_id ELSE NEW.org_id END;
  PERFORM enqueue_cloud_workspace_paid_authority_checks(
    affected_org_id, NULL, 'team_membership_changed'
  );
  IF TG_OP = 'UPDATE' AND OLD.org_id IS DISTINCT FROM NEW.org_id THEN
    PERFORM enqueue_cloud_workspace_paid_authority_checks(
      OLD.org_id, NULL, 'team_membership_changed'
    );
  END IF;
  RETURN coalesce(NEW, OLD);
END;
$$;
CREATE TRIGGER team_membership_cloud_authority_check
  AFTER INSERT OR UPDATE OR DELETE ON team_members
  FOR EACH ROW
  EXECUTE FUNCTION enqueue_cloud_authority_for_team_membership_change();

CREATE FUNCTION enqueue_cloud_authority_for_workspace_membership_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  affected_org_id uuid;
BEGIN
  affected_org_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.org_id ELSE NEW.org_id END;
  PERFORM enqueue_cloud_workspace_paid_authority_checks(
    affected_org_id, NULL, 'workspace_membership_changed'
  );
  RETURN coalesce(NEW, OLD);
END;
$$;
CREATE TRIGGER cloud_workspace_membership_authority_check
  AFTER INSERT OR UPDATE OR DELETE ON cloud_workspace_members
  FOR EACH ROW
  EXECUTE FUNCTION enqueue_cloud_authority_for_workspace_membership_change();

CREATE FUNCTION enqueue_cloud_authority_for_user_auth_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  PERFORM enqueue_cloud_workspace_paid_authority_checks(
    NULL, NEW.id, 'account_authentication_changed'
  );
  RETURN NEW;
END;
$$;
CREATE TRIGGER user_auth_cloud_authority_check
  AFTER UPDATE OF auth_status, deleted_at ON users
  FOR EACH ROW
  WHEN (
    OLD.auth_status IS DISTINCT FROM NEW.auth_status
    OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at
  )
  EXECUTE FUNCTION enqueue_cloud_authority_for_user_auth_change();

CREATE FUNCTION enqueue_cloud_authority_for_workos_link_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  affected_org_id uuid;
BEGIN
  affected_org_id := CASE
    WHEN TG_OP = 'DELETE' THEN OLD.organization_id
    ELSE NEW.organization_id
  END;
  PERFORM enqueue_cloud_workspace_paid_authority_checks(
    affected_org_id, NULL, 'workos_organization_link_changed'
  );
  RETURN coalesce(NEW, OLD);
END;
$$;
CREATE TRIGGER workos_link_cloud_authority_check
  AFTER INSERT OR UPDATE OR DELETE ON workos_organization_links
  FOR EACH ROW EXECUTE FUNCTION enqueue_cloud_authority_for_workos_link_change();

CREATE FUNCTION enqueue_cloud_authority_for_organization_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  PERFORM enqueue_cloud_workspace_paid_authority_checks(
    NEW.id, NULL, 'organization_authority_changed'
  );
  RETURN NEW;
END;
$$;
CREATE TRIGGER organization_cloud_authority_check
  AFTER UPDATE OF cloud_workspaces_allowed, deleted_at ON organizations
  FOR EACH ROW
  WHEN (
    OLD.cloud_workspaces_allowed IS DISTINCT FROM NEW.cloud_workspaces_allowed
    OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at
  )
  EXECUTE FUNCTION enqueue_cloud_authority_for_organization_change();

CREATE FUNCTION maintain_cloud_workspace_authority_check()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT'
     OR (
       NEW.desired_state = 'running'
       AND (
         OLD.desired_state IS DISTINCT FROM NEW.desired_state
         OR OLD.org_id IS DISTINCT FROM NEW.org_id
         OR OLD.team_id IS DISTINCT FROM NEW.team_id
         OR OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id
         OR OLD.assignee_user_id IS DISTINCT FROM NEW.assignee_user_id
       )
     ) THEN
    INSERT INTO cloud_workspace_paid_authority_checks (
      workspace_id, org_id, next_check_at, reason, enqueued_at, updated_at
    ) VALUES (
      NEW.id, NEW.org_id, now(), 'workspace_authority_changed', now(), now()
    )
    ON CONFLICT (workspace_id) DO UPDATE
    SET org_id = EXCLUDED.org_id, next_check_at = now(),
        reason = EXCLUDED.reason, enqueued_at = now(), updated_at = now();
  ELSIF OLD.desired_state IS DISTINCT FROM NEW.desired_state THEN
    UPDATE cloud_workspace_paid_authority_checks
    SET next_check_at = NULL, updated_at = now()
    WHERE workspace_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cloud_workspace_authority_check_maintenance
  AFTER INSERT OR UPDATE OF desired_state, org_id, team_id, owner_user_id,
                            assignee_user_id
  ON cloud_workspaces
  FOR EACH ROW EXECUTE FUNCTION maintain_cloud_workspace_authority_check();

INSERT INTO cloud_workspace_paid_authority_checks (
  workspace_id, org_id, next_check_at, reason
)
SELECT id, org_id, now(), 'migration_backfill'
FROM cloud_workspaces
WHERE status <> 'deleted'
ON CONFLICT (workspace_id) DO NOTHING;

ALTER TABLE cloud_workspace_paid_authority_checks ENABLE ROW LEVEL SECURITY;
CREATE POLICY cloud_workspace_paid_authority_checks_system
  ON cloud_workspace_paid_authority_checks FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
ALTER TABLE cloud_workspace_paid_authority_checks FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON cloud_workspace_paid_authority_checks TO zeros_app;

REVOKE ALL ON FUNCTION enqueue_cloud_workspace_paid_authority_checks(
  uuid, uuid, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION enqueue_cloud_authority_for_account_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION enqueue_cloud_authority_for_organization_entitlement_change()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION enqueue_cloud_authority_for_seat_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION enqueue_cloud_authority_for_membership_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION enqueue_cloud_authority_for_team_membership_change()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION enqueue_cloud_authority_for_workspace_membership_change()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION enqueue_cloud_authority_for_user_auth_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION enqueue_cloud_authority_for_workos_link_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION enqueue_cloud_authority_for_organization_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION maintain_cloud_workspace_authority_check() FROM PUBLIC;

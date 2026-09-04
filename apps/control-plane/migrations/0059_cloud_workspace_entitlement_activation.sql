-- ───────────────────────────────────────────────────────────
-- 0059 — cloud-workspace entitlement activation boundaries
--
-- Entitlements may be recorded before their contractual activation time.
-- Paid-work admission and the live runtime predicate must both treat valid_from
-- as a lower bound, just as they already treat valid_until as an upper bound.
-- Recreate the deployed predicate forward-only; never rewrite migration 0046.
-- ───────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION cloud_workspace_paid_authority_live(
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
              AND entitlement.valid_from <= now()
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
              AND entitlement.valid_from <= now()
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
                        OR collaborator_entitlement.valid_from > now()
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

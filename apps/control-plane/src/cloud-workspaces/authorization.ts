import { HttpError } from "../authz.js";
import type { Tx } from "../db.js";

export type CloudWorkspaceEntitlementPlan =
  | "pro"
  | "business"
  | "enterprise";

export type CloudWorkspaceAuthorization = {
  organizationId: string;
  teamId: string;
  actorUserId: string;
  billingOwnerUserId: string;
  isPersonal: boolean;
  entitlementScope: "account" | "organization";
  plan: CloudWorkspaceEntitlementPlan;
  entitlementRevision: number;
  accountRevision: number;
  organizationAuthorizationRevision: number;
  membershipAuthorizationRevision: number;
};

export class CloudWorkspaceAuthorizationError extends HttpError {
  constructor(
    status: 403 | 404 | 409,
    code: string,
    message: string,
  ) {
    super(status, code, message);
    this.name = "CloudWorkspaceAuthorizationError";
  }
}

/** Authorize access to already-owned durable data without requiring a current
 * paid-compute entitlement. Cancellation must stop new paid work, but it must
 * not trap an owner's existing checkpoint/export behind the billing gate.
 * Current account, tenant, Team, and owner membership are still mandatory. */
export async function authorizeCloudWorkspaceDataAccess(
  tx: Tx,
  input: {
    organizationId: string;
    teamId: string;
    actorUserId: string;
    ownerUserId: string;
    requireWorkspaceOwner: boolean;
  },
): Promise<{ isPersonal: boolean }> {
  await assertSystemAuthority(tx);
  if (input.requireWorkspaceOwner && input.actorUserId !== input.ownerUserId) {
    throw new CloudWorkspaceAuthorizationError(
      403,
      "cloud_workspace_owner_required",
      "Only the workspace owner can access this cloud workspace data",
    );
  }
  const scope = (
    await tx.query<{
      is_personal: boolean;
      created_by: string;
      member_count: number;
    }>(
      `SELECT organization.is_personal, organization.created_by,
              (SELECT count(*)::integer
               FROM organization_members cardinality
               WHERE cardinality.org_id = organization.id) AS member_count
       FROM organizations organization
       JOIN users actor
         ON actor.id = $3 AND actor.deleted_at IS NULL
        AND actor.auth_status = 'active'
       JOIN organization_members actor_membership
         ON actor_membership.org_id = organization.id
        AND actor_membership.user_id = actor.id
       JOIN teams team
         ON team.id = $2 AND team.org_id = organization.id
        AND team.deleted_at IS NULL
       JOIN team_members actor_team
         ON actor_team.team_id = team.id
        AND actor_team.org_id = organization.id
        AND actor_team.user_id = actor.id
       JOIN users owner
         ON owner.id = $4 AND owner.deleted_at IS NULL
        AND owner.auth_status = 'active'
       JOIN organization_members owner_membership
         ON owner_membership.org_id = organization.id
        AND owner_membership.user_id = owner.id
       JOIN team_members owner_team
         ON owner_team.team_id = team.id
        AND owner_team.org_id = organization.id
        AND owner_team.user_id = owner.id
       WHERE organization.id = $1 AND organization.deleted_at IS NULL
       FOR SHARE OF organization`,
      [
        input.organizationId,
        input.teamId,
        input.actorUserId,
        input.ownerUserId,
      ],
    )
  ).rows[0];
  if (!scope) {
    throw new CloudWorkspaceAuthorizationError(
      404,
      "cloud_workspace_scope_not_found",
      "Authorized cloud workspace scope not found",
    );
  }
  if (
    scope.is_personal &&
    (scope.created_by !== input.actorUserId || scope.member_count !== 1)
  ) {
    throw new CloudWorkspaceAuthorizationError(
      409,
      "personal_organization_membership_invalid",
      "Personal cloud requires exactly one account member",
    );
  }
  return { isPersonal: scope.is_personal };
}

type ScopeRow = {
  is_personal: boolean;
  cloud_workspaces_allowed: boolean;
  created_by: string;
  organization_authorization_revision: string | number;
  membership_authorization_revision: string | number;
  account_revision: string | number;
  workos_sync_state: string | null;
  workos_organization_id: string | null;
};

type AccountEntitlementRow = {
  plan: "free" | "pro";
  revision: string | number;
};

type OrganizationEntitlementRow = {
  plan: CloudWorkspaceEntitlementPlan;
  seat_limit: number | null;
  revision: string | number;
};

function safeRevision(value: string | number, label: string): number {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error(`Invalid ${label} revision`);
  }
  return revision;
}

async function assertSystemAuthority(tx: Tx): Promise<void> {
  const result = await tx.query<{ allowed: boolean }>(
    "SELECT app_is_system() AS allowed",
  );
  if (result.rows[0]?.allowed !== true) {
    throw new CloudWorkspaceAuthorizationError(
      404,
      "cloud_workspace_not_found",
      "Cloud workspace scope not found",
    );
  }
}

function activeEntitlementSql(alias: string): string {
  return `${alias}.status IN ('active', 'trialing')
          AND ${alias}.cloud_workspaces_allowed
          AND ${alias}.valid_from <= now()
          AND (${alias}.valid_until IS NULL OR ${alias}.valid_until > now())`;
}

async function loadAccountEntitlement(
  tx: Tx,
  userId: string,
): Promise<AccountEntitlementRow | null> {
  const result = await tx.query<AccountEntitlementRow>(
    `SELECT ae.plan, ae.revision
     FROM account_entitlements ae
     WHERE ae.user_id = $1
       AND ${activeEntitlementSql("ae")}`,
    [userId],
  );
  return result.rows[0] ?? null;
}

/**
 * The single paid-work admission spine. Callers still apply operation-specific
 * role, lifecycle, repository, and quota checks, but may not provision, wake,
 * rebuild, connect, or mint runtime credentials without this current database
 * decision. WorkOS/JWT claims are deliberately absent from the inputs.
 */
export async function authorizeCloudWorkspaceOperation(
  tx: Tx,
  input: {
    organizationId: string;
    teamId: string;
    actorUserId: string;
    billingOwnerUserId: string;
    workosEnabled: boolean;
    /** Phase 5 runtime access is single-member. Phase 6 replaces this boolean
     * with an explicit workspace-role permission decision. */
    requireWorkspaceOwner: boolean;
  },
): Promise<CloudWorkspaceAuthorization> {
  await assertSystemAuthority(tx);

  if (
    input.requireWorkspaceOwner &&
    input.actorUserId !== input.billingOwnerUserId
  ) {
    throw new CloudWorkspaceAuthorizationError(
      403,
      "cloud_workspace_owner_required",
      "Only the workspace owner can use this cloud workspace right now",
    );
  }

  const scoped = await tx.query<ScopeRow>(
    `SELECT o.is_personal, o.cloud_workspaces_allowed, o.created_by,
            o.authorization_revision AS organization_authorization_revision,
            om.authorization_revision AS membership_authorization_revision,
            actor.auth_revision AS account_revision,
            wol.state::text AS workos_sync_state,
            wol.workos_organization_id
     FROM organizations o
     JOIN users actor
       ON actor.id = $3 AND actor.deleted_at IS NULL
      AND actor.auth_status = 'active'
     JOIN organization_members om
       ON om.org_id = o.id AND om.user_id = actor.id
     JOIN teams team
       ON team.id = $2 AND team.org_id = o.id AND team.deleted_at IS NULL
     JOIN team_members tm
       ON tm.team_id = team.id AND tm.org_id = o.id AND tm.user_id = actor.id
     JOIN users billing_owner
       ON billing_owner.id = $4 AND billing_owner.deleted_at IS NULL
      AND billing_owner.auth_status = 'active'
     JOIN organization_members owner_membership
       ON owner_membership.org_id = o.id
      AND owner_membership.user_id = billing_owner.id
     JOIN team_members owner_team
       ON owner_team.team_id = team.id AND owner_team.org_id = o.id
      AND owner_team.user_id = billing_owner.id
     LEFT JOIN workos_organization_links wol ON wol.organization_id = o.id
     WHERE o.id = $1 AND o.deleted_at IS NULL
     FOR UPDATE OF o`,
    [
      input.organizationId,
      input.teamId,
      input.actorUserId,
      input.billingOwnerUserId,
    ],
  );
  const scope = scoped.rows[0];
  if (!scope) {
    throw new CloudWorkspaceAuthorizationError(
      404,
      "cloud_workspace_scope_not_found",
      "Authorized cloud workspace scope not found",
    );
  }
  if (!scope.cloud_workspaces_allowed) {
    throw new CloudWorkspaceAuthorizationError(
      403,
      "cloud_workspaces_not_allowed",
      "Cloud workspaces are not allowed for this account or organization",
    );
  }

  const base = {
    organizationId: input.organizationId,
    teamId: input.teamId,
    actorUserId: input.actorUserId,
    billingOwnerUserId: input.billingOwnerUserId,
    accountRevision: safeRevision(scope.account_revision, "account"),
    organizationAuthorizationRevision: safeRevision(
      scope.organization_authorization_revision,
      "organization authorization",
    ),
    membershipAuthorizationRevision: safeRevision(
      scope.membership_authorization_revision,
      "membership authorization",
    ),
  };

  if (scope.is_personal) {
    if (
      scope.created_by !== input.actorUserId ||
      input.actorUserId !== input.billingOwnerUserId
    ) {
      throw new CloudWorkspaceAuthorizationError(
        404,
        "cloud_workspace_scope_not_found",
        "Authorized cloud workspace scope not found",
      );
    }
    const cardinality = await tx.query<{ count: number }>(
      `SELECT count(*)::integer AS count
       FROM organization_members WHERE org_id = $1`,
      [input.organizationId],
    );
    if (cardinality.rows[0]?.count !== 1) {
      throw new CloudWorkspaceAuthorizationError(
        409,
        "personal_organization_membership_invalid",
        "Personal cloud requires exactly one account member",
      );
    }
    const entitlement = await loadAccountEntitlement(tx, input.billingOwnerUserId);
    if (!entitlement || entitlement.plan !== "pro") {
      throw new CloudWorkspaceAuthorizationError(
        403,
        "cloud_account_entitlement_required",
        "An active Pro account entitlement is required for Personal cloud",
      );
    }
    return {
      ...base,
      isPersonal: true,
      entitlementScope: "account",
      plan: "pro",
      entitlementRevision: safeRevision(
        entitlement.revision,
        "account entitlement",
      ),
    };
  }

  if (
    input.workosEnabled &&
    (scope.workos_sync_state !== "active" || !scope.workos_organization_id)
  ) {
    throw new CloudWorkspaceAuthorizationError(
      409,
      "organization_identity_not_ready",
      "Organization identity provisioning is not complete",
    );
  }

  const entitlementResult = await tx.query<OrganizationEntitlementRow>(
    `SELECT oe.plan, oe.seat_limit, oe.revision
     FROM organization_entitlements oe
     WHERE oe.org_id = $1
       AND ${activeEntitlementSql("oe")}`,
    [input.organizationId],
  );
  const entitlement = entitlementResult.rows[0];
  if (!entitlement) {
    throw new CloudWorkspaceAuthorizationError(
      403,
      "cloud_organization_entitlement_required",
      "An active organization cloud entitlement is required",
    );
  }

  if (entitlement.plan === "pro") {
    const collaborators = await tx.query<{
      member_count: number;
      entitled_count: number;
    }>(
      `SELECT count(*)::integer AS member_count,
              count(*) FILTER (
                WHERE account.auth_status = 'active'
                  AND account.deleted_at IS NULL
                  AND ae.plan = 'pro'
                  AND ${activeEntitlementSql("ae")}
              )::integer AS entitled_count
       FROM organization_members om
       JOIN users account ON account.id = om.user_id
       LEFT JOIN account_entitlements ae ON ae.user_id = om.user_id
       WHERE om.org_id = $1`,
      [input.organizationId],
    );
    const counts = collaborators.rows[0]!;
    if (counts.member_count > 5) {
      throw new CloudWorkspaceAuthorizationError(
        403,
        "cloud_pro_collaborator_limit_exceeded",
        "A Pro organization supports at most five collaborators",
      );
    }
    if (counts.entitled_count !== counts.member_count) {
      throw new CloudWorkspaceAuthorizationError(
        403,
        "cloud_pro_collaborator_not_entitled",
        "Every Pro organization collaborator needs an active Pro entitlement",
      );
    }
  } else {
    const seats = await tx.query<{
      active_count: number;
      actor_seated: boolean;
      owner_seated: boolean;
    }>(
      `SELECT count(*) FILTER (WHERE osa.state = 'active')::integer AS active_count,
              coalesce(bool_or(
                osa.user_id = $2 AND osa.state = 'active'
              ), false) AS actor_seated,
              coalesce(bool_or(
                osa.user_id = $3 AND osa.state = 'active'
              ), false) AS owner_seated
       FROM organization_seat_assignments osa
       WHERE osa.org_id = $1`,
      [input.organizationId, input.actorUserId, input.billingOwnerUserId],
    );
    const assigned = seats.rows[0]!;
    if (
      entitlement.seat_limit === null ||
      assigned.active_count > entitlement.seat_limit
    ) {
      throw new CloudWorkspaceAuthorizationError(
        403,
        "cloud_organization_seat_limit_exceeded",
        "Active organization seats exceed the purchased seat limit",
      );
    }
    if (!assigned.actor_seated || !assigned.owner_seated) {
      throw new CloudWorkspaceAuthorizationError(
        403,
        "cloud_organization_seat_required",
        "An active organization seat is required for paid cloud work",
      );
    }
  }

  return {
    ...base,
    isPersonal: false,
    entitlementScope: "organization",
    plan: entitlement.plan,
    entitlementRevision: safeRevision(
      entitlement.revision,
      "organization entitlement",
    ),
  };
}

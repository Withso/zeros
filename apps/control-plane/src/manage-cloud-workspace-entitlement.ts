// Guarded database-owner utility for activating Organization cloud-workspace
// billing authority and its exact active seat set. The default mode is a
// read-only plan. Execution is target-bound, refuses external billing sources,
// and appends owner-only evidence in the same transaction as the entitlement
// and seat changes.

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

import pg from "pg";
import { z } from "zod";

const CHANNELS = ["development", "alpha", "beta", "production"] as const;
const PLANS = ["pro", "business", "enterprise"] as const;
const ACTIVATION_STATUSES = ["active", "trialing"] as const;
const ENTITLEMENT_STATUSES = [
  "active",
  "trialing",
  "past_due",
  "paused",
  "cancelled",
  "expired",
] as const;
const UUID = z.string().uuid();
const SLUG = z.string().trim().min(1).max(255);
const REASON = z.string().trim().min(16).max(512);
const INDEFINITE = "none";
const MAX_SEATS = 10_000;

type EntitlementPlan = (typeof PLANS)[number];
type EntitlementStatus = (typeof ACTIVATION_STATUSES)[number];

export interface CloudWorkspaceEntitlementTarget {
  plan: EntitlementPlan;
  status: EntitlementStatus;
  cloudWorkspacesAllowed: true;
  seatLimit: number | null;
  source: "operator";
  sourceReference: string;
  validFrom: string;
  validUntil: string | null;
  activeSeatUserIds: string[];
}

export interface CloudWorkspaceEntitlementSnapshot {
  plan: EntitlementPlan;
  status: (typeof ENTITLEMENT_STATUSES)[number];
  cloudWorkspacesAllowed: boolean;
  seatLimit: number | null;
  source: "operator";
  sourceReference: string | null;
  validFrom: string;
  validUntil: string | null;
  revision: number;
  activeSeatUserIds: string[];
}

export interface CloudWorkspaceEntitlementRequestInput {
  databaseUrl: string;
  channel: string | undefined;
  railwayEnvironmentName?: string | undefined;
  execute: boolean;
  productionConfirmed?: string | undefined;
  approval?: string | undefined;
  organizationId: string | undefined;
  expectedOrganizationSlug: string | undefined;
  actorUserId: string | undefined;
  plan: string | undefined;
  status: string | undefined;
  validFrom: string | undefined;
  validUntil: string | undefined;
  seatLimit: string | undefined;
  activeSeatUserIds: string | undefined;
  reason: string | undefined;
}

export interface ValidatedCloudWorkspaceEntitlementRequest {
  databaseUrl: string;
  channel: (typeof CHANNELS)[number];
  execute: boolean;
  approval: string | null;
  organizationId: string;
  expectedOrganizationSlug: string;
  actorUserId: string;
  next: CloudWorkspaceEntitlementTarget;
  reason: string;
  targetFingerprint: string;
}

export interface CloudWorkspaceEntitlementChangeResult {
  state: "planned" | "changed" | "unchanged";
  organizationId: string;
  actorUserId: string;
  previous: CloudWorkspaceEntitlementSnapshot | null;
  next: CloudWorkspaceEntitlementTarget;
  targetFingerprint: string;
  approval: string | null;
}

type EntitlementRow = {
  plan: string;
  status: string;
  cloud_workspaces_allowed: boolean;
  seat_limit: number | null;
  source: string;
  source_reference: string | null;
  valid_from: Date | string;
  valid_until: Date | string | null;
  revision: string | number;
};

type OrganizationMemberRow = {
  user_id: string;
  role: string;
};

type UserRow = {
  id: string;
  auth_status: string;
  deleted_at: Date | string | null;
  staff_role: string | null;
};

export class CloudWorkspaceEntitlementManagementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudWorkspaceEntitlementManagementError";
  }
}

function databaseTarget(databaseUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new CloudWorkspaceEntitlementManagementError(
      "Invalid entitlement configuration: DATABASE_URL must be a PostgreSQL URL",
    );
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.pathname === "/"
  ) {
    throw new CloudWorkspaceEntitlementManagementError(
      "Invalid entitlement configuration: DATABASE_URL must identify one PostgreSQL database",
    );
  }
  return parsed;
}

function targetFingerprint(databaseUrl: string, channel: string): string {
  const parsed = databaseTarget(databaseUrl);
  return createHash("sha256")
    .update(
      [
        "zeros-control-plane-cloud-entitlement.v1",
        channel,
        parsed.hostname.toLowerCase(),
        parsed.port || "5432",
        parsed.pathname,
      ].join("\0"),
      "utf8",
    )
    .digest("hex")
    .slice(0, 16);
}

function reasonFingerprint(reason: string): string {
  return createHash("sha256").update(reason, "utf8").digest("hex").slice(0, 12);
}

function canonicalTimestamp(
  value: string | undefined,
  environmentName: string,
): string {
  const result = z.string().datetime({ offset: true }).safeParse(value?.trim());
  if (!result.success) {
    throw new CloudWorkspaceEntitlementManagementError(
      `${environmentName} must be one ISO-8601 timestamp with an offset`,
    );
  }
  return new Date(result.data).toISOString();
}

function canonicalOptionalTimestamp(value: string | undefined): string | null {
  if (value?.trim().toLowerCase() === INDEFINITE) return null;
  return canonicalTimestamp(
    value,
    "CONTROL_PLANE_CLOUD_ENTITLEMENT_VALID_UNTIL",
  );
}

function parseSeatLimit(value: string | undefined): number | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === INDEFINITE) return null;
  if (!normalized || !/^[1-9][0-9]{0,9}$/.test(normalized)) {
    throw new CloudWorkspaceEntitlementManagementError(
      "CONTROL_PLANE_CLOUD_ENTITLEMENT_SEAT_LIMIT must be a positive PostgreSQL integer or none",
    );
  }
  const parsed = Number(normalized);
  if (parsed > 2_147_483_647) {
    throw new CloudWorkspaceEntitlementManagementError(
      "CONTROL_PLANE_CLOUD_ENTITLEMENT_SEAT_LIMIT must be a positive PostgreSQL integer or none",
    );
  }
  return parsed;
}

function parseSeatUserIds(value: string | undefined): string[] {
  const normalized = value?.trim();
  if (normalized?.toLowerCase() === INDEFINITE) return [];
  if (!normalized) {
    throw new CloudWorkspaceEntitlementManagementError(
      "CONTROL_PLANE_CLOUD_ENTITLEMENT_ACTIVE_SEAT_USER_IDS must be an explicit comma-separated UUID list or none",
    );
  }
  const rawIds = normalized.split(",").map((candidate) => candidate.trim());
  if (rawIds.length > MAX_SEATS || rawIds.some((candidate) => !candidate)) {
    throw new CloudWorkspaceEntitlementManagementError(
      `CONTROL_PLANE_CLOUD_ENTITLEMENT_ACTIVE_SEAT_USER_IDS must contain at most ${MAX_SEATS} exact UUIDs`,
    );
  }
  const ids = rawIds.map((candidate) => {
    const parsed = UUID.safeParse(candidate);
    if (!parsed.success) {
      throw new CloudWorkspaceEntitlementManagementError(
        "CONTROL_PLANE_CLOUD_ENTITLEMENT_ACTIVE_SEAT_USER_IDS must contain only exact UUIDs",
      );
    }
    return parsed.data.toLowerCase();
  });
  if (new Set(ids).size !== ids.length) {
    throw new CloudWorkspaceEntitlementManagementError(
      "CONTROL_PLANE_CLOUD_ENTITLEMENT_ACTIVE_SEAT_USER_IDS contains a duplicate UUID",
    );
  }
  return ids.sort();
}

function snapshotFingerprint(
  snapshot: CloudWorkspaceEntitlementSnapshot | CloudWorkspaceEntitlementTarget,
): string {
  return createHash("sha256")
    .update(JSON.stringify(snapshot), "utf8")
    .digest("hex")
    .slice(0, 32);
}

function exactRevision(value: string | number): number {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new CloudWorkspaceEntitlementManagementError(
      "Current Organization entitlement revision is invalid",
    );
  }
  return revision;
}

function timestampFromDatabase(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new CloudWorkspaceEntitlementManagementError(
      "Current Organization entitlement validity is invalid",
    );
  }
  return parsed.toISOString();
}

function snapshotFromRow(
  row: EntitlementRow,
  activeSeatUserIds: string[],
): CloudWorkspaceEntitlementSnapshot {
  if (
    !PLANS.includes(row.plan as EntitlementPlan) ||
    !ENTITLEMENT_STATUSES.includes(
      row.status as (typeof ENTITLEMENT_STATUSES)[number],
    ) ||
    row.source !== "operator"
  ) {
    throw new CloudWorkspaceEntitlementManagementError(
      "Current Organization entitlement is not valid operator-managed billing authority",
    );
  }
  return {
    plan: row.plan as EntitlementPlan,
    status: row.status as (typeof ENTITLEMENT_STATUSES)[number],
    cloudWorkspacesAllowed: row.cloud_workspaces_allowed,
    seatLimit: row.seat_limit,
    source: "operator",
    sourceReference: row.source_reference,
    validFrom: timestampFromDatabase(row.valid_from),
    validUntil:
      row.valid_until === null ? null : timestampFromDatabase(row.valid_until),
    revision: exactRevision(row.revision),
    activeSeatUserIds: [...activeSeatUserIds].sort(),
  };
}

function targetsEqual(
  previous: CloudWorkspaceEntitlementSnapshot,
  next: CloudWorkspaceEntitlementTarget,
): boolean {
  return (
    previous.plan === next.plan &&
    previous.status === next.status &&
    previous.cloudWorkspacesAllowed === next.cloudWorkspacesAllowed &&
    previous.seatLimit === next.seatLimit &&
    previous.source === next.source &&
    previous.sourceReference === next.sourceReference &&
    previous.validFrom === next.validFrom &&
    previous.validUntil === next.validUntil &&
    previous.activeSeatUserIds.length === next.activeSeatUserIds.length &&
    previous.activeSeatUserIds.every(
      (userId, index) => userId === next.activeSeatUserIds[index],
    )
  );
}

export function validateCloudWorkspaceEntitlementRequest(
  input: CloudWorkspaceEntitlementRequestInput,
): ValidatedCloudWorkspaceEntitlementRequest {
  const channel = input.channel?.trim().toLowerCase() ?? "";
  if (!CHANNELS.includes(channel as (typeof CHANNELS)[number])) {
    throw new CloudWorkspaceEntitlementManagementError(
      "CONTROL_PLANE_CLOUD_ENTITLEMENT_CHANNEL must be development, alpha, beta, or production",
    );
  }
  const railwayEnvironment = input.railwayEnvironmentName?.trim().toLowerCase();
  if (railwayEnvironment && railwayEnvironment !== channel) {
    throw new CloudWorkspaceEntitlementManagementError(
      "Cloud entitlement channel does not match RAILWAY_ENVIRONMENT_NAME",
    );
  }
  if (
    input.execute &&
    channel === "production" &&
    input.productionConfirmed !== "true"
  ) {
    throw new CloudWorkspaceEntitlementManagementError(
      "CONTROL_PLANE_CLOUD_ENTITLEMENT_PRODUCTION_CONFIRMED=true is required for production confirmation",
    );
  }

  const organizationId = UUID.safeParse(input.organizationId);
  const expectedOrganizationSlug = SLUG.safeParse(
    input.expectedOrganizationSlug,
  );
  const actorUserId = UUID.safeParse(input.actorUserId);
  const plan = z.enum(PLANS).safeParse(input.plan?.trim().toLowerCase());
  const status = z
    .enum(ACTIVATION_STATUSES)
    .safeParse(input.status?.trim().toLowerCase());
  const reason = REASON.safeParse(input.reason);
  if (!organizationId.success || !actorUserId.success) {
    throw new CloudWorkspaceEntitlementManagementError(
      "Cloud entitlement Organization and actor must be exact UUIDs",
    );
  }
  if (!expectedOrganizationSlug.success) {
    throw new CloudWorkspaceEntitlementManagementError(
      "CONTROL_PLANE_CLOUD_ENTITLEMENT_EXPECTED_ORGANIZATION_SLUG is required",
    );
  }
  if (!plan.success) {
    throw new CloudWorkspaceEntitlementManagementError(
      "CONTROL_PLANE_CLOUD_ENTITLEMENT_PLAN must be pro, business, or enterprise",
    );
  }
  if (!status.success) {
    throw new CloudWorkspaceEntitlementManagementError(
      "CONTROL_PLANE_CLOUD_ENTITLEMENT_STATUS must be active or trialing",
    );
  }
  if (!reason.success) {
    throw new CloudWorkspaceEntitlementManagementError(
      "CONTROL_PLANE_CLOUD_ENTITLEMENT_REASON must contain 16 to 512 characters",
    );
  }

  const validFrom = canonicalTimestamp(
    input.validFrom,
    "CONTROL_PLANE_CLOUD_ENTITLEMENT_VALID_FROM",
  );
  const validUntil = canonicalOptionalTimestamp(input.validUntil);
  if (validUntil !== null && validUntil <= validFrom) {
    throw new CloudWorkspaceEntitlementManagementError(
      "CONTROL_PLANE_CLOUD_ENTITLEMENT_VALID_UNTIL must be later than VALID_FROM",
    );
  }
  const seatLimit = parseSeatLimit(input.seatLimit);
  const activeSeatUserIds = parseSeatUserIds(input.activeSeatUserIds);
  if (plan.data === "pro") {
    if (seatLimit !== null) {
      throw new CloudWorkspaceEntitlementManagementError(
        "A Pro Organization activation requires CONTROL_PLANE_CLOUD_ENTITLEMENT_SEAT_LIMIT=none",
      );
    }
    if (activeSeatUserIds.length !== 0) {
      throw new CloudWorkspaceEntitlementManagementError(
        "A Pro Organization activation requires CONTROL_PLANE_CLOUD_ENTITLEMENT_ACTIVE_SEAT_USER_IDS=none",
      );
    }
  } else {
    if (seatLimit === null) {
      throw new CloudWorkspaceEntitlementManagementError(
        "Business and Enterprise activation require a positive CONTROL_PLANE_CLOUD_ENTITLEMENT_SEAT_LIMIT",
      );
    }
    if (activeSeatUserIds.length === 0) {
      throw new CloudWorkspaceEntitlementManagementError(
        "Business and Enterprise activation require at least one explicit active seat",
      );
    }
    if (activeSeatUserIds.length > seatLimit) {
      throw new CloudWorkspaceEntitlementManagementError(
        "The explicit active seat count exceeds the requested seat limit",
      );
    }
  }

  const fingerprint = targetFingerprint(input.databaseUrl, channel);
  return {
    databaseUrl: input.databaseUrl,
    channel: channel as ValidatedCloudWorkspaceEntitlementRequest["channel"],
    execute: input.execute,
    approval: input.approval?.trim() || null,
    organizationId: organizationId.data.toLowerCase(),
    expectedOrganizationSlug: expectedOrganizationSlug.data.toLowerCase(),
    actorUserId: actorUserId.data.toLowerCase(),
    next: {
      plan: plan.data,
      status: status.data,
      cloudWorkspacesAllowed: true,
      seatLimit,
      source: "operator",
      sourceReference: `operator:${channel}:${fingerprint}`,
      validFrom,
      validUntil,
      activeSeatUserIds,
    },
    reason: reason.data,
    targetFingerprint: fingerprint,
  };
}

export function cloudWorkspaceEntitlementApprovalText(
  request: ValidatedCloudWorkspaceEntitlementRequest,
  previous: CloudWorkspaceEntitlementSnapshot | null,
): string {
  return [
    "cloud-entitlement",
    request.channel,
    request.targetFingerprint,
    request.organizationId,
    request.actorUserId,
    previous === null ? "none" : snapshotFingerprint(previous),
    snapshotFingerprint(request.next),
    reasonFingerprint(request.reason),
  ].join(":");
}

async function assertProCollaboratorsEligible(
  client: pg.PoolClient,
  organizationId: string,
  members: readonly OrganizationMemberRow[],
): Promise<void> {
  if (members.length === 0 || members.length > 5) {
    throw new CloudWorkspaceEntitlementManagementError(
      "A Pro Organization activation requires one to five collaborators",
    );
  }
  const entitlements = await client.query<{ user_id: string }>(
    `SELECT entitlement.user_id
     FROM account_entitlements entitlement
     JOIN users account ON account.id = entitlement.user_id
     WHERE entitlement.user_id = ANY($1::uuid[])
       AND entitlement.plan = 'pro'
       AND entitlement.status IN ('active', 'trialing')
       AND entitlement.cloud_workspaces_allowed
       AND entitlement.valid_from <= clock_timestamp()
       AND (
         entitlement.valid_until IS NULL
         OR entitlement.valid_until > clock_timestamp()
       )
       AND account.auth_status = 'active'
       AND account.deleted_at IS NULL
     ORDER BY entitlement.user_id
     FOR SHARE OF entitlement, account`,
    [members.map((member) => member.user_id)],
  );
  if (entitlements.rows.length !== members.length) {
    throw new CloudWorkspaceEntitlementManagementError(
      `Pro Organization ${organizationId} requires every collaborator to have current Pro account authority`,
    );
  }
}

export async function manageCloudWorkspaceEntitlement(
  pool: pg.Pool,
  request: ValidatedCloudWorkspaceEntitlementRequest,
): Promise<CloudWorkspaceEntitlementChangeResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SELECT set_config('app.system', 'on', true)");

    const privilege = await client.query<{
      principal: string;
      owns_entitlements: boolean;
      owns_seats: boolean;
      owns_evidence: boolean;
      can_insert_entitlements: boolean;
      can_update_entitlements: boolean;
      can_insert_seats: boolean;
      can_update_seats: boolean;
      can_write_evidence: boolean;
    }>(
      `SELECT current_user AS principal,
              pg_get_userbyid(entitlements.relowner) = current_user
                AS owns_entitlements,
              pg_get_userbyid(seats.relowner) = current_user AS owns_seats,
              pg_get_userbyid(evidence.relowner) = current_user AS owns_evidence,
              has_table_privilege(current_user,
                'public.organization_entitlements', 'INSERT')
                AS can_insert_entitlements,
              has_table_privilege(current_user,
                'public.organization_entitlements', 'UPDATE')
                AS can_update_entitlements,
              has_table_privilege(current_user,
                'public.organization_seat_assignments', 'INSERT')
                AS can_insert_seats,
              has_table_privilege(current_user,
                'public.organization_seat_assignments', 'UPDATE')
                AS can_update_seats,
              has_table_privilege(current_user,
                'public.cloud_workspace_entitlement_changes', 'INSERT')
                AS can_write_evidence
       FROM pg_class entitlements
       CROSS JOIN pg_class seats
       CROSS JOIN pg_class evidence
       WHERE entitlements.oid = 'public.organization_entitlements'::regclass
         AND seats.oid = 'public.organization_seat_assignments'::regclass
         AND evidence.oid =
             'public.cloud_workspace_entitlement_changes'::regclass`,
    );
    const owner = privilege.rows[0];
    if (
      !owner ||
      owner.principal === "zeros_app" ||
      !owner.owns_entitlements ||
      !owner.owns_seats ||
      !owner.owns_evidence ||
      !owner.can_insert_entitlements ||
      !owner.can_update_entitlements ||
      !owner.can_insert_seats ||
      !owner.can_update_seats ||
      !owner.can_write_evidence
    ) {
      throw new CloudWorkspaceEntitlementManagementError(
        "Cloud entitlement changes require the database/migration owner; the application role is refused",
      );
    }

    // No shipped runtime writes these billing tables. Serialize this rare
    // owner operation against ad-hoc/future billing writers as well as other
    // activations so an absent row or newly-added seat cannot evade the plan's
    // exact current-state fingerprint.
    await client.query(
      `LOCK TABLE organization_entitlements, organization_seat_assignments
       IN SHARE ROW EXCLUSIVE MODE`,
    );

    // After table-level writer serialization, the Organization-first row-lock
    // order fences lifecycle deletion and blocks new membership references
    // while the complete authority snapshot is inspected and replaced.
    const organizationResult = await client.query<{
      id: string;
      slug: string;
      is_personal: boolean;
      cloud_workspaces_allowed: boolean;
      lifecycle_status: string;
      deleted_at: Date | string | null;
    }>(
      `SELECT id, slug::text, is_personal, cloud_workspaces_allowed,
              lifecycle_status, deleted_at
       FROM organizations WHERE id = $1 FOR UPDATE`,
      [request.organizationId],
    );
    const organization = organizationResult.rows[0];
    if (!organization) {
      throw new CloudWorkspaceEntitlementManagementError(
        "Cloud entitlement Organization was not found",
      );
    }
    if (organization.slug.toLowerCase() !== request.expectedOrganizationSlug) {
      throw new CloudWorkspaceEntitlementManagementError(
        "Organization UUID does not match CONTROL_PLANE_CLOUD_ENTITLEMENT_EXPECTED_ORGANIZATION_SLUG",
      );
    }
    if (organization.is_personal) {
      throw new CloudWorkspaceEntitlementManagementError(
        "Personal tenants cannot receive an Organization cloud entitlement",
      );
    }
    if (
      organization.deleted_at !== null ||
      organization.lifecycle_status !== "active" ||
      !organization.cloud_workspaces_allowed
    ) {
      throw new CloudWorkspaceEntitlementManagementError(
        "Cloud entitlement activation requires one active cloud-enabled Organization",
      );
    }

    const membersResult = await client.query<OrganizationMemberRow>(
      `SELECT user_id, role::text
       FROM organization_members
       WHERE org_id = $1
       ORDER BY user_id
       FOR SHARE`,
      [request.organizationId],
    );
    const members = membersResult.rows;
    const memberIds = new Set(members.map((member) => member.user_id));
    const userIds = [...new Set([request.actorUserId, ...memberIds])].sort();
    const usersResult = await client.query<UserRow>(
      `SELECT id, auth_status, deleted_at, staff_role
       FROM users WHERE id = ANY($1::uuid[])
       ORDER BY id FOR SHARE`,
      [userIds],
    );
    const users = new Map(usersResult.rows.map((user) => [user.id, user]));
    const actor = users.get(request.actorUserId);
    if (
      !actor ||
      actor.auth_status !== "active" ||
      actor.deleted_at !== null ||
      actor.staff_role !== "platform_owner"
    ) {
      throw new CloudWorkspaceEntitlementManagementError(
        "Cloud entitlement actor must be one active Zeros platform owner",
      );
    }

    const workosLink = await client.query<{
      state: string;
      workos_organization_id: string | null;
    }>(
      `SELECT state, workos_organization_id
       FROM workos_organization_links
       WHERE organization_id = $1 FOR SHARE`,
      [request.organizationId],
    );
    if (
      workosLink.rows[0]?.state !== "active" ||
      !workosLink.rows[0].workos_organization_id
    ) {
      throw new CloudWorkspaceEntitlementManagementError(
        "Cloud entitlement activation requires an active WorkOS Organization identity",
      );
    }

    if (request.next.plan === "pro") {
      await assertProCollaboratorsEligible(
        client,
        request.organizationId,
        members,
      );
    } else {
      const invalidSeat = request.next.activeSeatUserIds.find((userId) => {
        const account = users.get(userId);
        return (
          !memberIds.has(userId) ||
          !account ||
          account.auth_status !== "active" ||
          account.deleted_at !== null
        );
      });
      if (invalidSeat) {
        throw new CloudWorkspaceEntitlementManagementError(
          "Every requested active seat must identify one active Organization member",
        );
      }
    }

    const entitlementResult = await client.query<EntitlementRow>(
      `SELECT plan, status, cloud_workspaces_allowed, seat_limit, source,
              source_reference, valid_from, valid_until, revision
       FROM organization_entitlements
       WHERE org_id = $1 FOR UPDATE`,
      [request.organizationId],
    );
    const seatsResult = await client.query<{
      user_id: string;
      state: string;
      revision: string | number;
    }>(
      `SELECT user_id, state, revision
       FROM organization_seat_assignments
       WHERE org_id = $1 ORDER BY user_id FOR UPDATE`,
      [request.organizationId],
    );
    const entitlementRow = entitlementResult.rows[0];
    if (!entitlementRow && seatsResult.rows.length > 0) {
      throw new CloudWorkspaceEntitlementManagementError(
        "Organization has seat assignments without billing authority; reconcile the inconsistent current state first",
      );
    }
    if (entitlementRow && entitlementRow.source !== "operator") {
      throw new CloudWorkspaceEntitlementManagementError(
        "Cloud entitlement activation refuses to overwrite non-operator external billing authority",
      );
    }
    const previous = entitlementRow
      ? snapshotFromRow(
          entitlementRow,
          seatsResult.rows
            .filter((seat) => seat.state === "active")
            .map((seat) => seat.user_id),
        )
      : null;

    const databaseClock = await client.query<{
      current_time: Date | string;
    }>("SELECT clock_timestamp() AS current_time");
    const currentTime = timestampFromDatabase(
      databaseClock.rows[0]!.current_time,
    );
    if (
      request.next.validFrom > currentTime ||
      (request.next.validUntil !== null &&
        request.next.validUntil <= currentTime)
    ) {
      throw new CloudWorkspaceEntitlementManagementError(
        "Requested Organization entitlement validity is not current",
      );
    }

    const approval = cloudWorkspaceEntitlementApprovalText(request, previous);
    if (previous && targetsEqual(previous, request.next)) {
      if (request.execute) {
        throw new CloudWorkspaceEntitlementManagementError(
          "Cloud entitlement is already at the requested value; generate a fresh plan",
        );
      }
      await client.query("ROLLBACK");
      return {
        state: "unchanged",
        organizationId: request.organizationId,
        actorUserId: request.actorUserId,
        previous,
        next: request.next,
        targetFingerprint: request.targetFingerprint,
        approval: null,
      };
    }

    if (!request.execute) {
      await client.query("ROLLBACK");
      return {
        state: "planned",
        organizationId: request.organizationId,
        actorUserId: request.actorUserId,
        previous,
        next: request.next,
        targetFingerprint: request.targetFingerprint,
        approval,
      };
    }
    if (request.approval !== approval) {
      throw new CloudWorkspaceEntitlementManagementError(
        "CONTROL_PLANE_CLOUD_ENTITLEMENT_APPROVAL does not match the current target-bound plan",
      );
    }

    const nextRevision = previous ? previous.revision + 1 : 1;
    if (!Number.isSafeInteger(nextRevision)) {
      throw new CloudWorkspaceEntitlementManagementError(
        "Organization entitlement revision cannot be incremented safely",
      );
    }
    await client.query(
      `INSERT INTO organization_entitlements (
         org_id, plan, status, cloud_workspaces_allowed, seat_limit, source,
         source_reference, valid_from, valid_until, revision, updated_at
       ) VALUES ($1, $2, $3, true, $4, 'operator', $5, $6, $7, 1,
                 clock_timestamp())
       ON CONFLICT (org_id) DO UPDATE
       SET plan = EXCLUDED.plan,
           status = EXCLUDED.status,
           cloud_workspaces_allowed = true,
           seat_limit = EXCLUDED.seat_limit,
           source = 'operator',
           source_reference = EXCLUDED.source_reference,
           valid_from = EXCLUDED.valid_from,
           valid_until = EXCLUDED.valid_until,
           revision = organization_entitlements.revision + 1,
           updated_at = clock_timestamp()`,
      [
        request.organizationId,
        request.next.plan,
        request.next.status,
        request.next.seatLimit,
        request.next.sourceReference,
        request.next.validFrom,
        request.next.validUntil,
      ],
    );
    await client.query(
      `UPDATE organization_seat_assignments
       SET state = 'released', released_at = clock_timestamp(),
           revision = revision + 1
       WHERE org_id = $1 AND state = 'active'
         AND NOT (user_id = ANY($2::uuid[]))`,
      [request.organizationId, request.next.activeSeatUserIds],
    );
    await client.query(
      `INSERT INTO organization_seat_assignments (
         org_id, user_id, state, assigned_by, assigned_at
       )
       SELECT $1, requested.user_id, 'active', $3, clock_timestamp()
       FROM unnest($2::uuid[]) AS requested(user_id)
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [
        request.organizationId,
        request.next.activeSeatUserIds,
        request.actorUserId,
      ],
    );
    await client.query(
      `UPDATE organization_seat_assignments
       SET state = 'active', assigned_by = $3, assigned_at = clock_timestamp(),
           released_at = NULL, revision = revision + 1
       WHERE org_id = $1 AND state = 'released'
         AND user_id = ANY($2::uuid[])`,
      [
        request.organizationId,
        request.next.activeSeatUserIds,
        request.actorUserId,
      ],
    );

    await client.query(
      `INSERT INTO cloud_workspace_entitlement_changes (
         org_id, actor_user_id,
         previous_plan, previous_status,
         previous_cloud_workspaces_allowed, previous_seat_limit,
         previous_source, previous_source_reference,
         previous_valid_from, previous_valid_until, previous_revision,
         previous_active_seat_user_ids,
         next_plan, next_status, next_cloud_workspaces_allowed,
         next_seat_limit, next_source, next_source_reference,
         next_valid_from, next_valid_until, next_revision,
         next_active_seat_user_ids,
         deployment_channel, target_fingerprint, database_principal, reason
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::uuid[],
         $13, $14, true, $15, 'operator', $16, $17, $18, $19, $20::uuid[],
         $21, $22, $23, $24
       )`,
      [
        request.organizationId,
        request.actorUserId,
        previous?.plan ?? null,
        previous?.status ?? null,
        previous?.cloudWorkspacesAllowed ?? null,
        previous?.seatLimit ?? null,
        previous?.source ?? null,
        previous?.sourceReference ?? null,
        previous?.validFrom ?? null,
        previous?.validUntil ?? null,
        previous?.revision ?? null,
        previous?.activeSeatUserIds ?? [],
        request.next.plan,
        request.next.status,
        request.next.seatLimit,
        request.next.sourceReference,
        request.next.validFrom,
        request.next.validUntil,
        nextRevision,
        request.next.activeSeatUserIds,
        request.channel,
        request.targetFingerprint,
        owner.principal,
        request.reason,
      ],
    );
    await client.query("COMMIT");
    return {
      state: "changed",
      organizationId: request.organizationId,
      actorUserId: request.actorUserId,
      previous,
      next: request.next,
      targetFingerprint: request.targetFingerprint,
      approval: null,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function runCli(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new CloudWorkspaceEntitlementManagementError(
      "DATABASE_URL is required",
    );
  }
  const request = validateCloudWorkspaceEntitlementRequest({
    databaseUrl,
    channel: process.env.CONTROL_PLANE_CLOUD_ENTITLEMENT_CHANNEL,
    railwayEnvironmentName: process.env.RAILWAY_ENVIRONMENT_NAME,
    execute: process.argv.includes("--execute"),
    productionConfirmed:
      process.env.CONTROL_PLANE_CLOUD_ENTITLEMENT_PRODUCTION_CONFIRMED,
    approval: process.env.CONTROL_PLANE_CLOUD_ENTITLEMENT_APPROVAL,
    organizationId: process.env.CONTROL_PLANE_CLOUD_ENTITLEMENT_ORGANIZATION_ID,
    expectedOrganizationSlug:
      process.env.CONTROL_PLANE_CLOUD_ENTITLEMENT_EXPECTED_ORGANIZATION_SLUG,
    actorUserId: process.env.CONTROL_PLANE_CLOUD_ENTITLEMENT_ACTOR_USER_ID,
    plan: process.env.CONTROL_PLANE_CLOUD_ENTITLEMENT_PLAN,
    status: process.env.CONTROL_PLANE_CLOUD_ENTITLEMENT_STATUS,
    validFrom: process.env.CONTROL_PLANE_CLOUD_ENTITLEMENT_VALID_FROM,
    validUntil: process.env.CONTROL_PLANE_CLOUD_ENTITLEMENT_VALID_UNTIL,
    seatLimit: process.env.CONTROL_PLANE_CLOUD_ENTITLEMENT_SEAT_LIMIT,
    activeSeatUserIds:
      process.env.CONTROL_PLANE_CLOUD_ENTITLEMENT_ACTIVE_SEAT_USER_IDS,
    reason: process.env.CONTROL_PLANE_CLOUD_ENTITLEMENT_REASON,
  });
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const result = await manageCloudWorkspaceEntitlement(pool, request);
    console.log(
      `[cloud-entitlement] state=${result.state} channel=${request.channel} ` +
        `target=${result.targetFingerprint} organization=${result.organizationId} ` +
        `actor=${result.actorUserId} plan=${result.next.plan} ` +
        `status=${result.next.status} seats=${result.next.activeSeatUserIds.length} ` +
        `seat_limit=${result.next.seatLimit ?? "none"}`,
    );
    if (result.approval) {
      console.log(`[cloud-entitlement] approval=${result.approval}`);
    }
  } finally {
    await pool.end();
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  runCli().catch((error) => {
    console.error(
      `[cloud-entitlement] failed: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
    process.exitCode = 1;
  });
}

import { randomBytes, randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import type pg from "pg";
import { z } from "zod";

import type { AuthedUser } from "./auth.js";
import { HttpError } from "./authz.js";
import { audit } from "./audit.js";
import { withSystemTx, type Tx } from "./db.js";
import {
  enqueueWorkOSCommand,
  workOSInvitationOrderingKey,
} from "./workos-command-outbox.js";

export const DELETION_GRACE_DAYS = 30;
export const SENSITIVE_ACTION_MAX_AGE_SECONDS = 5 * 60;

const LOCATOR_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** The public code is an exact support locator, never proof of ownership. */
export function deletionRecoveryCode(): string {
  const bytes = randomBytes(8);
  const characters = Array.from(
    bytes,
    (byte) => LOCATOR_ALPHABET[byte % LOCATOR_ALPHABET.length],
  ).join("");
  return `ZD-${characters.slice(0, 4)}-${characters.slice(4)}`;
}

export function deletionGracePeriod(requestedAt: Date): Date {
  return new Date(
    requestedAt.getTime() + DELETION_GRACE_DAYS * 24 * 60 * 60 * 1_000,
  );
}

/** `auth_time` advances only after active authentication, never refresh. */
export function requiresFreshAuthentication(
  authTimeSeconds: number | null,
  nowSeconds = Date.now() / 1_000,
): boolean {
  return (
    authTimeSeconds === null ||
    !Number.isFinite(authTimeSeconds) ||
    authTimeSeconds > nowSeconds + 60 ||
    nowSeconds - authTimeSeconds > SENSITIVE_ACTION_MAX_AGE_SECONDS
  );
}

/** A deletion-pending account remains denied everywhere except the two exact
 * endpoints needed to inspect and reverse its own request. Prefix matching is
 * deliberately forbidden so later account routes do not inherit this bypass. */
export function isDeletionRecoveryRequest(
  method: string,
  pathname: string,
): boolean {
  return (
    (method === "GET" && pathname === "/v1/account/deletion") ||
    (method === "POST" && pathname === "/v1/account/deletion/restore")
  );
}

const Uuid = z.string().uuid();
const AccountConfirmation = z.object({
  confirmation: z.literal("DELETE MY ACCOUNT"),
});
const OrganizationConfirmation = z.object({
  // Parsed before the organization is loaded so Personal can retain its
  // stronger invariant even when a legacy client sends no body. The
  // transaction requires this value for every self-service organization.
  confirmation: z.string().trim().min(1).max(500).optional(),
});
const RestoreRequest = z.object({ requestId: Uuid });

type DeletionState =
  | "scheduled"
  | "restored"
  | "purging"
  | "provider_deleting"
  | "purged"
  | "failed";

export type DeletionRequestRow = {
  id: string;
  public_code: string;
  target_kind: "account" | "organization";
  target_id: string;
  state: DeletionState;
  requested_at: Date;
  purge_after: Date;
};

type PublicDeletionRequest = {
  id: string;
  recoveryCode: string;
  targetKind: "account" | "organization";
  targetId: string;
  state: DeletionState;
  requestedAt: string;
  purgeAfter: string;
};

export function publicDeletionRequest(
  row: DeletionRequestRow,
): PublicDeletionRequest {
  return {
    id: row.id,
    recoveryCode: row.public_code,
    targetKind: row.target_kind,
    targetId: row.target_id,
    state: row.state,
    requestedAt: row.requested_at.toISOString(),
    purgeAfter: row.purge_after.toISOString(),
  };
}

function requireFreshWorkOS(user: AuthedUser): void {
  if (
    user.identity.provider !== "workos" ||
    requiresFreshAuthentication(user.authentication.authTime)
  ) {
    throw new HttpError(
      401,
      "reauthentication_required",
      "Sign in again before changing deletion settings.",
      { maxAgeSeconds: SENSITIVE_ACTION_MAX_AGE_SECONDS },
    );
  }
}

async function event(
  tx: Tx,
  requestId: string,
  actorId: string | null,
  action: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await tx.query(
    `INSERT INTO deletion_request_events (
       deletion_request_id, actor_user_id, action, metadata
     ) VALUES ($1, $2, $3, $4::jsonb)`,
    [requestId, actorId, action, JSON.stringify(metadata)],
  );
}

async function notify(
  tx: Tx,
  input: {
    userId: string | null;
    email: string;
    template:
      | "account_deletion_scheduled"
      | "account_deletion_restored"
      | "account_deletion_completed"
      | "organization_deletion_scheduled"
      | "organization_deletion_restored"
      | "organization_deletion_completed";
    request: DeletionRequestRow;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO security_notification_outbox (
       user_id, destination_email, template, payload
     ) VALUES (
       $1, $2, $3,
       jsonb_build_object(
         'recovery_code', $4::text,
         'request_id', $5::text,
         'purge_after', $6::timestamptz
       )
     )`,
    [
      input.userId,
      input.email,
      input.template,
      input.request.public_code,
      input.request.id,
      input.request.purge_after,
    ],
  );
}

async function assertPersonalHasNoCloudWorkspace(
  tx: Tx,
  accountId: string,
): Promise<void> {
  const impossible = await tx.query(
    `SELECT 1
     FROM cloud_workspaces workspace
     JOIN organizations organization ON organization.id = workspace.org_id
     WHERE organization.created_by = $1 AND organization.is_personal
     LIMIT 1`,
    [accountId],
  );
  if (impossible.rows[0]) {
    throw new Error("personal_cloud_workspace_invariant_violation");
  }
}

async function insertDeletionRequest(
  tx: Tx,
  input: {
    targetKind: "account" | "organization";
    targetId: string;
    userId?: string;
    organizationId?: string;
    requestedBy: string;
    parentRequestId?: string;
    origin?: "self_service" | "account_cascade" | "staff_operation";
  },
): Promise<DeletionRequestRow> {
  const inserted = await tx.query<DeletionRequestRow>(
    `INSERT INTO deletion_requests (
       public_code, target_kind, target_id, target_user_id,
       target_organization_id, requested_by_user_id, parent_request_id, origin
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, public_code, target_kind, target_id, state,
               requested_at, purge_after`,
    [
      deletionRecoveryCode(),
      input.targetKind,
      input.targetId,
      input.userId ?? null,
      input.organizationId ?? null,
      input.requestedBy,
      input.parentRequestId ?? null,
      input.origin ?? "self_service",
    ],
  );
  return inserted.rows[0]!;
}

async function scheduleOrganizationInTransaction(
  tx: Tx,
  input: {
    organizationId: string;
    actor: AuthedUser;
    expectedName?: string;
    parentRequestId?: string;
    origin?: "self_service" | "account_cascade";
  },
): Promise<DeletionRequestRow> {
  const selected = await tx.query<{
    id: string;
    name: string;
    is_personal: boolean;
    role: "owner" | "admin" | "member";
  }>(
    `SELECT o.id, o.name, o.is_personal, om.role
     FROM organizations o
     JOIN organization_members om
       ON om.org_id = o.id AND om.user_id = $2
     WHERE o.id = $1 AND o.deleted_at IS NULL
       AND o.lifecycle_status = 'active'
     FOR UPDATE OF o, om`,
    [input.organizationId, input.actor.id],
  );
  const organization = selected.rows[0];
  if (!organization) {
    throw new HttpError(404, "not_found", "Organization not found");
  }
  if (organization.is_personal) {
    throw new HttpError(
      409,
      "personal_organization",
      "Personal is permanent and device-local.",
    );
  }
  if (organization.role !== "owner") {
    throw new HttpError(403, "forbidden", "Owner access required");
  }
  if (
    input.origin !== "account_cascade" &&
    input.expectedName !== organization.name
  ) {
    throw new HttpError(
      422,
      "confirmation_mismatch",
      "Enter the exact organization name to continue.",
    );
  }

  // Cloud provider deletion has a separate verified lifecycle. Scheduling an
  // organization while a provider resource remains would either leak paid
  // infrastructure or make the 30-day restore promise false.
  const retainedWorkspace = await tx.query(
    `SELECT 1 FROM cloud_workspaces
     WHERE org_id = $1 AND status <> 'deleted'
     LIMIT 1`,
    [organization.id],
  );
  if (retainedWorkspace.rows[0]) {
    throw new HttpError(
      409,
      "organization_has_cloud_workspaces",
      "Delete every cloud workspace before scheduling organization deletion.",
    );
  }

  const members = await tx.query<{ user_id: string; email: string }>(
    `SELECT om.user_id, u.email
     FROM organization_members om
     JOIN users u ON u.id = om.user_id
     WHERE om.org_id = $1`,
    [organization.id],
  );
  const request = await insertDeletionRequest(tx, {
    targetKind: "organization",
    targetId: organization.id,
    organizationId: organization.id,
    requestedBy: input.actor.id,
    ...(input.parentRequestId
      ? { parentRequestId: input.parentRequestId }
      : {}),
    origin: input.origin ?? "self_service",
  });
  const revision = await tx.query<{
    authorization_revision: string | number;
    data_revision: string | number;
  }>(
    `UPDATE organizations
     SET deleted_at = $2,
         lifecycle_status = 'scheduled',
         deletion_request_id = $3,
         deletion_scheduled_at = $2,
         purge_after = $4,
         authorization_revision = authorization_revision + 1,
         data_revision = data_revision + 1
     WHERE id = $1
     RETURNING authorization_revision, data_revision`,
    [organization.id, request.requested_at, request.id, request.purge_after],
  );
  await tx.query(
    `UPDATE cloud_workspace_endpoint_grants
     SET revoked_at = COALESCE(revoked_at, now())
     WHERE org_id = $1 AND revoked_at IS NULL`,
    [organization.id],
  );
  await audit(
    tx,
    organization.id,
    input.actor.id,
    "organization.deletion_scheduled",
    { requestId: request.id, purgeAfter: request.purge_after.toISOString() },
  );
  await event(tx, request.id, input.actor.id, "deletion.scheduled", {
    target: "organization",
  });
  for (const member of members.rows) {
    await tx.query(
      `INSERT INTO security_events (
         kind, user_id, org_id, authorization_revision, data_revision, payload
       ) VALUES (
         'organization.access_revoked', $1, $2, $3, $4,
         jsonb_build_object('reason', 'organization_deletion_scheduled')
       )`,
      [
        member.user_id,
        organization.id,
        Number(revision.rows[0]!.authorization_revision),
        Number(revision.rows[0]!.data_revision),
      ],
    );
    await notify(tx, {
      userId: member.user_id,
      email: member.email,
      template: "organization_deletion_scheduled",
      request,
    });
  }
  return request;
}

async function restoreOrganizationRecordInTransaction(
  tx: Tx,
  input: {
    organizationId: string;
    request: DeletionRequestRow;
    restoredByUserId: string;
    supportCaseReference?: string;
  },
): Promise<DeletionRequestRow> {
  const { request } = input;
  const revisions = await tx.query<{
    authorization_revision: string | number;
    data_revision: string | number;
  }>(
    `UPDATE organizations
     SET deleted_at = NULL, lifecycle_status = 'active',
         deletion_request_id = NULL, deletion_scheduled_at = NULL,
         purge_after = NULL,
         authorization_revision = authorization_revision + 1,
         data_revision = data_revision + 1
     WHERE id = $1 AND deletion_request_id = $2
       AND lifecycle_status = 'scheduled'
     RETURNING authorization_revision, data_revision`,
    [input.organizationId, request.id],
  );
  if (!revisions.rows[0]) {
    throw new HttpError(
      409,
      "deletion_not_recoverable",
      "This organization can no longer be restored automatically.",
    );
  }
  await tx.query(
    `UPDATE deletion_requests
     SET state = 'restored', restored_at = now(), restored_by_user_id = $2,
         updated_at = now(), lease_owner = NULL, lease_expires_at = NULL
     WHERE id = $1`,
    [request.id, input.restoredByUserId],
  );
  await tx.query(
    `INSERT INTO deletion_request_events (
       deletion_request_id, actor_user_id, action,
       support_case_reference, metadata
     ) VALUES ($1, $2, 'deletion.restored', $3, $4::jsonb)`,
    [
      request.id,
      input.restoredByUserId,
      input.supportCaseReference ?? null,
      JSON.stringify({ target: "organization" }),
    ],
  );
  await audit(
    tx,
    input.organizationId,
    input.restoredByUserId,
    "organization.restored",
    {
      requestId: request.id,
      ...(input.supportCaseReference
        ? { supportCaseReference: input.supportCaseReference }
        : {}),
    },
  );
  const members = await tx.query<{ user_id: string; email: string }>(
    `SELECT om.user_id, u.email
     FROM organization_members om JOIN users u ON u.id = om.user_id
     WHERE om.org_id = $1`,
    [input.organizationId],
  );
  for (const member of members.rows) {
    await tx.query(
      `INSERT INTO security_events (
         kind, user_id, org_id, authorization_revision, data_revision, payload
       ) VALUES (
         'organization.authorization_changed', $1, $2, $3, $4,
         jsonb_build_object('reason', 'organization_deletion_restored')
       )`,
      [
        member.user_id,
        input.organizationId,
        Number(revisions.rows[0]!.authorization_revision),
        Number(revisions.rows[0]!.data_revision),
      ],
    );
    await notify(tx, {
      userId: member.user_id,
      email: member.email,
      template: "organization_deletion_restored",
      request,
    });
  }
  return { ...request, state: "restored" };
}

async function restoreOrganizationInTransaction(
  tx: Tx,
  input: { organizationId: string; requestId: string; actor: AuthedUser },
): Promise<DeletionRequestRow> {
  const selected = await tx.query<
    DeletionRequestRow & { role: "owner" | "admin" | "member" }
  >(
    `SELECT r.id, r.public_code, r.target_kind, r.target_id, r.state,
            r.requested_at, r.purge_after, om.role
     FROM deletion_requests r
     JOIN organizations o
       ON o.id = r.target_organization_id
      AND o.deletion_request_id = r.id
      AND o.lifecycle_status = 'scheduled'
     JOIN organization_members om
       ON om.org_id = o.id AND om.user_id = $3
     WHERE r.id = $1 AND r.target_kind = 'organization'
       AND r.target_id = $2
     FOR UPDATE OF r, o, om`,
    [input.requestId, input.organizationId, input.actor.id],
  );
  const request = selected.rows[0];
  if (!request) {
    throw new HttpError(404, "not_found", "Deletion request not found");
  }
  if (request.role !== "owner") {
    throw new HttpError(403, "forbidden", "Owner access required");
  }
  if (request.state !== "scheduled" || request.purge_after <= new Date()) {
    throw new HttpError(
      409,
      "deletion_not_recoverable",
      "This organization can no longer be restored automatically.",
    );
  }
  return restoreOrganizationRecordInTransaction(tx, {
    organizationId: input.organizationId,
    request,
    restoredByUserId: input.actor.id,
  });
}

async function scheduleAccount(
  pool: pg.Pool,
  actor: AuthedUser,
): Promise<DeletionRequestRow> {
  requireFreshWorkOS(actor);
  if (actor.staffRole !== null) {
    throw new HttpError(
      409,
      "staff_account",
      "Remove the Zeros staff role before deleting this account.",
    );
  }
  if (actor.accountStatus !== "active") {
    throw new HttpError(
      409,
      "deletion_already_scheduled",
      "This account already has a deletion request.",
    );
  }

  return withSystemTx(pool, async (tx) => {
    const account = await tx.query<{
      id: string;
      email: string;
      auth_status: string;
      deleted_at: Date | null;
    }>(
      `SELECT id, email, auth_status, deleted_at
       FROM users WHERE id = $1 FOR UPDATE`,
      [actor.id],
    );
    const row = account.rows[0];
    if (!row || row.deleted_at || row.auth_status !== "active") {
      throw new HttpError(
        409,
        "deletion_already_scheduled",
        "This account already has a deletion request.",
      );
    }

    const owned = await tx.query<{
      id: string;
      member_count: string | number;
      owner_count: string | number;
    }>(
      `SELECT o.id,
              (
                SELECT count(*)::integer
                FROM organization_members members
                WHERE members.org_id = o.id
              ) AS member_count,
              (
                SELECT count(*)::integer
                FROM organization_members owners
                WHERE owners.org_id = o.id AND owners.role = 'owner'
              ) AS owner_count
       FROM organizations o
       JOIN organization_members mine
         ON mine.org_id = o.id AND mine.user_id = $1 AND mine.role = 'owner'
       WHERE NOT o.is_personal AND o.deleted_at IS NULL
         AND o.lifecycle_status = 'active'
       ORDER BY o.id
       FOR UPDATE OF o`,
      [actor.id],
    );
    const blocking = owned.rows.find(
      (organization) =>
        Number(organization.member_count) > 1 &&
        Number(organization.owner_count) === 1,
    );
    if (blocking) {
      throw new HttpError(
        409,
        "ownership_transfer_required",
        "Transfer ownership of every shared organization before deleting your account.",
        { organizationId: blocking.id },
      );
    }

    const request = await insertDeletionRequest(tx, {
      targetKind: "account",
      targetId: actor.id,
      userId: actor.id,
      requestedBy: actor.id,
    });

    // A one-member Pro-style organization has no surviving owner, so it joins
    // the same grace period. Shared Business-style organizations remain owned
    // by their other owners and keep all tenant data.
    for (const organization of owned.rows) {
      if (Number(organization.member_count) !== 1) continue;
      await scheduleOrganizationInTransaction(tx, {
        organizationId: organization.id,
        actor,
        parentRequestId: request.id,
        origin: "account_cascade",
      });
    }

    const updated = await tx.query<{ auth_revision: string | number }>(
      `UPDATE users
       SET auth_status = 'deletion_pending', deleted_at = $2,
           deletion_request_id = $3, deletion_scheduled_at = $2,
           purge_after = $4, auth_revoked_at = $2,
           auth_status_changed_at = $2, auth_revision = auth_revision + 1
       WHERE id = $1
       RETURNING auth_revision`,
      [actor.id, request.requested_at, request.id, request.purge_after],
    );
    await tx.query(
      `UPDATE auth_sessions
       SET status = 'revoked', revoked_at = now(),
           revocation_reason = 'account_deletion_scheduled'
       WHERE user_id = $1 AND status = 'active'`,
      [actor.id],
    );
    await tx.query(
      `DELETE FROM workos_browser_sessions
       WHERE account_user_id = $1 OR provider_sub = $2`,
      [actor.id, actor.identity.subject],
    );
    await tx.query(
      `UPDATE cloud_workspace_endpoint_grants
       SET revoked_at = COALESCE(revoked_at, now())
       WHERE account_user_id = $1 AND revoked_at IS NULL`,
      [actor.id],
    );
    await enqueueWorkOSCommand(tx, {
      operation: "sessions.revoke_all",
      idempotencyKey: `account.sessions.${actor.id}.${updated.rows[0]!.auth_revision}`,
      aggregateKey: `account-sessions:${actor.id}`,
      orderingKey: `account:${actor.id}`,
      aggregateRevision: Number(updated.rows[0]!.auth_revision),
      userId: actor.id,
      providerObjectId: actor.identity.subject,
      payload: {
        workosUserId: actor.identity.subject,
        createdBefore: request.requested_at.toISOString(),
      },
    });
    await tx.query(
      `INSERT INTO security_events (
         kind, user_id, account_revision, payload
       ) VALUES (
         'account.revoked', $1, $2,
         jsonb_build_object('reason', 'account_deletion_scheduled')
       )`,
      [actor.id, Number(updated.rows[0]!.auth_revision)],
    );
    await event(tx, request.id, actor.id, "deletion.scheduled", {
      target: "account",
    });
    await notify(tx, {
      userId: actor.id,
      email: row.email,
      template: "account_deletion_scheduled",
      request,
    });
    return request;
  });
}

async function restoreAccountRecordInTransaction(
  tx: Tx,
  input: {
    accountId: string;
    email: string;
    request: DeletionRequestRow;
    restoredByUserId: string;
    supportCaseReference?: string;
  },
): Promise<DeletionRequestRow> {
  const account = await tx.query<{ auth_revision: string | number }>(
    `UPDATE users
     SET auth_status = 'active', deleted_at = NULL,
         deletion_request_id = NULL, deletion_scheduled_at = NULL,
         purge_after = NULL, auth_disabled_at = NULL,
         auth_status_changed_at = now(), auth_revision = auth_revision + 1
     WHERE id = $1 AND auth_status = 'deletion_pending'
       AND deletion_request_id = $2
     RETURNING auth_revision`,
    [input.accountId, input.request.id],
  );
  if (!account.rows[0]) {
    throw new HttpError(
      409,
      "deletion_not_recoverable",
      "This account can no longer be restored automatically.",
    );
  }
  await tx.query(
    `UPDATE deletion_requests
     SET state = 'restored', restored_at = now(), restored_by_user_id = $2,
         updated_at = now(), lease_owner = NULL, lease_expires_at = NULL
     WHERE id = $1`,
    [input.request.id, input.restoredByUserId],
  );
  await tx.query(
    `INSERT INTO deletion_request_events (
       deletion_request_id, actor_user_id, action,
       support_case_reference, metadata
     ) VALUES ($1, $2, 'deletion.restored', $3, $4::jsonb)`,
    [
      input.request.id,
      input.restoredByUserId,
      input.supportCaseReference ?? null,
      JSON.stringify({ target: "account" }),
    ],
  );

  const children = await tx.query<DeletionRequestRow>(
    `SELECT id, public_code, target_kind, target_id, state,
            requested_at, purge_after
     FROM deletion_requests
     WHERE parent_request_id = $1 AND target_kind = 'organization'
       AND state = 'scheduled'
     FOR UPDATE`,
    [input.request.id],
  );
  for (const child of children.rows) {
    await restoreOrganizationRecordInTransaction(tx, {
      organizationId: child.target_id,
      request: child,
      restoredByUserId: input.restoredByUserId,
      ...(input.supportCaseReference
        ? { supportCaseReference: input.supportCaseReference }
        : {}),
    });
  }
  const membershipsToProject = await tx.query<{
    org_id: string;
    role: "owner" | "admin" | "member";
    workos_sync_revision: string | number;
    provider_sub: string;
    email: string;
  }>(
    `SELECT om.org_id, om.role, om.workos_sync_revision,
            identity.provider_sub, u.email
     FROM organization_members om
     JOIN organizations o ON o.id = om.org_id
     JOIN users u ON u.id = om.user_id
     JOIN user_identities identity
       ON identity.user_id = om.user_id
      AND identity.provider = 'workos' AND identity.status = 'active'
     JOIN workos_organization_links provider_org
       ON provider_org.organization_id = om.org_id
      AND provider_org.state IN ('active', 'provisioning')
     WHERE om.user_id = $1 AND NOT o.is_personal
       AND o.deleted_at IS NULL AND o.lifecycle_status = 'active'
       AND om.membership_source <> 'scim'
       AND om.workos_membership_id IS NULL
     ORDER BY om.org_id`,
    [input.accountId],
  );
  for (const membership of membershipsToProject.rows) {
    await enqueueWorkOSCommand(tx, {
      operation: "membership.create",
      idempotencyKey: `membership.${membership.org_id}.${input.accountId}.${membership.workos_sync_revision}`,
      aggregateKey: `membership:${membership.org_id}:${input.accountId}`,
      orderingKey: workOSInvitationOrderingKey(
        membership.org_id,
        membership.email,
      ),
      aggregateRevision: Number(membership.workos_sync_revision),
      organizationId: membership.org_id,
      userId: input.accountId,
      payload: {
        workosUserId: membership.provider_sub,
        role: membership.role,
      },
    });
  }
  await tx.query(
    `INSERT INTO security_events (
       kind, user_id, account_revision, payload
     ) VALUES (
       'account.authorization_changed', $1, $2,
       jsonb_build_object('reason', 'account_deletion_restored')
     )`,
    [input.accountId, Number(account.rows[0]!.auth_revision)],
  );
  await notify(tx, {
    userId: input.accountId,
    email: input.email,
    template: "account_deletion_restored",
    request: input.request,
  });
  return { ...input.request, state: "restored" };
}

async function restoreAccount(
  pool: pg.Pool,
  actor: AuthedUser,
  requestId: string,
): Promise<DeletionRequestRow> {
  requireFreshWorkOS(actor);
  if (actor.accountStatus !== "deletion_pending") {
    throw new HttpError(
      409,
      "deletion_not_pending",
      "This account has no pending deletion request.",
    );
  }
  return withSystemTx(pool, async (tx) => {
    const selected = await tx.query<DeletionRequestRow & { email: string }>(
      `SELECT r.id, r.public_code, r.target_kind, r.target_id, r.state,
              r.requested_at, r.purge_after, u.email
       FROM deletion_requests r
       JOIN users u
         ON u.id = r.target_user_id AND u.deletion_request_id = r.id
       WHERE r.id = $1 AND r.target_kind = 'account' AND r.target_id = $2
       FOR UPDATE OF r, u`,
      [requestId, actor.id],
    );
    const request = selected.rows[0];
    if (!request) {
      throw new HttpError(404, "not_found", "Deletion request not found");
    }
    if (request.state !== "scheduled" || request.purge_after <= new Date()) {
      throw new HttpError(
        409,
        "deletion_not_recoverable",
        "This account can no longer be restored automatically.",
      );
    }
    return restoreAccountRecordInTransaction(tx, {
      accountId: actor.id,
      email: request.email,
      request,
      restoredByUserId: actor.id,
    });
  });
}

/** Staff authorization is deliberately performed by the isolated Ops router.
 * This function owns only the state transition, locks, audit evidence, and
 * notifications so customer and staff recovery cannot drift into two data
 * models. */
export async function restoreDeletionRequestByStaff(
  pool: pg.Pool,
  input: {
    requestId: string;
    operatorUserId: string;
    supportCaseReference: string;
  },
): Promise<DeletionRequestRow> {
  return withSystemTx(pool, async (tx) => {
    const selected = await tx.query<
      DeletionRequestRow & {
        target_user_id: string | null;
        target_organization_id: string | null;
      }
    >(
      `SELECT id, public_code, target_kind, target_id, state,
              requested_at, purge_after, target_user_id,
              target_organization_id
       FROM deletion_requests
       WHERE id = $1
       FOR UPDATE`,
      [input.requestId],
    );
    const request = selected.rows[0];
    if (!request) {
      throw new HttpError(404, "not_found", "Deletion request not found");
    }
    if (request.state !== "scheduled" || request.purge_after <= new Date()) {
      throw new HttpError(
        409,
        "deletion_not_recoverable",
        "This deletion request can no longer be restored.",
      );
    }

    if (request.target_kind === "account") {
      if (!request.target_user_id) {
        throw new HttpError(
          409,
          "deletion_not_recoverable",
          "This account can no longer be restored.",
        );
      }
      const account = await tx.query<{ email: string }>(
        `SELECT email FROM users
         WHERE id = $1 AND auth_status = 'deletion_pending'
           AND deletion_request_id = $2
         FOR UPDATE`,
        [request.target_user_id, request.id],
      );
      if (!account.rows[0]) {
        throw new HttpError(
          409,
          "deletion_not_recoverable",
          "This account can no longer be restored.",
        );
      }
      return restoreAccountRecordInTransaction(tx, {
        accountId: request.target_user_id,
        email: account.rows[0].email,
        request,
        restoredByUserId: input.operatorUserId,
        supportCaseReference: input.supportCaseReference,
      });
    }

    if (!request.target_organization_id) {
      throw new HttpError(
        409,
        "deletion_not_recoverable",
        "This organization can no longer be restored.",
      );
    }
    const organization = await tx.query(
      `SELECT 1 FROM organizations
       WHERE id = $1 AND lifecycle_status = 'scheduled'
         AND deletion_request_id = $2
       FOR UPDATE`,
      [request.target_organization_id, request.id],
    );
    if (!organization.rows[0]) {
      throw new HttpError(
        409,
        "deletion_not_recoverable",
        "This organization can no longer be restored.",
      );
    }
    return restoreOrganizationRecordInTransaction(tx, {
      organizationId: request.target_organization_id,
      request,
      restoredByUserId: input.operatorUserId,
      supportCaseReference: input.supportCaseReference,
    });
  });
}

/** Enter the durable purge worker immediately. This does not issue provider
 * calls inline: the same leased/outboxed workflow used after day 30 performs
 * and verifies WorkOS erasure before local finalization. */
export async function forceDeletionRequestPurgeByStaff(
  pool: pg.Pool,
  input: {
    requestId: string;
    operatorUserId: string;
    supportCaseReference: string;
  },
): Promise<DeletionRequestRow> {
  return withSystemTx(pool, async (tx) => {
    const selected = await tx.query<DeletionRequestRow>(
      `SELECT id, public_code, target_kind, target_id, state,
              requested_at, purge_after
       FROM deletion_requests
       WHERE id = $1
       FOR UPDATE`,
      [input.requestId],
    );
    const request = selected.rows[0];
    if (!request) {
      throw new HttpError(404, "not_found", "Deletion request not found");
    }
    if (request.state !== "scheduled") {
      throw new HttpError(
        409,
        "deletion_not_purgeable",
        "This deletion request cannot be force-purged in its current state.",
      );
    }

    const accelerated = await tx.query<DeletionRequestRow>(
      `UPDATE deletion_requests
       SET state = 'purging', purge_started_at = now(), next_attempt_at = now(),
           lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE id = $1 AND state = 'scheduled'
       RETURNING id, public_code, target_kind, target_id, state,
                 requested_at, purge_after`,
      [request.id],
    );
    await tx.query(
      `INSERT INTO deletion_request_events (
         deletion_request_id, actor_user_id, action,
         support_case_reference, metadata
       ) VALUES ($1, $2, 'purge.forced', $3, $4::jsonb)`,
      [
        request.id,
        input.operatorUserId,
        input.supportCaseReference,
        JSON.stringify({ target: request.target_kind }),
      ],
    );

    // A Pro organization cascaded from an account request is part of the same
    // deletion promise. Accelerate those exact children as one auditable unit.
    if (request.target_kind === "account") {
      const children = await tx.query<{ id: string }>(
        `UPDATE deletion_requests
         SET state = 'purging', purge_started_at = now(),
             next_attempt_at = now(), updated_at = now()
         WHERE parent_request_id = $1 AND target_kind = 'organization'
           AND state = 'scheduled'
         RETURNING id`,
        [request.id],
      );
      for (const child of children.rows) {
        await tx.query(
          `INSERT INTO deletion_request_events (
             deletion_request_id, actor_user_id, action,
             support_case_reference, metadata
           ) VALUES ($1, $2, 'purge.forced', $3, $4::jsonb)`,
          [
            child.id,
            input.operatorUserId,
            input.supportCaseReference,
            JSON.stringify({ target: "organization", reason: "account_purge" }),
          ],
        );
      }
    }
    return accelerated.rows[0]!;
  });
}

function parsedBody<T>(schema: z.ZodSchema<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new HttpError(422, "invalid_input", "Invalid request body");
  }
  return result.data;
}

/** Customer lifecycle surface. Operator recovery is deliberately separate so
 * an ops authorization bug cannot widen ordinary customer routes. */
export function createDeletionLifecycleRoutes(pool: pg.Pool): Hono {
  const app = new Hono();

  app.get("/v1/account/deletion", async (c) => {
    const user = c.get("user");
    const result = await withSystemTx(pool, (tx) =>
      tx.query<DeletionRequestRow>(
        `SELECT id, public_code, target_kind, target_id, state,
                requested_at, purge_after
         FROM deletion_requests
         WHERE target_kind = 'account' AND target_id = $1
         ORDER BY requested_at DESC LIMIT 1`,
        [user.id],
      ),
    );
    const request = result.rows[0];
    return c.json({
      deletion: request ? publicDeletionRequest(request) : null,
    });
  });

  app.post("/v1/account/deletion", async (c) => {
    const user = c.get("user");
    parsedBody(AccountConfirmation, await c.req.json().catch(() => ({})));
    const request = await scheduleAccount(pool, user);
    return c.json({ deletion: publicDeletionRequest(request) }, 202);
  });

  app.post("/v1/account/deletion/restore", async (c) => {
    const user = c.get("user");
    const body = parsedBody(
      RestoreRequest,
      await c.req.json().catch(() => ({})),
    );
    const request = await restoreAccount(pool, user, body.requestId);
    return c.json({ deletion: publicDeletionRequest(request) });
  });

  app.get("/v1/deletions", async (c) => {
    const user = c.get("user");
    const result = await withSystemTx(pool, (tx) =>
      tx.query<DeletionRequestRow>(
        `SELECT DISTINCT r.id, r.public_code, r.target_kind, r.target_id,
                r.state, r.requested_at, r.purge_after
         FROM deletion_requests r
         JOIN organization_members om
           ON om.org_id = r.target_organization_id
          AND om.user_id = $1 AND om.role = 'owner'
         WHERE r.target_kind = 'organization' AND r.state = 'scheduled'
           AND r.purge_after > now()
         ORDER BY r.requested_at DESC, r.id`,
        [user.id],
      ),
    );
    return c.json({ deletions: result.rows.map(publicDeletionRequest) });
  });

  const scheduleOrganization = async (c: Context) => {
    const user = c.get("user") as AuthedUser;
    requireFreshWorkOS(user);
    const organizationId = Uuid.safeParse(c.req.param("organization"));
    if (!organizationId.success) {
      throw new HttpError(404, "not_found", "Organization not found");
    }
    const body = parsedBody(
      OrganizationConfirmation,
      await c.req.json().catch(() => ({})),
    );
    const request = await withSystemTx(pool, (tx) =>
      scheduleOrganizationInTransaction(tx, {
        organizationId: organizationId.data,
        actor: user,
        ...(body.confirmation !== undefined
          ? { expectedName: body.confirmation }
          : {}),
      }),
    );
    return c.json({ deletion: publicDeletionRequest(request) }, 202);
  };
  app.delete("/v1/organizations/:organization", scheduleOrganization);
  app.delete("/v1/teams/:organization", scheduleOrganization);

  const restoreOrganization = async (c: Context) => {
    const user = c.get("user") as AuthedUser;
    requireFreshWorkOS(user);
    const organizationId = Uuid.safeParse(c.req.param("organization"));
    if (!organizationId.success) {
      throw new HttpError(404, "not_found", "Organization not found");
    }
    const body = parsedBody(
      RestoreRequest,
      await c.req.json().catch(() => ({})),
    );
    const request = await withSystemTx(pool, (tx) =>
      restoreOrganizationInTransaction(tx, {
        organizationId: organizationId.data,
        requestId: body.requestId,
        actor: user,
      }),
    );
    return c.json({ deletion: publicDeletionRequest(request) });
  };
  app.post("/v1/organizations/:organization/restore", restoreOrganization);
  app.post("/v1/teams/:organization/restore", restoreOrganization);

  return app;
}

type ClaimedDeletion = DeletionRequestRow & {
  target_user_id: string | null;
  target_organization_id: string | null;
  purge_command_id: string | null;
  attempt_count: number;
};

export function deletionLifecycleErrorCode(error: unknown): string {
  const reason =
    error instanceof Error ? error.message || error.name : "unknown";
  return reason.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 128) || "unknown";
}

function lifecycleRetryMs(attempt: number): number {
  return Math.min(60 * 60_000, 5_000 * 2 ** Math.min(attempt, 10));
}

/** Durable final-erasure worker. It never runs before `purge_after`; provider
 * deletion is an idempotent WorkOS outbox command and local erasure happens
 * only after that command succeeds (or when the provider object is already
 * absent). */
export class DeletionLifecycleProcessor {
  private readonly workerId: string;
  private readonly logger: Pick<Console, "warn" | "error">;

  constructor(
    private readonly pool: pg.Pool,
    options: {
      workerId?: string;
      logger?: Pick<Console, "warn" | "error">;
    } = {},
  ) {
    this.workerId = options.workerId ?? `deletion:${randomUUID()}`;
    this.logger = options.logger ?? console;
  }

  private claim(): Promise<ClaimedDeletion | null> {
    return withSystemTx(this.pool, async (tx) => {
      const result = await tx.query<{
        id: string;
        public_code: string;
        target_kind: "account" | "organization";
        target_id: string;
        target_user_id: string | null;
        target_organization_id: string | null;
        state: DeletionState;
        requested_at: Date;
        purge_after: Date;
        purge_command_id: string | null;
        attempt_count: number;
      }>(
        `WITH candidate AS (
           SELECT id
           FROM deletion_requests
           WHERE attempt_count < 20
             AND next_attempt_at <= now()
             AND (
               (state = 'scheduled' AND purge_after <= now())
               OR (
                 state IN ('purging', 'provider_deleting', 'failed')
                 AND (lease_expires_at IS NULL OR lease_expires_at <= now())
               )
             )
           ORDER BY purge_after, requested_at, id
           LIMIT 1
           FOR UPDATE SKIP LOCKED
         )
         UPDATE deletion_requests request
         SET state = CASE
               WHEN request.state IN ('scheduled', 'failed')
                 THEN 'purging'::deletion_request_state
               ELSE request.state
             END,
             purge_started_at = COALESCE(purge_started_at, now()),
             attempt_count = attempt_count + 1,
             lease_owner = $1,
             lease_expires_at = now() + interval '60 seconds',
             last_error_code = NULL,
             updated_at = now()
         FROM candidate
         WHERE request.id = candidate.id
         RETURNING request.id, request.public_code, request.target_kind,
                   request.target_id, request.target_user_id,
                   request.target_organization_id, request.state,
                   request.requested_at, request.purge_after,
                   request.purge_command_id, request.attempt_count`,
        [this.workerId],
      );
      return result.rows[0] ?? null;
    });
  }

  private async release(
    request: ClaimedDeletion,
    delayMs: number,
  ): Promise<void> {
    await withSystemTx(this.pool, (tx) =>
      tx.query(
        `UPDATE deletion_requests
         SET next_attempt_at = now() + ($3::bigint * interval '1 millisecond'),
             lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
         WHERE id = $1 AND lease_owner = $2`,
        [request.id, this.workerId, delayMs],
      ),
    );
  }

  private async prepareProviderDeletion(
    request: ClaimedDeletion,
  ): Promise<void> {
    await withSystemTx(this.pool, async (tx) => {
      const owned = await tx.query(
        `SELECT 1 FROM deletion_requests
         WHERE id = $1 AND lease_owner = $2 AND state = 'purging'
         FOR UPDATE`,
        [request.id, this.workerId],
      );
      if (!owned.rows[0]) return;

      let commandId: string | null = null;
      if (request.target_kind === "account" && request.target_user_id) {
        // Do not erase the provider identity while an impossible legacy row
        // would prevent the corresponding Zeros account from finalizing.
        await assertPersonalHasNoCloudWorkspace(tx, request.target_user_id);
        const identity = await tx.query<{ provider_sub: string }>(
          `SELECT provider_sub FROM user_identities
           WHERE user_id = $1 AND provider = 'workos'
             AND status IN ('active', 'provider_deleted')
           ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at DESC
           LIMIT 1`,
          [request.target_user_id],
        );
        if (identity.rows[0]) {
          commandId = await enqueueWorkOSCommand(tx, {
            operation: "user.delete",
            idempotencyKey: `account.delete.${request.id}`,
            aggregateKey: `account-delete:${request.target_user_id}`,
            orderingKey: `account:${request.target_user_id}`,
            aggregateRevision: 1,
            userId: request.target_user_id,
            providerObjectId: identity.rows[0].provider_sub,
            payload: { workosUserId: identity.rows[0].provider_sub },
          });
        }
      }
      if (
        request.target_kind === "organization" &&
        request.target_organization_id
      ) {
        const retained = await tx.query(
          `SELECT 1 FROM cloud_workspaces
           WHERE org_id = $1 AND status <> 'deleted' LIMIT 1`,
          [request.target_organization_id],
        );
        if (retained.rows[0]) {
          throw new Error("organization_cloud_deletion_not_verified");
        }
        const link = await tx.query<{
          workos_organization_id: string | null;
          state: string;
        }>(
          `SELECT workos_organization_id, state
           FROM workos_organization_links
           WHERE organization_id = $1 FOR UPDATE`,
          [request.target_organization_id],
        );
        if (link.rows[0] && !link.rows[0].workos_organization_id) {
          throw new Error("workos_organization_not_ready");
        }
        if (link.rows[0]?.workos_organization_id) {
          const revision = await tx.query<{
            workos_sync_revision: string | number;
          }>(
            `UPDATE organizations
             SET lifecycle_status = 'purging',
                 workos_sync_revision = workos_sync_revision + 1
             WHERE id = $1
             RETURNING workos_sync_revision`,
            [request.target_organization_id],
          );
          await tx.query(
            `UPDATE workos_organization_links
             SET state = 'deleting', updated_at = now()
             WHERE organization_id = $1`,
            [request.target_organization_id],
          );
          commandId = await enqueueWorkOSCommand(tx, {
            operation: "organization.delete",
            idempotencyKey: `organization.delete.${request.id}`,
            aggregateKey: `organization-delete:${request.target_organization_id}`,
            orderingKey: `organization:${request.target_organization_id}`,
            aggregateRevision: Number(revision.rows[0]!.workos_sync_revision),
            organizationId: request.target_organization_id,
            providerObjectId: link.rows[0].workos_organization_id,
            payload: {},
          });
        } else {
          await tx.query(
            `UPDATE organizations SET lifecycle_status = 'purging'
             WHERE id = $1`,
            [request.target_organization_id],
          );
        }
      }
      await tx.query(
        `UPDATE deletion_requests
         SET state = 'provider_deleting', purge_command_id = $3,
             next_attempt_at = now() + interval '2 seconds',
             lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
         WHERE id = $1 AND lease_owner = $2`,
        [request.id, this.workerId, commandId],
      );
      await event(tx, request.id, null, "purge.provider_requested", {
        providerCommand: commandId !== null,
      });
    });
  }

  private async providerReady(request: ClaimedDeletion): Promise<boolean> {
    if (!request.purge_command_id) return true;
    const command = await withSystemTx(this.pool, (tx) =>
      tx.query<{ state: string; last_error_code: string | null }>(
        `SELECT state, last_error_code FROM workos_command_outbox WHERE id = $1`,
        [request.purge_command_id],
      ),
    );
    const row = command.rows[0];
    if (row?.state === "succeeded") return true;
    if (row?.state === "dead" || row?.state === "failed" || !row) {
      throw new Error(row?.last_error_code || "provider_delete_failed");
    }
    await this.release(request, 5_000);
    return false;
  }

  private async finalizeAccount(request: ClaimedDeletion): Promise<void> {
    if (!request.target_user_id) throw new Error("account_target_missing");
    await withSystemTx(this.pool, async (tx) => {
      // Defense in depth for a row introduced after provider deletion was
      // requested through privileged maintenance or restored legacy data.
      await assertPersonalHasNoCloudWorkspace(tx, request.target_user_id!);
      const account = await tx.query<{ id: string; email: string }>(
        `SELECT id, email FROM users
         WHERE id = $1 AND auth_status = 'deletion_pending'
           AND deletion_request_id = $2
         FOR UPDATE`,
        [request.target_user_id, request.id],
      );
      if (!account.rows[0]) throw new Error("account_purge_state_mismatch");
      const identities = await tx.query<{ provider_sub: string }>(
        `SELECT provider_sub FROM user_identities WHERE user_id = $1`,
        [request.target_user_id],
      );
      const subjects = identities.rows.map((row) => row.provider_sub);

      await tx.query(
        `DELETE FROM github_oauth_states WHERE owner_user_id = $1`,
        [request.target_user_id],
      );
      await tx.query(
        `DELETE FROM github_oauth_handoffs WHERE owner_user_id = $1`,
        [request.target_user_id],
      );
      await tx.query(
        `DELETE FROM github_authorizations WHERE owner_user_id = $1`,
        [request.target_user_id],
      );
      await tx.query(
        `DELETE FROM github_installations WHERE owner_user_id = $1`,
        [request.target_user_id],
      );
      await tx.query(
        `DELETE FROM github_audit_log
         WHERE owner_user_id = $1 OR actor_id = $1`,
        [request.target_user_id],
      );
      await tx.query(
        `DELETE FROM account_recovery_requests WHERE target_user_id = $1`,
        [request.target_user_id],
      );
      await tx.query(`DELETE FROM auth_sessions WHERE user_id = $1`, [
        request.target_user_id,
      ]);
      await tx.query(
        `DELETE FROM workos_browser_sessions
         WHERE account_user_id = $1
            OR ($2::text[] <> '{}'::text[] AND provider_sub = ANY($2::text[]))`,
        [request.target_user_id, subjects],
      );
      await tx.query(
        `DELETE FROM workos_membership_projections
         WHERE user_id = $1
            OR ($2::text[] <> '{}'::text[] AND workos_user_id = ANY($2::text[]))`,
        [request.target_user_id, subjects],
      );
      await tx.query(
        `DELETE FROM workos_event_inbox
         WHERE $1::text[] <> '{}'::text[]
           AND workos_user_id = ANY($1::text[])`,
        [subjects],
      );
      await tx.query(
        `DELETE FROM identity_provider_events
         WHERE $1::text[] <> '{}'::text[]
           AND provider_sub = ANY($1::text[])`,
        [subjects],
      );
      await tx.query(`DELETE FROM team_members WHERE user_id = $1`, [
        request.target_user_id,
      ]);
      await tx.query(`DELETE FROM organization_members WHERE user_id = $1`, [
        request.target_user_id,
      ]);
      await tx.query(
        `DELETE FROM cloud_workspace_endpoint_grants
         WHERE account_user_id = $1`,
        [request.target_user_id],
      );
      await tx.query(`DELETE FROM security_events WHERE user_id = $1`, [
        request.target_user_id,
      ]);
      await tx.query(
        `DELETE FROM security_notification_outbox WHERE user_id = $1`,
        [request.target_user_id],
      );
      await tx.query(
        `DELETE FROM organizations
         WHERE created_by = $1 AND is_personal`,
        [request.target_user_id],
      );
      await tx.query(`DELETE FROM user_identities WHERE user_id = $1`, [
        request.target_user_id,
      ]);
      await tx.query(
        `UPDATE users
         SET email = 'deleted+' || replace(id::text, '-', '') || '@deleted.invalid',
             display_name = NULL, avatar_url = NULL,
             auth_status = 'deleted', deleted_at = COALESCE(deleted_at, now()),
             auth_disabled_at = COALESCE(auth_disabled_at, now()),
             auth_revoked_at = COALESCE(auth_revoked_at, now()),
             auth_status_changed_at = now(), auth_revision = auth_revision + 1,
             deletion_request_id = NULL, deletion_scheduled_at = NULL,
             purge_after = NULL
         WHERE id = $1`,
        [request.target_user_id],
      );
      await notify(tx, {
        userId: null,
        email: account.rows[0].email,
        template: "account_deletion_completed",
        request,
      });
      await tx.query(
        `UPDATE deletion_requests
         SET state = 'purged', purged_at = now(), updated_at = now(),
             lease_owner = NULL, lease_expires_at = NULL,
             last_error_code = NULL
         WHERE id = $1 AND lease_owner = $2`,
        [request.id, this.workerId],
      );
      await event(tx, request.id, null, "purge.completed", {
        target: "account",
      });
    });
  }

  private async finalizeOrganization(request: ClaimedDeletion): Promise<void> {
    if (!request.target_organization_id) {
      throw new Error("organization_target_missing");
    }
    await withSystemTx(this.pool, async (tx) => {
      const organization = await tx.query<{ id: string }>(
        `SELECT id FROM organizations
         WHERE id = $1 AND lifecycle_status = 'purging'
           AND deletion_request_id = $2
         FOR UPDATE`,
        [request.target_organization_id, request.id],
      );
      if (!organization.rows[0]) {
        throw new Error("organization_purge_state_mismatch");
      }
      const members = await tx.query<{ user_id: string; email: string }>(
        `SELECT om.user_id, u.email
         FROM organization_members om
         JOIN users u ON u.id = om.user_id
         WHERE om.org_id = $1`,
        [request.target_organization_id],
      );
      await tx.query(
        `DELETE FROM workos_event_inbox
         WHERE workos_organization_id IN (
           SELECT workos_organization_id FROM workos_organization_links
           WHERE organization_id = $1
         )`,
        [request.target_organization_id],
      );
      await tx.query(`DELETE FROM cloud_workspaces WHERE org_id = $1`, [
        request.target_organization_id,
      ]);
      await tx.query(`DELETE FROM audit_log WHERE org_id = $1`, [
        request.target_organization_id,
      ]);
      await tx.query(`DELETE FROM organizations WHERE id = $1`, [
        request.target_organization_id,
      ]);
      for (const member of members.rows) {
        await notify(tx, {
          userId: member.user_id,
          email: member.email,
          template: "organization_deletion_completed",
          request,
        });
      }
      await tx.query(
        `UPDATE deletion_requests
         SET state = 'purged', purged_at = now(), updated_at = now(),
             lease_owner = NULL, lease_expires_at = NULL,
             last_error_code = NULL
         WHERE id = $1 AND lease_owner = $2`,
        [request.id, this.workerId],
      );
      await event(tx, request.id, null, "purge.completed", {
        target: "organization",
      });
    });
  }

  private async fail(request: ClaimedDeletion, error: unknown): Promise<void> {
    const code = deletionLifecycleErrorCode(error);
    await withSystemTx(this.pool, (tx) =>
      tx.query(
        `UPDATE deletion_requests
         SET state = 'failed', last_error_code = $3,
             next_attempt_at = now() + ($4::bigint * interval '1 millisecond'),
             lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
         WHERE id = $1 AND lease_owner = $2`,
        [
          request.id,
          this.workerId,
          code,
          lifecycleRetryMs(request.attempt_count),
        ],
      ),
    );
    this.logger.warn(
      `[deletion] request=${request.id} target=${request.target_kind} retry [${code}]`,
    );
  }

  async tick(limit = 10): Promise<number> {
    const bounded = Math.max(1, Math.min(50, Math.trunc(limit)));
    let processed = 0;
    while (processed < bounded) {
      const request = await this.claim();
      if (!request) break;
      processed += 1;
      try {
        if (request.state === "purging") {
          await this.prepareProviderDeletion(request);
          continue;
        } else if (!(await this.providerReady(request))) {
          continue;
        }
        if (request.target_kind === "account") {
          await this.finalizeAccount(request);
        } else {
          await this.finalizeOrganization(request);
        }
      } catch (error) {
        await this.fail(request, error);
      }
    }
    return processed;
  }
}

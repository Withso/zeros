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
  enqueueWorkOSUserDeletionCommand,
  workOSInvitationOrderingKey,
} from "./workos-command-outbox.js";
import {
  accountWorkOSProviderSubjects,
  assertAccountWorkOSProviderErasureSubjectLimit,
  withWorkOSProviderLocks,
  WorkOSProviderLockAbortedError,
  WorkOSProviderLockTimeoutError,
  workOSOrganizationProviderLockKey,
  workOSProviderSubjectHash,
  workOSProviderSubjectLockKey,
  workOSUserProviderLockKey,
  type WorkOSProviderSubject,
} from "./workos-provider-locks.js";

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

async function fenceErasedWorkOSSubjects(
  tx: Tx,
  requestId: string,
  subjects: readonly WorkOSProviderSubject[],
): Promise<void> {
  const hashes = Array.from(
    new Map(
      subjects.map((subject) => [
        `${subject.kind}\0${workOSProviderSubjectHash(subject)}`,
        { kind: subject.kind, hash: workOSProviderSubjectHash(subject) },
      ]),
    ).values(),
  ).sort((left, right) =>
    `${left.kind}\0${left.hash}`.localeCompare(`${right.kind}\0${right.hash}`),
  );
  for (const subject of hashes) {
    await tx.query(
      `INSERT INTO deletion_request_events (
         deletion_request_id, actor_user_id, action, metadata
       )
       SELECT $1, NULL, 'purge.provider_erasure_fenced', $4::jsonb
       WHERE NOT EXISTS (
         SELECT 1 FROM workos_provider_erasure_fences fence
         WHERE fence.deletion_request_id = $1 AND fence.provider = 'workos'
           AND fence.subject_kind = $2 AND fence.hash_version = 1
           AND fence.subject_hash = $3
       )`,
      [
        requestId,
        subject.kind,
        subject.hash,
        JSON.stringify({
          provider: "workos",
          workosSubjectHashes: [subject.hash],
        }),
      ],
    );
  }
}

async function reconcileWorkOSProviderErasure(
  tx: Tx,
  requestId: string,
): Promise<void> {
  const evidence = await tx.query<{ fence_count: number }>(
    `SELECT count(*)::int AS fence_count
     FROM workos_provider_erasure_fences
     WHERE deletion_request_id = $1 AND provider = 'workos'`,
    [requestId],
  );
  const disposition =
    (evidence.rows[0]?.fence_count ?? 0) > 0 ? "fenced" : "no_workos_subject";
  await tx.query(
    `INSERT INTO workos_provider_erasure_reconciliations (
       deletion_request_id, disposition, evidence_source, evidence_reference
     ) VALUES ($1, $2, 'lifecycle_worker', $3)
     ON CONFLICT (deletion_request_id) DO NOTHING`,
    [
      requestId,
      disposition,
      disposition === "fenced"
        ? "deletion-lifecycle:provider-subject-fenced"
        : "deletion-lifecycle:no-workos-subject",
    ],
  );
  const reconciled = await tx.query<{ disposition: string }>(
    `SELECT disposition FROM workos_provider_erasure_reconciliations
     WHERE deletion_request_id = $1`,
    [requestId],
  );
  if (reconciled.rows[0]?.disposition !== disposition) {
    throw new Error("workos_provider_erasure_reconciliation_mismatch");
  }
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
  const personalOrganizations = await tx.query<{ id: string }>(
    `SELECT id FROM organizations
     WHERE created_by = $1 AND is_personal
     FOR UPDATE`,
    [accountId],
  );
  if (personalOrganizations.rows.length === 0) return;
  const impossible = await tx.query<{ impossible: boolean }>(
    `SELECT public.personal_organization_has_cloud_configuration($1)
              AS impossible`,
    [accountId],
  );
  if (impossible.rows[0]?.impossible) {
    throw new Error("personal_cloud_workspace_invariant_violation");
  }
}

async function assertOrganizationCloudPurgeReady(
  tx: Tx,
  organizationId: string,
  consumeFencedDeletions: boolean,
): Promise<void> {
  const retainedWorkspace = await tx.query(
    `SELECT 1 FROM cloud_workspaces
     WHERE org_id = $1
       AND (status <> 'deleted' OR data_deleted_at IS NULL)
     LIMIT 1 FOR UPDATE`,
    [organizationId],
  );
  if (retainedWorkspace.rows[0]) {
    throw new Error("organization_cloud_deletion_not_verified");
  }
  const retainedBlob = await tx.query(
    `SELECT 1 FROM workspace_blobs
     WHERE org_id = $1 AND state <> 'deleted'
     LIMIT 1 FOR UPDATE`,
    [organizationId],
  );
  if (retainedBlob.rows[0]) {
    throw new Error("organization_blob_deletion_not_verified");
  }
  const activeRotation = await tx.query(
    `SELECT 1 FROM workspace_blob_rotation_jobs
     WHERE org_id = $1
       AND NOT (state IN ('succeeded', 'failed') AND reserved_bytes = 0)
     LIMIT 1 FOR UPDATE`,
    [organizationId],
  );
  if (activeRotation.rows[0]) {
    throw new Error("organization_blob_rotation_not_terminal");
  }
  const retainedReservation = await tx.query(
    `SELECT 1 FROM workspace_blob_storage_reservations
     WHERE org_id = $1 LIMIT 1 FOR UPDATE`,
    [organizationId],
  );
  if (retainedReservation.rows[0]) {
    throw new Error("organization_blob_reservation_not_released");
  }
  const retainedDeletion = await tx.query(
    `SELECT 1 FROM workspace_blob_object_deletions
     WHERE org_id = $1
       AND (fenced_at IS NULL OR reserved_bytes <> 0)
     LIMIT 1 FOR UPDATE`,
    [organizationId],
  );
  if (retainedDeletion.rows[0]) {
    throw new Error("organization_blob_deletion_not_fenced");
  }
  if (consumeFencedDeletions) {
    await tx.query(
      `DELETE FROM workspace_blob_object_deletions
       WHERE org_id = $1 AND fenced_at IS NOT NULL AND reserved_bytes = 0`,
      [organizationId],
    );
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
     WHERE org_id = $1
       AND (status <> 'deleted' OR data_deleted_at IS NULL)
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
       WHERE account_user_id = $1 OR provider_sub = $2
          OR (account_user_id IS NULL
              AND lower(email::text) = lower($3::text))`,
      [actor.id, actor.identity.subject, actor.email],
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
  attempt_incremented: boolean;
  lease_revision: string | number;
};

export function deletionLifecycleErrorCode(error: unknown): string {
  const reason =
    error instanceof Error ? error.message || error.name : "unknown";
  return reason.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 128) || "unknown";
}

function lifecycleRetryMs(attempt: number): number {
  return Math.min(60 * 60_000, 5_000 * 2 ** Math.min(attempt, 10));
}

const ORGANIZATION_PURGE_READINESS_ERRORS = new Set([
  "organization_cloud_deletion_not_verified",
  "organization_blob_deletion_not_verified",
  "organization_blob_rotation_not_terminal",
  "organization_blob_reservation_not_released",
  "organization_blob_deletion_not_fenced",
]);

/** Durable final-erasure worker. It never runs before `purge_after`; provider
 * deletion is an idempotent WorkOS outbox command and local erasure happens
 * only after that command succeeds (or when the provider object is already
 * absent). */
export class DeletionLifecycleProcessor {
  private readonly workerId: string;
  private readonly logger: Pick<Console, "warn" | "error">;
  private readonly providerLockTimeoutMs: number;

  constructor(
    private readonly pool: pg.Pool,
    options: {
      workerId?: string;
      logger?: Pick<Console, "warn" | "error">;
      providerLockTimeoutMs?: number;
    } = {},
  ) {
    this.workerId = options.workerId ?? `deletion:${randomUUID()}`;
    this.logger = options.logger ?? console;
    this.providerLockTimeoutMs = Math.max(
      1,
      Math.trunc(options.providerLockTimeoutMs ?? 30_000),
    );
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
        attempt_incremented: boolean;
        lease_revision: string | number;
      }>(
        `WITH candidate AS (
           SELECT id, state AS claimed_state
           FROM deletion_requests
           WHERE (
               (state IN ('scheduled', 'failed') AND attempt_count < 20)
               OR (state IN ('purging', 'provider_deleting')
                   AND attempt_count <= 20)
             )
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
             attempt_count = CASE
               WHEN request.state IN ('scheduled', 'failed')
                 THEN attempt_count + 1
               ELSE attempt_count
             END,
             lease_revision = lease_revision + 1,
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
                   request.purge_command_id, request.attempt_count,
                   candidate.claimed_state IN ('scheduled', 'failed')
                     AS attempt_incremented,
                   request.lease_revision`,
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
         WHERE id = $1 AND lease_owner = $2
           AND attempt_count = $4 AND state = $5 AND lease_revision = $6`,
        [
          request.id,
          this.workerId,
          delayMs,
          request.attempt_count,
          request.state,
          request.lease_revision,
        ],
      ),
    );
  }

  private async releaseForProviderDrain(
    tx: Tx,
    request: ClaimedDeletion,
  ): Promise<void> {
    const released = await tx.query(
      `UPDATE deletion_requests
       SET next_attempt_at = now() + interval '2 seconds',
           lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE id = $1 AND lease_owner = $2 AND state = 'purging'
         AND attempt_count = $3 AND lease_revision = $4`,
      [
        request.id,
        this.workerId,
        request.attempt_count,
        request.lease_revision,
      ],
    );
    if ((released.rowCount ?? 0) !== 1) {
      throw new Error("deletion_purge_lease_changed");
    }
  }

  private async providerLockKeys(request: ClaimedDeletion): Promise<string[]> {
    const keys: string[] = [];
    if (request.target_kind === "account" && request.target_user_id) {
      keys.push(workOSUserProviderLockKey(request.target_user_id));
      const subjects = await accountWorkOSProviderSubjects(
        this.pool,
        request.target_user_id,
      );
      keys.push(
        ...subjects.map((subject) =>
          workOSProviderSubjectLockKey({
            kind: "user",
            id: subject,
          }),
        ),
      );
    }
    if (
      request.target_kind === "organization" &&
      request.target_organization_id
    ) {
      keys.push(
        workOSOrganizationProviderLockKey(request.target_organization_id),
      );
      const links = await this.pool.query<{
        workos_organization_id: string | null;
      }>(
        `SELECT workos_organization_id FROM workos_organization_links
         WHERE organization_id = $1`,
        [request.target_organization_id],
      );
      keys.push(
        ...links.rows.flatMap((link) =>
          link.workos_organization_id
            ? [
                workOSProviderSubjectLockKey({
                  kind: "organization",
                  id: link.workos_organization_id,
                }),
              ]
            : [],
        ),
      );
    }
    return Array.from(new Set(keys)).sort();
  }

  private async withStableProviderLocks(
    request: ClaimedDeletion,
    work: () => Promise<void>,
  ): Promise<void> {
    let lockKeys = await this.providerLockKeys(request);
    for (;;) {
      const missing = await withWorkOSProviderLocks(
        this.pool,
        lockKeys,
        async () => {
          // Resolution necessarily precedes session-lock acquisition. Repeat
          // it after acquiring the complete known set; cooperating writers
          // share the stable local target lock, so an expanded set is retried
          // before any provider fence, command, or local erasure is committed.
          const current = await this.providerLockKeys(request);
          const missingKeys = current.filter((key) => !lockKeys.includes(key));
          if (missingKeys.length > 0) return missingKeys;
          await work();
          return [];
        },
        { timeoutMs: this.providerLockTimeoutMs },
      );
      if (missing.length === 0) return;
      lockKeys = Array.from(new Set([...lockKeys, ...missing])).sort();
    }
  }

  private async prepareProviderDeletion(
    request: ClaimedDeletion,
  ): Promise<void> {
    await this.withStableProviderLocks(request, () =>
      this.prepareProviderDeletionLocked(request),
    );
  }

  private async prepareProviderDeletionLocked(
    request: ClaimedDeletion,
  ): Promise<void> {
    await withSystemTx(this.pool, async (tx) => {
      const owned = await tx.query(
        `SELECT 1 FROM deletion_requests
         WHERE id = $1 AND lease_owner = $2 AND state = 'purging'
           AND attempt_count = $3
           AND lease_revision = $4
           AND lease_expires_at > clock_timestamp()
         FOR UPDATE`,
        [
          request.id,
          this.workerId,
          request.attempt_count,
          request.lease_revision,
        ],
      );
      if (!owned.rows[0]) return;

      let commandId: string | null = null;
      if (request.target_kind === "account" && request.target_user_id) {
        // Do not erase the provider identity while an impossible legacy row
        // would prevent the corresponding Zeros account from finalizing.
        await assertPersonalHasNoCloudWorkspace(tx, request.target_user_id);
        const pendingProviderCommand = await tx.query(
          `SELECT 1
           FROM workos_command_outbox command
           WHERE command.state IN ('queued', 'processing')
             AND (
               command.user_id = $1
               OR position($1::text in command.aggregate_key) > 0
               OR position($1::text in command.ordering_key) > 0
               OR command.provider_object_id IN (
                 SELECT identity.provider_sub
                 FROM user_identities identity
                 WHERE identity.user_id = $1
               )
               OR command.payload->>'workosUserId' IN (
                 SELECT identity.provider_sub
                 FROM user_identities identity
                 WHERE identity.user_id = $1
               )
               OR command.payload->>'inviterWorkosUserId' IN (
                 SELECT identity.provider_sub
                 FROM user_identities identity
                 WHERE identity.user_id = $1
               )
               OR command.payload->>'sessionId' IN (
                 SELECT session.provider_session_id
                 FROM auth_sessions session
                 WHERE session.user_id = $1
                    OR session.provider_sub IN (
                      SELECT identity.provider_sub
                      FROM user_identities identity
                      WHERE identity.user_id = $1
                    )
               )
               OR lower(command.payload->>'email') = (
                 SELECT lower(account.email::text)
                 FROM users account WHERE account.id = $1
               )
             )
           LIMIT 1`,
          [request.target_user_id],
        );
        if (pendingProviderCommand.rows[0]) {
          await this.releaseForProviderDrain(tx, request);
          return;
        }
        const providerSubjects = await accountWorkOSProviderSubjects(
          tx,
          request.target_user_id,
        );
        await assertAccountWorkOSProviderErasureSubjectLimit(
          tx,
          request.id,
          providerSubjects,
        );
        await fenceErasedWorkOSSubjects(
          tx,
          request.id,
          providerSubjects.map((providerSubject) => ({
            kind: "user",
            id: providerSubject,
          })),
        );
        for (const providerSubject of providerSubjects) {
          commandId = await enqueueWorkOSUserDeletionCommand(tx, {
            deletionRequestId: request.id,
            userId: request.target_user_id,
            workosUserId: providerSubject,
          });
        }
      }
      if (
        request.target_kind === "organization" &&
        request.target_organization_id
      ) {
        const pendingProviderCommand = await tx.query(
          `SELECT 1
           FROM workos_command_outbox command
           WHERE command.state IN ('queued', 'processing')
             AND (
               command.organization_id = $1
               OR position($1::text in command.aggregate_key) > 0
               OR position($1::text in command.ordering_key) > 0
               OR command.payload->>'externalId' = $1::text
             )
           LIMIT 1`,
          [request.target_organization_id],
        );
        if (pendingProviderCommand.rows[0]) {
          await this.releaseForProviderDrain(tx, request);
          return;
        }
        const organization = await tx.query(
          `SELECT 1 FROM organizations
           WHERE id = $1 AND deletion_request_id = $2
             AND lifecycle_status IN ('scheduled', 'purging', 'provider_deleted')
           FOR UPDATE`,
          [request.target_organization_id, request.id],
        );
        if (!organization.rows[0]) {
          throw new Error("organization_purge_state_mismatch");
        }
        await assertOrganizationCloudPurgeReady(
          tx,
          request.target_organization_id,
          false,
        );
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
        const workosOrganizationId =
          link.rows[0]?.workos_organization_id ?? null;
        await fenceErasedWorkOSSubjects(
          tx,
          request.id,
          workosOrganizationId
            ? [{ kind: "organization", id: workosOrganizationId }]
            : [],
        );
        if (workosOrganizationId) {
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
            providerObjectId: workosOrganizationId,
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
         WHERE id = $1 AND lease_owner = $2
           AND attempt_count = $4 AND state = 'purging'
           AND lease_revision = $5`,
        [
          request.id,
          this.workerId,
          commandId,
          request.attempt_count,
          request.lease_revision,
        ],
      );
      await event(tx, request.id, null, "purge.provider_requested", {
        providerCommand: commandId !== null,
      });
    });
  }

  private async providerReady(request: ClaimedDeletion): Promise<boolean> {
    if (request.target_kind === "account" && request.target_user_id) {
      const capturedSubjects = await accountWorkOSProviderSubjects(
        this.pool,
        request.target_user_id,
      );
      const commands = await withSystemTx(this.pool, (tx) =>
        tx.query<{
          provider_subject: string | null;
          state: string;
          last_error_code: string | null;
        }>(
          `SELECT payload->>'workosUserId' AS provider_subject,
                  state, last_error_code
           FROM workos_command_outbox
           WHERE operation = 'user.delete' AND user_id = $1
             AND payload->>'deletionRequestId' = $2::text`,
          [request.target_user_id, request.id],
        ),
      );
      const commandedSubjects = new Set(
        commands.rows.flatMap((command) =>
          command.provider_subject ? [command.provider_subject] : [],
        ),
      );
      if (capturedSubjects.some((subject) => !commandedSubjects.has(subject))) {
        throw new Error("provider_delete_command_missing");
      }
      const failed = commands.rows.find(
        (command) => command.state === "dead" || command.state === "failed",
      );
      if (failed) {
        throw new Error(failed.last_error_code || "provider_delete_failed");
      }
      if (commands.rows.every((command) => command.state === "succeeded")) {
        return true;
      }
      await this.release(request, 5_000);
      return false;
    }
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
    await this.withStableProviderLocks(request, () =>
      this.finalizeAccountLocked(request),
    );
  }

  private async finalizeAccountLocked(request: ClaimedDeletion): Promise<void> {
    if (!request.target_user_id) throw new Error("account_target_missing");
    await withSystemTx(this.pool, async (tx) => {
      const ownedRequest = await tx.query(
        `SELECT 1 FROM deletion_requests
         WHERE id = $1 AND state = 'provider_deleting'
           AND lease_owner = $2 AND attempt_count = $3
           AND lease_revision = $4
           AND lease_expires_at > clock_timestamp()
         FOR UPDATE`,
        [
          request.id,
          this.workerId,
          request.attempt_count,
          request.lease_revision,
        ],
      );
      if (!ownedRequest.rows[0]) {
        throw new Error("account_purge_lease_changed");
      }
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
      const subjects = await accountWorkOSProviderSubjects(
        tx,
        request.target_user_id!,
      );
      await assertAccountWorkOSProviderErasureSubjectLimit(
        tx,
        request.id,
        subjects,
      );
      // Re-read the complete, exact subject set while the stable account and
      // provider-subject locks are held. A candidate reviewed during the grace
      // period is just as capable of replaying a late token as the superseded
      // identity, so persist its one-way fence before erasing the only mapping.
      await fenceErasedWorkOSSubjects(
        tx,
        request.id,
        subjects.map((id) => ({ kind: "user", id })),
      );
      const providerDeletionCommands = await tx.query<{
        provider_subject: string | null;
        state: string;
      }>(
        `SELECT payload->>'workosUserId' AS provider_subject, state
         FROM workos_command_outbox
         WHERE operation = 'user.delete' AND user_id = $1
           AND payload->>'deletionRequestId' = $2::text`,
        [request.target_user_id, request.id],
      );
      const succeededSubjects = new Set(
        providerDeletionCommands.rows.flatMap((command) =>
          command.state === "succeeded" && command.provider_subject
            ? [command.provider_subject]
            : [],
        ),
      );
      const succeededSubjectHashes = new Set(
        Array.from(succeededSubjects, (subject) =>
          workOSProviderSubjectHash({ kind: "user", id: subject }),
        ),
      );
      const providerFences = await tx.query<{ subject_hash: string }>(
        `SELECT subject_hash FROM workos_provider_erasure_fences
         WHERE deletion_request_id = $1 AND provider = 'workos'
           AND subject_kind = 'user' AND hash_version = 1`,
        [request.id],
      );
      if (
        subjects.some((subject) => !succeededSubjects.has(subject)) ||
        providerFences.rows.some(
          (fence) => !succeededSubjectHashes.has(fence.subject_hash),
        ) ||
        providerDeletionCommands.rows.some(
          (command) => command.state !== "succeeded",
        )
      ) {
        throw new Error("account_provider_erasure_incomplete");
      }
      await reconcileWorkOSProviderErasure(tx, request.id);
      const providerCommandsInFlight = await tx.query(
        `SELECT 1 FROM workos_command_outbox command
         WHERE command.state IN ('queued', 'processing')
           AND (
             command.user_id = $1
             OR position($1::text in command.aggregate_key) > 0
             OR position($1::text in command.ordering_key) > 0
             OR command.provider_object_id = ANY($2::text[])
             OR command.payload->>'workosUserId' = ANY($2::text[])
             OR command.payload->>'inviterWorkosUserId' = ANY($2::text[])
             OR command.payload->>'sessionId' IN (
               SELECT session.provider_session_id
               FROM auth_sessions session
               WHERE session.user_id = $1
                  OR ($2::text[] <> '{}'::text[]
                      AND session.provider_sub = ANY($2::text[]))
             )
             OR lower(command.payload->>'email') = lower($3::text)
           )
         LIMIT 1`,
        [request.target_user_id, subjects, account.rows[0].email],
      );
      if (providerCommandsInFlight.rows[0]) {
        throw new Error("account_provider_commands_in_flight");
      }
      await tx.query(
        `DELETE FROM workos_command_outbox command
         WHERE command.user_id = $1
            OR position($1::text in command.aggregate_key) > 0
            OR position($1::text in command.ordering_key) > 0
            OR command.provider_object_id = ANY($2::text[])
            OR command.payload->>'workosUserId' = ANY($2::text[])
            OR command.payload->>'inviterWorkosUserId' = ANY($2::text[])
            OR command.payload->>'sessionId' IN (
              SELECT session.provider_session_id
              FROM auth_sessions session
              WHERE session.user_id = $1
                 OR ($2::text[] <> '{}'::text[]
                     AND session.provider_sub = ANY($2::text[]))
            )
            OR lower(command.payload->>'email') = lower($3::text)`,
        [request.target_user_id, subjects, account.rows[0].email],
      );

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
      await tx.query(
        `DELETE FROM auth_sessions
         WHERE user_id = $1
            OR ($2::text[] <> '{}'::text[] AND provider_sub = ANY($2::text[]))`,
        [request.target_user_id, subjects],
      );
      await tx.query(
        `DELETE FROM workos_browser_sessions
         WHERE account_user_id = $1
            OR ($2::text[] <> '{}'::text[] AND provider_sub = ANY($2::text[]))
            OR (account_user_id IS NULL
                AND lower(email::text) = lower($3::text))`,
        [request.target_user_id, subjects, account.rows[0].email],
      );
      await tx.query(
        `DELETE FROM workos_membership_projections
         WHERE user_id = $1
            OR ($2::text[] <> '{}'::text[] AND workos_user_id = ANY($2::text[]))`,
        [request.target_user_id, subjects],
      );
      await tx.query(
        `DELETE FROM workos_event_inbox
         WHERE ($1::text[] <> '{}'::text[]
                AND workos_user_id = ANY($1::text[]))
            OR lower(data->>'email') = lower($2::text)`,
        [subjects, account.rows[0].email],
      );
      await tx.query(
        `DELETE FROM identity_provider_events
         WHERE ($1::text[] <> '{}'::text[]
                AND provider_sub = ANY($1::text[]))
            OR email = $2::citext`,
        [subjects, account.rows[0].email],
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
      const completed = await tx.query(
        `UPDATE deletion_requests
         SET state = 'purged', purged_at = now(), updated_at = now(),
             lease_owner = NULL, lease_expires_at = NULL,
             last_error_code = NULL
         WHERE id = $1 AND state = 'provider_deleting'
           AND lease_owner = $2 AND attempt_count = $3
           AND lease_revision = $4`,
        [
          request.id,
          this.workerId,
          request.attempt_count,
          request.lease_revision,
        ],
      );
      if ((completed.rowCount ?? 0) !== 1) {
        throw new Error("account_purge_lease_changed");
      }
      await event(tx, request.id, null, "purge.completed", {
        target: "account",
      });
    });
  }

  private async finalizeOrganization(request: ClaimedDeletion): Promise<void> {
    await this.withStableProviderLocks(request, () =>
      this.finalizeOrganizationLocked(request),
    );
  }

  private async finalizeOrganizationLocked(
    request: ClaimedDeletion,
  ): Promise<void> {
    const organizationId = request.target_organization_id;
    if (!organizationId) {
      throw new Error("organization_target_missing");
    }
    await withSystemTx(this.pool, async (tx) => {
      const ownedRequest = await tx.query(
        `SELECT 1 FROM deletion_requests
         WHERE id = $1 AND state = 'provider_deleting'
           AND lease_owner = $2 AND attempt_count = $3
           AND lease_revision = $4
           AND lease_expires_at > clock_timestamp()
         FOR UPDATE`,
        [
          request.id,
          this.workerId,
          request.attempt_count,
          request.lease_revision,
        ],
      );
      if (!ownedRequest.rows[0]) {
        throw new Error("organization_purge_lease_changed");
      }
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
      const providerLink = await tx.query<{
        workos_organization_id: string | null;
      }>(
        `SELECT workos_organization_id
         FROM workos_organization_links
         WHERE organization_id = $1`,
        [organizationId],
      );
      const workosOrganizationId =
        providerLink.rows[0]?.workos_organization_id ?? null;
      await fenceErasedWorkOSSubjects(
        tx,
        request.id,
        workosOrganizationId
          ? [{ kind: "organization", id: workosOrganizationId }]
          : [],
      );
      // Provider deletion is irreversible. Before removing the tenant row,
      // prove that every coordinator-owned byte has reached a terminal,
      // fenced state. The Organization row lock also serializes this check
      // against new FK-backed detached-object identities.
      await assertOrganizationCloudPurgeReady(tx, organizationId, true);
      const members = await tx.query<{ user_id: string; email: string }>(
        `SELECT om.user_id, u.email
         FROM organization_members om
         JOIN users u ON u.id = om.user_id
         WHERE om.org_id = $1`,
        [request.target_organization_id],
      );
      await tx.query(
        `DELETE FROM workos_membership_projections
         WHERE organization_id = $1
            OR workos_organization_id IN (
           SELECT workos_organization_id FROM workos_organization_links
           WHERE organization_id = $1
         )`,
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
      const providerCommandsInFlight = await tx.query(
        `SELECT 1 FROM workos_command_outbox command
         WHERE command.state IN ('queued', 'processing')
           AND (
             command.organization_id = $1
             OR position($1::text in command.aggregate_key) > 0
             OR position($1::text in command.ordering_key) > 0
             OR command.payload->>'externalId' = $1::text
             OR ($2::text IS NOT NULL AND command.provider_object_id = $2)
           )
         LIMIT 1`,
        [organizationId, workosOrganizationId],
      );
      if (providerCommandsInFlight.rows[0]) {
        throw new Error("organization_provider_commands_in_flight");
      }
      await reconcileWorkOSProviderErasure(tx, request.id);
      await tx.query(
        `DELETE FROM workos_command_outbox command
         WHERE command.organization_id = $1
            OR position($1::text in command.aggregate_key) > 0
            OR position($1::text in command.ordering_key) > 0
            OR command.payload->>'externalId' = $1::text
            OR ($2::text IS NOT NULL AND command.provider_object_id = $2)`,
        [organizationId, workosOrganizationId],
      );
      await tx.query(
        `SELECT public.purge_cloud_workspace_operator_configuration($1)`,
        [request.target_organization_id],
      );
      await tx.query(`DELETE FROM workspace_fork_intents WHERE org_id = $1`, [
        request.target_organization_id,
      ]);
      await tx.query(`DELETE FROM cloud_workspaces WHERE org_id = $1`, [
        request.target_organization_id,
      ]);
      await tx.query(`DELETE FROM repositories WHERE org_id = $1`, [
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
      const completed = await tx.query(
        `UPDATE deletion_requests
         SET state = 'purged', purged_at = now(), updated_at = now(),
             lease_owner = NULL, lease_expires_at = NULL,
             last_error_code = NULL
         WHERE id = $1 AND state = 'provider_deleting'
           AND lease_owner = $2 AND attempt_count = $3
           AND lease_revision = $4`,
        [
          request.id,
          this.workerId,
          request.attempt_count,
          request.lease_revision,
        ],
      );
      if ((completed.rowCount ?? 0) !== 1) {
        throw new Error("organization_purge_lease_changed");
      }
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
         WHERE id = $1 AND lease_owner = $2
           AND attempt_count = $5 AND state = $6
           AND lease_revision = $7`,
        [
          request.id,
          this.workerId,
          code,
          lifecycleRetryMs(request.attempt_count),
          request.attempt_count,
          request.state,
          request.lease_revision,
        ],
      ),
    );
    this.logger.warn(
      `[deletion] request=${request.id} target=${request.target_kind} retry [${code}]`,
    );
  }

  private async deferForProviderLock(
    request: ClaimedDeletion,
    error: WorkOSProviderLockTimeoutError | WorkOSProviderLockAbortedError,
  ): Promise<void> {
    await withSystemTx(this.pool, (tx) =>
      tx.query(
        `UPDATE deletion_requests
         SET attempt_count = CASE WHEN $3::boolean
               THEN GREATEST(attempt_count - 1, 0)
               ELSE attempt_count
             END,
             next_attempt_at = now() + interval '1 second',
             lease_owner = NULL, lease_expires_at = NULL,
             last_error_code = $4, updated_at = now()
         WHERE id = $1 AND lease_owner = $2
           AND attempt_count = $5 AND state = $6
           AND lease_revision = $7`,
        [
          request.id,
          this.workerId,
          request.attempt_incremented,
          error.code,
          request.attempt_count,
          request.state,
          request.lease_revision,
        ],
      ),
    );
    this.logger.warn(
      `[deletion] request=${request.id} target=${request.target_kind} waiting [${error.code}]`,
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
        if (
          error instanceof WorkOSProviderLockTimeoutError ||
          error instanceof WorkOSProviderLockAbortedError
        ) {
          await this.deferForProviderLock(request, error);
          continue;
        }
        const code = deletionLifecycleErrorCode(error);
        if (
          request.target_kind === "organization" &&
          ORGANIZATION_PURGE_READINESS_ERRORS.has(code)
        ) {
          await this.release(request, 60_000);
          this.logger.warn(
            `[deletion] request=${request.id} target=organization waiting [${code}]`,
          );
        } else {
          await this.fail(request, error);
        }
      }
    }
    return processed;
  }
}

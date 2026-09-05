import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { z } from "zod";

import { withSystemTx, type Tx } from "./db.js";
import type {
  WorkOSInvitationRecord,
  WorkOSManagementProvider,
  WorkOSMembershipRecord,
  WorkOSOrganizationRecord,
} from "./workos-provider.js";
import {
  accountWorkOSProviderSubjects,
  withWorkOSProviderLocks,
  WorkOSProviderLockAbortedError,
  WorkOSProviderLockTimeoutError,
  workOSOrganizationProviderLockKey,
  workOSProviderSubjectHash,
  workOSProviderSubjectLockKey,
  workOSUserProviderLockKey,
} from "./workos-provider-locks.js";
import { replayDeferredWorkOSInvitationEvents } from "./workos-sync-events.js";

export type WorkOSCommandOperation =
  | "organization.create"
  | "organization.update"
  | "organization.delete"
  | "membership.create"
  | "membership.update"
  | "membership.delete"
  | "invitation.create"
  | "invitation.revoke"
  | "session.revoke"
  | "sessions.revoke_all"
  | "user.delete";

export type EnqueueWorkOSCommandInput = {
  operation: WorkOSCommandOperation;
  idempotencyKey: string;
  aggregateKey: string;
  /** Commands sharing this key are processed in insertion order. */
  orderingKey?: string;
  aggregateRevision: number;
  organizationId?: string | null;
  userId?: string | null;
  providerObjectId?: string | null;
  payload: Record<string, unknown>;
};

const WorkOSIdentifier = z.string().regex(/^[A-Za-z0-9_-]{1,512}$/);
const UserDeletePayload = z.object({
  workosUserId: WorkOSIdentifier,
  deletionRequestId: z.string().uuid(),
});

export function workOSUserDeletionIdempotencyKey(
  deletionRequestId: string,
  workosUserId: string,
): string {
  const requestId = z.string().uuid().parse(deletionRequestId);
  const subject = WorkOSIdentifier.parse(workosUserId);
  return `account.delete.${requestId}.${workOSProviderSubjectHash({ kind: "user", id: subject })}`;
}

const DELETION_SAFE_WORKOS_OPERATIONS: ReadonlySet<WorkOSCommandOperation> =
  new Set([
    "membership.delete",
    "invitation.revoke",
    "session.revoke",
    "sessions.revoke_all",
    "user.delete",
  ]);

function payloadString(
  payload: Record<string, unknown>,
  key: string,
): string | null {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function associatedWorkOSUserIds(
  tx: Tx,
  input: Pick<
    EnqueueWorkOSCommandInput,
    "userId" | "providerObjectId" | "operation" | "payload"
  >,
): Promise<string[]> {
  const providerSubjects = [
    payloadString(input.payload, "workosUserId"),
    payloadString(input.payload, "inviterWorkosUserId"),
    ...(input.operation === "user.delete" ||
    input.operation === "sessions.revoke_all"
      ? [input.providerObjectId ?? null]
      : []),
  ].filter((value): value is string => value !== null);
  const email = payloadString(input.payload, "email");
  const sessionId =
    input.operation === "session.revoke"
      ? payloadString(input.payload, "sessionId")
      : null;
  const resolved = await tx.query<{ id: string }>(
    `SELECT id
     FROM (
       SELECT $1::uuid AS id WHERE $1::uuid IS NOT NULL
       UNION
       SELECT identity.user_id
       FROM user_identities identity
       WHERE $2::text[] <> '{}'::text[]
         AND identity.provider = 'workos'
         AND identity.provider_sub = ANY($2::text[])
       UNION
       SELECT account.id
       FROM users account
       WHERE $3::citext IS NOT NULL AND account.email = $3::citext
       UNION
       SELECT browser.account_user_id
       FROM workos_browser_sessions browser
       WHERE $4::text IS NOT NULL
         AND browser.provider_session_id = $4
         AND browser.account_user_id IS NOT NULL
       UNION
       SELECT session.user_id
       FROM auth_sessions session
       WHERE $4::text IS NOT NULL
         AND session.provider = 'workos'
         AND session.provider_session_id = $4
         AND session.user_id IS NOT NULL
       UNION
       SELECT identity.user_id
       FROM auth_sessions session
       JOIN user_identities identity
         ON identity.provider = 'workos'
        AND identity.provider_sub = session.provider_sub
       WHERE $4::text IS NOT NULL
         AND session.provider = 'workos'
         AND session.provider_session_id = $4
     ) associated
     WHERE id IS NOT NULL
     ORDER BY id`,
    [input.userId ?? null, providerSubjects, email, sessionId],
  );
  return resolved.rows.map((row) => row.id);
}

async function assertWorkOSEnqueueLifecycle(
  tx: Tx,
  input: EnqueueWorkOSCommandInput,
): Promise<void> {
  if (input.operation === "organization.delete") {
    if (!input.organizationId) {
      throw new Error("WorkOS organization purge target is missing");
    }
    const authority = await tx.query<{
      workos_organization_id: string | null;
    }>(
      `SELECT link.workos_organization_id
       FROM organizations organization
       JOIN deletion_requests request
         ON request.id = organization.deletion_request_id
        AND request.target_kind = 'organization'
        AND request.target_id = organization.id
        AND request.target_organization_id = organization.id
       LEFT JOIN workos_organization_links link
         ON link.organization_id = organization.id
       WHERE organization.id = $1
         AND organization.lifecycle_status = 'purging'
         AND request.state = 'purging'`,
      [input.organizationId],
    );
    if (!authority.rows[0]) {
      throw new Error("WorkOS organization purge has not started");
    }
    if (
      !input.providerObjectId ||
      authority.rows[0].workos_organization_id !== input.providerObjectId
    ) {
      throw new Error("WorkOS organization provider target mismatch");
    }
  }

  if (input.operation === "user.delete") {
    if (!input.userId) throw new Error("WorkOS user purge target is missing");
    const authority = await tx.query<{ deletion_request_id: string }>(
      `SELECT request.id AS deletion_request_id
       FROM deletion_requests request
       JOIN users account
         ON account.id = request.target_user_id
        AND request.target_id = account.id
       WHERE account.id = $1
         AND request.id = account.deletion_request_id
         AND request.target_kind = 'account'
         AND request.state IN ('purging', 'provider_deleting', 'failed')
         AND account.auth_status = 'deletion_pending'
         AND account.deletion_request_id = request.id`,
      [input.userId],
    );
    if (!authority.rows[0]) {
      throw new Error("WorkOS user purge has not started");
    }
    const parsed = UserDeletePayload.safeParse(input.payload);
    const providerUserId = parsed.success ? parsed.data.workosUserId : null;
    const deletionRequestId = parsed.success
      ? parsed.data.deletionRequestId
      : null;
    if (
      !providerUserId ||
      !deletionRequestId ||
      !input.providerObjectId ||
      input.providerObjectId !== providerUserId ||
      input.idempotencyKey !==
        workOSUserDeletionIdempotencyKey(deletionRequestId, providerUserId)
    ) {
      throw new Error("WorkOS user provider target mismatch");
    }
    if (deletionRequestId !== authority.rows[0].deletion_request_id) {
      throw new Error("WorkOS user provider target mismatch");
    }
    const providerFence = await tx.query(
      `SELECT 1 FROM workos_provider_erasure_fences
       WHERE provider = 'workos' AND subject_kind = 'user'
         AND hash_version = 1 AND deletion_request_id = $1
         AND subject_hash = $2`,
      [
        deletionRequestId,
        workOSProviderSubjectHash({ kind: "user", id: providerUserId }),
      ],
    );
    if (!providerFence.rows[0]) {
      throw new Error("WorkOS user provider target mismatch");
    }
    // A WorkOS identity first observed while the account purge owns the
    // stable account lock has no durable source row by design. The exact
    // request-bound fence above is its authority until local purge completes.
    return;
  }

  if (input.organizationId) {
    const organization = await tx.query<{ lifecycle_status: string }>(
      `SELECT lifecycle_status FROM organizations
       WHERE id = $1 FOR KEY SHARE`,
      [input.organizationId],
    );
    const status = organization.rows[0]?.lifecycle_status;
    const permitted =
      input.operation === "organization.delete"
        ? status === "purging"
        : status === "active" || status === "scheduled";
    if (!permitted) {
      throw new Error(
        `WorkOS organization provider command is unavailable while ${status ?? "missing"}`,
      );
    }
  }

  const userIds = await associatedWorkOSUserIds(tx, input);
  if (userIds.length === 0) return;
  const users = await tx.query<{ id: string; auth_status: string }>(
    `SELECT id, auth_status FROM users
     WHERE id = ANY($1::uuid[])
     ORDER BY id
     FOR KEY SHARE`,
    [userIds],
  );
  const deletionSafe = DELETION_SAFE_WORKOS_OPERATIONS.has(input.operation);
  const unavailable = users.rows.find((user) =>
    deletionSafe
      ? user.auth_status === "deleted"
      : user.auth_status !== "active",
  );
  if (unavailable) {
    throw new Error(
      `WorkOS user provider command is unavailable while ${unavailable.auth_status}`,
    );
  }
}

export async function enqueueWorkOSCommand(
  tx: Tx,
  input: EnqueueWorkOSCommandInput,
): Promise<string> {
  await assertWorkOSEnqueueLifecycle(tx, input);
  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO workos_command_outbox (
       operation, idempotency_key, aggregate_key, ordering_key,
       aggregate_revision,
       organization_id, user_id, provider_object_id, payload
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [
      input.operation,
      input.idempotencyKey,
      input.aggregateKey,
      input.orderingKey ?? input.aggregateKey,
      input.aggregateRevision,
      input.organizationId ?? null,
      input.userId ?? null,
      input.providerObjectId ?? null,
      JSON.stringify(input.payload),
    ],
  );
  if (inserted.rows[0]) return inserted.rows[0].id;
  const existing = await tx.query<{ id: string }>(
    `SELECT id FROM workos_command_outbox WHERE idempotency_key = $1`,
    [input.idempotencyKey],
  );
  if (!existing.rows[0]) {
    throw new Error("WorkOS command idempotency lookup failed");
  }
  return existing.rows[0].id;
}

/**
 * Allocate an append-only revision for one account-erasure subject. Callers
 * hold the stable account provider lock, so a missing idempotency key and the
 * following MAX revision read are one serialized decision.
 */
export async function enqueueWorkOSUserDeletionCommand(
  tx: Tx,
  input: {
    deletionRequestId: string;
    userId: string;
    workosUserId: string;
  },
): Promise<string> {
  const deletionRequestId = z.string().uuid().parse(input.deletionRequestId);
  const userId = z.string().uuid().parse(input.userId);
  const workosUserId = WorkOSIdentifier.parse(input.workosUserId);
  const idempotencyKey = workOSUserDeletionIdempotencyKey(
    deletionRequestId,
    workosUserId,
  );
  const aggregateKey = `account-delete:${userId}`;
  const orderingKey = `account:${userId}`;
  const existing = await tx.query<{
    id: string;
    operation: string;
    aggregate_key: string;
    ordering_key: string;
    aggregate_revision: string | number;
    organization_id: string | null;
    user_id: string | null;
    provider_object_id: string | null;
    payload: Record<string, unknown>;
  }>(
    `SELECT id, operation, aggregate_key, ordering_key, aggregate_revision,
            organization_id, user_id, provider_object_id, payload
     FROM workos_command_outbox WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  const prior = existing.rows[0];
  if (prior) {
    const payload = UserDeletePayload.safeParse(prior.payload);
    if (
      prior.operation !== "user.delete" ||
      prior.aggregate_key !== aggregateKey ||
      prior.ordering_key !== orderingKey ||
      prior.organization_id !== null ||
      prior.user_id !== userId ||
      prior.provider_object_id !== workosUserId ||
      !payload.success ||
      payload.data.deletionRequestId !== deletionRequestId ||
      payload.data.workosUserId !== workosUserId
    ) {
      throw new Error("WorkOS user deletion idempotency conflict");
    }
    await assertWorkOSEnqueueLifecycle(tx, {
      operation: "user.delete",
      idempotencyKey,
      aggregateKey,
      orderingKey,
      aggregateRevision: Number(prior.aggregate_revision),
      userId,
      providerObjectId: workosUserId,
      payload: { workosUserId, deletionRequestId },
    });
    return prior.id;
  }

  const revision = await tx.query<{ next_revision: string | number }>(
    `SELECT COALESCE(MAX(aggregate_revision), 0) + 1 AS next_revision
     FROM workos_command_outbox WHERE aggregate_key = $1`,
    [aggregateKey],
  );
  const aggregateRevision = Number(revision.rows[0]?.next_revision);
  if (!Number.isSafeInteger(aggregateRevision) || aggregateRevision < 1) {
    throw new Error("WorkOS user deletion revision is invalid");
  }
  return enqueueWorkOSCommand(tx, {
    operation: "user.delete",
    idempotencyKey,
    aggregateKey,
    orderingKey,
    aggregateRevision,
    userId,
    providerObjectId: workosUserId,
    payload: { workosUserId, deletionRequestId },
  });
}

/** Keep normalized email addresses out of operational keys while serializing
 * every replacement/revocation for one WorkOS organization recipient. */
export function workOSInvitationOrderingKey(
  organizationId: string,
  email: string,
): string {
  const digest = createHash("sha256")
    .update(email.trim().toLowerCase(), "utf8")
    .digest("hex")
    .slice(0, 32);
  return `invitation-email:${organizationId}:${digest}`;
}

type ClaimedCommand = {
  id: string;
  operation: WorkOSCommandOperation;
  idempotencyKey: string;
  aggregateKey: string;
  aggregateRevision: number;
  organizationId: string | null;
  userId: string | null;
  providerObjectId: string | null;
  payload: Record<string, unknown>;
  attemptCount: number;
};

const Identifier = WorkOSIdentifier;
const Uuid = z.string().uuid();
const Role = z.enum(["owner", "admin", "member"]);
const OrganizationPayload = z.object({
  externalId: Uuid,
  name: z.string().trim().min(1).max(500),
});
const MembershipPayload = z.object({
  workosUserId: Identifier,
  role: Role,
});
const InvitationPayload = z.object({
  localInvitationId: Uuid,
  email: z.string().trim().toLowerCase().email().max(254),
  role: Role,
  inviterWorkosUserId: Identifier.optional(),
});
const SessionPayload = z.object({ sessionId: Identifier });
const SessionsPayload = z.object({
  workosUserId: Identifier,
  createdBefore: z.string().datetime({ offset: true }),
});

export function sessionsEligibleForRevocation(
  sessions: ReadonlyArray<{
    id: string;
    status: string;
    createdAt: string;
  }>,
  createdBefore: string,
): string[] {
  const cutoff = Date.parse(createdBefore);
  if (!Number.isFinite(cutoff)) return [];
  return sessions.flatMap((session) => {
    const createdAt = Date.parse(session.createdAt);
    return session.status === "active" &&
      Number.isFinite(createdAt) &&
      createdAt <= cutoff
      ? [session.id]
      : [];
  });
}

type WorkOSCommandLogger = Pick<Console, "info" | "warn" | "error">;

class WorkOSCommandLeaseLost extends Error {
  constructor() {
    super("WorkOS command lease ownership changed");
    this.name = "WorkOSCommandLeaseLost";
  }
}

function safeError(error: unknown): {
  code: string;
  status: number | null;
  retryable: boolean;
} {
  const status =
    error && typeof error === "object" && "status" in error
      ? Number((error as { status: unknown }).status)
      : null;
  const name = error instanceof Error ? error.name : "unknown";
  const code = name.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 128) || "unknown";
  return {
    code,
    status: Number.isInteger(status) ? status : null,
    retryable:
      status === null || status === 408 || status === 429 || status >= 500,
  };
}

function retryDelayMs(attempt: number): number {
  return Math.min(15 * 60_000, 1_000 * 2 ** Math.min(attempt, 9));
}

type CommandResult =
  | { kind: "organization"; value: WorkOSOrganizationRecord }
  | { kind: "membership"; value: WorkOSMembershipRecord }
  | { kind: "invitation"; value: WorkOSInvitationRecord }
  | { kind: "void"; deletedMembershipIds?: string[] };

export class WorkOSCommandProcessor {
  private readonly workerId: string;
  private readonly logger: WorkOSCommandLogger;
  private readonly leaseDurationMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly providerLockTimeoutMs: number;

  constructor(
    private readonly pool: pg.Pool,
    private readonly provider: WorkOSManagementProvider,
    options: {
      workerId?: string;
      logger?: WorkOSCommandLogger;
      leaseDurationMs?: number;
      heartbeatIntervalMs?: number;
      providerLockTimeoutMs?: number;
    } = {},
  ) {
    this.workerId = options.workerId ?? `workos:${randomUUID()}`;
    this.logger = options.logger ?? console;
    this.leaseDurationMs = Math.max(
      1_000,
      Math.trunc(options.leaseDurationMs ?? 60_000),
    );
    this.heartbeatIntervalMs = Math.max(
      250,
      Math.min(
        Math.trunc(options.heartbeatIntervalMs ?? 15_000),
        Math.max(250, Math.trunc(this.leaseDurationMs / 2)),
      ),
    );
    this.providerLockTimeoutMs = Math.max(
      1,
      Math.trunc(options.providerLockTimeoutMs ?? 30_000),
    );
  }

  private async claim(): Promise<ClaimedCommand | null> {
    return withSystemTx(this.pool, async (tx) => {
      const claimed = await tx.query<{
        id: string;
        operation: WorkOSCommandOperation;
        idempotency_key: string;
        aggregate_key: string;
        aggregate_revision: string | number;
        organization_id: string | null;
        user_id: string | null;
        provider_object_id: string | null;
        payload: Record<string, unknown>;
        attempt_count: number;
      }>(
        `WITH candidate AS (
           SELECT c.id
           FROM workos_command_outbox c
           WHERE (
             (c.state = 'queued' AND c.next_attempt_at <= now())
             OR (
               c.state = 'processing' AND c.lease_expires_at IS NOT NULL
               AND c.lease_expires_at <= now()
             )
           )
             AND (
               c.operation IN (
                 'organization.create', 'session.revoke',
                 'sessions.revoke_all', 'user.delete'
               )
               OR c.organization_id IS NULL
               OR EXISTS (
                 SELECT 1 FROM workos_organization_links ready
                 WHERE ready.organization_id = c.organization_id
                   AND ready.workos_organization_id IS NOT NULL
                   AND ready.state IN ('active', 'deleting')
               )
               OR NOT EXISTS (
                 SELECT 1 FROM workos_command_outbox provisioning
                 WHERE provisioning.organization_id = c.organization_id
                   AND provisioning.operation = 'organization.create'
                   AND provisioning.state IN ('queued', 'processing')
               )
             )
             AND NOT EXISTS (
               SELECT 1 FROM workos_command_outbox older
               WHERE older.ordering_key = c.ordering_key
                 AND older.sequence < c.sequence
                 AND older.state IN ('queued', 'processing')
             )
           ORDER BY
             CASE WHEN c.operation = 'organization.create' THEN 0 ELSE 1 END,
             c.next_attempt_at, c.sequence
           LIMIT 1
           FOR UPDATE SKIP LOCKED
         )
         UPDATE workos_command_outbox c
         SET state = 'processing', attempt_count = attempt_count + 1,
             lease_owner = $1,
             lease_expires_at = now() +
               ($2::bigint * interval '1 millisecond'),
             updated_at = now()
         FROM candidate
         WHERE c.id = candidate.id
         RETURNING c.id, c.operation, c.idempotency_key, c.aggregate_key,
                   c.aggregate_revision, c.organization_id, c.user_id,
                   c.provider_object_id, c.payload, c.attempt_count`,
        [this.workerId, this.leaseDurationMs],
      );
      const command = claimed.rows[0];
      return command
        ? {
            id: command.id,
            operation: command.operation,
            idempotencyKey: command.idempotency_key,
            aggregateKey: command.aggregate_key,
            aggregateRevision: Number(command.aggregate_revision),
            organizationId: command.organization_id,
            userId: command.user_id,
            providerObjectId: command.provider_object_id,
            payload: command.payload,
            attemptCount: command.attempt_count,
          }
        : null;
    });
  }

  private async providerLockTargets(command: ClaimedCommand): Promise<{
    keys: string[];
    userIds: string[];
  }> {
    const userIds = await withSystemTx(this.pool, (tx) =>
      associatedWorkOSUserIds(tx, command),
    );
    const userDeletion =
      command.operation === "user.delete"
        ? UserDeletePayload.safeParse(command.payload)
        : null;
    return {
      keys: [
        ...(command.organizationId
          ? [workOSOrganizationProviderLockKey(command.organizationId)]
          : []),
        ...userIds.map(workOSUserProviderLockKey),
        ...(userDeletion?.success
          ? [
              workOSProviderSubjectLockKey({
                kind: "user",
                id: userDeletion.data.workosUserId,
              }),
            ]
          : []),
      ],
      userIds,
    };
  }

  private async executionTargetIsAvailable(
    tx: Tx,
    command: ClaimedCommand,
    userIds: readonly string[],
  ): Promise<boolean> {
    if (command.operation === "organization.delete") {
      if (!command.organizationId || !command.providerObjectId) return false;
      const authoritative = await tx.query(
        `SELECT 1
         FROM organizations organization
         JOIN deletion_requests request
           ON request.id = organization.deletion_request_id
          AND request.target_kind = 'organization'
          AND request.target_id = organization.id
          AND request.target_organization_id = organization.id
         JOIN workos_organization_links link
           ON link.organization_id = organization.id
          AND link.workos_organization_id = $3
         WHERE organization.id = $1
           AND organization.lifecycle_status = 'purging'
           AND request.state = 'provider_deleting'
           AND request.purge_command_id = $2`,
        [command.organizationId, command.id, command.providerObjectId],
      );
      return authoritative.rows[0] !== undefined;
    }
    if (command.operation === "user.delete") {
      const parsed = UserDeletePayload.safeParse(command.payload);
      const providerUserId = parsed.success ? parsed.data.workosUserId : null;
      const deletionRequestId = parsed.success
        ? parsed.data.deletionRequestId
        : null;
      if (
        !command.userId ||
        !command.providerObjectId ||
        !providerUserId ||
        !deletionRequestId ||
        command.providerObjectId !== providerUserId ||
        command.idempotencyKey !==
          workOSUserDeletionIdempotencyKey(deletionRequestId, providerUserId)
      ) {
        return false;
      }
      const authoritative = await tx.query(
        `SELECT 1
         FROM deletion_requests request
         JOIN users account
           ON account.id = request.target_user_id
          AND request.target_id = account.id
         JOIN workos_provider_erasure_fences fence
           ON fence.deletion_request_id = request.id
          AND fence.provider = 'workos'
          AND fence.subject_kind = 'user'
          AND fence.hash_version = 1
          AND fence.subject_hash = $3
         WHERE account.id = $1 AND request.id = $2
           AND request.target_kind = 'account'
           AND request.state IN ('purging', 'provider_deleting', 'failed')
           AND account.auth_status = 'deletion_pending'
           AND account.deletion_request_id = request.id`,
        [
          command.userId,
          deletionRequestId,
          workOSProviderSubjectHash({ kind: "user", id: providerUserId }),
        ],
      );
      return authoritative.rows[0] !== undefined;
    }

    const deletionSafe = DELETION_SAFE_WORKOS_OPERATIONS.has(command.operation);
    if (command.organizationId) {
      const organization = await tx.query<{ lifecycle_status: string }>(
        `SELECT lifecycle_status FROM organizations WHERE id = $1`,
        [command.organizationId],
      );
      const status = organization.rows[0]?.lifecycle_status;
      if (!status || status === "purged") return false;
      if (status !== "active" && status !== "scheduled" && !deletionSafe) {
        return false;
      }
    }
    if (userIds.length === 0) return command.userId === null;
    const users = await tx.query<{
      id: string;
      auth_status: string;
      deletion_state: string | null;
    }>(
      `SELECT account.id, account.auth_status,
              request.state AS deletion_state
       FROM users account
       LEFT JOIN deletion_requests request
         ON request.id = account.deletion_request_id
       WHERE account.id = ANY($1::uuid[])`,
      [userIds],
    );
    if (
      command.userId &&
      !users.rows.some((row) => row.id === command.userId)
    ) {
      return false;
    }
    return users.rows.every((user) => {
      if (user.auth_status === "deleted") return false;
      if (deletionSafe) return true;
      return (
        user.auth_status === "active" ||
        (user.auth_status === "deletion_pending" &&
          user.deletion_state === "scheduled")
      );
    });
  }

  private async beginExecution(
    command: ClaimedCommand,
    userIds: readonly string[],
  ): Promise<boolean> {
    return withSystemTx(this.pool, async (tx) => {
      const owned = await tx.query(
        `SELECT 1 FROM workos_command_outbox
         WHERE id = $1 AND state = 'processing' AND lease_owner = $2
           AND attempt_count = $3
           AND lease_expires_at > clock_timestamp()
         FOR UPDATE`,
        [command.id, this.workerId, command.attemptCount],
      );
      if (!owned.rows[0]) return false;
      if (!(await this.executionTargetIsAvailable(tx, command, userIds))) {
        await tx.query(
          `UPDATE workos_command_outbox
           SET state = 'dead', completed_at = now(), updated_at = now(),
               lease_owner = NULL, lease_expires_at = NULL,
               last_error_code = 'target_deleting'
           WHERE id = $1 AND state = 'processing' AND lease_owner = $2
             AND attempt_count = $3`,
          [command.id, this.workerId, command.attemptCount],
        );
        return false;
      }
      await tx.query(
        `UPDATE workos_command_outbox
         SET lease_expires_at = now() +
               ($4::bigint * interval '1 millisecond'),
             updated_at = now()
         WHERE id = $1 AND state = 'processing' AND lease_owner = $2
           AND attempt_count = $3`,
        [command.id, this.workerId, command.attemptCount, this.leaseDurationMs],
      );
      return true;
    });
  }

  private async renewLease(command: ClaimedCommand): Promise<boolean> {
    const renewed = await withSystemTx(this.pool, (tx) =>
      tx.query(
        `UPDATE workos_command_outbox
         SET lease_expires_at = now() +
               ($4::bigint * interval '1 millisecond'),
             updated_at = now()
         WHERE id = $1 AND state = 'processing' AND lease_owner = $2
           AND attempt_count = $3
           AND lease_expires_at > clock_timestamp()`,
        [command.id, this.workerId, command.attemptCount, this.leaseDurationMs],
      ),
    );
    return (renewed.rowCount ?? 0) === 1;
  }

  private async workosOrganizationId(command: ClaimedCommand): Promise<string> {
    if (!command.organizationId) throw new Error("command has no organization");
    const result = await withSystemTx(this.pool, (tx) =>
      tx.query<{ workos_organization_id: string | null }>(
        `SELECT workos_organization_id FROM workos_organization_links
         WHERE organization_id = $1 AND state IN ('active', 'deleting')`,
        [command.organizationId],
      ),
    );
    const id = result.rows[0]?.workos_organization_id;
    if (!id) {
      const dependency = new Error(
        "WorkOS organization is not ready",
      ) as Error & {
        status: number;
      };
      dependency.status = 503;
      throw dependency;
    }
    return id;
  }

  private async execute(
    command: ClaimedCommand,
    checkpoint: () => Promise<void>,
  ): Promise<CommandResult> {
    const provider = new Proxy(this.provider, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          await checkpoint();
          return Reflect.apply(value, target, args);
        };
      },
    }) as WorkOSManagementProvider;
    if (
      command.operation === "organization.create" ||
      command.operation === "organization.update"
    ) {
      const payload = OrganizationPayload.parse(command.payload);
      if (command.operation === "organization.create") {
        try {
          return {
            kind: "organization",
            value: await provider.createOrganization({
              name: payload.name,
              externalId: payload.externalId,
              idempotencyKey: command.idempotencyKey,
            }),
          };
        } catch (error) {
          if (safeError(error).status !== 409) throw error;
          return {
            kind: "organization",
            value: await provider.getOrganizationByExternalId(
              payload.externalId,
            ),
          };
        }
      }
      return {
        kind: "organization",
        value: await provider.updateOrganization({
          organizationId: await this.workosOrganizationId(command),
          name: payload.name,
          externalId: payload.externalId,
        }),
      };
    }
    if (command.operation === "organization.delete") {
      const id =
        command.providerObjectId ?? (await this.workosOrganizationId(command));
      try {
        await provider.deleteOrganization(id);
      } catch (error) {
        if (safeError(error).status !== 404) throw error;
      }
      return { kind: "void" };
    }
    if (
      command.operation === "membership.create" ||
      command.operation === "membership.update"
    ) {
      const payload = MembershipPayload.parse(command.payload);
      const organizationId = await this.workosOrganizationId(command);
      const withDesiredRole = async (
        membership: WorkOSMembershipRecord,
      ): Promise<WorkOSMembershipRecord> =>
        membership.roleSlug === payload.role
          ? membership
          : provider.updateMembership({
              membershipId: membership.id,
              roleSlug: payload.role,
            });
      const createMembership = (): Promise<WorkOSMembershipRecord> =>
        provider.createMembership({
          organizationId,
          userId: payload.workosUserId,
          roleSlug: payload.role,
        });
      if (
        command.operation === "membership.update" &&
        command.providerObjectId
      ) {
        try {
          return {
            kind: "membership",
            value: await provider.updateMembership({
              membershipId: command.providerObjectId,
              roleSlug: payload.role,
            }),
          };
        } catch (error) {
          if (safeError(error).status !== 404) throw error;
        }
      }
      try {
        return {
          kind: "membership",
          value: await createMembership(),
        };
      } catch (error) {
        const failure = safeError(error);
        const observed = await provider.listMemberships({
          organizationId,
          userId: payload.workosUserId,
        });
        const active = observed.find(
          (membership) => membership.status === "active",
        );
        if (active) {
          return { kind: "membership", value: await withDesiredRole(active) };
        }

        // Sending a WorkOS invitation creates a pending membership for an
        // existing user. Zeros consumes either the native WorkOS token or its
        // compatibility token at the local authorization endpoint; provider
        // invitation revocation cannot activate that pending object. WorkOS
        // requires pending memberships to be deleted;
        // a fresh create then produces the desired active membership.
        const pending = observed.filter(
          (membership) => membership.status === "pending",
        );
        const canReplacePending =
          failure.status === 409 || failure.code === "GenericServerException";
        if (pending.length === 0 || !canReplacePending) {
          if (failure.status === 409) {
            throw new Error("WorkOS membership conflict was not recoverable");
          }
          throw error;
        }
        if (pending.some((membership) => membership.directoryManaged)) {
          throw error;
        }
        for (const membership of pending) {
          try {
            await provider.deleteMembership(membership.id);
          } catch (deleteError) {
            if (safeError(deleteError).status !== 404) throw deleteError;
          }
        }
        try {
          return { kind: "membership", value: await createMembership() };
        } catch (retryError) {
          // The second response can also be lost after WorkOS commits. Observe
          // the provider before retrying so the command remains idempotent.
          const recovered = (
            await provider.listMemberships({
              organizationId,
              userId: payload.workosUserId,
            })
          ).find((membership) => membership.status === "active");
          if (!recovered) throw retryError;
          return {
            kind: "membership",
            value: await withDesiredRole(recovered),
          };
        }
      }
    }
    if (command.operation === "membership.delete") {
      const payload = MembershipPayload.parse(command.payload);
      // Always reconcile the captured ID with current provider state. An
      // invitation may have become a new membership after the local removal
      // transaction read the old ID but before this command executes.
      const ids = new Set(
        command.providerObjectId ? [command.providerObjectId] : [],
      );
      let organizationId: string | null = null;
      try {
        organizationId = await this.workosOrganizationId(command);
      } catch (error) {
        // A captured provider ID is independently actionable even if local
        // organization provisioning or deletion has made listing unavailable.
        // Keep provider-list errors outside this catch: those are not evidence
        // that reconciliation is unnecessary.
        if (!command.providerObjectId || safeError(error).status !== 503) {
          throw error;
        }
      }
      if (organizationId) {
        for (const membership of await provider.listMemberships({
          organizationId,
          userId: payload.workosUserId,
        })) {
          ids.add(membership.id);
        }
      }
      for (const id of ids) {
        try {
          await provider.deleteMembership(id);
        } catch (error) {
          if (safeError(error).status !== 404) throw error;
        }
      }
      return { kind: "void", deletedMembershipIds: Array.from(ids) };
    }
    if (command.operation === "invitation.create") {
      const payload = InvitationPayload.parse(command.payload);
      const organizationId = await this.workosOrganizationId(command);
      const existing = await provider.listInvitations({
        organizationId,
        email: payload.email,
      });
      const pending = existing.filter(
        (invitation) => invitation.state === "pending",
      );
      const matching = pending.find(
        (invitation) => invitation.roleSlug === payload.role,
      );
      for (const stale of pending) {
        if (stale.id === matching?.id) continue;
        try {
          await provider.revokeInvitation(stale.id);
        } catch (error) {
          if (safeError(error).status !== 404) throw error;
        }
      }
      return {
        kind: "invitation",
        value:
          matching ??
          (await provider.sendInvitation({
            organizationId,
            email: payload.email,
            roleSlug: payload.role,
            ...(payload.inviterWorkosUserId
              ? { inviterUserId: payload.inviterWorkosUserId }
              : {}),
          })),
      };
    }
    if (command.operation === "invitation.revoke") {
      const payload = InvitationPayload.parse(command.payload);
      const organizationId = await this.workosOrganizationId(command);
      // WorkOS can contain a captured invitation plus a newer pending copy
      // (lost response, resend, or an accept/recreate race). Retire every
      // pending object for this exact organization/email pair. Do not attempt
      // to revoke an exact object already known to be accepted or expired.
      const listed = await provider.listInvitations({
        organizationId,
        email: payload.email,
      });
      const exact = command.providerObjectId
        ? listed.find(
            (invitation) => invitation.id === command.providerObjectId,
          )
        : null;
      const ids = Array.from(
        new Set([
          ...(command.providerObjectId && (!exact || exact.state === "pending")
            ? [command.providerObjectId]
            : []),
          ...listed
            .filter((invitation) => invitation.state === "pending")
            .map((invitation) => invitation.id),
        ]),
      );
      for (const id of ids) {
        try {
          await provider.revokeInvitation(id);
        } catch (error) {
          const failure = safeError(error);
          if (failure.status === 404) continue;
          if (
            failure.status !== null &&
            failure.status >= 400 &&
            failure.status < 500 &&
            failure.status !== 408 &&
            failure.status !== 429
          ) {
            // Acceptance can win after the list above but before revoke. A
            // non-pending object is already converged; the membership command
            // serialized behind this one will create or remove coarse access
            // according to Zeros' current desired state.
            const current = await provider.listInvitations({
              organizationId,
              email: payload.email,
            });
            const observed = current.find((invitation) => invitation.id === id);
            if (observed && observed.state !== "pending") {
              continue;
            }
          }
          throw error;
        }
      }
      return { kind: "void" };
    }
    if (command.operation === "session.revoke") {
      const payload = SessionPayload.parse(command.payload);
      try {
        await provider.revokeSession(payload.sessionId);
      } catch (error) {
        if (safeError(error).status !== 404) throw error;
      }
      return { kind: "void" };
    }
    if (command.operation === "sessions.revoke_all") {
      const payload = SessionsPayload.parse(command.payload);
      let after: string | undefined;
      for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
        let page: Awaited<ReturnType<WorkOSManagementProvider["listSessions"]>>;
        try {
          page = await provider.listSessions(payload.workosUserId, {
            limit: 100,
            ...(after ? { after } : {}),
          });
        } catch (error) {
          // Provider-user deletion can win before this ordered command is
          // observed (for example, a WorkOS administrator deletes the user
          // directly). An absent user has no remaining provider sessions, so
          // that state already satisfies revoke-all and must not poison the
          // outbox with a permanent dead letter.
          if (safeError(error).status === 404) return { kind: "void" };
          throw error;
        }
        for (const sessionId of sessionsEligibleForRevocation(
          page.data,
          payload.createdBefore,
        )) {
          try {
            await provider.revokeSession(sessionId);
          } catch (error) {
            if (safeError(error).status !== 404) throw error;
          }
        }
        const next = page.listMetadata.after ?? undefined;
        if (!next) return { kind: "void" };
        after = next;
      }
      throw new Error("WorkOS session pagination exceeded safety bound");
    }
    if (command.operation === "user.delete") {
      const payload = UserDeletePayload.parse(command.payload);
      try {
        await provider.deleteUser(payload.workosUserId);
      } catch (error) {
        if (safeError(error).status !== 404) throw error;
      }
      return { kind: "void" };
    }
    throw new Error("Unsupported WorkOS command operation");
  }

  private async complete(
    command: ClaimedCommand,
    result: CommandResult,
  ): Promise<void> {
    await withSystemTx(this.pool, async (tx) => {
      const owned = await tx.query(
        `SELECT 1 FROM workos_command_outbox
         WHERE id = $1 AND state = 'processing' AND lease_owner = $2
           AND attempt_count = $3
           AND lease_expires_at > clock_timestamp()
         FOR UPDATE`,
        [command.id, this.workerId, command.attemptCount],
      );
      if (!owned.rows[0]) return;
      if (result.kind === "organization" && command.organizationId) {
        const expected = OrganizationPayload.parse(command.payload).externalId;
        if (result.value.externalId !== expected) {
          throw new Error("WorkOS organization external ID mismatch");
        }
        await tx.query(
          `UPDATE workos_organization_links
           SET workos_organization_id = $2,
               state = CASE WHEN $3 = 'organization.delete'
                            THEN 'deleted'::workos_sync_state
                            ELSE 'active'::workos_sync_state END,
               last_provider_event_at = $4::timestamptz,
               last_error_code = NULL, updated_at = now()
           WHERE organization_id = $1`,
          [
            command.organizationId,
            result.value.id,
            command.operation,
            result.value.updatedAt,
          ],
        );
      }
      if (
        result.kind === "membership" &&
        command.organizationId &&
        command.userId
      ) {
        const role = Role.parse(result.value.roleSlug);
        await tx.query(
          `INSERT INTO workos_membership_projections (
             workos_membership_id, workos_organization_id, workos_user_id,
             organization_id, user_id, status, role, directory_managed,
             last_provider_event_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (workos_membership_id) DO UPDATE
           SET workos_organization_id = EXCLUDED.workos_organization_id,
               workos_user_id = EXCLUDED.workos_user_id,
               organization_id = EXCLUDED.organization_id,
               user_id = EXCLUDED.user_id,
               status = EXCLUDED.status,
               role = EXCLUDED.role,
               directory_managed = EXCLUDED.directory_managed,
               last_provider_event_at = GREATEST(
                 workos_membership_projections.last_provider_event_at,
                 EXCLUDED.last_provider_event_at
               ),
               updated_at = now()
           WHERE workos_membership_projections.status <> 'deleted'`,
          [
            result.value.id,
            result.value.organizationId,
            result.value.userId,
            command.organizationId,
            command.userId,
            result.value.status,
            role,
            result.value.directoryManaged,
            result.value.updatedAt,
          ],
        );
        await tx.query(
          `UPDATE organization_members
           SET workos_membership_id = $3,
               membership_source = CASE WHEN $4 THEN 'scim' ELSE 'zeros' END
           WHERE org_id = $1 AND user_id = $2`,
          [
            command.organizationId,
            command.userId,
            result.value.id,
            result.value.directoryManaged,
          ],
        );
      }
      if (command.operation === "membership.delete" && command.organizationId) {
        const payload = MembershipPayload.parse(command.payload);
        for (const membershipId of result.kind === "void"
          ? (result.deletedMembershipIds ?? [])
          : []) {
          await tx.query(
            `INSERT INTO workos_membership_projections (
               workos_membership_id, workos_organization_id, workos_user_id,
               organization_id, user_id, status, role, directory_managed,
               last_provider_event_at
             )
             SELECT $2, wol.workos_organization_id, $3, $1, $4,
                    'deleted', $5, false, now()
             FROM workos_organization_links wol
             WHERE wol.organization_id = $1
               AND wol.workos_organization_id IS NOT NULL
             ON CONFLICT (workos_membership_id) DO UPDATE
             SET status = 'deleted', updated_at = now(),
                 last_provider_event_at = GREATEST(
                   workos_membership_projections.last_provider_event_at,
                   now()
                 )`,
            [
              command.organizationId,
              membershipId,
              payload.workosUserId,
              command.userId,
              payload.role,
            ],
          );
        }
        if (
          (result.kind === "void" ? result.deletedMembershipIds : [])
            ?.length === 0
        ) {
          await tx.query(
            `UPDATE workos_membership_projections
             SET status = 'deleted', updated_at = now(),
                 last_provider_event_at = GREATEST(last_provider_event_at, now())
             WHERE organization_id = $1 AND workos_user_id = $2`,
            [command.organizationId, payload.workosUserId],
          );
        }
      }
      if (result.kind === "invitation") {
        const payload = InvitationPayload.parse(command.payload);
        await tx.query(
          `UPDATE invitations
           SET workos_invitation_id = $2, invitation_source = 'workos',
               workos_updated_at = $3
           WHERE id = $1`,
          [payload.localInvitationId, result.value.id, result.value.updatedAt],
        );
        await replayDeferredWorkOSInvitationEvents(tx, result.value.id);
        await tx.query(
          `UPDATE workos_command_outbox
           SET provider_object_id = $2, updated_at = now()
           WHERE aggregate_key = $1 AND operation = 'invitation.revoke'
             AND state = 'queued' AND provider_object_id IS NULL`,
          [command.aggregateKey, result.value.id],
        );
      }
      if (
        command.operation === "organization.delete" &&
        command.organizationId
      ) {
        await tx.query(
          `UPDATE workos_organization_links
           SET state = 'deleted', updated_at = now()
           WHERE organization_id = $1`,
          [command.organizationId],
        );
      }
      await tx.query(
        `UPDATE workos_command_outbox
         SET state = 'succeeded', completed_at = now(), updated_at = now(),
             lease_owner = NULL, lease_expires_at = NULL,
             provider_object_id = COALESCE(
               $3,
               provider_object_id
             ), last_error_code = NULL
         WHERE id = $1 AND state = 'processing' AND lease_owner = $2
           AND attempt_count = $4`,
        [
          command.id,
          this.workerId,
          result.kind === "void" ? null : result.value.id,
          command.attemptCount,
        ],
      );
    });
  }

  private async fail(command: ClaimedCommand, error: unknown): Promise<void> {
    const failure = safeError(error);
    const retry = failure.retryable && command.attemptCount < 10;
    await withSystemTx(this.pool, (tx) =>
      tx.query(
        `UPDATE workos_command_outbox
         SET state = $3::workos_command_state,
             next_attempt_at = CASE WHEN $3 = 'queued'
               THEN now() + ($4::bigint * interval '1 millisecond')
               ELSE next_attempt_at END,
             completed_at = CASE WHEN $3 = 'dead' THEN now() ELSE NULL END,
             lease_owner = NULL, lease_expires_at = NULL,
             last_error_code = $5, updated_at = now()
         WHERE id = $1 AND state = 'processing' AND lease_owner = $2
           AND attempt_count = $6
           AND lease_expires_at > clock_timestamp()`,
        [
          command.id,
          this.workerId,
          retry ? "queued" : "dead",
          retryDelayMs(command.attemptCount),
          failure.code,
          command.attemptCount,
        ],
      ),
    );
    this.logger.warn(
      `[workos-sync] ${command.operation} ${retry ? "will retry" : "dead-lettered"} [${failure.code}]`,
    );
  }

  private async deferForProviderLock(
    command: ClaimedCommand,
    error: WorkOSProviderLockTimeoutError | WorkOSProviderLockAbortedError,
  ): Promise<void> {
    await withSystemTx(this.pool, (tx) =>
      tx.query(
        `UPDATE workos_command_outbox
         SET state = 'queued', attempt_count = GREATEST(attempt_count - 1, 0),
             next_attempt_at = now() + interval '1 second',
             lease_owner = NULL, lease_expires_at = NULL,
             last_error_code = $3, updated_at = now()
         WHERE id = $1 AND state = 'processing' AND lease_owner = $2
           AND attempt_count = $4`,
        [command.id, this.workerId, error.code, command.attemptCount],
      ),
    );
    this.logger.warn(
      `[workos-sync] ${command.operation} waiting [${error.code}]`,
    );
  }

  private async process(command: ClaimedCommand): Promise<void> {
    const targets = await this.providerLockTargets(command);
    try {
      await withWorkOSProviderLocks(
        this.pool,
        targets.keys,
        async () => {
          if (!(await this.beginExecution(command, targets.userIds))) return;

          let leaseLost = false;
          let renewal: Promise<boolean> | null = null;
          const renew = (): Promise<boolean> => {
            if (renewal) return renewal;
            renewal = this.renewLease(command)
              .catch((error: unknown) => {
                leaseLost = true;
                this.logger.warn(
                  `[workos-sync] ${command.operation} lease heartbeat failed [${safeError(error).code}]`,
                );
                return false;
              })
              .then((owned) => {
                if (!owned) leaseLost = true;
                return owned;
              })
              .finally(() => {
                renewal = null;
              });
            return renewal;
          };
          const checkpoint = async (): Promise<void> => {
            if (leaseLost || !(await renew())) {
              throw new WorkOSCommandLeaseLost();
            }
          };
          const timer = setInterval(() => {
            void renew();
          }, this.heartbeatIntervalMs);
          timer.unref();
          try {
            const result = await this.execute(command, checkpoint);
            await checkpoint();
            await this.complete(command, result);
          } catch (error) {
            if (error instanceof WorkOSCommandLeaseLost || leaseLost) return;
            await this.fail(command, error);
          } finally {
            clearInterval(timer);
            await renewal;
          }
        },
        { timeoutMs: this.providerLockTimeoutMs },
      );
    } catch (error) {
      if (
        error instanceof WorkOSProviderLockTimeoutError ||
        error instanceof WorkOSProviderLockAbortedError
      ) {
        await this.deferForProviderLock(command, error);
        return;
      }
      throw error;
    }
  }

  async tick(maxCommands = 20): Promise<number> {
    let processed = 0;
    for (; processed < maxCommands; processed++) {
      const command = await this.claim();
      if (!command) break;
      await this.process(command);
    }
    return processed;
  }
}

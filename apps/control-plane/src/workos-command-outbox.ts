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
  | "session.revoke";

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

export async function enqueueWorkOSCommand(
  tx: Tx,
  input: EnqueueWorkOSCommandInput,
): Promise<void> {
  await tx.query(
    `INSERT INTO workos_command_outbox (
       operation, idempotency_key, aggregate_key, ordering_key,
       aggregate_revision,
       organization_id, user_id, provider_object_id, payload
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     ON CONFLICT (idempotency_key) DO NOTHING`,
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

const Identifier = z.string().regex(/^[A-Za-z0-9_-]{1,512}$/);
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

type WorkOSCommandLogger = Pick<Console, "info" | "warn" | "error">;

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

  constructor(
    private readonly pool: pg.Pool,
    private readonly provider: WorkOSManagementProvider,
    options: { workerId?: string; logger?: WorkOSCommandLogger } = {},
  ) {
    this.workerId = options.workerId ?? `workos:${randomUUID()}`;
    this.logger = options.logger ?? console;
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
               c.operation IN ('organization.create', 'session.revoke')
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
             lease_owner = $1, lease_expires_at = now() + interval '60 seconds',
             updated_at = now()
         FROM candidate
         WHERE c.id = candidate.id
         RETURNING c.id, c.operation, c.idempotency_key, c.aggregate_key,
                   c.aggregate_revision, c.organization_id, c.user_id,
                   c.provider_object_id, c.payload, c.attempt_count`,
        [this.workerId],
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
      const dependency = new Error("WorkOS organization is not ready") as Error & {
        status: number;
      };
      dependency.status = 503;
      throw dependency;
    }
    return id;
  }

  private async execute(command: ClaimedCommand): Promise<CommandResult> {
    if (
      command.operation === "organization.create" ||
      command.operation === "organization.update"
    ) {
      const payload = OrganizationPayload.parse(command.payload);
      if (command.operation === "organization.create") {
        try {
          return {
            kind: "organization",
            value: await this.provider.createOrganization({
              name: payload.name,
              externalId: payload.externalId,
              idempotencyKey: command.idempotencyKey,
            }),
          };
        } catch (error) {
          if (safeError(error).status !== 409) throw error;
          return {
            kind: "organization",
            value: await this.provider.getOrganizationByExternalId(
              payload.externalId,
            ),
          };
        }
      }
      return {
        kind: "organization",
        value: await this.provider.updateOrganization({
          organizationId: await this.workosOrganizationId(command),
          name: payload.name,
          externalId: payload.externalId,
        }),
      };
    }
    if (command.operation === "organization.delete") {
      const id = command.providerObjectId ?? (await this.workosOrganizationId(command));
      try {
        await this.provider.deleteOrganization(id);
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
          : this.provider.updateMembership({
              membershipId: membership.id,
              roleSlug: payload.role,
            });
      const createMembership = (): Promise<WorkOSMembershipRecord> =>
        this.provider.createMembership({
          organizationId,
          userId: payload.workosUserId,
          roleSlug: payload.role,
        });
      if (command.operation === "membership.update" && command.providerObjectId) {
        try {
          return {
            kind: "membership",
            value: await this.provider.updateMembership({
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
        const observed = await this.provider.listMemberships({
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
            await this.provider.deleteMembership(membership.id);
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
            await this.provider.listMemberships({
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
        for (const membership of await this.provider.listMemberships({
          organizationId,
          userId: payload.workosUserId,
        })) {
          ids.add(membership.id);
        }
      }
      for (const id of ids) {
        try {
          await this.provider.deleteMembership(id);
        } catch (error) {
          if (safeError(error).status !== 404) throw error;
        }
      }
      return { kind: "void", deletedMembershipIds: Array.from(ids) };
    }
    if (command.operation === "invitation.create") {
      const payload = InvitationPayload.parse(command.payload);
      const organizationId = await this.workosOrganizationId(command);
      const existing = await this.provider.listInvitations({
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
          await this.provider.revokeInvitation(stale.id);
        } catch (error) {
          if (safeError(error).status !== 404) throw error;
        }
      }
      return {
        kind: "invitation",
        value:
          matching ??
          (await this.provider.sendInvitation({
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
      const listed = await this.provider.listInvitations({
        organizationId,
        email: payload.email,
      });
      const exact = command.providerObjectId
        ? listed.find((invitation) => invitation.id === command.providerObjectId)
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
          await this.provider.revokeInvitation(id);
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
            const current = await this.provider.listInvitations({
              organizationId,
              email: payload.email,
            });
            const observed = current.find(
              (invitation) => invitation.id === id,
            );
            if (observed && observed.state !== "pending") {
              continue;
            }
          }
          throw error;
        }
      }
      return { kind: "void" };
    }
    const payload = SessionPayload.parse(command.payload);
    try {
      await this.provider.revokeSession(payload.sessionId);
    } catch (error) {
      if (safeError(error).status !== 404) throw error;
    }
    return { kind: "void" };
  }

  private async complete(
    command: ClaimedCommand,
    result: CommandResult,
  ): Promise<void> {
    await withSystemTx(this.pool, async (tx) => {
      const owned = await tx.query(
        `SELECT 1 FROM workos_command_outbox
         WHERE id = $1 AND state = 'processing' AND lease_owner = $2
         FOR UPDATE`,
        [command.id, this.workerId],
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
      if (
        command.operation === "membership.delete" &&
        command.organizationId
      ) {
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
        if ((result.kind === "void" ? result.deletedMembershipIds : [])?.length === 0) {
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
         WHERE id = $1 AND lease_owner = $2`,
        [
          command.id,
          this.workerId,
          result.kind === "void" ? null : result.value.id,
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
         WHERE id = $1 AND state = 'processing' AND lease_owner = $2`,
        [
          command.id,
          this.workerId,
          retry ? "queued" : "dead",
          retryDelayMs(command.attemptCount),
          failure.code,
        ],
      ),
    );
    this.logger.warn(
      `[workos-sync] ${command.operation} ${retry ? "will retry" : "dead-lettered"} [${failure.code}]`,
    );
  }

  async tick(maxCommands = 20): Promise<number> {
    let processed = 0;
    for (; processed < maxCommands; processed++) {
      const command = await this.claim();
      if (!command) break;
      try {
        const result = await this.execute(command);
        await this.complete(command, result);
      } catch (error) {
        await this.fail(command, error);
      }
    }
    return processed;
  }
}

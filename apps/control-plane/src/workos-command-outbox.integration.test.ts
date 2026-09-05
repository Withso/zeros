import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ensureUser } from "./auth.js";
import { withSystemTx } from "./db.js";
import { runMigrations } from "./migrate.js";
import {
  enqueueWorkOSCommand,
  WorkOSCommandProcessor,
} from "./workos-command-outbox.js";
import { workOSProviderSubjectHash } from "./workos-provider-locks.js";
import { ingestWorkOSManagementEvent } from "./workos-sync-events.js";
import type {
  WorkOSInvitationRecord,
  WorkOSManagementProvider,
  WorkOSMembershipRecord,
  WorkOSOrganizationRecord,
} from "./workos-provider.js";

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

class FakeWorkOSProvider implements WorkOSManagementProvider {
  readonly calls: string[] = [];
  failNextOrganizationCreate = false;
  failAfterNextMembershipCreate = false;
  nextMembershipCreateFailure: { name: string; status: number } | null = null;
  readonly memberships: WorkOSMembershipRecord[] = [];
  readonly invitations: WorkOSInvitationRecord[] = [];
  readonly sessions: Array<{
    id: string;
    userId: string;
    status: string;
    createdAt: string;
  }> = [];
  readonly missingSessionUserIds = new Set<string>();
  readonly deletedUsers: string[] = [];
  failNextUserDeleteId: string | null = null;
  lastInvitationOptions: {
    organizationId: string;
    email: string;
    roleSlug: string;
    inviterUserId?: string;
  } | null = null;
  acceptBeforeNextInvitationRevoke = false;
  missingInvitationStatus = 404;
  onInvitationCreated:
    | ((invitation: WorkOSInvitationRecord) => Promise<void>)
    | null = null;
  onOrganizationUpdated: (() => Promise<void>) | null = null;

  async constructWebhookEvent(): Promise<never> {
    throw new Error("unused");
  }

  async listEvents() {
    return { data: [], after: null };
  }

  async createOrganization(options: {
    name: string;
    externalId: string;
    idempotencyKey: string;
  }): Promise<WorkOSOrganizationRecord> {
    this.calls.push(`organization.create:${options.externalId}`);
    if (this.failNextOrganizationCreate) {
      this.failNextOrganizationCreate = false;
      const failure = new Error("temporary WorkOS outage") as Error & {
        status: number;
      };
      failure.status = 503;
      throw failure;
    }
    return {
      id: `org_${options.externalId.replaceAll("-", "")}`,
      name: options.name,
      externalId: options.externalId,
      updatedAt: new Date().toISOString(),
    };
  }

  async getOrganizationByExternalId(
    externalId: string,
  ): Promise<WorkOSOrganizationRecord> {
    return {
      id: `org_${externalId.replaceAll("-", "")}`,
      name: "Recovered",
      externalId,
      updatedAt: new Date().toISOString(),
    };
  }

  async updateOrganization(options: {
    organizationId: string;
    name: string;
    externalId: string;
  }): Promise<WorkOSOrganizationRecord> {
    this.calls.push(`organization.update:${options.organizationId}`);
    await this.onOrganizationUpdated?.();
    return {
      id: options.organizationId,
      name: options.name,
      externalId: options.externalId,
      updatedAt: new Date().toISOString(),
    };
  }

  async deleteOrganization(organizationId: string): Promise<void> {
    this.calls.push(`organization.delete:${organizationId}`);
  }

  async createMembership(options: {
    organizationId: string;
    userId: string;
    roleSlug: string;
  }): Promise<WorkOSMembershipRecord> {
    this.calls.push(`membership.create:${options.organizationId}`);
    if (this.nextMembershipCreateFailure) {
      const { name, status } = this.nextMembershipCreateFailure;
      this.nextMembershipCreateFailure = null;
      const failure = new Error("membership create failed") as Error & {
        status: number;
      };
      failure.name = name;
      failure.status = status;
      throw failure;
    }
    const pending = this.memberships.find(
      (membership) =>
        membership.organizationId === options.organizationId &&
        membership.userId === options.userId &&
        membership.status === "pending",
    );
    if (pending) {
      const conflict = new Error(
        "a pending invitation membership already exists",
      ) as Error & { status: number };
      conflict.name = "GenericServerException";
      conflict.status = 500;
      throw conflict;
    }
    const existing = this.memberships.find(
      (membership) =>
        membership.organizationId === options.organizationId &&
        membership.userId === options.userId &&
        membership.status === "active",
    );
    if (existing) {
      const conflict = new Error("membership exists") as Error & {
        status: number;
      };
      conflict.status = 409;
      throw conflict;
    }
    const created: WorkOSMembershipRecord = {
      id: `om_${randomUUID().replaceAll("-", "")}`,
      organizationId: options.organizationId,
      userId: options.userId,
      status: "active",
      directoryManaged: false,
      roleSlug: options.roleSlug,
      updatedAt: new Date().toISOString(),
    };
    this.memberships.push(created);
    if (this.failAfterNextMembershipCreate) {
      this.failAfterNextMembershipCreate = false;
      const failure = new Error(
        "response lost after provider accepted",
      ) as Error & {
        status: number;
      };
      failure.status = 503;
      throw failure;
    }
    return created;
  }

  async updateMembership(options: {
    membershipId: string;
    roleSlug: string;
  }): Promise<WorkOSMembershipRecord> {
    this.calls.push(`membership.update:${options.membershipId}`);
    return {
      id: options.membershipId,
      organizationId: "org_unused",
      userId: "user_unused",
      status: "active",
      directoryManaged: false,
      roleSlug: options.roleSlug,
      updatedAt: new Date().toISOString(),
    };
  }

  async deleteMembership(membershipId: string): Promise<void> {
    this.calls.push(`membership.delete:${membershipId}`);
    const index = this.memberships.findIndex(
      (membership) => membership.id === membershipId,
    );
    if (index >= 0) this.memberships.splice(index, 1);
  }

  async listMemberships(options: {
    organizationId: string;
    userId: string;
  }): Promise<WorkOSMembershipRecord[]> {
    this.calls.push(`membership.list:${options.organizationId}`);
    return this.memberships.filter(
      (membership) =>
        membership.organizationId === options.organizationId &&
        membership.userId === options.userId,
    );
  }

  async sendInvitation(options: {
    organizationId: string;
    email: string;
    roleSlug: string;
    inviterUserId?: string;
  }): Promise<WorkOSInvitationRecord> {
    this.lastInvitationOptions = { ...options };
    this.calls.push(`invitation.create:${options.email}`);
    const created: WorkOSInvitationRecord = {
      id: `inv_${randomUUID().replaceAll("-", "")}`,
      organizationId: options.organizationId,
      email: options.email,
      state: "pending",
      roleSlug: options.roleSlug,
      updatedAt: new Date().toISOString(),
    };
    this.invitations.push(created);
    // Preserve the response WorkOS produced at mutation time. A webhook may
    // arrive before the command transaction records this ID and move the
    // provider object forward while the original response remains pending.
    const response = { ...created };
    await this.onInvitationCreated?.(created);
    return response;
  }

  async findInvitationByToken(token: string): Promise<WorkOSInvitationRecord> {
    const invitation = this.invitations.find((item) => item.id === token);
    if (invitation) return invitation;
    const missing = new Error("invitation missing") as Error & {
      status: number;
    };
    missing.status = 404;
    throw missing;
  }

  async getInvitation(invitationId: string): Promise<WorkOSInvitationRecord> {
    return this.findInvitationByToken(invitationId);
  }

  async listInvitations(options: {
    organizationId: string;
    email: string;
  }): Promise<WorkOSInvitationRecord[]> {
    this.calls.push(`invitation.list:${options.email}`);
    return this.invitations.filter(
      (invitation) =>
        invitation.organizationId === options.organizationId &&
        invitation.email === options.email,
    );
  }

  async revokeInvitation(
    invitationId: string,
  ): Promise<WorkOSInvitationRecord> {
    this.calls.push(`invitation.revoke:${invitationId}`);
    const invitation = this.invitations.find(
      (item) => item.id === invitationId,
    );
    if (!invitation) {
      const missing = new Error("invitation missing") as Error & {
        status: number;
      };
      missing.status = this.missingInvitationStatus;
      throw missing;
    }
    if (this.acceptBeforeNextInvitationRevoke) {
      this.acceptBeforeNextInvitationRevoke = false;
      invitation.state = "accepted";
      invitation.updatedAt = new Date().toISOString();
      const accepted = new Error("invitation was accepted") as Error & {
        status: number;
      };
      accepted.status = 409;
      throw accepted;
    }
    invitation.state = "revoked";
    invitation.updatedAt = new Date().toISOString();
    return invitation;
  }

  async listSessions(
    subject: string,
    options: { limit: number; after?: string },
  ): Promise<{
    data: Array<{ id: string; status: string; createdAt: string }>;
    listMetadata: { after: string | null };
  }> {
    this.calls.push(`session.list:${subject}`);
    if (this.missingSessionUserIds.has(subject)) {
      const missing = new Error("WorkOS user not found") as Error & {
        status: number;
      };
      missing.name = "NotFoundException";
      missing.status = 404;
      throw missing;
    }
    const offset = options.after ? Number(options.after) : 0;
    const rows = this.sessions
      .filter((session) => session.userId === subject)
      .slice(offset, offset + options.limit);
    const next = offset + rows.length;
    return {
      data: rows.map(({ id, status, createdAt }) => ({
        id,
        status,
        createdAt,
      })),
      listMetadata: {
        after:
          next <
          this.sessions.filter((session) => session.userId === subject).length
            ? String(next)
            : null,
      },
    };
  }

  async revokeSession(sessionId: string): Promise<void> {
    this.calls.push(`session.revoke:${sessionId}`);
    const session = this.sessions.find(
      (candidate) => candidate.id === sessionId,
    );
    if (session) session.status = "revoked";
  }

  async deleteUser(userId: string): Promise<void> {
    this.calls.push(`user.delete:${userId}`);
    if (this.failNextUserDeleteId === userId) {
      this.failNextUserDeleteId = null;
      const failure = new Error(
        "temporary WorkOS user deletion outage",
      ) as Error & {
        status: number;
      };
      failure.status = 503;
      throw failure;
    }
    this.deletedUsers.push(userId);
  }
}

async function seedOrganization(pool: pg.Pool, suffix: string) {
  const subject = `user_${suffix}`;
  const user = await ensureUser(pool, {
    provider: "workos",
    providerSubject: subject,
    email: `${suffix}@example.com`,
    displayName: "Outbox Owner",
  });
  const organization = await pool.query<{ id: string }>(
    `INSERT INTO organizations (
       slug, name, created_by, is_personal, cloud_workspaces_allowed
     ) VALUES ($1, 'Outbox Organization', $2, false, true)
     RETURNING id`,
    [`outbox-${suffix}`, user.id],
  );
  const organizationId = organization.rows[0]!.id;
  await pool.query(
    `INSERT INTO organization_members (org_id, user_id, role)
     VALUES ($1, $2, 'owner')`,
    [organizationId, user.id],
  );
  await pool.query(
    `INSERT INTO workos_organization_links (
       organization_id, external_id, state
     ) VALUES ($1::uuid, $1::text, 'provisioning')`,
    [organizationId],
  );
  return { organizationId, userId: user.id, workosUserId: subject };
}

function deletionPublicCode(): string {
  const suffix = randomUUID()
    .replaceAll("-", "")
    .replace(/[01]/g, "A")
    .slice(0, 4)
    .toUpperCase();
  return `ZD-AUTH-${suffix}`;
}

async function stageAccountPurge(
  pool: pg.Pool,
  userId: string,
  fenceSubjects = true,
): Promise<string> {
  const request = await pool.query<{ id: string }>(
    `INSERT INTO deletion_requests (
       public_code, target_kind, target_id, target_user_id, state,
       purge_started_at
     ) VALUES ($1, 'account', $2, $2, 'purging', now())
     RETURNING id`,
    [deletionPublicCode(), userId],
  );
  await pool.query(
    `UPDATE users
     SET auth_status = 'deletion_pending', deleted_at = now(),
         deletion_request_id = $2, deletion_scheduled_at = now(),
         purge_after = (
           SELECT purge_after FROM deletion_requests WHERE id = $2
         )
     WHERE id = $1`,
    [userId, request.rows[0]!.id],
  );
  if (fenceSubjects) {
    const subjects = await pool.query<{ provider_sub: string }>(
      `SELECT provider_sub FROM user_identities
       WHERE provider = 'workos' AND user_id = $1
       UNION
       SELECT candidate_provider_sub AS provider_sub
       FROM account_recovery_requests
       WHERE target_user_id = $1 AND state = 'pending'`,
      [userId],
    );
    for (const subject of subjects.rows) {
      await pool.query(
        `INSERT INTO deletion_request_events (
           deletion_request_id, actor_user_id, action, metadata
         ) VALUES ($1, NULL, 'purge.provider_erasure_fenced', $2::jsonb)`,
        [
          request.rows[0]!.id,
          JSON.stringify({
            provider: "workos",
            workosSubjectHashes: [
              workOSProviderSubjectHash({
                kind: "user",
                id: subject.provider_sub,
              }),
            ],
          }),
        ],
      );
    }
  }
  return request.rows[0]!.id;
}

async function stageOrganizationPurge(
  pool: pg.Pool,
  organizationId: string,
): Promise<string> {
  const request = await pool.query<{ id: string }>(
    `INSERT INTO deletion_requests (
       public_code, target_kind, target_id, target_organization_id, state,
       purge_started_at
     ) VALUES ($1, 'organization', $2, $2, 'purging', now())
     RETURNING id`,
    [deletionPublicCode(), organizationId],
  );
  await pool.query(
    `UPDATE organizations
     SET lifecycle_status = 'purging', deleted_at = now(),
         deletion_request_id = $2, deletion_scheduled_at = now(),
         purge_after = (
           SELECT purge_after FROM deletion_requests WHERE id = $2
         )
     WHERE id = $1`,
    [organizationId, request.rows[0]!.id],
  );
  return request.rows[0]!.id;
}

d("WorkOS command outbox", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 4 });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool);
  });

  afterAll(async () => pool.end());

  it("holds the organization provider lock until an outbound mutation is durably completed", async () => {
    const seeded = await seedOrganization(
      pool,
      randomUUID().replaceAll("-", ""),
    );
    const workosOrganizationId = `org_${randomUUID().replaceAll("-", "")}`;
    await pool.query(
      `UPDATE workos_organization_links
       SET state = 'active', workos_organization_id = $2
       WHERE organization_id = $1`,
      [seeded.organizationId, workosOrganizationId],
    );
    await withSystemTx(pool, (tx) =>
      enqueueWorkOSCommand(tx, {
        operation: "organization.update",
        idempotencyKey: `organization.${seeded.organizationId}.2`,
        aggregateKey: `organization:${seeded.organizationId}`,
        aggregateRevision: 2,
        organizationId: seeded.organizationId,
        payload: {
          externalId: seeded.organizationId,
          name: "Locked organization",
        },
      }),
    );

    let releaseProvider!: () => void;
    let providerEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      providerEntered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const provider = new FakeWorkOSProvider();
    provider.onOrganizationUpdated = async () => {
      providerEntered();
      await blocked;
    };
    const processing = new WorkOSCommandProcessor(pool, provider, {
      workerId: "provider-lock-holder",
    }).tick(1);
    await entered;

    const contender = await pool.connect();
    try {
      const attempted = await contender.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_lock(
           hashtextextended('workos-provider-org:' || $1::text, 0)
         ) AS acquired`,
        [seeded.organizationId],
      );
      if (attempted.rows[0]?.acquired) {
        await contender.query(
          `SELECT pg_advisory_unlock(
             hashtextextended('workos-provider-org:' || $1::text, 0)
           )`,
          [seeded.organizationId],
        );
      }
      expect(attempted.rows[0]?.acquired).toBe(false);
    } finally {
      contender.release();
      releaseProvider();
    }
    await expect(processing).resolves.toBe(1);
  });

  it("requeues provider-lock contention without spending an execution attempt", async () => {
    const seeded = await seedOrganization(
      pool,
      randomUUID().replaceAll("-", ""),
    );
    const workosOrganizationId = `org_${randomUUID().replaceAll("-", "")}`;
    await pool.query(
      `UPDATE workos_organization_links
       SET state = 'active', workos_organization_id = $2
       WHERE organization_id = $1`,
      [seeded.organizationId, workosOrganizationId],
    );
    const commandId = await withSystemTx(pool, (tx) =>
      enqueueWorkOSCommand(tx, {
        operation: "organization.update",
        idempotencyKey: `organization.${seeded.organizationId}.lock-contention`,
        aggregateKey: `organization:${seeded.organizationId}`,
        aggregateRevision: 2,
        organizationId: seeded.organizationId,
        payload: {
          externalId: seeded.organizationId,
          name: "Contended organization",
        },
      }),
    );

    const blocker = await pool.connect();
    await blocker.query(
      `SELECT pg_advisory_lock(
         hashtextextended('workos-provider-org:' || $1::text, 0)
       )`,
      [seeded.organizationId],
    );
    const processing = new WorkOSCommandProcessor(
      pool,
      new FakeWorkOSProvider(),
      {
        workerId: "provider-lock-contender",
        providerLockTimeoutMs: 25,
        logger: { info() {}, warn() {}, error() {} },
      },
    ).tick(1);
    await new Promise((resolve) => setTimeout(resolve, 75));
    await blocker.query(
      `SELECT pg_advisory_unlock(
         hashtextextended('workos-provider-org:' || $1::text, 0)
       )`,
      [seeded.organizationId],
    );
    blocker.release();
    await expect(processing).resolves.toBe(1);

    await expect(
      pool.query(
        `SELECT state, attempt_count, lease_owner, lease_expires_at,
                last_error_code
         FROM workos_command_outbox WHERE id = $1`,
        [commandId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          state: "queued",
          attempt_count: 0,
          lease_owner: null,
          lease_expires_at: null,
          last_error_code: "workos_provider_lock_timeout",
        },
      ],
    });

    await pool.query(
      `UPDATE workos_command_outbox SET next_attempt_at = now() WHERE id = $1`,
      [commandId],
    );
    const retryProvider = new FakeWorkOSProvider();
    expect(await new WorkOSCommandProcessor(pool, retryProvider).tick(1)).toBe(
      1,
    );
    expect(retryProvider.calls).toEqual([
      `organization.update:${workosOrganizationId}`,
    ]);
  });

  it("does not complete a stale same-worker attempt after its lease identity changes", async () => {
    const seeded = await seedOrganization(
      pool,
      randomUUID().replaceAll("-", ""),
    );
    const workosOrganizationId = `org_${randomUUID().replaceAll("-", "")}`;
    await pool.query(
      `UPDATE workos_organization_links
       SET state = 'active', workos_organization_id = $2,
           last_provider_event_at = NULL
       WHERE organization_id = $1`,
      [seeded.organizationId, workosOrganizationId],
    );
    const commandId = await withSystemTx(pool, (tx) =>
      enqueueWorkOSCommand(tx, {
        operation: "organization.update",
        idempotencyKey: `organization.${seeded.organizationId}.2`,
        aggregateKey: `organization:${seeded.organizationId}`,
        aggregateRevision: 2,
        organizationId: seeded.organizationId,
        payload: {
          externalId: seeded.organizationId,
          name: "Stale attempt",
        },
      }),
    );

    let releaseProvider!: () => void;
    let providerEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      providerEntered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const provider = new FakeWorkOSProvider();
    provider.onOrganizationUpdated = async () => {
      providerEntered();
      await blocked;
    };
    const processing = new WorkOSCommandProcessor(pool, provider, {
      workerId: "stable-worker-id",
      logger: { info() {}, warn() {}, error() {} },
    }).tick(1);
    await entered;
    await pool.query(
      `UPDATE workos_command_outbox
       SET attempt_count = attempt_count + 1,
           lease_expires_at = now() + interval '60 seconds'
       WHERE id = $1 AND state = 'processing'
         AND lease_owner = 'stable-worker-id'`,
      [commandId],
    );
    releaseProvider();
    await expect(processing).resolves.toBe(1);

    await expect(
      pool.query(
        `SELECT state, attempt_count FROM workos_command_outbox WHERE id = $1`,
        [commandId],
      ),
    ).resolves.toMatchObject({
      rows: [{ state: "processing", attempt_count: 2 }],
    });
    await expect(
      pool.query(
        `SELECT last_provider_event_at FROM workos_organization_links
         WHERE organization_id = $1`,
        [seeded.organizationId],
      ),
    ).resolves.toMatchObject({ rows: [{ last_provider_event_at: null }] });
  });

  it("rejects new non-deletion provider commands after organization purge begins", async () => {
    const seeded = await seedOrganization(
      pool,
      randomUUID().replaceAll("-", ""),
    );
    await pool.query(
      `UPDATE organizations SET lifecycle_status = 'purging' WHERE id = $1`,
      [seeded.organizationId],
    );

    await expect(
      withSystemTx(pool, (tx) =>
        enqueueWorkOSCommand(tx, {
          operation: "organization.update",
          idempotencyKey: `organization.${seeded.organizationId}.2`,
          aggregateKey: `organization:${seeded.organizationId}`,
          aggregateRevision: 2,
          organizationId: seeded.organizationId,
          payload: {
            externalId: seeded.organizationId,
            name: "Must not escape purge",
          },
        }),
      ),
    ).rejects.toThrow(/organization.*provider command.*purging/i);
  });

  it("rejects terminal provider deletion commands for active targets", async () => {
    const seeded = await seedOrganization(
      pool,
      randomUUID().replaceAll("-", ""),
    );

    await expect(
      withSystemTx(pool, (tx) =>
        enqueueWorkOSCommand(tx, {
          operation: "organization.delete",
          idempotencyKey: `organization.delete.active.${seeded.organizationId}`,
          aggregateKey: `organization-delete:${seeded.organizationId}`,
          aggregateRevision: 1,
          organizationId: seeded.organizationId,
          payload: {},
        }),
      ),
    ).rejects.toThrow(/organization.*purge.*not started/i);

    await expect(
      withSystemTx(pool, (tx) =>
        enqueueWorkOSCommand(tx, {
          operation: "user.delete",
          idempotencyKey: `account.delete.active.${seeded.userId}`,
          aggregateKey: `account-delete:${seeded.userId}`,
          aggregateRevision: 1,
          userId: seeded.userId,
          providerObjectId: seeded.workosUserId,
          payload: { workosUserId: seeded.workosUserId },
        }),
      ),
    ).rejects.toThrow(/user.*purge.*not started/i);
  });

  it("requires a strict request id and its exact provider-erasure fence for user deletion", async () => {
    const seeded = await seedOrganization(
      pool,
      randomUUID().replaceAll("-", ""),
    );
    const deletionRequestId = await stageAccountPurge(
      pool,
      seeded.userId,
      false,
    );
    const idempotencyKey = `account.delete.${deletionRequestId}.${workOSProviderSubjectHash({ kind: "user", id: seeded.workosUserId })}`;

    await expect(
      withSystemTx(pool, (tx) =>
        enqueueWorkOSCommand(tx, {
          operation: "user.delete",
          idempotencyKey,
          aggregateKey: `account-delete:${seeded.userId}`,
          aggregateRevision: 1,
          userId: seeded.userId,
          providerObjectId: seeded.workosUserId,
          payload: {
            workosUserId: seeded.workosUserId,
            deletionRequestId: "not-a-uuid",
          },
        }),
      ),
    ).rejects.toThrow(/user.*provider target.*mismatch/i);

    await expect(
      withSystemTx(pool, (tx) =>
        enqueueWorkOSCommand(tx, {
          operation: "user.delete",
          idempotencyKey,
          aggregateKey: `account-delete:${seeded.userId}`,
          aggregateRevision: 1,
          userId: seeded.userId,
          providerObjectId: seeded.workosUserId,
          payload: { workosUserId: seeded.workosUserId, deletionRequestId },
        }),
      ),
    ).rejects.toThrow(/user.*provider target.*mismatch/i);

    const raw = await pool.query<{ id: string }>(
      `INSERT INTO workos_command_outbox (
         operation, idempotency_key, aggregate_key, ordering_key,
         aggregate_revision, user_id, provider_object_id, payload
       ) VALUES ('user.delete', $1, $2, $2, 1, $3, $4, $5::jsonb)
       RETURNING id`,
      [
        idempotencyKey,
        `account-delete:${seeded.userId}`,
        seeded.userId,
        seeded.workosUserId,
        JSON.stringify({
          workosUserId: seeded.workosUserId,
          deletionRequestId,
        }),
      ],
    );
    await pool.query(
      `UPDATE deletion_requests
       SET state = 'provider_deleting', purge_command_id = $2
       WHERE id = $1`,
      [deletionRequestId, raw.rows[0]!.id],
    );

    const provider = new FakeWorkOSProvider();
    expect(await new WorkOSCommandProcessor(pool, provider).tick(1)).toBe(1);
    expect(provider.calls).toEqual([]);
    await expect(
      pool.query(
        `SELECT state, last_error_code
         FROM workos_command_outbox WHERE id = $1`,
        [raw.rows[0]!.id],
      ),
    ).resolves.toMatchObject({
      rows: [{ state: "dead", last_error_code: "target_deleting" }],
    });
  });

  it("rejects terminal provider deletion commands bound to another target", async () => {
    const target = await seedOrganization(
      pool,
      randomUUID().replaceAll("-", ""),
    );
    const other = await seedOrganization(
      pool,
      randomUUID().replaceAll("-", ""),
    );
    const targetWorkOSOrganizationId = `org_${randomUUID().replaceAll("-", "")}`;
    const otherWorkOSOrganizationId = `org_${randomUUID().replaceAll("-", "")}`;
    await pool.query(
      `UPDATE workos_organization_links
       SET state = 'active',
           workos_organization_id = CASE organization_id
             WHEN $1 THEN $2 ELSE $4
           END
       WHERE organization_id IN ($1, $3)`,
      [
        target.organizationId,
        targetWorkOSOrganizationId,
        other.organizationId,
        otherWorkOSOrganizationId,
      ],
    );
    await stageOrganizationPurge(pool, target.organizationId);
    const accountRequestId = await stageAccountPurge(pool, target.userId);

    await expect(
      withSystemTx(pool, (tx) =>
        enqueueWorkOSCommand(tx, {
          operation: "organization.delete",
          idempotencyKey: `organization.delete.cross-tenant.${target.organizationId}`,
          aggregateKey: `organization-delete:${target.organizationId}`,
          aggregateRevision: 1,
          organizationId: target.organizationId,
          providerObjectId: otherWorkOSOrganizationId,
          payload: {},
        }),
      ),
    ).rejects.toThrow(/organization.*provider target.*mismatch/i);

    await expect(
      withSystemTx(pool, (tx) =>
        enqueueWorkOSCommand(tx, {
          operation: "user.delete",
          idempotencyKey: `account.delete.${accountRequestId}.${workOSProviderSubjectHash({ kind: "user", id: other.workosUserId })}`,
          aggregateKey: `account-delete:${target.userId}`,
          aggregateRevision: 1,
          userId: target.userId,
          providerObjectId: other.workosUserId,
          payload: {
            workosUserId: other.workosUserId,
            deletionRequestId: accountRequestId,
          },
        }),
      ),
    ).rejects.toThrow(/user.*provider target.*mismatch/i);

    await expect(
      withSystemTx(pool, (tx) =>
        enqueueWorkOSCommand(tx, {
          operation: "user.delete",
          idempotencyKey: `account.delete.${accountRequestId}.${workOSProviderSubjectHash({ kind: "user", id: other.workosUserId })}`,
          aggregateKey: `account-delete:${target.userId}`,
          aggregateRevision: 2,
          userId: target.userId,
          providerObjectId: target.workosUserId,
          payload: {
            workosUserId: other.workosUserId,
            deletionRequestId: accountRequestId,
          },
        }),
      ),
    ).rejects.toThrow(/user.*provider target.*mismatch/i);
  });

  it("retires terminal deletion commands that are not the purge request authority", async () => {
    const seeded = await seedOrganization(
      pool,
      randomUUID().replaceAll("-", ""),
    );
    const workosOrganizationId = `org_${randomUUID().replaceAll("-", "")}`;
    await pool.query(
      `UPDATE workos_organization_links
       SET state = 'active', workos_organization_id = $2
       WHERE organization_id = $1`,
      [seeded.organizationId, workosOrganizationId],
    );
    const organizationRequestId = await stageOrganizationPurge(
      pool,
      seeded.organizationId,
    );
    const accountRequestId = await stageAccountPurge(pool, seeded.userId);
    const staleAccountRequestId = randomUUID();
    const commands = await pool.query<{ id: string; operation: string }>(
      `INSERT INTO workos_command_outbox (
         operation, idempotency_key, aggregate_key, ordering_key,
         aggregate_revision, organization_id, user_id, provider_object_id,
         payload
       ) VALUES
         ('organization.delete', $1, $2, $2, 1, $3, NULL, $4, '{}'::jsonb),
         ('user.delete', $5, $6, $6, 1, NULL, $7, $8,
          jsonb_build_object(
            'workosUserId', $8::text,
            'deletionRequestId', $9::text
          ))
       RETURNING id, operation`,
      [
        `organization.delete.stale.${seeded.organizationId}`,
        `organization-delete:${seeded.organizationId}`,
        seeded.organizationId,
        workosOrganizationId,
        `account.delete.${staleAccountRequestId}.${workOSProviderSubjectHash({ kind: "user", id: seeded.workosUserId })}`,
        `account-delete:${seeded.userId}`,
        seeded.userId,
        seeded.workosUserId,
        staleAccountRequestId,
      ],
    );
    await pool.query(
      `UPDATE deletion_requests
       SET state = 'provider_deleting'
       WHERE id = ANY($1::uuid[])`,
      [[organizationRequestId, accountRequestId]],
    );

    const provider = new FakeWorkOSProvider();
    expect(await new WorkOSCommandProcessor(pool, provider).tick(2)).toBe(2);
    expect(provider.calls).toEqual([]);
    await expect(
      pool.query(
        `SELECT operation, state, last_error_code
         FROM workos_command_outbox
         WHERE id = ANY($1::uuid[])
         ORDER BY operation`,
        [commands.rows.map((command) => command.id)],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          operation: "organization.delete",
          state: "dead",
          last_error_code: "target_deleting",
        },
        {
          operation: "user.delete",
          state: "dead",
          last_error_code: "target_deleting",
        },
      ],
    });
  });

  it("retires authoritative deletion commands bound to another target", async () => {
    const target = await seedOrganization(
      pool,
      randomUUID().replaceAll("-", ""),
    );
    const other = await seedOrganization(
      pool,
      randomUUID().replaceAll("-", ""),
    );
    const targetWorkOSOrganizationId = `org_${randomUUID().replaceAll("-", "")}`;
    const otherWorkOSOrganizationId = `org_${randomUUID().replaceAll("-", "")}`;
    await pool.query(
      `UPDATE workos_organization_links
       SET state = 'active',
           workos_organization_id = CASE organization_id
             WHEN $1 THEN $2 ELSE $4
           END
       WHERE organization_id IN ($1, $3)`,
      [
        target.organizationId,
        targetWorkOSOrganizationId,
        other.organizationId,
        otherWorkOSOrganizationId,
      ],
    );
    const organizationRequestId = await stageOrganizationPurge(
      pool,
      target.organizationId,
    );
    const accountRequestId = await stageAccountPurge(pool, target.userId);
    const commands = await pool.query<{ id: string; operation: string }>(
      `INSERT INTO workos_command_outbox (
         operation, idempotency_key, aggregate_key, ordering_key,
         aggregate_revision, organization_id, user_id, provider_object_id,
         payload
       ) VALUES
         ('organization.delete', $1, $2, $2, 1, $3, NULL, $4, '{}'::jsonb),
         ('user.delete', $5, $6, $6, 1, NULL, $7, $8,
          jsonb_build_object(
            'workosUserId', $8::text,
            'deletionRequestId', $9::text
          ))
       RETURNING id, operation`,
      [
        `organization.delete.cross-tenant.raw.${target.organizationId}`,
        `organization-delete:${target.organizationId}`,
        target.organizationId,
        otherWorkOSOrganizationId,
        `account.delete.${accountRequestId}.${workOSProviderSubjectHash({ kind: "user", id: other.workosUserId })}`,
        `account-delete:${target.userId}`,
        target.userId,
        other.workosUserId,
        accountRequestId,
      ],
    );
    const organizationCommandId = commands.rows.find(
      (command) => command.operation === "organization.delete",
    )!.id;
    const userCommandId = commands.rows.find(
      (command) => command.operation === "user.delete",
    )!.id;
    await pool.query(
      `UPDATE deletion_requests
       SET state = 'provider_deleting',
           purge_command_id = CASE id
             WHEN $1::uuid THEN $2::uuid ELSE $4::uuid
           END
       WHERE id IN ($1, $3)`,
      [
        organizationRequestId,
        organizationCommandId,
        accountRequestId,
        userCommandId,
      ],
    );

    const provider = new FakeWorkOSProvider();
    expect(await new WorkOSCommandProcessor(pool, provider).tick(2)).toBe(2);
    expect(provider.calls).toEqual([]);
    await expect(
      pool.query(
        `SELECT operation, state, last_error_code
         FROM workos_command_outbox
         WHERE id = ANY($1::uuid[])
         ORDER BY operation`,
        [commands.rows.map((command) => command.id)],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          operation: "organization.delete",
          state: "dead",
          last_error_code: "target_deleting",
        },
        {
          operation: "user.delete",
          state: "dead",
          last_error_code: "target_deleting",
        },
      ],
    });
  });

  it("retires an already queued additive command when its target begins purging", async () => {
    const seeded = await seedOrganization(
      pool,
      randomUUID().replaceAll("-", ""),
    );
    const workosOrganizationId = `org_${randomUUID().replaceAll("-", "")}`;
    await pool.query(
      `UPDATE workos_organization_links
       SET state = 'active', workos_organization_id = $2
       WHERE organization_id = $1`,
      [seeded.organizationId, workosOrganizationId],
    );
    const commandId = await withSystemTx(pool, (tx) =>
      enqueueWorkOSCommand(tx, {
        operation: "organization.update",
        idempotencyKey: `organization.${seeded.organizationId}.2`,
        aggregateKey: `organization:${seeded.organizationId}`,
        aggregateRevision: 2,
        organizationId: seeded.organizationId,
        payload: {
          externalId: seeded.organizationId,
          name: "Queued before purge",
        },
      }),
    );
    await pool.query(
      `UPDATE organizations SET lifecycle_status = 'purging' WHERE id = $1`,
      [seeded.organizationId],
    );
    const provider = new FakeWorkOSProvider();

    expect(await new WorkOSCommandProcessor(pool, provider).tick(1)).toBe(1);
    expect(provider.calls).toEqual([]);
    await expect(
      pool.query(
        `SELECT state, last_error_code
         FROM workos_command_outbox WHERE id = $1`,
        [commandId],
      ),
    ).resolves.toMatchObject({
      rows: [{ state: "dead", last_error_code: "target_deleting" }],
    });
  });

  it("heartbeats a target-locked command so a long provider call is not reclaimed", async () => {
    const seeded = await seedOrganization(
      pool,
      randomUUID().replaceAll("-", ""),
    );
    const workosOrganizationId = `org_${randomUUID().replaceAll("-", "")}`;
    await pool.query(
      `UPDATE workos_organization_links
       SET state = 'active', workos_organization_id = $2
       WHERE organization_id = $1`,
      [seeded.organizationId, workosOrganizationId],
    );
    const commandId = await withSystemTx(pool, (tx) =>
      enqueueWorkOSCommand(tx, {
        operation: "organization.update",
        idempotencyKey: `organization.${seeded.organizationId}.2`,
        aggregateKey: `organization:${seeded.organizationId}`,
        aggregateRevision: 2,
        organizationId: seeded.organizationId,
        payload: {
          externalId: seeded.organizationId,
          name: "Heartbeat organization",
        },
      }),
    );
    let releaseProvider!: () => void;
    let providerEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      providerEntered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const provider = new FakeWorkOSProvider();
    provider.onOrganizationUpdated = async () => {
      providerEntered();
      await blocked;
    };
    const processing = new WorkOSCommandProcessor(pool, provider, {
      workerId: "heartbeat-owner",
      leaseDurationMs: 1_000,
      heartbeatIntervalMs: 250,
    }).tick(1);
    await entered;
    try {
      await new Promise((resolve) => setTimeout(resolve, 1_250));
      await expect(
        pool.query(
          `SELECT attempt_count,
                  lease_expires_at > clock_timestamp() AS lease_current
           FROM workos_command_outbox WHERE id = $1`,
          [commandId],
        ),
      ).resolves.toMatchObject({
        rows: [{ attempt_count: 1, lease_current: true }],
      });
    } finally {
      releaseProvider();
    }
    await expect(processing).resolves.toBe(1);
  });

  it("uses auth-session ownership for enqueue and processing lifecycle gates", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const workosUserId = `user_${suffix}`;
    const sessionId = `session_${suffix}`;
    const user = await ensureUser(pool, {
      provider: "workos",
      providerSubject: workosUserId,
      email: `session-owner-${suffix}@example.com`,
      displayName: "Session owner",
    });
    await pool.query(
      `INSERT INTO auth_sessions (
         provider_session_id, provider_sub, user_id, client_kind, status
       ) VALUES ($1, $2, $3, 'web', 'active')`,
      [sessionId, workosUserId, user.id],
    );
    await expect(
      pool.query(
        `SELECT 1 FROM workos_browser_sessions
         WHERE provider_session_id = $1`,
        [sessionId],
      ),
    ).resolves.toMatchObject({ rows: [] });

    const commandId = await withSystemTx(pool, (tx) =>
      enqueueWorkOSCommand(tx, {
        operation: "session.revoke",
        idempotencyKey: `session.revoke.${sessionId}.1`,
        aggregateKey: `session:${sessionId}`,
        aggregateRevision: 1,
        payload: { sessionId },
      }),
    );
    await pool.query(
      `UPDATE users
       SET auth_status = 'deleted', deleted_at = now()
       WHERE id = $1`,
      [user.id],
    );

    const provider = new FakeWorkOSProvider();
    expect(await new WorkOSCommandProcessor(pool, provider).tick(1)).toBe(1);
    expect(provider.calls).toEqual([]);
    await expect(
      pool.query(
        `SELECT state, last_error_code
         FROM workos_command_outbox WHERE id = $1`,
        [commandId],
      ),
    ).resolves.toMatchObject({
      rows: [{ state: "dead", last_error_code: "target_deleting" }],
    });
    await expect(
      withSystemTx(pool, (tx) =>
        enqueueWorkOSCommand(tx, {
          operation: "session.revoke",
          idempotencyKey: `session.revoke.${sessionId}.2`,
          aggregateKey: `session:${sessionId}`,
          aggregateRevision: 2,
          payload: { sessionId },
        }),
      ),
    ).rejects.toThrow(/user provider command.*deleted/i);
  });

  it("revokes only pre-deletion sessions before deleting the WorkOS user", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const workosUserId = `user_${suffix}`;
    const user = await ensureUser(pool, {
      provider: "workos",
      providerSubject: workosUserId,
      email: `account-delete-${suffix}@example.com`,
      displayName: "Account deletion",
    });
    const deletionRequestId = await stageAccountPurge(pool, user.id);
    const cutoff = "2026-09-01T00:00:01.000Z";
    const deleteCommandId = await withSystemTx(pool, async (tx) => {
      await enqueueWorkOSCommand(tx, {
        operation: "sessions.revoke_all",
        idempotencyKey: `account.sessions.${user.id}.1`,
        aggregateKey: `account-sessions:${user.id}`,
        orderingKey: `account:${user.id}`,
        aggregateRevision: 1,
        userId: user.id,
        providerObjectId: workosUserId,
        payload: { workosUserId, createdBefore: cutoff },
      });
      return enqueueWorkOSCommand(tx, {
        operation: "user.delete",
        idempotencyKey: `account.delete.${deletionRequestId}.${workOSProviderSubjectHash({ kind: "user", id: workosUserId })}`,
        aggregateKey: `account-delete:${user.id}`,
        orderingKey: `account:${user.id}`,
        aggregateRevision: 1,
        userId: user.id,
        providerObjectId: workosUserId,
        payload: { workosUserId, deletionRequestId },
      });
    });
    await pool.query(
      `UPDATE deletion_requests
       SET state = 'provider_deleting', purge_command_id = $2
       WHERE id = $1`,
      [deletionRequestId, deleteCommandId],
    );

    const provider = new FakeWorkOSProvider();
    provider.sessions.push(
      {
        id: `session_old_${suffix}`,
        userId: workosUserId,
        status: "active",
        createdAt: "2026-09-01T00:00:00.000Z",
      },
      {
        id: `session_recovery_${suffix}`,
        userId: workosUserId,
        status: "active",
        createdAt: "2026-09-01T00:00:02.000Z",
      },
    );

    expect(await new WorkOSCommandProcessor(pool, provider).tick()).toBe(2);
    expect(provider.calls).toEqual([
      `session.list:${workosUserId}`,
      `session.revoke:session_old_${suffix}`,
      `user.delete:${workosUserId}`,
    ]);
    expect(provider.sessions).toEqual([
      expect.objectContaining({
        id: `session_old_${suffix}`,
        status: "revoked",
      }),
      expect.objectContaining({
        id: `session_recovery_${suffix}`,
        status: "active",
      }),
    ]);
    expect(provider.deletedUsers).toEqual([workosUserId]);
  });

  it("durably retries every captured WorkOS user after its source row expires", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const primarySubject = `user_multi_delete_primary_${suffix}`;
    const candidateSubject = `user_multi_delete_candidate_${suffix}`;
    const user = await ensureUser(pool, {
      provider: "workos",
      providerSubject: primarySubject,
      email: `multi-delete-${suffix}@example.com`,
      displayName: "Multi-subject deletion",
    });
    const identity = await pool.query<{ id: string }>(
      `SELECT id FROM user_identities
       WHERE user_id = $1 AND provider = 'workos' AND provider_sub = $2`,
      [user.id, primarySubject],
    );
    const recoveryCodePart = suffix
      .replace(/[01]/g, "A")
      .slice(0, 8)
      .toUpperCase();
    await pool.query(
      `INSERT INTO account_recovery_requests (
         public_code, candidate_provider_sub, candidate_session_id,
         candidate_email, candidate_auth_time, target_user_id,
         target_identity_id
       ) VALUES ($1, $2, $3, $4, now(), $5, $6)`,
      [
        `ZR-${recoveryCodePart.slice(0, 4)}-${recoveryCodePart.slice(4)}`,
        candidateSubject,
        `session_multi_delete_candidate_${suffix}`,
        user.email,
        user.id,
        identity.rows[0]!.id,
      ],
    );
    const deletionRequestId = await stageAccountPurge(pool, user.id);
    const commandIds = await withSystemTx(pool, async (tx) => {
      const ids: string[] = [];
      for (const [index, subject] of [
        primarySubject,
        candidateSubject,
      ].entries()) {
        ids.push(
          await enqueueWorkOSCommand(tx, {
            operation: "user.delete",
            idempotencyKey: `account.delete.${deletionRequestId}.${workOSProviderSubjectHash({ kind: "user", id: subject })}`,
            aggregateKey: `account-delete:${user.id}`,
            orderingKey: `account:${user.id}`,
            aggregateRevision: index + 1,
            userId: user.id,
            providerObjectId: subject,
            payload: {
              workosUserId: subject,
              deletionRequestId,
            },
          }),
        );
      }
      return ids;
    });
    const [primaryCommandId, candidateCommandId] = commandIds as [
      string,
      string,
    ];
    // The request-bound fence is the durable handoff. A short-lived recovery
    // row may expire after enqueue, but that must not strand the already
    // captured provider subject or turn its delete command into a dead letter.
    await pool.query(
      `DELETE FROM account_recovery_requests
       WHERE target_user_id = $1 AND candidate_provider_sub = $2`,
      [user.id, candidateSubject],
    );
    await pool.query(
      `UPDATE deletion_requests
       SET state = 'provider_deleting', purge_command_id = $2
       WHERE id = $1`,
      [deletionRequestId, candidateCommandId],
    );

    const provider = new FakeWorkOSProvider();
    provider.failNextUserDeleteId = candidateSubject;
    const processor = new WorkOSCommandProcessor(pool, provider, {
      logger: { info() {}, warn() {}, error() {} },
    });
    expect(await processor.tick(1)).toBe(1);
    await expect(
      pool.query(`SELECT state FROM workos_command_outbox WHERE id = $1`, [
        primaryCommandId,
      ]),
    ).resolves.toMatchObject({ rows: [{ state: "succeeded" }] });
    expect(await processor.tick(1)).toBe(1);
    await expect(
      pool.query(`SELECT state FROM workos_command_outbox WHERE id = $1`, [
        candidateCommandId,
      ]),
    ).resolves.toMatchObject({ rows: [{ state: "queued" }] });
    await pool.query(
      `UPDATE workos_command_outbox SET next_attempt_at = now() WHERE id = $1`,
      [candidateCommandId],
    );
    expect(await processor.tick(1)).toBe(1);
    expect(new Set(provider.deletedUsers)).toEqual(
      new Set([primarySubject, candidateSubject]),
    );
    await expect(
      pool.query(`SELECT state FROM workos_command_outbox WHERE id = $1`, [
        candidateCommandId,
      ]),
    ).resolves.toMatchObject({ rows: [{ state: "succeeded" }] });
  });

  it("executes an exact late subject while provider deletion remains active", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const originalSubject = `user_late_delete_original_${suffix}`;
    const lateSubject = `user_late_delete_candidate_${suffix}`;
    const user = await ensureUser(pool, {
      provider: "workos",
      providerSubject: originalSubject,
      email: `late-delete-${suffix}@example.com`,
      displayName: "Late provider deletion",
    });
    const deletionRequestId = await stageAccountPurge(pool, user.id);
    await pool.query(
      `INSERT INTO deletion_request_events (
         deletion_request_id, actor_user_id, action, metadata
       ) VALUES ($1, NULL, 'purge.provider_erasure_fenced', $2::jsonb)`,
      [
        deletionRequestId,
        JSON.stringify({
          provider: "workos",
          workosSubjectHashes: [
            workOSProviderSubjectHash({ kind: "user", id: lateSubject }),
          ],
        }),
      ],
    );
    await pool.query(
      `UPDATE deletion_requests
       SET state = 'provider_deleting'
       WHERE id = $1`,
      [deletionRequestId],
    );

    const commandId = await withSystemTx(pool, (tx) =>
      enqueueWorkOSCommand(tx, {
        operation: "user.delete",
        idempotencyKey: `account.delete.${deletionRequestId}.${workOSProviderSubjectHash({ kind: "user", id: lateSubject })}`,
        aggregateKey: `account-delete:${user.id}`,
        orderingKey: `account:${user.id}`,
        aggregateRevision: 1,
        userId: user.id,
        providerObjectId: lateSubject,
        payload: { workosUserId: lateSubject, deletionRequestId },
      }),
    );
    const provider = new FakeWorkOSProvider();

    expect(await new WorkOSCommandProcessor(pool, provider).tick(1)).toBe(1);
    expect(provider.deletedUsers).toEqual([lateSubject]);
    await expect(
      pool.query(`SELECT state FROM workos_command_outbox WHERE id = $1`, [
        commandId,
      ]),
    ).resolves.toMatchObject({ rows: [{ state: "succeeded" }] });
  });

  it("converges session revocation when the WorkOS user is already absent", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const workosUserId = `user_${suffix}`;
    const user = await ensureUser(pool, {
      provider: "workos",
      providerSubject: workosUserId,
      email: `missing-session-user-${suffix}@example.com`,
      displayName: "Missing session user",
    });
    await withSystemTx(pool, (tx) =>
      enqueueWorkOSCommand(tx, {
        operation: "sessions.revoke_all",
        idempotencyKey: `account.sessions.${user.id}.1`,
        aggregateKey: `account-sessions:${user.id}`,
        orderingKey: `account:${user.id}`,
        aggregateRevision: 1,
        userId: user.id,
        providerObjectId: workosUserId,
        payload: {
          workosUserId,
          createdBefore: "2026-09-01T00:00:01.000Z",
        },
      }),
    );

    const provider = new FakeWorkOSProvider();
    provider.missingSessionUserIds.add(workosUserId);

    expect(await new WorkOSCommandProcessor(pool, provider).tick()).toBe(1);
    expect(provider.calls).toEqual([`session.list:${workosUserId}`]);
    const command = await pool.query<{
      state: string;
      last_error_code: string | null;
    }>(
      `SELECT state, last_error_code
       FROM workos_command_outbox
       WHERE idempotency_key = $1`,
      [`account.sessions.${user.id}.1`],
    );
    expect(command.rows[0]).toEqual({
      state: "succeeded",
      last_error_code: null,
    });
  });

  it("provisions an organization before its membership and persists provider IDs", async () => {
    const seeded = await seedOrganization(
      pool,
      randomUUID().replaceAll("-", ""),
    );
    await withSystemTx(pool, async (tx) => {
      await enqueueWorkOSCommand(tx, {
        operation: "organization.create",
        idempotencyKey: `organization.${seeded.organizationId}.1`,
        aggregateKey: `organization:${seeded.organizationId}`,
        aggregateRevision: 1,
        organizationId: seeded.organizationId,
        payload: {
          externalId: seeded.organizationId,
          name: "Outbox Organization",
        },
      });
      await enqueueWorkOSCommand(tx, {
        operation: "membership.create",
        idempotencyKey: `membership.${seeded.organizationId}.${seeded.userId}.1`,
        aggregateKey: `membership:${seeded.organizationId}:${seeded.userId}`,
        aggregateRevision: 1,
        organizationId: seeded.organizationId,
        userId: seeded.userId,
        payload: { workosUserId: seeded.workosUserId, role: "owner" },
      });
    });

    const provider = new FakeWorkOSProvider();
    expect(await new WorkOSCommandProcessor(pool, provider).tick()).toBe(2);
    expect(
      provider.calls.map((call) => call.slice(0, call.indexOf(":"))),
    ).toEqual(["organization.create", "membership.create"]);
    const link = await pool.query(
      `SELECT state, workos_organization_id
       FROM workos_organization_links WHERE organization_id = $1`,
      [seeded.organizationId],
    );
    expect(link.rows[0]).toMatchObject({ state: "active" });
    expect(link.rows[0].workos_organization_id).toMatch(/^org_/);
    const member = await pool.query(
      `SELECT workos_membership_id FROM organization_members
       WHERE org_id = $1 AND user_id = $2`,
      [seeded.organizationId, seeded.userId],
    );
    expect(member.rows[0].workos_membership_id).toMatch(/^om_/);
    const states = await pool.query(
      `SELECT state FROM workos_command_outbox
       WHERE organization_id = $1 ORDER BY created_at, id`,
      [seeded.organizationId],
    );
    expect(states.rows).toEqual([
      { state: "succeeded" },
      { state: "succeeded" },
    ]);
  });

  it("retires a retrying create before an authoritative delete", async () => {
    const seeded = await seedOrganization(
      pool,
      randomUUID().replaceAll("-", ""),
    );
    await withSystemTx(pool, (tx) =>
      enqueueWorkOSCommand(tx, {
        operation: "organization.create",
        idempotencyKey: `organization.${seeded.organizationId}.1`,
        aggregateKey: `organization:${seeded.organizationId}`,
        aggregateRevision: 1,
        organizationId: seeded.organizationId,
        payload: {
          externalId: seeded.organizationId,
          name: "Outbox Organization",
        },
      }),
    );
    const provider = new FakeWorkOSProvider();
    provider.failNextOrganizationCreate = true;
    const processor = new WorkOSCommandProcessor(pool, provider, {
      logger: { info() {}, warn() {}, error() {} },
    });
    expect(await processor.tick()).toBe(1);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]).toMatch(/^organization\.create:/);

    const workosOrganizationId = `org_${randomUUID().replaceAll("-", "")}`;
    await pool.query(
      `UPDATE workos_organization_links
       SET state = 'active', workos_organization_id = $2
       WHERE organization_id = $1`,
      [seeded.organizationId, workosOrganizationId],
    );
    const deletionRequestId = await stageOrganizationPurge(
      pool,
      seeded.organizationId,
    );
    const deleteCommandId = await withSystemTx(pool, (tx) =>
      enqueueWorkOSCommand(tx, {
        operation: "organization.delete",
        idempotencyKey: `organization.${seeded.organizationId}.2`,
        aggregateKey: `organization:${seeded.organizationId}`,
        aggregateRevision: 2,
        organizationId: seeded.organizationId,
        providerObjectId: workosOrganizationId,
        payload: {},
      }),
    );
    await pool.query(
      `UPDATE deletion_requests
       SET state = 'provider_deleting', purge_command_id = $2
       WHERE id = $1`,
      [deletionRequestId, deleteCommandId],
    );

    await pool.query(
      `UPDATE workos_command_outbox SET next_attempt_at = now()
       WHERE organization_id = $1 AND state = 'queued'`,
      [seeded.organizationId],
    );
    expect(await processor.tick()).toBe(2);
    expect(provider.calls[1]).toBe(
      `organization.delete:${workosOrganizationId}`,
    );
    const states = await pool.query<{ state: string }>(
      `SELECT state FROM workos_command_outbox
       WHERE organization_id = $1 ORDER BY aggregate_revision`,
      [seeded.organizationId],
    );
    expect(states.rows).toEqual([{ state: "dead" }, { state: "succeeded" }]);
  });

  it("recovers when WorkOS accepted a membership but its response was lost", async () => {
    const seeded = await seedOrganization(
      pool,
      randomUUID().replaceAll("-", ""),
    );
    await pool.query(
      `UPDATE workos_organization_links
       SET state = 'active', workos_organization_id = $2
       WHERE organization_id = $1`,
      [seeded.organizationId, `org_${randomUUID().replaceAll("-", "")}`],
    );
    await withSystemTx(pool, (tx) =>
      enqueueWorkOSCommand(tx, {
        operation: "membership.create",
        idempotencyKey: `membership.${seeded.organizationId}.${seeded.userId}.1`,
        aggregateKey: `membership:${seeded.organizationId}:${seeded.userId}`,
        aggregateRevision: 1,
        organizationId: seeded.organizationId,
        userId: seeded.userId,
        payload: { workosUserId: seeded.workosUserId, role: "owner" },
      }),
    );
    const provider = new FakeWorkOSProvider();
    provider.failAfterNextMembershipCreate = true;
    const processor = new WorkOSCommandProcessor(pool, provider, {
      logger: { info() {}, warn() {}, error() {} },
    });

    expect(await processor.tick()).toBe(1);

    const member = await pool.query<{ workos_membership_id: string | null }>(
      `SELECT workos_membership_id FROM organization_members
       WHERE org_id = $1 AND user_id = $2`,
      [seeded.organizationId, seeded.userId],
    );
    expect(member.rows[0]?.workos_membership_id).toBe(
      provider.memberships[0]?.id,
    );
    expect(provider.memberships).toHaveLength(1);
    expect(
      provider.calls.filter((call) => call.startsWith("membership.list:")),
    ).toHaveLength(1);
  });

  it("replaces an invitation-created pending membership with an active membership", async () => {
    const seeded = await seedOrganization(
      pool,
      randomUUID().replaceAll("-", ""),
    );
    const workosOrganizationId = `org_${randomUUID().replaceAll("-", "")}`;
    const pendingMembershipId = `om_${randomUUID().replaceAll("-", "")}`;
    await pool.query(
      `UPDATE workos_organization_links
       SET state = 'active', workos_organization_id = $2
       WHERE organization_id = $1`,
      [seeded.organizationId, workosOrganizationId],
    );
    await withSystemTx(pool, (tx) =>
      enqueueWorkOSCommand(tx, {
        operation: "membership.create",
        idempotencyKey: `membership.${seeded.organizationId}.${seeded.userId}.1`,
        aggregateKey: `membership:${seeded.organizationId}:${seeded.userId}`,
        aggregateRevision: 1,
        organizationId: seeded.organizationId,
        userId: seeded.userId,
        payload: { workosUserId: seeded.workosUserId, role: "owner" },
      }),
    );
    const provider = new FakeWorkOSProvider();
    provider.memberships.push({
      id: pendingMembershipId,
      organizationId: workosOrganizationId,
      userId: seeded.workosUserId,
      status: "pending",
      directoryManaged: false,
      roleSlug: "owner",
      updatedAt: new Date().toISOString(),
    });

    expect(await new WorkOSCommandProcessor(pool, provider).tick()).toBe(1);

    const command = await pool.query<{ state: string }>(
      `SELECT state FROM workos_command_outbox
       WHERE aggregate_key = $1 AND aggregate_revision = 1`,
      [`membership:${seeded.organizationId}:${seeded.userId}`],
    );
    expect(command.rows[0]?.state).toBe("succeeded");
    expect(provider.calls).toContain(
      `membership.delete:${pendingMembershipId}`,
    );
    expect(provider.memberships).toHaveLength(1);
    expect(provider.memberships[0]).toMatchObject({
      status: "active",
      organizationId: workosOrganizationId,
      userId: seeded.workosUserId,
    });
  });

  it("does not delete a pending membership after a terminal create error", async () => {
    const seeded = await seedOrganization(
      pool,
      randomUUID().replaceAll("-", ""),
    );
    const workosOrganizationId = `org_${randomUUID().replaceAll("-", "")}`;
    const pendingMembershipId = `om_${randomUUID().replaceAll("-", "")}`;
    await pool.query(
      `UPDATE workos_organization_links
       SET state = 'active', workos_organization_id = $2
       WHERE organization_id = $1`,
      [seeded.organizationId, workosOrganizationId],
    );
    await withSystemTx(pool, (tx) =>
      enqueueWorkOSCommand(tx, {
        operation: "membership.create",
        idempotencyKey: `membership.${seeded.organizationId}.${seeded.userId}.1`,
        aggregateKey: `membership:${seeded.organizationId}:${seeded.userId}`,
        aggregateRevision: 1,
        organizationId: seeded.organizationId,
        userId: seeded.userId,
        payload: { workosUserId: seeded.workosUserId, role: "owner" },
      }),
    );
    const provider = new FakeWorkOSProvider();
    provider.memberships.push({
      id: pendingMembershipId,
      organizationId: workosOrganizationId,
      userId: seeded.workosUserId,
      status: "pending",
      directoryManaged: false,
      roleSlug: "owner",
      updatedAt: new Date().toISOString(),
    });
    provider.nextMembershipCreateFailure = {
      name: "UnauthorizedException",
      status: 401,
    };

    expect(
      await new WorkOSCommandProcessor(pool, provider, {
        logger: { info() {}, warn() {}, error() {} },
      }).tick(),
    ).toBe(1);

    const command = await pool.query<{ state: string }>(
      `SELECT state FROM workos_command_outbox
       WHERE aggregate_key = $1 AND aggregate_revision = 1`,
      [`membership:${seeded.organizationId}:${seeded.userId}`],
    );
    expect(command.rows[0]?.state).toBe("dead");
    expect(provider.memberships).toHaveLength(1);
    expect(provider.memberships[0]?.id).toBe(pendingMembershipId);
    expect(provider.calls).not.toContain(
      `membership.delete:${pendingMembershipId}`,
    );
  });

  it("serializes replacement invitations and revokes one whose provider ID was not persisted", async () => {
    const seeded = await seedOrganization(
      pool,
      randomUUID().replaceAll("-", ""),
    );
    const workosOrganizationId = `org_${randomUUID().replaceAll("-", "")}`;
    await pool.query(
      `UPDATE workos_organization_links
       SET state = 'active', workos_organization_id = $2
       WHERE organization_id = $1`,
      [seeded.organizationId, workosOrganizationId],
    );
    const oldInvitationId = randomUUID();
    const newInvitationId = randomUUID();
    const email = "replacement@example.com";
    await pool.query(
      `INSERT INTO invitations (id, org_id, email, role, token_hash, invited_by, revoked_at)
       VALUES ($1, $3, $4, 'member', $5, $2, now()),
              ($6, $3, $4, 'admin', $7, $2, NULL)`,
      [
        oldInvitationId,
        seeded.userId,
        seeded.organizationId,
        email,
        `hash-${oldInvitationId}`,
        newInvitationId,
        `hash-${newInvitationId}`,
      ],
    );
    const provider = new FakeWorkOSProvider();
    const oldProviderInvitation = {
      id: `inv_${randomUUID().replaceAll("-", "")}`,
      organizationId: workosOrganizationId,
      email,
      state: "pending",
      roleSlug: "member",
      updatedAt: new Date().toISOString(),
    } as const;
    provider.invitations.push({ ...oldProviderInvitation });
    const orderingKey = `invitation-email:${seeded.organizationId}:test`;
    await withSystemTx(pool, async (tx) => {
      await enqueueWorkOSCommand(tx, {
        operation: "invitation.revoke",
        idempotencyKey: `invitation.${oldInvitationId}.2`,
        aggregateKey: `invitation:${oldInvitationId}`,
        orderingKey,
        aggregateRevision: 2,
        organizationId: seeded.organizationId,
        payload: { localInvitationId: oldInvitationId, email, role: "member" },
      });
      await enqueueWorkOSCommand(tx, {
        operation: "invitation.create",
        idempotencyKey: `invitation.${newInvitationId}.1`,
        aggregateKey: `invitation:${newInvitationId}`,
        orderingKey,
        aggregateRevision: 1,
        organizationId: seeded.organizationId,
        payload: {
          localInvitationId: newInvitationId,
          email,
          role: "admin",
          inviterWorkosUserId: seeded.workosUserId,
        },
      });
    });

    expect(
      await ingestWorkOSManagementEvent(
        pool,
        {
          id: `event_${randomUUID().replaceAll("-", "")}`,
          event: "invitation.created",
          createdAt: oldProviderInvitation.updatedAt,
          data: {
            ...oldProviderInvitation,
            acceptedAt: null,
            revokedAt: null,
          },
        },
        "webhook",
      ),
    ).toEqual({ status: "ignored" });
    const replacementBeforeCommand = await pool.query(
      `SELECT workos_invitation_id FROM invitations WHERE id = $1`,
      [newInvitationId],
    );
    expect(replacementBeforeCommand.rows[0]?.workos_invitation_id).toBeNull();

    expect(await new WorkOSCommandProcessor(pool, provider).tick()).toBe(2);
    const providerActions = provider.calls.filter(
      (call) => !call.startsWith("invitation.list:"),
    );
    expect(providerActions[0]).toMatch(/^invitation\.revoke:/);
    expect(providerActions[1]).toBe(`invitation.create:${email}`);
    expect(provider.lastInvitationOptions).toEqual({
      organizationId: workosOrganizationId,
      email,
      roleSlug: "admin",
      inviterUserId: seeded.workosUserId,
    });
    expect(
      provider.invitations.filter((item) => item.state === "pending"),
    ).toHaveLength(1);
    expect(
      provider.invitations.find((item) => item.state === "pending")?.roleSlug,
    ).toBe("admin");
  });

  it("serializes an early exact-ID acceptance without granting local access", async () => {
    const seeded = await seedOrganization(
      pool,
      randomUUID().replaceAll("-", ""),
    );
    const workosOrganizationId = `org_${randomUUID().replaceAll("-", "")}`;
    await pool.query(
      `UPDATE workos_organization_links
       SET state = 'active', workos_organization_id = $2
       WHERE organization_id = $1`,
      [seeded.organizationId, workosOrganizationId],
    );
    const localInvitationId = randomUUID();
    const email = "fast-accept@example.com";
    await pool.query(
      `INSERT INTO invitations (
         id, org_id, email, role, token_hash, invited_by
       ) VALUES ($1, $2, $3, 'member', $4, $5)`,
      [
        localInvitationId,
        seeded.organizationId,
        email,
        `hash-${localInvitationId}`,
        seeded.userId,
      ],
    );
    await withSystemTx(pool, (tx) =>
      enqueueWorkOSCommand(tx, {
        operation: "invitation.create",
        idempotencyKey: `invitation.${localInvitationId}.1`,
        aggregateKey: `invitation:${localInvitationId}`,
        aggregateRevision: 1,
        organizationId: seeded.organizationId,
        payload: {
          localInvitationId,
          email,
          role: "member",
        },
      }),
    );

    const provider = new FakeWorkOSProvider();
    let earlyAcceptance:
      | ReturnType<typeof ingestWorkOSManagementEvent>
      | undefined;
    provider.onInvitationCreated = async (invitation) => {
      const acceptedAt = new Date(Date.now() + 1_000).toISOString();
      invitation.state = "accepted";
      invitation.updatedAt = acceptedAt;
      earlyAcceptance = ingestWorkOSManagementEvent(
        pool,
        {
          id: `event_${randomUUID().replaceAll("-", "")}`,
          event: "invitation.accepted",
          createdAt: acceptedAt,
          data: {
            ...invitation,
            acceptedAt,
            revokedAt: null,
          },
        },
        "webhook",
      );
      void earlyAcceptance.catch(() => undefined);
    };

    expect(await new WorkOSCommandProcessor(pool, provider).tick()).toBe(1);
    expect(earlyAcceptance).toBeDefined();
    await expect(earlyAcceptance!).resolves.toEqual({ status: "applied" });
    const local = await pool.query<{
      workos_invitation_id: string | null;
      accepted_at: Date | null;
      revoked_at: Date | null;
    }>(
      `SELECT workos_invitation_id, accepted_at, revoked_at
       FROM invitations WHERE id = $1`,
      [localInvitationId],
    );
    expect(local.rows[0]?.workos_invitation_id).toBe(
      provider.invitations[0]?.id,
    );
    expect(local.rows[0]?.accepted_at).toBeNull();
    expect(local.rows[0]?.revoked_at?.toISOString()).toBe(
      provider.invitations[0]?.updatedAt,
    );
  });

  it("persists a provider membership tombstone before a stale active event can restore access", async () => {
    const seeded = await seedOrganization(
      pool,
      randomUUID().replaceAll("-", ""),
    );
    const workosOrganizationId = `org_${randomUUID().replaceAll("-", "")}`;
    const membershipId = `om_${randomUUID().replaceAll("-", "")}`;
    const observedAt = new Date().toISOString();
    await pool.query(
      `UPDATE workos_organization_links
       SET state = 'active', workos_organization_id = $2
       WHERE organization_id = $1`,
      [seeded.organizationId, workosOrganizationId],
    );
    await pool.query(
      `UPDATE organization_members SET workos_membership_id = $3
       WHERE org_id = $1 AND user_id = $2`,
      [seeded.organizationId, seeded.userId, membershipId],
    );
    await pool.query(
      `INSERT INTO workos_membership_projections (
         workos_membership_id, workos_organization_id, workos_user_id,
         organization_id, user_id, status, role, last_provider_event_at
       ) VALUES ($1, $2, $3, $4, $5, 'active', 'owner', $6)`,
      [
        membershipId,
        workosOrganizationId,
        seeded.workosUserId,
        seeded.organizationId,
        seeded.userId,
        observedAt,
      ],
    );
    await withSystemTx(pool, async (tx) => {
      await enqueueWorkOSCommand(tx, {
        operation: "membership.delete",
        idempotencyKey: `membership.${seeded.organizationId}.${seeded.userId}.2`,
        aggregateKey: `membership:${seeded.organizationId}:${seeded.userId}`,
        aggregateRevision: 2,
        organizationId: seeded.organizationId,
        userId: seeded.userId,
        providerObjectId: membershipId,
        payload: { workosUserId: seeded.workosUserId, role: "owner" },
      });
      await tx.query(
        `DELETE FROM organization_members WHERE org_id = $1 AND user_id = $2`,
        [seeded.organizationId, seeded.userId],
      );
    });
    const provider = new FakeWorkOSProvider();
    provider.memberships.push({
      id: membershipId,
      organizationId: workosOrganizationId,
      userId: seeded.workosUserId,
      status: "active",
      directoryManaged: false,
      roleSlug: "owner",
      updatedAt: observedAt,
    });

    const inFlightResult = await ingestWorkOSManagementEvent(
      pool,
      {
        id: `event_${randomUUID().replaceAll("-", "")}`,
        event: "organization_membership.updated",
        createdAt: new Date(Date.now() + 500).toISOString(),
        data: {
          id: membershipId,
          organizationId: workosOrganizationId,
          userId: seeded.workosUserId,
          status: "active",
          directoryManaged: false,
          role: { slug: "owner" },
          updatedAt: new Date(Date.now() + 500).toISOString(),
        },
      },
      "webhook",
    );
    expect(inFlightResult).toEqual({ status: "applied" });
    const whileDeleteIsPending = await pool.query(
      `SELECT 1 FROM organization_members WHERE org_id = $1 AND user_id = $2`,
      [seeded.organizationId, seeded.userId],
    );
    expect(whileDeleteIsPending.rowCount).toBe(0);

    expect(await new WorkOSCommandProcessor(pool, provider).tick()).toBe(1);

    const staleResult = await ingestWorkOSManagementEvent(
      pool,
      {
        id: `event_${randomUUID().replaceAll("-", "")}`,
        event: "organization_membership.updated",
        createdAt: new Date(Date.now() + 1_000).toISOString(),
        data: {
          id: membershipId,
          organizationId: workosOrganizationId,
          userId: seeded.workosUserId,
          status: "active",
          directoryManaged: false,
          role: { slug: "owner" },
          updatedAt: new Date(Date.now() + 1_000).toISOString(),
        },
      },
      "webhook",
    );
    expect(staleResult).toEqual({ status: "ignored" });
    const membership = await pool.query(
      `SELECT 1 FROM organization_members WHERE org_id = $1 AND user_id = $2`,
      [seeded.organizationId, seeded.userId],
    );
    expect(membership.rowCount).toBe(0);
  });

  it("deletes every provider membership discovered after a stale ID was captured", async () => {
    const seeded = await seedOrganization(
      pool,
      randomUUID().replaceAll("-", ""),
    );
    const workosOrganizationId = `org_${randomUUID().replaceAll("-", "")}`;
    const capturedMembershipId = `om_${randomUUID().replaceAll("-", "")}`;
    const replacementMembershipId = `om_${randomUUID().replaceAll("-", "")}`;
    await pool.query(
      `UPDATE workos_organization_links
       SET state = 'active', workos_organization_id = $2
       WHERE organization_id = $1`,
      [seeded.organizationId, workosOrganizationId],
    );
    await withSystemTx(pool, (tx) =>
      enqueueWorkOSCommand(tx, {
        operation: "membership.delete",
        idempotencyKey: `membership.${seeded.organizationId}.${seeded.userId}.2`,
        aggregateKey: `membership:${seeded.organizationId}:${seeded.userId}`,
        aggregateRevision: 2,
        organizationId: seeded.organizationId,
        userId: seeded.userId,
        providerObjectId: capturedMembershipId,
        payload: { workosUserId: seeded.workosUserId, role: "owner" },
      }),
    );
    const provider = new FakeWorkOSProvider();
    for (const [id, status] of [
      [capturedMembershipId, "active"],
      [replacementMembershipId, "pending"],
    ] as const) {
      provider.memberships.push({
        id,
        organizationId: workosOrganizationId,
        userId: seeded.workosUserId,
        status,
        directoryManaged: false,
        roleSlug: "owner",
        updatedAt: new Date().toISOString(),
      });
    }

    expect(await new WorkOSCommandProcessor(pool, provider).tick()).toBe(1);
    expect(provider.calls).toContain(`membership.list:${workosOrganizationId}`);
    expect(
      provider.calls.filter((call) => call.startsWith("membership.delete:")),
    ).toEqual([
      `membership.delete:${capturedMembershipId}`,
      `membership.delete:${replacementMembershipId}`,
    ]);
    expect(provider.memberships).toHaveLength(0);
  });

  it("deletes a captured membership while its organization link is not ready", async () => {
    const seeded = await seedOrganization(
      pool,
      randomUUID().replaceAll("-", ""),
    );
    const capturedMembershipId = `om_${randomUUID().replaceAll("-", "")}`;
    await withSystemTx(pool, (tx) =>
      enqueueWorkOSCommand(tx, {
        operation: "membership.delete",
        idempotencyKey: `membership.${seeded.organizationId}.${seeded.userId}.2`,
        aggregateKey: `membership:${seeded.organizationId}:${seeded.userId}`,
        aggregateRevision: 2,
        organizationId: seeded.organizationId,
        userId: seeded.userId,
        providerObjectId: capturedMembershipId,
        payload: { workosUserId: seeded.workosUserId, role: "owner" },
      }),
    );
    const provider = new FakeWorkOSProvider();
    const processor = new WorkOSCommandProcessor(pool, provider, {
      logger: { info() {}, warn() {}, error() {} },
    });

    expect(await processor.tick()).toBe(1);
    expect(provider.calls).toContain(
      `membership.delete:${capturedMembershipId}`,
    );
    expect(
      provider.calls.some((call) => call.startsWith("membership.list:")),
    ).toBe(false);
    const command = await pool.query<{ state: string }>(
      `SELECT state FROM workos_command_outbox
       WHERE aggregate_key = $1 AND aggregate_revision = 2`,
      [`membership:${seeded.organizationId}:${seeded.userId}`],
    );
    expect(command.rows[0]?.state).toBe("succeeded");
  });

  it("revokes every pending provider invitation even when one exact ID was captured", async () => {
    const seeded = await seedOrganization(
      pool,
      randomUUID().replaceAll("-", ""),
    );
    const workosOrganizationId = `org_${randomUUID().replaceAll("-", "")}`;
    const localInvitationId = randomUUID();
    const email = "duplicate-pending@example.com";
    await pool.query(
      `UPDATE workos_organization_links
       SET state = 'active', workos_organization_id = $2
       WHERE organization_id = $1`,
      [seeded.organizationId, workosOrganizationId],
    );
    await pool.query(
      `INSERT INTO invitations (
         id, org_id, email, role, token_hash, invited_by, revoked_at
       ) VALUES ($1, $2, $3, 'member', $4, $5, now())`,
      [
        localInvitationId,
        seeded.organizationId,
        email,
        `hash-${localInvitationId}`,
        seeded.userId,
      ],
    );
    const provider = new FakeWorkOSProvider();
    const providerInvitationIds = [
      `inv_${randomUUID().replaceAll("-", "")}`,
      `inv_${randomUUID().replaceAll("-", "")}`,
    ];
    for (const id of providerInvitationIds) {
      provider.invitations.push({
        id,
        organizationId: workosOrganizationId,
        email,
        state: "pending",
        roleSlug: "member",
        updatedAt: new Date().toISOString(),
      });
    }
    await withSystemTx(pool, (tx) =>
      enqueueWorkOSCommand(tx, {
        operation: "invitation.revoke",
        idempotencyKey: `invitation.${localInvitationId}.2`,
        aggregateKey: `invitation:${localInvitationId}`,
        aggregateRevision: 2,
        organizationId: seeded.organizationId,
        providerObjectId: providerInvitationIds[0],
        payload: { localInvitationId, email, role: "member" },
      }),
    );

    expect(await new WorkOSCommandProcessor(pool, provider).tick()).toBe(1);
    expect(provider.calls).toContain(`invitation.list:${email}`);
    expect(
      provider.calls.filter((call) => call.startsWith("invitation.revoke:")),
    ).toEqual(providerInvitationIds.map((id) => `invitation.revoke:${id}`));
    expect(
      provider.invitations.filter(
        (invitation) => invitation.state === "pending",
      ),
    ).toHaveLength(0);
  });

  it("converges when an invitation is accepted between listing and revocation", async () => {
    const seeded = await seedOrganization(
      pool,
      randomUUID().replaceAll("-", ""),
    );
    const workosOrganizationId = `org_${randomUUID().replaceAll("-", "")}`;
    const localInvitationId = randomUUID();
    const providerInvitationId = `inv_${randomUUID().replaceAll("-", "")}`;
    const providerMembershipId = `om_${randomUUID().replaceAll("-", "")}`;
    const email = "accept-race@example.com";
    const orderingKey = `invitation-email:${seeded.organizationId}:race`;
    await pool.query(
      `UPDATE workos_organization_links
       SET state = 'active', workos_organization_id = $2
       WHERE organization_id = $1`,
      [seeded.organizationId, workosOrganizationId],
    );
    await pool.query(
      `INSERT INTO invitations (
         id, org_id, email, role, token_hash, invited_by, revoked_at,
         workos_invitation_id, workos_sync_revision
       ) VALUES ($1, $2, $3, 'member', $4, $5, now(), $6, 2)`,
      [
        localInvitationId,
        seeded.organizationId,
        email,
        `hash-${localInvitationId}`,
        seeded.userId,
        providerInvitationId,
      ],
    );
    await withSystemTx(pool, async (tx) => {
      await enqueueWorkOSCommand(tx, {
        operation: "invitation.revoke",
        idempotencyKey: `invitation.${localInvitationId}.2`,
        aggregateKey: `invitation:${localInvitationId}`,
        orderingKey,
        aggregateRevision: 2,
        organizationId: seeded.organizationId,
        providerObjectId: providerInvitationId,
        payload: { localInvitationId, email, role: "member" },
      });
      await enqueueWorkOSCommand(tx, {
        operation: "membership.delete",
        idempotencyKey: `membership.${seeded.organizationId}.${seeded.userId}.2`,
        aggregateKey: `membership:${seeded.organizationId}:${seeded.userId}`,
        orderingKey,
        aggregateRevision: 2,
        organizationId: seeded.organizationId,
        userId: seeded.userId,
        providerObjectId: providerMembershipId,
        payload: { workosUserId: seeded.workosUserId, role: "owner" },
      });
    });
    const provider = new FakeWorkOSProvider();
    provider.invitations.push({
      id: providerInvitationId,
      organizationId: workosOrganizationId,
      email,
      state: "pending",
      roleSlug: "member",
      updatedAt: new Date().toISOString(),
    });
    provider.memberships.push({
      id: providerMembershipId,
      organizationId: workosOrganizationId,
      userId: seeded.workosUserId,
      status: "active",
      directoryManaged: false,
      roleSlug: "owner",
      updatedAt: new Date().toISOString(),
    });
    provider.acceptBeforeNextInvitationRevoke = true;
    const processor = new WorkOSCommandProcessor(pool, provider, {
      logger: { info() {}, warn() {}, error() {} },
    });

    expect(await processor.tick()).toBe(2);
    const states = await pool.query<{ operation: string; state: string }>(
      `SELECT operation, state FROM workos_command_outbox
       WHERE ordering_key = $1 ORDER BY sequence`,
      [orderingKey],
    );
    expect(states.rows).toEqual([
      { operation: "invitation.revoke", state: "succeeded" },
      { operation: "membership.delete", state: "succeeded" },
    ]);
    expect(provider.invitations[0]?.state).toBe("accepted");
    expect(provider.memberships).toHaveLength(0);
  });

  it("does not treat an absent invitation after a forbidden revoke as converged", async () => {
    const seeded = await seedOrganization(
      pool,
      randomUUID().replaceAll("-", ""),
    );
    const workosOrganizationId = `org_${randomUUID().replaceAll("-", "")}`;
    const localInvitationId = randomUUID();
    const providerInvitationId = `inv_${randomUUID().replaceAll("-", "")}`;
    const email = "forbidden-revoke@example.com";
    await pool.query(
      `UPDATE workos_organization_links
       SET state = 'active', workos_organization_id = $2
       WHERE organization_id = $1`,
      [seeded.organizationId, workosOrganizationId],
    );
    await withSystemTx(pool, (tx) =>
      enqueueWorkOSCommand(tx, {
        operation: "invitation.revoke",
        idempotencyKey: `invitation.${localInvitationId}.2`,
        aggregateKey: `invitation:${localInvitationId}`,
        aggregateRevision: 2,
        organizationId: seeded.organizationId,
        providerObjectId: providerInvitationId,
        payload: { localInvitationId, email, role: "member" },
      }),
    );
    const provider = new FakeWorkOSProvider();
    provider.missingInvitationStatus = 403;
    const processor = new WorkOSCommandProcessor(pool, provider, {
      logger: { info() {}, warn() {}, error() {} },
    });

    expect(await processor.tick()).toBe(1);
    const command = await pool.query<{ state: string }>(
      `SELECT state FROM workos_command_outbox
       WHERE aggregate_key = $1 AND aggregate_revision = 2`,
      [`invitation:${localInvitationId}`],
    );
    expect(command.rows[0]?.state).toBe("dead");
  });
});

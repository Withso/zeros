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
  readonly memberships: WorkOSMembershipRecord[] = [];
  readonly invitations: WorkOSInvitationRecord[] = [];
  onInvitationCreated:
    | ((invitation: WorkOSInvitationRecord) => Promise<void>)
    | null = null;

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
      const failure = new Error("response lost after provider accepted") as Error & {
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
        membership.userId === options.userId &&
        membership.status === "active",
    );
  }

  async sendInvitation(options: {
    organizationId: string;
    email: string;
    roleSlug: string;
  }): Promise<WorkOSInvitationRecord> {
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

  async revokeInvitation(invitationId: string): Promise<WorkOSInvitationRecord> {
    this.calls.push(`invitation.revoke:${invitationId}`);
    const invitation = this.invitations.find((item) => item.id === invitationId);
    if (!invitation) {
      const missing = new Error("invitation missing") as Error & { status: number };
      missing.status = 404;
      throw missing;
    }
    invitation.state = "revoked";
    invitation.updatedAt = new Date().toISOString();
    return invitation;
  }

  async revokeSession(): Promise<void> {}
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

d("WorkOS command outbox", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 4 });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool);
  });

  afterAll(async () => pool.end());

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
    expect(provider.calls.map((call) => call.slice(0, call.indexOf(":")))).toEqual(
      ["organization.create", "membership.create"],
    );
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
    expect(states.rows).toEqual([{ state: "succeeded" }, { state: "succeeded" }]);
  });

  it("does not let a later delete overtake a retrying create", async () => {
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
        operation: "organization.delete",
        idempotencyKey: `organization.${seeded.organizationId}.2`,
        aggregateKey: `organization:${seeded.organizationId}`,
        aggregateRevision: 2,
        organizationId: seeded.organizationId,
        payload: {},
      });
    });
    const provider = new FakeWorkOSProvider();
    provider.failNextOrganizationCreate = true;
    const processor = new WorkOSCommandProcessor(pool, provider, {
      logger: { info() {}, warn() {}, error() {} },
    });
    expect(await processor.tick()).toBe(1);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]).toMatch(/^organization\.create:/);

    await pool.query(
      `UPDATE workos_command_outbox SET next_attempt_at = now()
       WHERE organization_id = $1 AND state = 'queued'`,
      [seeded.organizationId],
    );
    expect(await processor.tick()).toBe(2);
    expect(provider.calls[1]).toMatch(/^organization\.create:/);
    expect(provider.calls[2]).toMatch(/^organization\.delete:/);
    const states = await pool.query<{ state: string }>(
      `SELECT state FROM workos_command_outbox
       WHERE organization_id = $1 ORDER BY aggregate_revision`,
      [seeded.organizationId],
    );
    expect(states.rows).toEqual([{ state: "succeeded" }, { state: "succeeded" }]);
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
    await pool.query(
      `UPDATE workos_command_outbox SET next_attempt_at = now()
       WHERE organization_id = $1 AND state = 'queued'`,
      [seeded.organizationId],
    );
    expect(await processor.tick()).toBe(1);

    const member = await pool.query<{ workos_membership_id: string | null }>(
      `SELECT workos_membership_id FROM organization_members
       WHERE org_id = $1 AND user_id = $2`,
      [seeded.organizationId, seeded.userId],
    );
    expect(member.rows[0]?.workos_membership_id).toBe(provider.memberships[0]?.id);
    expect(provider.memberships).toHaveLength(1);
    expect(provider.calls.filter((call) => call.startsWith("membership.list:"))).toHaveLength(1);
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
        payload: { localInvitationId: newInvitationId, email, role: "admin" },
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
    expect(provider.invitations.filter((item) => item.state === "pending")).toHaveLength(1);
    expect(provider.invitations.find((item) => item.state === "pending")?.roleSlug).toBe("admin");
  });

  it("replays an exact-ID invitation event that arrived before provider correlation committed", async () => {
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
    provider.onInvitationCreated = async (invitation) => {
      const acceptedAt = new Date(Date.now() + 1_000).toISOString();
      invitation.state = "accepted";
      invitation.updatedAt = acceptedAt;
      expect(
        await ingestWorkOSManagementEvent(
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
        ),
      ).toEqual({ status: "ignored" });
    };

    expect(await new WorkOSCommandProcessor(pool, provider).tick()).toBe(1);
    const local = await pool.query<{
      workos_invitation_id: string | null;
      accepted_at: Date | null;
    }>(
      `SELECT workos_invitation_id, accepted_at
       FROM invitations WHERE id = $1`,
      [localInvitationId],
    );
    expect(local.rows[0]?.workos_invitation_id).toBe(
      provider.invitations[0]?.id,
    );
    expect(local.rows[0]?.accepted_at?.toISOString()).toBe(
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
});

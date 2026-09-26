import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureUser } from "../auth.js";
import { withSystemTx, withUserTx } from "../db.js";
import { runMigrations } from "../migrate.js";
import {
  authorizeCloudWorkspaceActor,
  DatabaseCloudWorkspaceCollaborationService,
} from "./actors.js";
import { seedReadyProCloudWorkspace } from "./test-fixtures.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
d("Pro workspace sharing", () => {
  let pool: pg.Pool,
    service: DatabaseCloudWorkspaceCollaborationService,
    fixture: Awaited<ReturnType<typeof seedReadyProCloudWorkspace>>;
  beforeAll(() => {
    pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 6,
    });
    service = new DatabaseCloudWorkspaceCollaborationService(pool);
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await runMigrations(pool);
    fixture = await seedReadyProCloudWorkspace(pool);
  });
  const scope = () => ({
    workspaceId: fixture.workspaceId,
    organizationId: fixture.organizationId,
    actorUserId: fixture.userId,
  });
  async function account(pro = true) {
    const email = `collaborator-${randomUUID()}@example.test`;
    const user = await ensureUser(pool, {
      provider: "workos",
      providerSubject: `user_${randomUUID()}`,
      email,
      displayName: "Collaborator",
    });
    if (pro)
      await pool.query(
        "INSERT INTO account_entitlements(user_id,plan,status,cloud_workspaces_allowed,source) VALUES($1,'pro','active',true,'operator')",
        [user.id],
      );
    return { user, email };
  }
  const access = (
    userId: string,
    capability: "read" | "run" | "edit" | "manage" = "read",
  ) =>
    withSystemTx(pool, (tx) =>
      authorizeCloudWorkspaceActor(tx, {
        ...scope(),
        actorUserId: userId,
        capability,
      }),
    );
  it("lets 25 Pro Organization members read, but requires explicit writer assignments including for administrators", async () => {
    const members = [];
    for (let n = 0; n < 24; n++) {
      const { user } = await account();
      members.push(user.id);
      await pool.query(
        "INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,$3)",
        [fixture.organizationId, user.id, n === 0 ? "admin" : "member"],
      );
    }
    for (const userId of members)
      await expect(access(userId)).resolves.toMatchObject({ role: "viewer" });
    await expect(access(members[0]!, "manage")).rejects.toMatchObject({
      status: 403,
    });
    for (const userId of members.slice(0, 9))
      await service.setRole({ ...scope(), userId, role: "developer" });
    await expect(
      service.setRole({ ...scope(), userId: members[9]!, role: "developer" }),
    ).rejects.toMatchObject({ code: "cloud_workspace_writer_limit" });
    expect((await service.list(scope())).writers).toEqual({
      limit: 10,
      used: 10,
      available: 0,
    });
    await expect(access(members[9]!, "run")).rejects.toMatchObject({
      status: 403,
    });
    await service.setRole({ ...scope(), userId: members[0]!, role: "viewer" });
    await expect(access(members[0]!, "edit")).rejects.toMatchObject({
      status: 403,
    });
    await service.setRole({
      ...scope(),
      userId: members[9]!,
      role: "developer",
    });
  });
  it("reserves the last slot atomically across concurrent invitations and releases expired reservations", async () => {
    for (let n = 0; n < 8; n++)
      await service.invite({
        ...scope(),
        email: `writer-${n}@example.test`,
        role: "developer",
      });
    const results = await Promise.allSettled([
      service.invite({
        ...scope(),
        email: "last-a@example.test",
        role: "developer",
      }),
      service.invite({
        ...scope(),
        email: "last-b@example.test",
        role: "prompter",
      }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === "rejected"),
    ).toMatchObject({ reason: { code: "cloud_workspace_writer_limit" } });
    await service.invite({
      ...scope(),
      email: "viewer@example.test",
      role: "viewer",
    });
    await pool.query(
      "UPDATE cloud_workspace_invitations SET expires_at=clock_timestamp() WHERE workspace_id=$1",
      [fixture.workspaceId],
    );
    await service.invite({
      ...scope(),
      email: "new-writer@example.test",
      role: "developer",
    });
    expect((await service.list(scope())).writers?.used).toBe(2);
  });
  it("requires Pro for guests, preserves the sponsor, and revokes Write after downgrade or Pro expiry", async () => {
    const { user, email } = await account(false);
    const invitation = await service.invite({
      ...scope(),
      email,
      role: "developer",
    });
    const accept = () =>
      service.accept({
        actorUserId: user.id,
        identity: user.identity,
        token: invitation.token!,
      });
    await expect(accept()).rejects.toMatchObject({ status: 404 });
    await pool.query(
      "INSERT INTO account_entitlements(user_id,plan,status,cloud_workspaces_allowed,source) VALUES($1,'pro','active',true,'operator')",
      [user.id],
    );
    await accept();
    await accept();
    await expect(access(user.id, "edit")).resolves.toMatchObject({
      role: "developer",
      sponsorUserId: fixture.userId,
    });
    expect(
      (
        await pool.query(
          "SELECT 1 FROM organization_members WHERE org_id=$1 AND user_id=$2",
          [fixture.organizationId, user.id],
        )
      ).rowCount,
    ).toBe(0);
    const before = await access(user.id);
    await service.setRole({ ...scope(), userId: user.id, role: "viewer" });
    expect((await access(user.id)).fingerprint).not.toBe(before.fingerprint);
    await expect(access(user.id, "run")).rejects.toMatchObject({ status: 403 });
    await service.setRole({ ...scope(), userId: user.id, role: "developer" });
    await pool.query(
      "UPDATE account_entitlements SET status='expired',revision=revision+1 WHERE user_id=$1",
      [user.id],
    );
    await expect(access(user.id)).rejects.toMatchObject({ status: 404 });
    expect((await service.list(scope())).writers?.used).toBe(2);
    expect(
      (
        await pool.query(
          "SELECT 1 FROM managed_compute_user_periods WHERE user_id=$1",
          [user.id],
        )
      ).rowCount,
    ).toBe(0);
  });
  it("lists more than 100 Read-only guests with bounded, complete pagination", async () => {
    for (let n = 0; n < 101; n++) {
      const { user, email } = await account();
      const invitation = await service.invite({
        ...scope(),
        email,
        role: "viewer",
      });
      await service.accept({
        actorUserId: user.id,
        identity: user.identity,
        token: invitation.token!,
      });
    }
    const first = await service.list(scope());
    expect(first.guests).toHaveLength(100);
    expect(first.guestCursor).toBeTruthy();
    const second = await service.list({
      ...scope(),
      guestCursor: first.guestCursor!,
    });
    expect(second.guests).toHaveLength(1);
    expect(second.guestCursor).toBeNull();
    expect(
      new Set([...first.guests, ...second.guests].map((guest) => guest.userId))
        .size,
    ).toBe(101);
    expect(second.writers?.used).toBe(1);
  });
  it("deduplicates verified aliases, revokes superseded invitations, and releases expired guest slots", async () => {
    const { user, email } = await account();
    const alias = `alias-${randomUUID()}@example.test`;
    await pool.query(
      `INSERT INTO user_identities(user_id,provider,provider_sub,email_at_link,email_verified_at)
      VALUES($1,'auth0',$2,$3,clock_timestamp())`,
      [user.id, randomUUID(), alias],
    );
    const first = await service.invite({
      ...scope(),
      email,
      role: "developer",
    });
    const second = await service.invite({
      ...scope(),
      email: alias,
      role: "developer",
    });
    expect((await service.list(scope())).writers?.used).toBe(2);
    await expect(
      service.accept({
        actorUserId: user.id,
        identity: user.identity,
        token: first.token!,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await service.revokeInvitation({ ...scope(), invitationId: second.id });
    expect((await service.list(scope())).writers?.used).toBe(1);
    const invited = await service.invite({
      ...scope(),
      email,
      role: "developer",
    });
    await service.accept({
      actorUserId: user.id,
      identity: user.identity,
      token: invited.token!,
    });
    await pool.query(
      "UPDATE cloud_workspace_guest_grants SET expires_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=$2",
      [fixture.workspaceId, user.id],
    );
    expect((await service.list(scope())).writers?.used).toBe(1);
  });
  it("does not revive stale guest access or pending invitations after an Organization member leaves", async () => {
    const { user, email } = await account();
    const invitation = await service.invite({
      ...scope(),
      email,
      role: "developer",
    });
    await service.accept({
      actorUserId: user.id,
      identity: user.identity,
      token: invitation.token!,
    });
    await pool.query(
      "INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'member')",
      [fixture.organizationId, user.id],
    );
    await service.setRole({ ...scope(), userId: user.id, role: "developer" });
    const pending = await service.invite({ ...scope(), email, role: "viewer" });
    await withUserTx(pool, fixture.userId, (tx) =>
      tx.query(
        "DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2",
        [fixture.organizationId, user.id],
      ),
    );
    await expect(access(user.id)).rejects.toMatchObject({ status: 404 });
    await expect(
      service.accept({
        actorUserId: user.id,
        identity: user.identity,
        token: pending.token!,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("keeps an Organization member's invitation access bounded by its grant and cannot revive a prior writer role", async () => {
    const { user, email } = await account();
    await pool.query(
      "INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'member')",
      [fixture.organizationId, user.id],
    );
    await service.setRole({ ...scope(), userId: user.id, role: "developer" });
    const accept = async (role: "viewer" | "developer") => {
      const invitation = await service.invite({ ...scope(), email, role });
      await service.accept({ actorUserId: user.id, identity: user.identity, token: invitation.token! });
    };
    await accept("viewer");
    await expect(access(user.id, "run")).rejects.toMatchObject({ status: 403 });
    await accept("developer");
    await expect(access(user.id, "edit")).resolves.toMatchObject({ role: "developer" });
    expect((await service.list(scope())).writers?.used).toBe(2);
    await pool.query(
      "UPDATE cloud_workspace_guest_grants SET expires_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=$2 AND revoked_at IS NULL",
      [fixture.workspaceId, user.id],
    );
    await expect(access(user.id, "edit")).rejects.toMatchObject({ status: 403 });
    expect((await service.list(scope())).writers?.used).toBe(1);
    await service.setSharing({ ...scope(), sharingMode: "private", expectedRevision: (await service.list(scope())).accessRevision });
    await expect(access(user.id)).rejects.toMatchObject({ status: 404 });
  });
  it("keeps direct assignments private and each workspace's ten-slot limit independent", async () => {
    const { user } = await account();
    await pool.query(
      "INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'admin')",
      [fixture.organizationId, user.id],
    );
    const revision = (await service.list(scope())).accessRevision;
    await service.setSharing({
      ...scope(),
      sharingMode: "private",
      expectedRevision: revision,
    });
    await expect(access(user.id)).rejects.toMatchObject({ status: 404 });
    await service.setRole({ ...scope(), userId: user.id, role: "developer" });
    await expect(access(user.id, "edit")).resolves.toMatchObject({
      role: "developer",
    });
    const other = await seedReadyProCloudWorkspace(pool, {
      ownerUserId: fixture.userId,
    });
    expect(
      (
        await service.list({
          ...scope(),
          workspaceId: other.workspaceId,
          organizationId: other.organizationId,
        })
      ).writers,
    ).toEqual({ limit: 10, used: 1, available: 9 });
  });
});

/** S-3 revocation producer with PostgreSQL: 0158 writes a security event in
 * the committing transaction of every epoch bump (under zeros_app in user and
 * system context), the client feed never returns it, and realtime turns it
 * into an `auth.epochs` push through the real feed. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { withSystemTx, withUserTx, type Tx } from "../db.js";
import { ensureUser } from "../auth.js";
import { listSecurityEvents, publishPendingSecurityEvents } from "../security-events.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { seedReadyProCloudWorkspace, type ReadyCloudWorkspaceFixture } from "../cloud-workspaces/test-fixtures.js";
import { CapabilityRevocationPush, DatabaseCapabilityRevocationSource } from "./capability-revocation-push.js";
import { DatabaseRealtimeSecurityEventFeed, DatabaseSecurityEventSource } from "./security-event-feed.js";
import type { UplinkAuthDelta } from "./uplink-protocol.js";

const url = process.env.TEST_DATABASE_URL, d = url ? describe : describe.skip;

d("capability epoch events with PostgreSQL", () => {
  let pool: pg.Pool, fixture: ReadyCloudWorkspaceFixture, member: string;
  beforeEach(async () => {
    pool = new pg.Pool({ connectionString: url, max: 4 });
    await resetMigratedTestDatabase(pool);
    fixture = await seedReadyProCloudWorkspace(pool);
    member = randomUUID();
    await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'Member')", [member, `${member}@example.test`]);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'member')", [fixture.organizationId, member]);
    await pool.query("INSERT INTO cloud_workspace_members(workspace_id,org_id,user_id,role) VALUES($1,$2,$3,'developer')",
      [fixture.workspaceId, fixture.organizationId, member]);
  });
  afterAll(async () => { await pool?.end(); });

  type Row = { kind: string; user_id: string | null; org_id: string | null; workspace_id: string | null; payload: Record<string, unknown>; ttl: number };
  const marker = async () => Number((await pool.query<{ s: string }>("SELECT coalesce(max(sequence),0) AS s FROM security_events")).rows[0]!.s);
  const eventsSince = async (after: number) => (await pool.query<Row>(`SELECT kind::text, user_id, org_id, workspace_id, payload,
      extract(epoch FROM expires_at - created_at)::int AS ttl
    FROM security_events WHERE sequence > $1 AND kind::text = 'capability.epochs_changed' ORDER BY sequence`, [after])).rows;
  const asUser = (userId: string, statement: string, values: unknown[]) => withUserTx(pool, userId, (tx: Tx) => tx.query(statement, values));
  const asSystem = (statement: string, values: unknown[]) => withSystemTx(pool, (tx: Tx) => tx.query(statement, values));

  it("writes wa and wr events with the workspace in the payload, and nothing for a no-op write", async () => {
    let after = await marker();
    await asSystem("UPDATE cloud_workspaces SET authority_epoch=authority_epoch+1 WHERE id=$1", [fixture.workspaceId]);
    expect(await eventsSince(after)).toEqual([{ kind: "capability.epochs_changed", user_id: null, org_id: fixture.organizationId,
      workspace_id: null, payload: { epoch: "wa", workspaceId: fixture.workspaceId }, ttl: 3600 }]);
    after = await marker();
    await asSystem("UPDATE cloud_workspaces SET access_revision=access_revision+1 WHERE id=$1", [fixture.workspaceId]);
    expect((await eventsSince(after)).map(row => row.payload)).toEqual([{ epoch: "wr", workspaceId: fixture.workspaceId }]);
    after = await marker();
    await asSystem("UPDATE cloud_workspaces SET authority_epoch=authority_epoch, access_revision=access_revision WHERE id=$1", [fixture.workspaceId]);
    expect(await eventsSince(after)).toEqual([]);
  });

  it("writes an me event in the transaction of a role change made in user context", async () => {
    const after = await marker();
    await asUser(fixture.userId, "UPDATE organization_members SET role='admin' WHERE org_id=$1 AND user_id=$2", [fixture.organizationId, member]);
    expect((await eventsSince(after)).map(row => [row.user_id, row.org_id, row.payload])).toEqual([[member, fixture.organizationId, { epoch: "me" }]]);
    // A rolled-back change leaves neither the bump nor the event.
    const before = await marker();
    await expect(withUserTx(pool, fixture.userId, async tx => {
      await tx.query("UPDATE organization_members SET role='member' WHERE org_id=$1 AND user_id=$2", [fixture.organizationId, member]);
      throw new Error("abort");
    })).rejects.toThrow("abort");
    expect(await eventsSince(before)).toEqual([]);
  });

  it("writes ac and dk events for account and device changes", async () => {
    const publicKey = randomBytes(32);
    const device = (await pool.query<{ id: string }>(
      "INSERT INTO devices(user_id,label,platform,public_key,key_fingerprint) VALUES($1,'S3','macos',$2,$3) RETURNING id",
      [member, publicKey, createHash("sha256").update(publicKey).digest()])).rows[0]!.id;
    const after = await marker();
    await asSystem("UPDATE users SET auth_revision=auth_revision+1 WHERE id=$1", [member]);
    await asSystem("UPDATE devices SET key_version=key_version+1 WHERE id=$1", [device]);
    await asSystem("UPDATE devices SET trust_state='revoked', revoked_at=clock_timestamp() WHERE id=$1", [device]);
    await asSystem("UPDATE devices SET label='renamed' WHERE id=$1", [device]);
    expect((await eventsSince(after)).map(row => [row.user_id, row.payload])).toEqual([
      [member, { epoch: "ac" }], [member, { epoch: "dk", deviceId: device }], [member, { epoch: "dk", deviceId: device }]]);
  });

  it("never returns the event on a client security feed", async () => {
    const suffix = randomUUID(), now = Math.floor(Date.now() / 1000);
    const user = await ensureUser(pool, { provider: "workos", providerSubject: `user_cap_${suffix}`, email: `cap-${suffix}@example.test`,
      displayName: "Cap", session: { id: `session_${suffix}`, clientKind: "desktop", authTime: now, tokenExpiresAt: now + 300 } });
    await pool.query(`INSERT INTO auth_sessions(provider_session_id,provider_sub,user_id,client_kind,last_token_expires_at)
      VALUES ($1,$2,$3,'desktop',now()+interval '5 minutes')`, [user.authentication.sessionId, user.identity.subject, user.id]);
    const org = (await pool.query("SELECT id FROM organizations WHERE created_by=$1 AND is_personal", [user.id])).rows[0].id;
    // An organization event the same user does receive proves the feed is live.
    await pool.query("INSERT INTO security_events(kind,org_id) VALUES ('organization.data_changed',$1)", [org]);
    // An me bump (not ac: a raised auth_revision ends this identity's feed).
    await asSystem("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'member')", [fixture.organizationId, user.id]);
    await publishPendingSecurityEvents(pool);
    expect(Number((await pool.query(`SELECT count(*) AS n FROM security_events
      WHERE kind::text='capability.epochs_changed' AND user_id=$1 AND delivery_sequence IS NOT NULL`, [user.id])).rows[0].n)).toBeGreaterThan(0);
    const events = await listSecurityEvents(pool, user, 0);
    expect(events.map(event => event.kind)).toContain("organization.data_changed");
    expect(events.some(event => event.kind === "capability.epochs_changed")).toBe(false);
  });

  it("maps events to the workspaces a user has or recently lost", async () => {
    const source = new DatabaseCapabilityRevocationSource(pool);
    const other = randomUUID();
    await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'Other')", [other, `${other}@example.test`]);
    expect(await source.workspacesForUser(member, fixture.organizationId, [fixture.workspaceId])).toEqual([fixture.workspaceId]);
    expect(await source.workspacesForUser(other, null, [fixture.workspaceId])).toEqual([]);
    expect(await source.workspacesForUser(member, randomUUID(), [fixture.workspaceId])).toEqual([]);
    await pool.query("DELETE FROM cloud_workspace_members WHERE workspace_id=$1 AND user_id=$2", [fixture.workspaceId, member]);
    await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [fixture.organizationId, member]);
    expect(await source.workspacesForUser(member, fixture.organizationId, [fixture.workspaceId])).toEqual([fixture.workspaceId]);
  });

  it("pushes the raised epoch to the owning uplink through the real feed, timed from created_at", async () => {
    const feed = new DatabaseRealtimeSecurityEventFeed(new DatabaseSecurityEventSource(pool));
    await feed.start();
    const pushes: Array<{ workspaceId: string; delta: UplinkAuthDelta; createdAtMs: number }> = [];
    const identity = { workspaceId: fixture.workspaceId, organizationId: fixture.organizationId, generation: 1,
      engineInstanceId: fixture.engineInstanceId, bootId: randomUUID() };
    const snapshot = vi.fn(async () => {
      const row = (await pool.query<{ wa: string; wr: string }>("SELECT authority_epoch AS wa, access_revision AS wr FROM cloud_workspaces WHERE id=$1",
        [fixture.workspaceId])).rows[0]!;
      return { epochs: { wa: Number(row.wa), wr: Number(row.wr) }, revocations: [], authCursor: "t1", complete: true };
    });
    const push = new CapabilityRevocationPush({
      feed, source: new DatabaseCapabilityRevocationSource(pool),
      flags: { enabled: (_org, flag) => flag === "capabilities", anyEnabled: flag => flag === "capabilities" },
      uplink: () => ({ server: { ownedEngineInstances: () => [identity.engineInstanceId], session: () => ({ identity }),
        pushAuthEpochs: (workspaceId, delta, createdAtMs) => { pushes.push({ workspaceId, delta, createdAtMs }); } }, auth: { snapshot } }),
      deviceStreams: () => null, logger: { warn: vi.fn() },
    });
    try {
      const before = Date.now();
      await asSystem("UPDATE cloud_workspaces SET authority_epoch=authority_epoch+1 WHERE id=$1", [fixture.workspaceId]);
      const wa = Number((await pool.query<{ wa: string }>("SELECT authority_epoch AS wa FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0]!.wa);
      feed.wake();
      await feed.settled();
      await push.settled();
      expect(pushes).toHaveLength(1);
      expect(pushes[0]).toMatchObject({ workspaceId: fixture.workspaceId, delta: { epochs: { wa } } });
      expect(pushes[0]!.createdAtMs).toBeGreaterThanOrEqual(before - 1_000);
      expect(pushes[0]!.createdAtMs).toBeLessThanOrEqual(Date.now());
    } finally {
      push.stop();
      await feed.stop();
    }
  });
});

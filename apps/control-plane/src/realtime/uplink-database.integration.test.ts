import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { installEngineAuthorityCache, type EngineAuthorityCache } from "../cloud-workspaces/engine-authority-cache.js";
import { seedReadyCloudWorkspace } from "../cloud-workspaces/test-fixtures.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { AuditUplinkSecurityAlerts } from "./uplink-alerts.js";
import { DatabaseUplinkAuthority, type UplinkIdentity } from "./uplink-authority.js";
import { UPLINK_AUTHORITY_CHANNEL, UPLINK_CRED_REVISION_CHANNEL, UPLINK_OWNER_CHANNEL, handleUplinkNotification, startUplinkNotifications } from "./uplink-notifications.js";
import { DatabaseUplinkPresenceStore, type UplinkPresenceSnapshot } from "./uplink-presence.js";
import { DatabaseUplinkCredentialStore, UplinkCredentialPush } from "./uplink-cred.js";
import type { CloudEngineUplinkServer } from "./uplink-server.js";

vi.setConfig({ testTimeout: 30_000 });

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
d("engine uplink database paths", () => {
  let pool: pg.Pool;
  let identity: UplinkIdentity;
  let token: string;
  let ownerUserId: string;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    const f = await seedReadyCloudWorkspace(pool, { runtimeV4: true });
    const boot = (await pool.query<{ runtime_boot_id: string }>(
      "SELECT runtime_boot_id FROM cloud_workspace_engine_instances WHERE id=$1", [f.engineInstanceId])).rows[0]!.runtime_boot_id;
    identity = { workspaceId: f.workspaceId, organizationId: f.organizationId, generation: 1, engineInstanceId: f.engineInstanceId, bootId: boot };
    token = f.heartbeatToken;
    ownerUserId = f.userId;
  });

  const authority = (alerts?: AuditUplinkSecurityAlerts) =>
    new DatabaseUplinkAuthority({ pool, workosEnabled: false, ...(alerts ? { alerts } : {}) });

  it("admits the registered bootId and tells a foreign credential (4401) from a stale engine (4403)", async () => {
    await expect(authority().verify(identity, token)).resolves.toMatchObject({ ok: true });
    await expect(authority().verify(identity, `zwh_${randomBytes(32).toString("base64url")}`))
      .resolves.toEqual({ ok: false, reason: "unauthenticated" });
    await expect(authority().verify({ ...identity, generation: 2 }, token)).resolves.toEqual({ ok: false, reason: "authority" });
    await pool.query("UPDATE cloud_workspace_engine_instances SET state='revoked', revoked_at=clock_timestamp() WHERE id=$1", [identity.engineInstanceId]);
    await expect(authority().verify(identity, token)).resolves.toEqual({ ok: false, reason: "authority" });
  });

  it("rejects an unregistered bootId and records one security event per window", async () => {
    const logged: string[] = [];
    const alerts = new AuditUplinkSecurityAlerts({ pool, log: message => logged.push(message) });
    const foreign = { ...identity, bootId: randomUUID() };
    await expect(authority(alerts).verify(foreign, token)).resolves.toEqual({ ok: false, reason: "boot_mismatch" });
    await expect(authority(alerts).verify(foreign, token)).resolves.toEqual({ ok: false, reason: "boot_mismatch" });
    for (let i = 0; i < 50; i++) {
      const rows = await pool.query("SELECT subject FROM audit_log WHERE org_id=$1 AND action='security.uplink_boot_mismatch'", [identity.organizationId]);
      if (rows.rowCount) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const rows = await pool.query<{ subject: Record<string, unknown> }>(
      "SELECT subject FROM audit_log WHERE org_id=$1 AND action='security.uplink_boot_mismatch'", [identity.organizationId]);
    expect(rows.rows.map(row => row.subject)).toEqual([expect.objectContaining({ engineInstanceId: identity.engineInstanceId, bootId: foreign.bootId })]);
    expect(logged).toHaveLength(1);
    expect(logged[0]).not.toContain(token);
  });

  it("answers a rejected hello within one database transaction", async () => {
    const connect = vi.spyOn(pool, "connect");
    try {
      await expect(authority().verify(identity, `zwh_${randomBytes(32).toString("base64url")}`))
        .resolves.toEqual({ ok: false, reason: "unauthenticated" });
      expect(connect).toHaveBeenCalledTimes(1);
      connect.mockClear();
      await expect(authority().verify({ ...identity, generation: 2 }, token)).resolves.toEqual({ ok: false, reason: "authority" });
      expect(connect).toHaveBeenCalledTimes(1);
    } finally { connect.mockRestore(); }
  });

  it("reads authority from SQL even when the authority cache would allow", async () => {
    // A notification-driven recheck can run before the cache's own
    // invalidation lands, so the uplink never asks the cache.
    const stale = {
      shadowing: () => true, enforcing: () => true, recordEnforcedHit: () => {}, observe: () => {},
      lookup: () => ({ allowed: true, authorityEpoch: 1, accountUserId: ownerUserId, leaseExpiresAtMs: Date.now() + 60_000,
        runtimeBootId: identity.bootId, deadlineMs: null }),
    };
    installEngineAuthorityCache(stale as unknown as EngineAuthorityCache);
    try {
      await pool.query("UPDATE cloud_workspace_engine_instances SET state='revoked', revoked_at=clock_timestamp() WHERE id=$1", [identity.engineInstanceId]);
      await expect(authority().verify(identity, token)).resolves.toEqual({ ok: false, reason: "authority" });
    } finally { installEngineAuthorityCache(undefined); }
  });
  it("reports an unreachable database as unavailable, never as a credential rejection", async () => {
    const broken = new pg.Pool({ connectionString: "postgres://nobody:nothing@127.0.0.1:1/none", connectionTimeoutMillis: 500 });
    try {
      await expect(new DatabaseUplinkAuthority({ pool: broken, workosEnabled: false }).verify(identity, token))
        .resolves.toEqual({ ok: false, reason: "unavailable" });
    } finally { await broken.end(); }
  });

  function snapshot(overrides: Partial<UplinkPresenceSnapshot> = {}): UplinkPresenceSnapshot {
    const now = Date.now();
    return { connectionId: randomUUID(), engineInstanceId: identity.engineInstanceId, workspaceId: identity.workspaceId,
      organizationId: identity.organizationId, generation: 1, realtimeInstance: "realtime-a", protocol: 1, connected: true,
      ready: false, phase: null, connectedAtMs: now, lastSeenAtMs: now, disconnectedAtMs: null, ...overrides };
  }
  const row = async () => (await pool.query("SELECT * FROM cloud_workspace_engine_uplinks WHERE engine_instance_id=$1", [identity.engineInstanceId])).rows[0];

  it("fences presence writes by connection and never lets a delayed older connect win", async () => {
    const store = new DatabaseUplinkPresenceStore(pool);
    const older = snapshot({ connectedAtMs: Date.now() - 1_000, lastSeenAtMs: Date.now() - 1_000 });
    const newer = snapshot({ realtimeInstance: "realtime-b" });
    await store.write(newer);
    await store.write(older);
    await store.write({ ...older, connected: false, disconnectedAtMs: Date.now() });
    expect(await row()).toMatchObject({ connection_id: newer.connectionId, realtime_instance: "realtime-b", connected: true });
    await store.write({ ...newer, ready: true, phase: "ready" });
    await store.write({ ...newer, connected: false, ready: false, phase: "ready", disconnectedAtMs: Date.now() });
    expect(await row()).toMatchObject({ connection_id: newer.connectionId, connected: false, ready: false, phase: "ready" });
    await expect(store.owners([identity.engineInstanceId])).resolves.toEqual([
      { engineInstanceId: identity.engineInstanceId, connectionId: newer.connectionId, connectedAtMs: newer.connectedAtMs }]);
    await store.write(snapshot({ engineInstanceId: randomUUID() }));
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_engine_uplinks")).rows[0].n).toBe(1);
  });

  it("breaks same-millisecond presence ties by connection id", async () => {
    const store = new DatabaseUplinkPresenceStore(pool);
    const at = Date.now();
    const lower = snapshot({ connectionId: "00000000-0000-4000-8000-000000000001", connectedAtMs: at, lastSeenAtMs: at });
    const higher = snapshot({ connectionId: "00000000-0000-4000-8000-000000000002", connectedAtMs: at, lastSeenAtMs: at, realtimeInstance: "realtime-b" });
    await store.write(lower);
    await store.write(higher);
    expect(await row()).toMatchObject({ connection_id: higher.connectionId, realtime_instance: "realtime-b" });
    await store.write({ ...lower, ready: true, phase: "ready" });
    expect(await row()).toMatchObject({ connection_id: higher.connectionId, ready: false, phase: null });
    await store.write({ ...higher, ready: true, phase: "ready" }); // the owner itself always re-writes
    expect(await row()).toMatchObject({ connection_id: higher.connectionId, ready: true, phase: "ready" });
  });

  it("notifies a new owner and authority loss, but not lease renewals", async () => {
    const listener = await pool.connect();
    const notices: { channel: string; payload: string }[] = [];
    try {
      listener.on("notification", notice => notices.push({ channel: notice.channel, payload: notice.payload ?? "" }));
      await listener.query(`LISTEN ${UPLINK_OWNER_CHANNEL}`);
      await listener.query(`LISTEN ${UPLINK_AUTHORITY_CHANNEL}`);
      const store = new DatabaseUplinkPresenceStore(pool);
      const first = snapshot();
      await store.write(first);
      await store.write({ ...first, ready: true, phase: "ready" });
      await pool.query("UPDATE cloud_workspace_engine_instances SET last_heartbeat_at=clock_timestamp(), lease_expires_at=clock_timestamp()+interval '10 minutes' WHERE id=$1", [identity.engineInstanceId]);
      await pool.query("UPDATE cloud_workspaces SET authority_epoch=authority_epoch+1 WHERE id=$1", [identity.workspaceId]);
      await pool.query("UPDATE cloud_workspace_engine_instances SET state='revoked', revoked_at=clock_timestamp() WHERE id=$1", [identity.engineInstanceId]);
      for (let i = 0; i < 50 && notices.length < 3; i++) await new Promise(resolve => setTimeout(resolve, 20));
      expect(notices).toEqual([
        { channel: UPLINK_OWNER_CHANNEL, payload: `${identity.engineInstanceId}:${first.connectionId}:${first.connectedAtMs}` },
        { channel: UPLINK_AUTHORITY_CHANNEL, payload: `w:${identity.workspaceId}` },
        { channel: UPLINK_AUTHORITY_CHANNEL, payload: `e:${identity.engineInstanceId}` },
      ]);
      const server = { ownerChanged: vi.fn(), revalidate: vi.fn(), revalidateWorkspace: vi.fn() };
      for (const notice of notices) handleUplinkNotification(server, notice.channel, notice.payload);
      expect(server.ownerChanged).toHaveBeenCalledWith(identity.engineInstanceId, first.connectionId, first.connectedAtMs);
      expect(server.revalidateWorkspace).toHaveBeenCalledWith(identity.workspaceId);
      expect(server.revalidate).toHaveBeenCalledWith([identity.engineInstanceId]);
    } finally {
      await listener.query("UNLISTEN *");
      listener.release();
    }
  });

  it("reads the desired credential revision through the system statement a raw pool read cannot see", async () => {
    const writerEpoch = randomUUID();
    await pool.query(`INSERT INTO cloud_workspace_local_command_writers
      (workspace_id, org_id, generation, engine_instance_id, boot_id, writer_epoch, funding_owner_user_id, funding_owner_epoch)
      VALUES ($1,$2,$3,$4,$5,$6,$7,1)`,
    [identity.workspaceId, identity.organizationId, identity.generation, identity.engineInstanceId, identity.bootId, writerEpoch, ownerUserId]);
    await pool.query(`INSERT INTO cloud_agent_boot_bindings
      (workspace_id, org_id, generation, engine_instance_id, boot_id, writer_epoch, funding_owner_user_id, funding_owner_epoch)
      VALUES ($1,$2,$3,$4,$5,$6,$7,1)`,
    [identity.workspaceId, identity.organizationId, identity.generation, identity.engineInstanceId, identity.bootId, writerEpoch, ownerUserId]);
    // The table is FORCE ROW LEVEL SECURITY with system-only policies: the
    // runtime role without app.system sees no row, so a raw pool.query here
    // (what the gate-time read used to do) silently returns nothing.
    const probe = await pool.connect();
    try {
      await probe.query("BEGIN");
      await probe.query("SET LOCAL ROLE zeros_app");
      const hidden = await probe.query(
        "SELECT desired_cache_revision FROM cloud_agent_boot_bindings WHERE engine_instance_id=$1", [identity.engineInstanceId]);
      expect(hidden.rows).toEqual([]);
      await probe.query("ROLLBACK");
    } finally { probe.release(); }
    const store = new DatabaseUplinkCredentialStore(pool);
    await expect(store.desiredRevision(identity.engineInstanceId)).resolves.toBe(1);
    await pool.query("UPDATE cloud_agent_boot_bindings SET desired_cache_revision=3 WHERE engine_instance_id=$1", [identity.engineInstanceId]);
    await expect(store.desiredRevision(identity.engineInstanceId)).resolves.toBe(3);
    await expect(store.desiredRevision(randomUUID())).resolves.toBeNull();
    await pool.query("UPDATE cloud_agent_boot_bindings SET retired_at=clock_timestamp() WHERE engine_instance_id=$1", [identity.engineInstanceId]);
    await expect(store.desiredRevision(identity.engineInstanceId)).resolves.toBeNull();
  });

  it("reads many engines' desired revisions in one system statement, skipping retired and unknown engines", async () => {
    const writerEpoch = randomUUID();
    await pool.query(`INSERT INTO cloud_workspace_local_command_writers
      (workspace_id, org_id, generation, engine_instance_id, boot_id, writer_epoch, funding_owner_user_id, funding_owner_epoch)
      VALUES ($1,$2,$3,$4,$5,$6,$7,1)`,
    [identity.workspaceId, identity.organizationId, identity.generation, identity.engineInstanceId, identity.bootId, writerEpoch, ownerUserId]);
    await pool.query(`INSERT INTO cloud_agent_boot_bindings
      (workspace_id, org_id, generation, engine_instance_id, boot_id, writer_epoch, funding_owner_user_id, funding_owner_epoch, desired_cache_revision)
      VALUES ($1,$2,$3,$4,$5,$6,$7,1,4)`,
    [identity.workspaceId, identity.organizationId, identity.generation, identity.engineInstanceId, identity.bootId, writerEpoch, ownerUserId]);
    const store = new DatabaseUplinkCredentialStore(pool);
    const unknown = randomUUID();
    await expect(store.desiredRevisions([])).resolves.toEqual(new Map());
    await expect(store.desiredRevisions([identity.engineInstanceId, unknown, identity.engineInstanceId]))
      .resolves.toEqual(new Map([[identity.engineInstanceId, 4]]));
    await pool.query("UPDATE cloud_agent_boot_bindings SET retired_at=clock_timestamp() WHERE engine_instance_id=$1", [identity.engineInstanceId]);
    await expect(store.desiredRevisions([identity.engineInstanceId])).resolves.toEqual(new Map());
  });

  it("re-pushes the current revision to already-connected cred.v1 uplinks once the listener is ready", async () => {
    const writerEpoch = randomUUID();
    await pool.query(`INSERT INTO cloud_workspace_local_command_writers
      (workspace_id, org_id, generation, engine_instance_id, boot_id, writer_epoch, funding_owner_user_id, funding_owner_epoch)
      VALUES ($1,$2,$3,$4,$5,$6,$7,1)`,
    [identity.workspaceId, identity.organizationId, identity.generation, identity.engineInstanceId, identity.bootId, writerEpoch, ownerUserId]);
    await pool.query(`INSERT INTO cloud_agent_boot_bindings
      (workspace_id, org_id, generation, engine_instance_id, boot_id, writer_epoch, funding_owner_user_id, funding_owner_epoch, desired_cache_revision)
      VALUES ($1,$2,$3,$4,$5,$6,$7,1,6)`,
    [identity.workspaceId, identity.organizationId, identity.generation, identity.engineInstanceId, identity.bootId, writerEpoch, ownerUserId]);
    // An engine whose gate is already open never re-gates, so a bump lost
    // while the listener was down must be repaired from onReady.
    const sent: Array<{ t: string; d: Record<string, unknown> }> = [];
    const session = { connectionId: randomUUID(), identity, features: new Set(["cred.v1"]),
      sendReliable: (t: string, d: Record<string, unknown>) => { sent.push({ t, d }); return true; } };
    const store = new DatabaseUplinkCredentialStore(pool);
    const reads: string[][] = [];
    const cred = new UplinkCredentialPush({
      sessionFor: id => id === identity.engineInstanceId ? session : null,
      readRevision: identity => store.desiredRevision(identity.engineInstanceId),
      readRevisions: ids => { reads.push([...ids]); return store.desiredRevisions(ids); },
    });
    const server = { ownerChanged: vi.fn(), revalidate: vi.fn(), revalidateWorkspace: vi.fn(),
      ownedEngineInstances: () => [identity.engineInstanceId, randomUUID()] };
    const listenerPool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
    const stop = startUplinkNotifications(listenerPool, server as unknown as CloudEngineUplinkServer,
      { owners: async () => [] }, console, cred);
    try {
      for (let i = 0; i < 100 && sent.length < 1; i++) await new Promise(resolve => setTimeout(resolve, 20));
      expect(sent).toEqual([{ t: "cred.revision", d: { kind: "agent-controls", revision: 6 } }]);
      // One read for the owned engines that negotiated cred.v1 only.
      expect(reads).toEqual([[identity.engineInstanceId]]);
      // lease.v1 uplinks skip the periodic authority recheck only while this holds.
      expect((server as { notificationsCurrent?: boolean }).notificationsCurrent).toBe(true);
    } finally {
      await stop();
      await listenerPool.end();
    }
    expect((server as { notificationsCurrent?: boolean }).notificationsCurrent).toBe(false);
  });

  it("notifies a credential-control revision bump and routes it to the push extension", async () => {
    const listener = await pool.connect();
    const notices: { channel: string; payload: string }[] = [];
    try {
      listener.on("notification", notice => notices.push({ channel: notice.channel, payload: notice.payload ?? "" }));
      await listener.query(`LISTEN ${UPLINK_CRED_REVISION_CHANNEL}`);
      const writerEpoch = randomUUID();
      await pool.query(`INSERT INTO cloud_workspace_local_command_writers
        (workspace_id, org_id, generation, engine_instance_id, boot_id, writer_epoch, funding_owner_user_id, funding_owner_epoch)
        VALUES ($1,$2,$3,$4,$5,$6,$7,1)`,
      [identity.workspaceId, identity.organizationId, identity.generation, identity.engineInstanceId, identity.bootId, writerEpoch, ownerUserId]);
      await pool.query(`INSERT INTO cloud_agent_boot_bindings
        (workspace_id, org_id, generation, engine_instance_id, boot_id, writer_epoch, funding_owner_user_id, funding_owner_epoch)
        VALUES ($1,$2,$3,$4,$5,$6,$7,1)`,
      [identity.workspaceId, identity.organizationId, identity.generation, identity.engineInstanceId, identity.bootId, writerEpoch, ownerUserId]);
      // Only a desired-revision bump notifies; other column updates do not.
      await pool.query("UPDATE cloud_agent_boot_bindings SET credentials_initialized=true WHERE engine_instance_id=$1", [identity.engineInstanceId]);
      await pool.query("UPDATE cloud_agent_boot_bindings SET desired_cache_revision=desired_cache_revision+1 WHERE engine_instance_id=$1", [identity.engineInstanceId]);
      for (let i = 0; i < 50 && notices.length < 1; i++) await new Promise(resolve => setTimeout(resolve, 20));
      expect(notices).toEqual([{ channel: UPLINK_CRED_REVISION_CHANNEL, payload: `${identity.engineInstanceId}:2` }]);
      const server = { ownerChanged: vi.fn(), revalidate: vi.fn(), revalidateWorkspace: vi.fn() };
      const cred = { revisionChanged: vi.fn() };
      handleUplinkNotification(server, UPLINK_CRED_REVISION_CHANNEL, notices[0]!.payload, cred);
      expect(cred.revisionChanged).toHaveBeenCalledWith(identity.engineInstanceId, 2);
      expect(server.revalidate).not.toHaveBeenCalled();
    } finally {
      await listener.query("UNLISTEN *");
      listener.release();
    }
  });
});

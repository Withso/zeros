import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { faultInjectingPool } from "../chaos/fault-pool.js";
import { seedReadyCloudWorkspace } from "../cloud-workspaces/test-fixtures.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import type { UplinkIdentity } from "./uplink-authority.js";
import { DatabaseUplinkLeaseStore, UPLINK_ENGINE_LEASE_MS } from "./uplink-lease.js";
import { UPLINK_AUTHORITY_CHANNEL, UPLINK_OWNER_CHANNEL } from "./uplink-notifications.js";

vi.setConfig({ testTimeout: 30_000 });

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
d("engine lease renewal over the uplink (lease.v1)", () => {
  let pool: pg.Pool;
  let identity: UplinkIdentity;
  let token: string;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    const f = await seedReadyCloudWorkspace(pool, { runtimeV4: true });
    const boot = (await pool.query<{ runtime_boot_id: string }>(
      "SELECT runtime_boot_id FROM cloud_workspace_engine_instances WHERE id=$1", [f.engineInstanceId])).rows[0]!.runtime_boot_id;
    identity = { workspaceId: f.workspaceId, organizationId: f.organizationId, generation: 1, engineInstanceId: f.engineInstanceId, bootId: boot };
    token = f.heartbeatToken;
  });

  const store = (db: pg.Pool = pool) => new DatabaseUplinkLeaseStore({ pool: db, workosEnabled: false });
  const engineRow = async () => (await pool.query<{ row: Record<string, unknown> }>(
    "SELECT to_jsonb(engine) AS row FROM cloud_workspace_engine_instances engine WHERE id=$1", [identity.engineInstanceId])).rows[0]!.row;
  const workspaceRow = async () => (await pool.query<{ row: Record<string, unknown> }>(
    "SELECT to_jsonb(workspace) AS row FROM cloud_workspaces workspace WHERE id=$1", [identity.workspaceId])).rows[0]!.row;
  const lease = async () => (await pool.query<{ lease: Date }>(
    "SELECT lease_expires_at AS lease FROM cloud_workspace_engine_instances WHERE id=$1", [identity.engineInstanceId])).rows[0]!.lease.getTime();
  const changedKeys = (before: Record<string, unknown>, after: Record<string, unknown>) =>
    Object.keys({ ...before, ...after }).filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key])).sort();

  it("renews a live lease to 36 minutes in one transaction, changing only the lease columns", async () => {
    expect(UPLINK_ENGINE_LEASE_MS).toBe(36 * 60_000);
    const before = await engineRow(), workspaceBefore = await workspaceRow();
    const connect = vi.spyOn(pool, "connect");
    const startedAt = Date.now();
    let renewed: Awaited<ReturnType<DatabaseUplinkLeaseStore["renew"]>>;
    try {
      renewed = await store().renew(identity, token);
      expect(connect).toHaveBeenCalledTimes(1);
    } finally { connect.mockRestore(); }
    expect(renewed).toEqual({ ok: true, leaseExpiresAtMs: await lease() });
    if (!renewed.ok) throw new Error("renewal refused");
    expect(renewed.leaseExpiresAtMs).toBeGreaterThanOrEqual(startedAt + UPLINK_ENGINE_LEASE_MS - 5_000);
    expect(renewed.leaseExpiresAtMs).toBeLessThanOrEqual(Date.now() + UPLINK_ENGINE_LEASE_MS + 5_000);
    expect(changedKeys(before, await engineRow())).toEqual(["last_heartbeat_at", "lease_expires_at", "updated_at"]);
    expect(changedKeys(workspaceBefore, await workspaceRow())).toEqual([]);
  });

  it("wakes no authority-cache, engine-health, uplink-owner or uplink-teardown listener", async () => {
    const listener = await pool.connect();
    const notices: { channel: string; payload: string }[] = [];
    try {
      listener.on("notification", notice => notices.push({ channel: notice.channel, payload: notice.payload ?? "" }));
      for (const channel of ["zeros_cloud_authority_cache", "zeros_cloud_lifecycle_work", UPLINK_AUTHORITY_CHANNEL, UPLINK_OWNER_CHANNEL])
        await listener.query(`LISTEN ${channel}`);
      await expect(store().renew(identity, token)).resolves.toMatchObject({ ok: true });
      await expect(store().renew(identity, token)).resolves.toMatchObject({ ok: true });
      // Notifications reach a listener in commit order, so a marker committed
      // after the renewals arriving first proves they sent none.
      await pool.query("SELECT pg_notify('zeros_cloud_lifecycle_work', 'c6-marker')");
      for (let i = 0; i < 100 && notices.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 20));
      expect(notices).toEqual([{ channel: "zeros_cloud_lifecycle_work", payload: "c6-marker" }]);
    } finally {
      await listener.query("UNLISTEN *");
      listener.release();
    }
  });

  it("never shortens a longer lease, while still recording the renewal", async () => {
    await pool.query("UPDATE cloud_workspace_engine_instances SET lease_expires_at=clock_timestamp()+interval '50 minutes' WHERE id=$1",
      [identity.engineInstanceId]);
    const longer = await lease(), heartbeatBefore = (await engineRow()).last_heartbeat_at;
    await expect(store().renew(identity, token)).resolves.toEqual({ ok: true, leaseExpiresAtMs: longer });
    expect(await lease()).toBe(longer);
    expect((await engineRow()).last_heartbeat_at).not.toEqual(heartbeatBefore);
  });

  const setEngine = (assignments: string) => async () => {
    await pool.query(`UPDATE cloud_workspace_engine_instances SET ${assignments} WHERE id=$1`, [identity.engineInstanceId]);
    return {};
  };
  it.each<[string, () => Promise<{ identity?: UplinkIdentity; token?: string }>]>([
    ["a different heartbeat credential", async () => ({ token: `zwh_${randomBytes(32).toString("base64url")}` })],
    ["another boot of the engine", async () => ({ identity: { ...identity, bootId: randomUUID() } })],
    ["another generation", async () => ({ identity: { ...identity, generation: 2 } })],
    ["a revoked engine", setEngine("state='revoked', revoked_at=clock_timestamp()")],
    ["a superseded engine", setEngine("state='superseded', revoked_at=clock_timestamp()")],
    ["an engine whose final checkpoint is recorded", setEngine("final_checkpoint_at=clock_timestamp()")],
    ["a workspace asked to stop", async () => {
      await pool.query("UPDATE cloud_workspaces SET desired_state='stopped' WHERE id=$1", [identity.workspaceId]);
      return {};
    }],
  ])("refuses %s as an authority loss without touching the lease", async (_name, arrange) => {
    const override = await arrange();
    const before = await engineRow();
    await expect(store().renew(override.identity ?? identity, override.token ?? token)).resolves.toEqual({ ok: false, reason: "authority" });
    expect(changedKeys(before, await engineRow())).toEqual([]);
  });

  it("never revives a lapsed lease", async () => {
    await pool.query(`UPDATE cloud_workspace_engine_instances SET last_heartbeat_at=clock_timestamp()-interval '2 minutes',
      lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [identity.engineInstanceId]);
    const before = await engineRow();
    await expect(store().renew(identity, token)).resolves.toEqual({ ok: false, reason: "authority" });
    expect(changedKeys(before, await engineRow())).toEqual([]);
  });

  it("reports a database outage or a held lifecycle lock as unavailable, never as an authority loss", async () => {
    const fault = faultInjectingPool(pool);
    fault.down();
    await expect(store(fault.pool).renew(identity, token)).resolves.toEqual({ ok: false, reason: "unavailable" });
    fault.up();
    await expect(store(fault.pool).renew(identity, token)).resolves.toMatchObject({ ok: true });
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM cloud_workspaces WHERE id=$1 FOR UPDATE", [identity.workspaceId]);
      const startedAt = Date.now();
      await expect(store().renew(identity, token)).resolves.toEqual({ ok: false, reason: "unavailable" });
      expect(Date.now() - startedAt).toBeLessThan(10_000);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    await expect(store().renew(identity, token)).resolves.toMatchObject({ ok: true });
  });
});

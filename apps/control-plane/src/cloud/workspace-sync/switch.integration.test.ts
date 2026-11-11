import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { withSystemTx, withUserTx } from "../../db.js";
import { localDeviceStream } from "../local-commands/test-fixture.js";
import { syncFixture, type SyncFixture } from "./test-fixture.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const optIn = { "x-zeros-sync": "1", "x-zeros-sync-wanted": "1" };
const releasedMac = z.object({ deviceId: z.string().uuid(), name: z.string(), connected: z.boolean(), active: z.boolean(),
  reachable: z.boolean(), expiresAt: z.string().datetime().nullable(), syncing: z.boolean().optional() }).strict();

suite("the per-device sync switch through the production router and PostgreSQL", () => {
  let pool: pg.Pool, f: SyncFixture;
  let sharedMac: { parse(value: unknown): unknown };
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 10, statement_timeout: 5000 });
    const root = new URL(process.env.CLOUD_API_TEST_PROTOCOL_ROOT ?? "../../../../../packages/protocol/src/", import.meta.url);
    sharedMac = (await import(new URL("local-commands.ts", root).href)).LocalCommandMacSchema;
  });
  beforeEach(async () => { f = await syncFixture(pool); });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(() => pool.end());

  const path = (id: string) => `${f.path}/macs/${id}`;
  const list = async (headers: Record<string, string> = optIn) => {
    const response = await f.call(`${f.path}/macs`, "GET", undefined, headers);
    expect(response.status).toBe(200);
    return (await response.json()).macs;
  };
  async function connected() {
    const mac = await f.register();
    expect((await f.call(`${path(mac.device.deviceId)}/connect`, "POST", undefined, mac.headers)).status).toBe(200);
    return mac;
  }
  const clocks = () => pool.query("SELECT state,updated_at,active_at,stop_generation,access_epoch,login_revision FROM cloud_v2_workspaces WHERE id=$1", [f.workspaceId]).then(result => result.rows[0]);
  const flag = (target: string, headers: Record<string, string>, body: unknown) => f.call(`${path(target)}/sync`, "PUT", body, { ...headers, ...optIn });

  it("lets a registered, unconnected caller switch another of their connected Macs without reporting for it", async () => {
    const caller = await f.register(), target = await connected();
    const before = await clocks(), providerCalls = f.fetcher.mock.calls.length;
    const response = await flag(target.device.deviceId, caller.headers, { wanted: true });
    expect(response.status).toBe(200);
    expect((await response.json()).mac).toMatchObject({ deviceId: target.device.deviceId, connected: true, syncing: false, syncWanted: true });
    expect((await list()).find((mac: { deviceId: string }) => mac.deviceId === caller.device.deviceId)).toMatchObject({ connected: false, syncWanted: false });
    expect((await flag(target.device.deviceId, caller.headers, { syncing: true })).status).toBe(409);
    expect((await flag(target.device.deviceId, caller.headers, { syncing: false, wanted: false })).status).toBe(409);
    expect((await flag(target.device.deviceId, target.headers, { syncing: true })).status).toBe(200);
    const off = await flag(target.device.deviceId, caller.headers, { wanted: false });
    expect(off.status).toBe(200);
    expect((await off.json()).mac).toMatchObject({ syncing: true, syncWanted: false });
    expect(await clocks()).toEqual(before); expect(f.fetcher).toHaveBeenCalledTimes(providerCalls);
  });

  it("requires the new exact opt-in and preserves every released reply shape", async () => {
    const mac = await connected(), target = path(mac.device.deviceId);
    const enabled = await flag(mac.device.deviceId, mac.headers, { wanted: true, syncing: true });
    expect(enabled.status).toBe(200);
    const enabledMac = (await enabled.json()).mac;
    expect(sharedMac.parse(enabledMac)).toEqual(enabledMac); expect(enabledMac).toMatchObject({ syncing: true, syncWanted: true });
    for (const headers of [{}, { "x-zeros-sync": "1" }, { "x-zeros-sync-wanted": "true" }]) {
      const rows = await list(headers);
      expect(releasedMac.safeParse(rows[0]).success).toBe(true); expect(rows[0]).not.toHaveProperty("syncWanted");
      expect(sharedMac.parse(rows[0])).toEqual(rows[0]);
      for (const operation of ["connect", "sync", "disconnect"] as const) {
        const response = await f.call(`${target}/${operation}`, operation === "sync" ? "PUT" : "POST",
          operation === "sync" ? { syncing: true } : undefined, { ...mac.headers, ...headers });
        expect(response.status).toBe(200);
        const value = (await response.json()).mac;
        expect(releasedMac.safeParse(value).success).toBe(true); expect(value).not.toHaveProperty("syncWanted");
      }
      for (const body of [{ wanted: true }, { syncing: false, wanted: false }])
        expect((await f.call(`${target}/sync`, "PUT", body, { ...mac.headers, ...headers })).status).toBe(400);
      expect((await f.call(`${target}/connect`, "POST", undefined, mac.headers)).status).toBe(200);
    }
    const wantedOnly = (await list({ "x-zeros-sync-wanted": "1" }))[0];
    expect(wantedOnly).toHaveProperty("syncWanted", false); expect(wantedOnly).not.toHaveProperty("syncing");
    expect((await (await f.call(`${target}/connect`, "POST", undefined, { ...mac.headers, ...optIn })).json()).mac.syncWanted).toBe(false);
    expect((await (await f.call(`${target}/disconnect`, "POST", undefined, { ...mac.headers, ...optIn })).json()).mac.syncWanted).toBe(false);
  });

  it("preserves the released self-report refusal including its message", async () => {
    const caller = await f.register(), target = await connected();
    const response = await f.call(`${path(target.device.deviceId)}/sync`, "PUT", { syncing: true }, caller.headers);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "device_mismatch", message: "Sync must be requested on that Mac" } });
  });

  it("persists intent while stopped, does not renew activity or connection time, and avoids repeated writes", async () => {
    const mac = await connected();
    await f.cp.store.requestLifecycle(f.workspaceId, f.owner.id, "stop");
    await f.cp.store.transition(f.workspaceId, ["stopping"], "stopped");
    const before = await clocks(), calls = f.fetcher.mock.calls.length;
    const connection = () => pool.query("SELECT xmin::text,connected_at,last_used_at,sync_wanted FROM cloud_v2_connected_macs WHERE workspace_id=$1", [f.workspaceId]).then(result => result.rows);
    const initial = await connection();
    expect((await flag(mac.device.deviceId, mac.headers, { wanted: true })).status).toBe(200);
    const changed = await connection();
    expect(changed[0]).toMatchObject({ connected_at: initial[0].connected_at, last_used_at: initial[0].last_used_at, sync_wanted: true });
    expect((await flag(mac.device.deviceId, mac.headers, { wanted: true })).status).toBe(200);
    expect(await connection()).toEqual(changed); expect(await clocks()).toEqual(before); expect(f.fetcher).toHaveBeenCalledTimes(calls);
  });

  it("keeps wanted across app restart and connection expiry within the same registration", async () => {
    const mac = await connected();
    expect((await flag(mac.device.deviceId, mac.headers, { wanted: true })).status).toBe(200);
    const next = await f.register(mac.device.deviceId);
    expect(next.device.registrationId).toBe(mac.device.registrationId); expect(next.device.instanceId).not.toBe(mac.device.instanceId);
    expect((await flag(mac.device.deviceId, mac.headers, { wanted: false })).status).toBe(409);
    expect((await list())[0].syncWanted).toBe(true);
    await pool.query("UPDATE cloud_v2_connected_macs SET connected_at=now()-interval '13 hours',last_used_at=now()-interval '13 hours' WHERE workspace_id=$1", [f.workspaceId]);
    expect((await list())[0]).toMatchObject({ connected: false, syncing: false, syncWanted: true });
    const reply = await f.call(`${path(mac.device.deviceId)}/connect`, "POST", undefined, { ...next.headers, ...optIn });
    expect(reply.status).toBe(200); expect((await reply.json()).mac).toMatchObject({ connected: true, syncWanted: true });
  });

  it("clears wanted on explicit disconnect and registration replacement, including released SQL writers", async () => {
    const mac = await connected();
    for (const oldWriter of [false, true]) {
      expect((await flag(mac.device.deviceId, mac.headers, { wanted: true })).status).toBe(200);
      if (oldWriter) await withSystemTx(pool, tx => tx.query("UPDATE cloud_v2_connected_macs SET disconnected_at=clock_timestamp() WHERE workspace_id=$1", [f.workspaceId]));
      else expect((await f.call(`${path(mac.device.deviceId)}/disconnect`, "POST", undefined, { ...mac.headers, ...optIn })).status).toBe(200);
      expect((await pool.query("SELECT sync_wanted FROM cloud_v2_connected_macs WHERE workspace_id=$1", [f.workspaceId])).rows).toEqual([{ sync_wanted: false }]);
      await withSystemTx(pool, tx => tx.query("UPDATE cloud_v2_connected_macs SET disconnected_at=NULL,connected_at=clock_timestamp() WHERE workspace_id=$1", [f.workspaceId]));
      expect((await list())[0].syncWanted).toBe(false);
    }
    expect((await flag(mac.device.deviceId, mac.headers, { wanted: true })).status).toBe(200);
    await withSystemTx(pool, tx => tx.query("UPDATE local_command_devices SET registration_id=$3 WHERE user_id=$1 AND device_id=$2", [f.owner.id, mac.device.deviceId, randomUUID()]));
    expect((await pool.query("SELECT sync_wanted FROM cloud_v2_connected_macs WHERE workspace_id=$1", [f.workspaceId])).rows).toEqual([{ sync_wanted: false }]);
  });

  it("notifies the target's open channel even when its presence value did not change", async () => {
    const caller = await f.register(), target = await connected();
    const stream = await localDeviceStream(f, { ...target, headers: { ...target.headers, ...optIn } });
    try {
      const ready = await stream.event("ready");
      const response = await flag(target.device.deviceId, caller.headers, { wanted: true });
      expect(response.status).toBe(200);
      expect(await stream.event("presence")).toEqual(ready.presence);
      expect((await list()).find((mac: { deviceId: string }) => mac.deviceId === target.device.deviceId).syncWanted).toBe(true);
    } finally { await stream.close(); }
  });

  it("hides another person's target and workspace and refuses stale device authority", async () => {
    const caller = await f.register(), target = await connected(), theirs = await f.register(randomUUID(), f.other);
    for (const id of [theirs.device.deviceId, randomUUID()]) {
      const response = await flag(id, caller.headers, { wanted: true });
      expect(response.status).toBe(404); expect((await response.json()).error.code).toBe("not_found");
    }
    expect((await flag(target.device.deviceId, theirs.headers, { wanted: true })).status).toBe(404);
    expect((await flag(target.device.deviceId, { ...caller.headers, "x-zeros-device-id": theirs.device.deviceId }, { wanted: true })).status).toBe(404);
    for (const field of ["x-zeros-device-registration", "x-zeros-device-instance"])
      expect((await flag(target.device.deviceId, { ...caller.headers, [field]: randomUUID() }, { wanted: true })).status).toBe(409);
    expect((await flag(target.device.deviceId, {}, { wanted: true })).status).toBe(400);
  });

  it.each(["unconnected", "expired", "revoked"] as const)("refuses a %s target without renewing its connection", async state => {
    const caller = await f.register(), target = state === "unconnected" ? await f.register() : await connected();
    if (state === "expired") await pool.query("UPDATE cloud_v2_connected_macs SET connected_at=now()-interval '13 hours',last_used_at=now()-interval '13 hours' WHERE workspace_id=$1", [f.workspaceId]);
    if (state === "revoked") await pool.query("UPDATE local_command_devices SET revoked_at=clock_timestamp() WHERE user_id=$1 AND device_id=$2", [f.owner.id, target.device.deviceId]);
    const before = (await pool.query("SELECT * FROM cloud_v2_connected_macs WHERE workspace_id=$1", [f.workspaceId])).rows;
    for (const wanted of [true, false]) {
      const response = await flag(target.device.deviceId, caller.headers, { wanted });
      expect(response.status).toBe(state === "revoked" ? 404 : 403);
      expect((await response.json()).error.code).toBe(state === "revoked" ? "not_found" : "mac_not_connected");
    }
    expect((await pool.query("SELECT * FROM cloud_v2_connected_macs WHERE workspace_id=$1", [f.workspaceId])).rows).toEqual(before);
  });

  it.each(["membership", "session", "instance", "target_registration"] as const)("rechecks %s after waiting for the target row", async change => {
    const caller = await f.register(), target = await connected(), tx = await pool.connect();
    await tx.query("BEGIN");
    await tx.query("SELECT workspace_id FROM cloud_v2_connected_macs WHERE workspace_id=$1 FOR UPDATE", [f.workspaceId]);
    const pending = flag(target.device.deviceId, caller.headers, { wanted: true });
    try {
      await expect.poll(async () => Number((await pool.query(`SELECT count(*) FROM pg_stat_activity WHERE datname=current_database()
        AND wait_event_type='Lock' AND query LIKE 'SELECT workspace_id FROM cloud_v2_connected_macs WHERE workspace_id=%'`)).rows[0].count)).toBe(1);
      if (change === "membership") await tx.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.owner.id]);
      else if (change === "session") await tx.query("UPDATE auth_sessions SET status='revoked',revoked_at=clock_timestamp() WHERE provider_session_id=$1", [f.owner.authentication.sessionId]);
      else await tx.query(`UPDATE local_command_devices SET ${change === "instance" ? "instance_id" : "registration_id"}=$3 WHERE user_id=$1 AND device_id=$2`,
        [f.owner.id, change === "instance" ? caller.device.deviceId : target.device.deviceId, randomUUID()]);
    } finally { await tx.query("COMMIT"); tx.release(); }
    expect((await pending).status).not.toBe(200);
    expect((await pool.query("SELECT sync_wanted FROM cloud_v2_connected_macs WHERE workspace_id=$1", [f.workspaceId])).rows).toEqual([{ sync_wanted: false }]);
  });

  it("bounds switch bodies and shares the existing flag budget", async () => {
    const mac = await connected();
    for (const body of [undefined, {}, { wanted: 1 }, { wanted: null }, { wanted: true, path: "/private" }])
      expect((await flag(mac.device.deviceId, mac.headers, body)).status).toBe(400);
    expect((await flag(mac.device.deviceId, mac.headers, { padding: "x".repeat(256 * 1024) })).status).toBe(413);
    for (let i = 5; i < 60; i++) expect((await flag(mac.device.deviceId, mac.headers, i % 2 ? { wanted: true } : { syncing: false })).status).toBe(200);
    const limited = await flag(mac.device.deviceId, mac.headers, { wanted: false });
    expect(limited.status).toBe(429); expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await f.grant(mac.headers)).status).toBe(200);
  });

  it("preserves existing live sync intent on upgrade and defaults old inserts to false", async () => {
    const running = await connected(), idle = await connected(), disconnected = await connected();
    await pool.query("UPDATE cloud_v2_connected_macs SET syncing=true WHERE device_id=ANY($1::uuid[])", [[running.device.deviceId, disconnected.device.deviceId]]);
    await pool.query("UPDATE cloud_v2_connected_macs SET disconnected_at=clock_timestamp() WHERE device_id=$1", [disconnected.device.deviceId]);
    await pool.query(`DROP TRIGGER connected_mac_sync_wanted_fence ON cloud_v2_connected_macs;
      DROP FUNCTION clear_connected_mac_sync_wanted(); ALTER TABLE cloud_v2_connected_macs DROP COLUMN sync_wanted;`);
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      await tx.query(await readFile(new URL("../../../migrations/0237_cloud_sync_wanted.sql", import.meta.url), "utf8"));
      await tx.query("COMMIT");
    } finally { await tx.query("ROLLBACK"); tx.release(); }
    const flags = new Map((await pool.query("SELECT device_id,sync_wanted FROM cloud_v2_connected_macs")).rows.map(row => [row.device_id, row.sync_wanted]));
    expect(flags.get(running.device.deviceId)).toBe(true); expect(flags.get(idle.device.deviceId)).toBe(false);
    expect(flags.get(disconnected.device.deviceId)).toBe(false);
    const newMac = await f.register();
    await withSystemTx(pool, db => db.query(`INSERT INTO cloud_v2_connected_macs(workspace_id,user_id,device_id,registration_id)
      VALUES($1,$2,$3,$4)`, [f.workspaceId, f.owner.id, newMac.device.deviceId, newMac.device.registrationId]));
    expect((await list()).find((mac: { deviceId: string }) => mac.deviceId === newMac.device.deviceId).syncWanted).toBe(false);
    expect((await pool.query(`SELECT is_nullable,column_default FROM information_schema.columns
      WHERE table_name='cloud_v2_connected_macs' AND column_name='sync_wanted'`)).rows).toEqual([{ is_nullable: "NO", column_default: "false" }]);
  });

  it("does not accept a switch after membership changes during its final Mac read", async () => {
    const caller = await f.register(), target = await connected(), devices = f.cp.routes.localDevices!.devices;
    const original = devices.macs.bind(devices);
    vi.spyOn(devices, "macs").mockImplementationOnce(async (...args) => {
      const value = await original(...args);
      await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.owner.id]);
      return value;
    });
    const response = await flag(target.device.deviceId, caller.headers, { wanted: true });
    expect(response.status).toBe(404);
    expect((await pool.query("SELECT sync_wanted FROM cloud_v2_connected_macs WHERE workspace_id=$1", [f.workspaceId])).rows).toEqual([{ sync_wanted: false }]);
  });

  it("keeps reads lock-free and desired state system-only and deletes it with the workspace", async () => {
    const mac = await connected();
    expect((await flag(mac.device.deviceId, mac.headers, { wanted: true })).status).toBe(200);
    const tx = await pool.connect();
    await tx.query("BEGIN");
    await tx.query("SELECT workspace_id FROM cloud_v2_connected_macs WHERE workspace_id=$1 FOR UPDATE", [f.workspaceId]);
    try { expect((await list())[0].syncWanted).toBe(true); }
    finally { await tx.query("ROLLBACK"); tx.release(); }
    expect(await withUserTx(pool, f.owner.id, async db => (await db.query("SELECT sync_wanted FROM cloud_v2_connected_macs")).rows)).toEqual([]);
    expect(await withUserTx(pool, f.owner.id, async db => (await db.query("UPDATE cloud_v2_connected_macs SET sync_wanted=false")).rowCount)).toBe(0);
    await f.cp.store.transition(f.workspaceId, ["running"], "deleting");
    await f.cp.store.transition(f.workspaceId, ["deleting"], "deleted");
    expect((await pool.query("SELECT sync_wanted FROM cloud_v2_connected_macs WHERE workspace_id=$1", [f.workspaceId])).rowCount).toBe(0);
  });
});

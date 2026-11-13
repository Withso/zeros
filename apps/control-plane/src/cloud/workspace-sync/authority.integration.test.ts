import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystemTx, withUserTx } from "../../db.js";
import { CloudV2SourceAuthority } from "../source-authority.js";
import { syncFixture, type SyncFixture } from "./test-fixture.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
suite("direct sync authority fences with PostgreSQL", () => {
  let pool: pg.Pool, f: SyncFixture, mac: Awaited<ReturnType<SyncFixture["register"]>>;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 10, statement_timeout: 5000 }); });
  beforeEach(async () => {
    f = await syncFixture(pool); mac = await f.register();
    expect((await f.call(`${f.path}/macs/${mac.device.deviceId}/connect`, "POST", {}, mac.headers)).status).toBe(200);
  });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
  afterAll(() => pool.end());

  async function holdWorkspaceRead() {
    const entered = deferred(), release = deferred(), original = f.cp.store.promptContext.bind(f.cp.store);
    vi.spyOn(f.cp.store, "promptContext").mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      entered.resolve(); await release.promise; return result;
    });
    const pending = f.grant(mac.headers);
    await Promise.race([entered.promise, pending.then(() => { throw new Error("The grant bypassed the held workspace read"); })]);
    return { pending, release: release.resolve };
  }

  it.each(["session", "identity", "account", "membership", "entitlement", "registration", "instance", "disconnect", "stop", "archive", "delete",
    "epoch", "login", "generation", "boot", "route"] as const)("does not issue a grant after %s changes during the workspace read", async change => {
    const held = await holdWorkspaceRead();
    try {
      if (change === "session") await pool.query("UPDATE auth_sessions SET status='revoked',revoked_at=clock_timestamp() WHERE provider_session_id=$1", [f.owner.authentication.sessionId]);
      else if (change === "identity") await pool.query("UPDATE user_identities SET status='revoked' WHERE user_id=$1", [f.owner.id]);
      else if (change === "account") await pool.query("UPDATE users SET auth_revision=auth_revision+1 WHERE id=$1", [f.owner.id]);
      else if (change === "membership") await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.owner.id]);
      else if (change === "entitlement") await pool.query("UPDATE organizations SET cloud_workspaces_allowed=false WHERE id=$1", [f.organizationId]);
      else if (change === "registration" || change === "instance") await pool.query(`UPDATE local_command_devices SET ${change === "registration" ? "registration_id" : "instance_id"}=$3 WHERE user_id=$1 AND device_id=$2`, [f.owner.id, mac.device.deviceId, randomUUID()]);
      else if (change === "disconnect") await f.call(`${f.path}/macs/${mac.device.deviceId}/disconnect`, "POST", {}, mac.headers);
      else if (change === "stop" || change === "archive") await f.cp.store.requestLifecycle(f.workspaceId, f.owner.id, change);
      else if (change === "delete") await f.cp.store.transition(f.workspaceId, ["running"], "deleting");
      else if (change === "epoch") await pool.query("UPDATE cloud_v2_workspaces SET access_epoch=access_epoch+1 WHERE id=$1", [f.workspaceId]);
      else if (change === "login") await pool.query("UPDATE cloud_v2_workspaces SET login_revision=login_revision+1 WHERE id=$1", [f.workspaceId]);
      else if (change === "generation") await pool.query("UPDATE cloud_v2_workspaces SET stop_generation=stop_generation+1 WHERE id=$1", [f.workspaceId]);
      else if (change === "boot") await pool.query("UPDATE cloud_v2_workspaces SET worker_boot_id=$2,sync_boot_ids=ARRAY[$2::uuid] WHERE id=$1", [f.workspaceId, randomUUID()]);
      else await pool.query("UPDATE cloud_v2_workspaces SET worker_route_url='https://other.example.test/' WHERE id=$1", [f.workspaceId]);
    } finally { held.release(); }
    const response = await held.pending;
    expect(response.status).not.toBe(200); expect(await response.json()).not.toHaveProperty("grant");
  });

  async function holdFinalDeviceRead() {
    const devices = f.cp.routes.localDevices!.devices, original = devices.verify.bind(devices), entered = deferred(), release = deferred();
    let reads = 0;
    vi.spyOn(devices, "verify").mockImplementation(async (...args) => {
      const value = await original(...args);
      if (++reads === 2) { entered.resolve(); await release.promise; }
      return value;
    });
    const pending = f.grant(mac.headers);
    await Promise.race([entered.promise, pending.then(() => { throw new Error("No final device recheck"); })]);
    return { pending, release: release.resolve };
  }

  it("rechecks the session after the device verification await", async () => {
    const held = await holdFinalDeviceRead();
    try { await pool.query("UPDATE auth_sessions SET status='revoked',revoked_at=clock_timestamp() WHERE provider_session_id=$1", [f.owner.authentication.sessionId]); }
    finally { held.release(); }
    const response = await held.pending;
    expect(response.status).toBe(401); expect((await response.json()).error.code).toBe("session_revoked");
  });

  it("anchors issuance before a slow final observation instead of granting a fresh minute afterwards", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const started = Date.now(), held = await holdFinalDeviceRead();
    vi.setSystemTime(started + 61_000); held.release();
    const response = await held.pending;
    expect(response.status).toBe(503); expect((await response.json()).error.code).toBe("cloud_sync_unavailable");
  });

  it("issues a sync grant when GitHub grace expires during the final authority read", async () => {
    await pool.query("UPDATE cloud_v2_workspaces SET access_epoch=access_epoch+1 WHERE id=$1", [f.workspaceId]);
    await pool.query(`UPDATE cloud_github_source_verifications SET verified_at=clock_timestamp()-interval '59 minutes 30 seconds',
      failure_code='github_unavailable',failure_status=503,retry_at=clock_timestamp()+interval '1 minute' WHERE org_id=$1`, [f.organizationId]);
    vi.useFakeTimers({ toFake: ["Date"] });
    const started = Date.now(), held = await holdFinalDeviceRead();
    vi.setSystemTime(started + 31_000); held.release();
    const response = await held.pending;
    expect(response.status).toBe(200); expect(await response.json()).toHaveProperty("grant");
  });

  it.each(["membership", "session", "instance"] as const)("rechecks %s after waiting to write the sync flag", async change => {
    const tx = await pool.connect();
    await tx.query("BEGIN");
    await tx.query("SELECT workspace_id FROM cloud_v2_connected_macs WHERE workspace_id=$1 FOR UPDATE", [f.workspaceId]);
    const pending = f.call(`${f.path}/macs/${mac.device.deviceId}/sync`, "PUT", { syncing: true }, mac.headers);
    try {
      await expect.poll(async () => Number((await pool.query(`SELECT count(*) FROM pg_stat_activity WHERE datname=current_database()
        AND wait_event_type='Lock' AND query LIKE 'SELECT workspace_id FROM cloud_v2_connected_macs WHERE workspace_id=%'`)).rows[0].count)).toBe(1);
      if (change === "membership") await tx.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.owner.id]);
      else if (change === "session") await tx.query("UPDATE auth_sessions SET status='revoked',revoked_at=clock_timestamp() WHERE provider_session_id=$1", [f.owner.authentication.sessionId]);
      else await tx.query("UPDATE local_command_devices SET instance_id=$3 WHERE user_id=$1 AND device_id=$2", [f.owner.id, mac.device.deviceId, randomUUID()]);
    } finally { await tx.query("COMMIT"); tx.release(); }
    expect((await pending).status).not.toBe(200);
    expect((await pool.query("SELECT syncing FROM cloud_v2_connected_macs WHERE workspace_id=$1", [f.workspaceId])).rows).toEqual([{ syncing: false }]);
  });

  it("keeps sync available through source outages and rate limits without lifecycle effects", async () => {
    for (const [code, status] of [["github_unavailable", 503], ["github_rate_limited", 429]] as const) {
      await pool.query("UPDATE cloud_v2_workspaces SET access_epoch=access_epoch+1 WHERE id=$1", [f.workspaceId]);
      await pool.query(`UPDATE cloud_github_source_verifications SET verified_at=clock_timestamp()-interval '2 hours',
        failure_code=$2,failure_status=$3,retry_at=clock_timestamp()+interval '1 minute' WHERE org_id=$1`, [f.organizationId, code, status]);
      const before = (await pool.query("SELECT state,updated_at,active_at FROM cloud_v2_workspaces WHERE id=$1", [f.workspaceId])).rows[0];
      f.fetcher.mockClear();
      const response = await f.grant(mac.headers);
      expect(response.status).toBe(200); expect(await response.json()).toHaveProperty("grant");
      expect(f.fetcher).not.toHaveBeenCalled();
      expect((await pool.query("SELECT state,updated_at,active_at FROM cloud_v2_workspaces WHERE id=$1", [f.workspaceId])).rows[0]).toEqual(before);
    }
  });

  it("does not consult source continuation for a sync grant", async () => {
    const source = vi.spyOn(CloudV2SourceAuthority.prototype, "continueWorkspace");
    await pool.query("UPDATE cloud_v2_workspaces SET access_epoch=access_epoch+1 WHERE id=$1", [f.workspaceId]);
    await pool.query(`UPDATE cloud_github_source_verifications SET verified_at=clock_timestamp()-interval '20 minutes',
      failure_code='github_unavailable',failure_status=503,retry_at=clock_timestamp()+interval '1 minute' WHERE org_id=$1`, [f.organizationId]);
    f.fetcher.mockClear();
    expect((await f.grant(mac.headers)).status).toBe(200);
    expect(source).not.toHaveBeenCalled();
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it.each([false, true])("never exposes an adoption candidate and follows only a promoted capable boot (rollback=%s)", async rollback => {
    const handoffs = f.cp.workers.runtimeHandoffs!;
    await handoffs.recordRuntime(f.token, f.boot, "a".repeat(64));
    const current = (await f.cp.store.workerSession(f.token, f.boot))!;
    const h = (await handoffs.prepare(f.token, f.boot, { target: "b".repeat(64), instanceId: randomUUID(), revision: current.loginRevision, generation: 7 }))!;
    expect(await handoffs.commit(f.token, f.boot, h.id, current.loginRevision, 7, h.target_sha256)).toBe(true);
    await handoffs.activate(f.token, h.id);
    expect((await f.grant(mac.headers)).status).toBe(409);
    expect((await f.hello("sync-v1", h.next_boot_id, h.id)).status).toBe(200);
    expect((await f.hello("", f.boot, undefined, h.previous_sha256)).status).toBe(200);
    expect((await pool.query("SELECT sync_boot_ids FROM cloud_v2_workspaces WHERE id=$1", [f.workspaceId])).rows[0].sync_boot_ids).toEqual([h.next_boot_id]);
    let boot = h.next_boot_id;
    if (rollback) {
      const fallback = (await handoffs.rollback(h.id))!; boot = fallback.rollback_boot_id;
      expect((await f.hello("sync-v1", boot, h.id, h.previous_sha256)).status).toBe(200);
    }
    expect(await handoffs.promote(f.token, h.id, boot)).toBe(true);
    const response = await f.grant(mac.headers);
    expect(response.status).toBe(200);
    const claims = JSON.parse(Buffer.from((await response.json()).grant.split(".")[1], "base64url").toString());
    expect(claims.boot).toBe(boot);
  });

  it("inherits system-only RLS and accepts released workspace/device SQL shapes", async () => {
    expect(await withUserTx(pool, f.owner.id, async tx => (await tx.query("SELECT syncing FROM cloud_v2_connected_macs WHERE workspace_id=$1", [f.workspaceId])).rows)).toEqual([]);
    expect(await withUserTx(pool, f.owner.id, async tx => (await tx.query("UPDATE cloud_v2_connected_macs SET syncing=true WHERE workspace_id=$1", [f.workspaceId])).rowCount)).toBe(0);
    await withSystemTx(pool, async tx => {
      await tx.query("UPDATE cloud_v2_workspaces SET active_at=active_at WHERE id=$1", [f.workspaceId]);
      await tx.query(`INSERT INTO cloud_v2_connected_macs(workspace_id,user_id,device_id,registration_id,is_latest_sender)
        VALUES($1,$2,$3,$4,false) ON CONFLICT(workspace_id,user_id,device_id) DO UPDATE SET registration_id=EXCLUDED.registration_id,
          disconnected_at=NULL,connected_at=clock_timestamp()`, [f.workspaceId, f.owner.id, mac.device.deviceId, mac.device.registrationId]);
    });
    expect((await pool.query("SELECT syncing FROM cloud_v2_connected_macs WHERE workspace_id=$1", [f.workspaceId])).rows).toEqual([{ syncing: false }]);
    await f.cp.store.transition(f.workspaceId, ["running"], "deleting");
    await f.cp.store.transition(f.workspaceId, ["deleting"], "deleted");
    expect((await pool.query("SELECT syncing FROM cloud_v2_connected_macs WHERE workspace_id=$1", [f.workspaceId])).rowCount).toBe(0);
  });
});

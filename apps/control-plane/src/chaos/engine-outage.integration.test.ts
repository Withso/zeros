import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { stopUnavailableCloudEngine } from "../cloud-workspaces/engine-health.js";
import { seedReadyCloudWorkspace } from "../cloud-workspaces/test-fixtures.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { DatabaseUplinkAuthority, type UplinkIdentity } from "../realtime/uplink-authority.js";
import { DatabaseUplinkLeaseStore } from "../realtime/uplink-lease.js";
import { faultInjectingPool } from "./fault-pool.js";

vi.setConfig({ testTimeout: 30_000 });

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("engine uplink and workspace liveness through a database outage", () => {
  let pool: pg.Pool;
  let identity: UplinkIdentity;
  let token: string;
  let workspaceId: string;
  let engineId: string;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    await pool.query("UPDATE managed_compute_provider_requirements SET require_credit=false WHERE provider='boat'");
    const f = await seedReadyCloudWorkspace(pool, { runtimeV4: true });
    const boot = (await pool.query<{ runtime_boot_id: string }>(
      "SELECT runtime_boot_id FROM cloud_workspace_engine_instances WHERE id=$1", [f.engineInstanceId])).rows[0]!.runtime_boot_id;
    identity = { workspaceId: f.workspaceId, organizationId: f.organizationId, generation: 1, engineInstanceId: f.engineInstanceId, bootId: boot };
    token = f.heartbeatToken;
    workspaceId = f.workspaceId;
    engineId = f.engineInstanceId;
  });

  const authority = (db: pg.Pool) => new DatabaseUplinkAuthority({ pool: db, workosEnabled: false });
  // A 10-minute outage leaves the last heartbeat 10 minutes old and the
  // 90 s lease lapsed 8.5 minutes ago.
  const lapseEngineLease = () => pool.query(
    "UPDATE cloud_workspace_engine_instances SET last_heartbeat_at=now()-interval '10 minutes',lease_expires_at=now()-interval '510 seconds' WHERE id=$1",
    [engineId]);
  const desired = async () => (await pool.query("SELECT desired_state FROM cloud_workspaces WHERE id=$1", [workspaceId])).rows[0].desired_state;

  it("answers an engine hello during a database outage as unavailable, never as a credential or authority rejection", async () => {
    const fault = faultInjectingPool(pool);
    fault.down();
    await expect(authority(fault.pool).verify(identity, token)).resolves.toEqual({ ok: false, reason: "unavailable" });
    fault.up();
    await expect(authority(fault.pool).verify(identity, token)).resolves.toMatchObject({ ok: true });
  });

  it("stops no workspace while the database is down", async () => {
    await lapseEngineLease();
    const fault = faultInjectingPool(pool);
    fault.down();
    await expect(stopUnavailableCloudEngine(fault.pool, null, workspaceId)).rejects.toMatchObject({ code: "database_acquire_unavailable" });
    fault.up();
    expect(await desired()).toBe("running");
  });

  // PLAN-v3 decision G: a control-plane outage stops no VM and disconnects
  // no one. An engine on lease.v1 renews a 36-minute lease over the uplink
  // every 5 minutes, so at least 31 minutes remain when an outage starts.
  // Moving the engine's timestamps back is the same as that much time
  // passing without a renewal.
  const leases = (db: pg.Pool) => new DatabaseUplinkLeaseStore({ pool: db, workosEnabled: false });
  const elapse = (minutes: number) => pool.query(
    `UPDATE cloud_workspace_engine_instances SET last_heartbeat_at=last_heartbeat_at-make_interval(mins=>$2),
       lease_expires_at=lease_expires_at-make_interval(mins=>$2) WHERE id=$1`, [engineId, minutes]);
  const recoversWithoutStopping = async () => {
    expect(await stopUnavailableCloudEngine(pool, null, workspaceId)).toBe(false);
    expect(await desired()).toBe("running");
    await expect(authority(pool).verify(identity, token)).resolves.toMatchObject({ ok: true });
    const renewed = await leases(pool).renew(identity, token);
    expect(renewed).toMatchObject({ ok: true });
    expect(renewed.ok ? renewed.leaseExpiresAtMs : 0).toBeGreaterThan(Date.now() + 35 * 60_000);
  };

  it("keeps a lease.v1 workspace running and its engine admitted through a 10-minute database outage", async () => {
    await expect(leases(pool).renew(identity, token)).resolves.toMatchObject({ ok: true });
    const fault = faultInjectingPool(pool);
    fault.down();
    await expect(leases(fault.pool).renew(identity, token)).resolves.toEqual({ ok: false, reason: "unavailable" });
    await expect(stopUnavailableCloudEngine(fault.pool, null, workspaceId)).rejects.toMatchObject({ code: "database_acquire_unavailable" });
    fault.up();
    // The outage began just before the next renewal: 5 minutes, then 10 down.
    await elapse(15);
    await recoversWithoutStopping();
  });

  it("keeps a lease.v1 workspace running through the 30-minute outage the S1 outage rule allows", async () => {
    await expect(leases(pool).renew(identity, token)).resolves.toMatchObject({ ok: true });
    await elapse(35);
    await recoversWithoutStopping();
  });

  // Engines without lease.v1 (old engines, or organizations without
  // engine_lease_over_uplink) keep the 90 s HTTP lease: a longer outage
  // still stops their workspace on recovery. A lapsed lease is never revived.
  it("stops an HTTP-lease workspace on recovery after an outage longer than its 90 s lease", async () => {
    await lapseEngineLease();
    expect(await stopUnavailableCloudEngine(pool, null, workspaceId)).toBe(true);
    expect(await desired()).toBe("stopped");
  });

  it("refuses an HTTP-lease engine's hello and renewal after an outage longer than its 90 s lease", async () => {
    await lapseEngineLease();
    await expect(authority(pool).verify(identity, token)).resolves.toEqual({ ok: false, reason: "authority" });
    await expect(leases(pool).renew(identity, token)).resolves.toEqual({ ok: false, reason: "authority" });
  });
});

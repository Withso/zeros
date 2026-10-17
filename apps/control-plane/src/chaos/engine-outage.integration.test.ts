import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { stopUnavailableCloudEngine } from "../cloud-workspaces/engine-health.js";
import { seedReadyCloudWorkspace } from "../cloud-workspaces/test-fixtures.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { DatabaseUplinkAuthority, type UplinkIdentity } from "../realtime/uplink-authority.js";
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

  // The target is PLAN-v3 decision G: a control-plane outage stops no VM and
  // disconnects no one. The fix that flips the two it.fails tests below and
  // deletes the stop test above needs a security decision about renewing a
  // lapsed engine lease.
  it("after an outage longer than the 90 s engine lease, recovery stops the workspace (decision G gap)", async () => {
    await lapseEngineLease();
    expect(await stopUnavailableCloudEngine(pool, null, workspaceId)).toBe(true);
    expect(await desired()).toBe("stopped");
  });

  it("after an outage longer than the 90 s engine lease, recovery refuses the engine's uplink hello (decision G gap)", async () => {
    await lapseEngineLease();
    await expect(authority(pool).verify(identity, token)).resolves.toEqual({ ok: false, reason: "authority" });
  });

  it.fails("keeps a workspace whose engine lease lapsed during a 10-minute database outage running after recovery", async () => {
    await lapseEngineLease();
    expect(await stopUnavailableCloudEngine(pool, null, workspaceId)).toBe(false);
    expect(await desired()).toBe("running");
  });

  it.fails("re-admits a connected engine whose lease lapsed during a 10-minute database outage", async () => {
    await lapseEngineLease();
    await expect(authority(pool).verify(identity, token)).resolves.toMatchObject({ ok: true });
  });
});

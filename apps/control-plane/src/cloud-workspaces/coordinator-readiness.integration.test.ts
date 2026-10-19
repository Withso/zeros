import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystemTx, withUserTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { seedReadyCloudWorkspace, type ReadyCloudWorkspaceFixture } from "./test-fixtures.js";
import { readCloudRuntimeTarget } from "./runtime-connect-routes.js";
import { readCloudWorkspaceDocument } from "./routes.js";
import { assertCurrentCloudEngineAuthority } from "./engine-authority.js";
import { stopUnavailableCloudEngine } from "./engine-health.js";
import { recordCloudCoordinatorReadiness, cloudEngineInteractive } from "./coordinator-readiness.js";
import type { CloudCoordinatorStatus } from "./coordinator-contract.js";
import { DatabaseUplinkPresenceStore } from "../realtime/uplink-presence.js";
import { readLifecycleDueInMs } from "./lifecycle-jobs.js";
import { readCapabilityPlacement } from "./capability-service-verifier.js";
import { issueCloudWorkspaceGrant } from "./grants.js";
import { withAuthorityDeadlineBarrier } from "./authority-deadline-test-utils.js";

vi.setConfig({ testTimeout: 15_000 });

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("coordinator readiness with PostgreSQL", () => {
  let pool: pg.Pool, f: ReadyCloudWorkspaceFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => { await resetMigratedTestDatabase(pool); f = await seedReadyCloudWorkspace(pool, { runtimeV4: true }); });
  const target = () => withSystemTx(pool, tx => readCloudRuntimeTarget(tx, { ...f, actorUserId: f.userId }, false));
  const document = () => withSystemTx(pool, tx => readCloudWorkspaceDocument(tx, f, null));
  const execution = () => withSystemTx(pool, tx => assertCurrentCloudEngineAuthority(tx, { ...f, generation: 1,
    workosEnabled: false }));
  const scope = () => ({ ...f, generation: 1 });
  async function optedIn(): Promise<CloudCoordinatorStatus> {
    const row = (await pool.query("UPDATE cloud_workspace_engine_instances SET coordinator_version=1 WHERE id=$1 RETURNING runtime_boot_id", [f.engineInstanceId])).rows[0];
    return { version: 1, bootId: row.runtime_boot_id, revision: 1, frontendId: randomUUID(), ready: true, expiresAtMs: Date.now() + 60_000 };
  }
  const record = (report: CloudCoordinatorStatus, receivedAtMs = Date.now()) =>
    withSystemTx(pool, tx => recordCloudCoordinatorReadiness(tx, scope(), report, receivedAtMs));

  it("frontend_exit_withdraws_all_interactive_readiness without retiring the execution owner", async () => {
    await pool.query(`UPDATE cloud_workspace_engine_instances SET coordinator_version=1,
      interactive_frontend_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',interactive_ready_until=now()+interval '1 minute' WHERE id=$1`, [f.engineInstanceId]);
    expect(await target()).toMatchObject({ engineInstanceId: f.engineInstanceId });
    expect((await document()).status).toBe("ready");
    await pool.query("UPDATE cloud_workspace_engine_instances SET interactive_ready_until=NULL WHERE id=$1", [f.engineInstanceId]);
    expect(await target()).toBeNull();
    expect((await document()).status).toBe("waking");
    await expect(execution()).resolves.toBeDefined();
    expect(await stopUnavailableCloudEngine(pool, null, f.workspaceId)).toBe(false);
    expect((await pool.query("SELECT state FROM cloud_workspace_engine_instances WHERE id=$1", [f.engineInstanceId])).rows[0].state).toBe("ready");
  });

  it("a delayed frontend-withdrawal write cannot keep catalog or connect ready beyond the proof deadline", async () => {
    await pool.query(`UPDATE cloud_workspace_engine_instances SET coordinator_version=1,
      interactive_frontend_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',interactive_ready_until=now()-interval '1 second',
      lease_expires_at=now()+interval '36 minutes' WHERE id=$1`, [f.engineInstanceId]);
    expect(await target()).toBeNull();
    expect((await document()).status).toBe("waking");
    await expect(execution()).resolves.toBeDefined();
    await stopUnavailableCloudEngine(pool, null, f.workspaceId);
    expect((await pool.query("SELECT operation FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 AND state IN ('queued','observing','dispatching')", [f.workspaceId])).rows).toEqual([]);
  });

  it("legacy engines retain readiness without a frontend lease", async () => {
    expect(await target()).toMatchObject({ engineInstanceId: f.engineInstanceId });
    expect((await document()).status).toBe("ready");
    await expect(execution()).resolves.toBeDefined();
  });

  it.each(["opt-in", "frontend"])("the database refuses a readiness deadline without a positive %s", async missing => {
    await expect(pool.query(`UPDATE cloud_workspace_engine_instances SET coordinator_version=$2,
      interactive_frontend_id=$3,interactive_ready_until=clock_timestamp()+interval '1 minute' WHERE id=$1`,
    [f.engineInstanceId, missing === "opt-in" ? null : 1, missing === "frontend" ? null : randomUUID()]))
      .rejects.toMatchObject({ code: "23514" });
  });

  it("orders API and S2 reports by the original boot revision, including late A after B", async () => {
    const first = await optedIn(); expect(await record(first)).toBe(true);
    const store = new DatabaseUplinkPresenceStore(pool), at = Date.now();
    const presence = { ...scope(), connectionId: randomUUID(), realtimeInstance: "fixture", protocol: 1,
      connected: true, ready: false, phase: "starting" as const, connectedAtMs: at, lastSeenAtMs: at, disconnectedAtMs: null };
    await store.write({ ...presence, coordinator: { report: { ...first, revision: 2, ready: false, expiresAtMs: 0 }, receivedAtMs: at } });
    expect(await target()).toBeNull();
    expect(await record(first)).toBe(false);
    expect(await record({ ...first, revision: 100, bootId: randomUUID() })).toBe(false);
    const replacement = { ...first, revision: 3, frontendId: randomUUID() };
    expect(await record(replacement)).toBe(true);
    await store.write({ ...presence, coordinator: { report: { ...first, revision: 2, ready: false, expiresAtMs: 0 }, receivedAtMs: at } });
    expect(await target()).not.toBeNull();
    expect((await pool.query("SELECT interactive_revision,interactive_frontend_id FROM cloud_workspace_engine_instances WHERE id=$1", [f.engineInstanceId])).rows[0])
      .toEqual({ interactive_revision: "3", interactive_frontend_id: replacement.frontendId });
  });

  it("a report held behind the workspace lock cannot publish readiness past its original deadline", async () => {
    const report = { ...await optedIn(), expiresAtMs: Date.now() + 200 };
    const blocker = await pool.connect(); let pending: Promise<boolean> | undefined;
    try {
      await blocker.query("BEGIN"); await blocker.query("SELECT 1 FROM cloud_workspaces WHERE id=$1 FOR UPDATE", [f.workspaceId]);
      pending = record(report);
      await expect.poll(async () => (await pool.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid))>0 AND datname=current_database()" )).rows[0].count).toBeGreaterThan(0);
      await blocker.query("SELECT pg_sleep(0.25)"); await blocker.query("COMMIT");
      expect(await pending).toBe(true);
      expect(await target()).toBeNull(); expect((await document()).status).toBe("waking");
      await expect(execution()).resolves.toBeDefined();
    } finally { await blocker.query("ROLLBACK"); blocker.release(); await pending; }
  });

  it("does not extend the observation on a delayed presence retry, even with a far-future owner clock", async () => {
    const report = { ...await optedIn(), expiresAtMs: Date.now() + 3600_000 };
    expect(await record(report, Date.now() - 91_000)).toBe(true);
    expect(await target()).toBeNull();
  });

  it("uses the engine-health deadline to notify catalog expiry without admitting a stop", async () => {
    const report = await optedIn(); await record(report);
    await pool.query("UPDATE cloud_workspace_engine_instances SET lease_expires_at=now()+interval '36 minutes',interactive_ready_until=now()-interval '1 second' WHERE id=$1", [f.engineInstanceId]);
    const due = await readLifecycleDueInMs(pool, "engineHealth", f.workspaceId, { provider: null, driftIntervalMs: 60_000 });
    expect(due).toBeLessThan(0);
    const before = Number((await document()).version);
    expect(await stopUnavailableCloudEngine(pool, null, f.workspaceId)).toBe(true);
    expect(Number((await document()).version)).toBeGreaterThan(before);
    expect(await readLifecycleDueInMs(pool, "engineHealth", f.workspaceId, { provider: null, driftIntervalMs: 60_000 })).toBeGreaterThan(35 * 60_000);
    expect((await pool.query("SELECT 1 FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1", [f.workspaceId])).rows).toHaveLength(0);
    await expect(execution()).resolves.toBeDefined();
  });

  it("keeps execution placement live while the final client admission fence is unavailable", async () => {
    await optedIn();
    expect((await readCapabilityPlacement(pool, f))?.engineInstanceId).toBe(f.engineInstanceId);
    expect(await withSystemTx(pool, tx => cloudEngineInteractive(tx, scope()))).toBe(false);
    await expect(execution()).resolves.toBeDefined();
  });

  it("refuses an endpoint grant whose interactive deadline expires during its insert", async () => {
    await record(await optedIn());
    const controlled = withAuthorityDeadlineBarrier(pool, /INSERT INTO cloud_workspace_endpoint_grants/, client =>
      client.query("UPDATE cloud_workspace_engine_instances SET interactive_ready_until=clock_timestamp()-interval '1 second' WHERE id=$1", [f.engineInstanceId]));
    await expect(withSystemTx(controlled, tx => issueCloudWorkspaceGrant(tx, { ...scope(), accountUserId: f.userId,
      audience: "https://engine.example.test/", purpose: "engine-connect", ttlSeconds: 15, issuedBy: f.userId })))
      .rejects.toMatchObject({ code: "grant_subject_not_authorized" });
  });

  it("does not bypass engine RLS or the exact tenant/generation fence", async () => {
    const report = await optedIn();
    expect(await withUserTx(pool, f.userId, tx => recordCloudCoordinatorReadiness(tx, scope(), report, Date.now()))).toBe(false);
    for (const change of [{ organizationId: randomUUID() }, { generation: 2 }, { engineInstanceId: randomUUID() }]) {
      expect(await withSystemTx(pool, tx => recordCloudCoordinatorReadiness(tx, { ...scope(), ...change }, report, Date.now()))).toBe(false);
    }
    expect(await target()).toBeNull();
    expect(await record(report)).toBe(true);
  });
});

import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystemTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { seedReadyCloudWorkspace, type ReadyCloudWorkspaceFixture } from "./test-fixtures.js";
import { seedRuntimeBundle } from "./runtime-test-fixtures.js";
import { DatabaseCloudRuntimeTransitionService } from "./runtime-transfer.js";
import { DatabaseRuntimeStagingStore } from "./runtime-staging-store.js";
import { CloudRuntimeStagingWorker } from "./runtime-staging-worker.js";
import { notifyRuntimeStaging } from "./runtime-staging-notification.js";

(process.env.TEST_DATABASE_URL ? describe : describe.skip)("runtime staging discovery and source fences", () => {
  let pool: pg.Pool, fixture: ReadyCloudWorkspaceFixture;
  let store: DatabaseRuntimeStagingStore, transitions: DatabaseCloudRuntimeTransitionService;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL }); });
  afterAll(async () => pool.end());
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    fixture = await seedReadyCloudWorkspace(pool, { runtimeV4: true });
    await pool.query("UPDATE managed_compute_provider_requirements SET require_credit=false WHERE provider='boat'");
    await pool.query(`INSERT INTO cloud_workspace_setup_attestations (
      setup_run_id,workspace_id,generation,org_id,execution_fence,image_ref,image_source_commit,
      repository_revision,repository_commit,settings_version,settings_snapshot_sha256,
      engine_instance_id,engine_protocol_version,engine_health,durable_record_connected,
      runtime_id,runtime_manifest_sha256,runtime_base_image_id,runtime_base_compatibility_id,runtime_profile,runtime_engine_protocol_version,
      runtime_installer_receipt_sha256,runtime_boot_id,runtime_supervisor_session_id)
      SELECT run.id,run.workspace_id,run.generation,run.org_id,run.execution_fence,g.image_ref,g.source_commit,
        'main',$2,1,spec.settings_snapshot_sha256,engine.id,engine.protocol_version,'ready',true,
        g.runtime_id,g.runtime_manifest_sha256,g.runtime_base_image_id,g.runtime_base_compatibility_id,g.runtime_profile,g.runtime_engine_protocol_version,
        engine.runtime_installer_receipt_sha256,engine.runtime_boot_id,engine.runtime_supervisor_session_id
      FROM cloud_workspace_setup_runs run JOIN cloud_workspace_generations g USING(workspace_id,generation,org_id)
      JOIN cloud_workspace_setup_specs spec USING(workspace_id,generation,org_id)
      JOIN cloud_workspace_engine_instances engine ON engine.setup_run_id=run.id WHERE run.workspace_id=$1`,
    [fixture.workspaceId, "c".repeat(40)]);
    await pool.query("UPDATE cloud_workspace_setup_runs SET state='succeeded',completed_at=now(),lease_owner=NULL,lease_expires_at=NULL WHERE workspace_id=$1", [fixture.workspaceId]);
    await pool.query("UPDATE cloud_workspaces SET status='busy' WHERE id=$1", [fixture.workspaceId]);
    await withSystemTx(pool, tx => seedRuntimeBundle(tx, { digit: "2", releaseOrder: 2 }));
    store = new DatabaseRuntimeStagingStore({ pool, qualificationMode: "full", workosEnabled: false });
    transitions = new DatabaseCloudRuntimeTransitionService({ pool, qualificationMode: "full", workosEnabled: false });
  });
  async function claim() {
    const item = (await store.discover(null, 16)).items[0]!;
    const offered = await transitions.offer(item);
    expect(offered).not.toBeNull();
    return (await transitions.claim({ workspaceId: fixture.workspaceId, organizationId: fixture.organizationId,
      transitionId: offered!.transitionId }, "zeros-v2-test-stage"))!;
  }

  it("discovers busy running work immediately and preserves idempotent offer identity across restarts", async () => {
    const first = await store.discover(null, 16), second = await store.discover(null, 16);
    expect(first).toEqual(second);
    expect(first.items).toEqual([expect.objectContaining({ workspaceId: fixture.workspaceId, organizationId: fixture.organizationId,
      generation: 1, sourceEngineInstanceId: fixture.engineInstanceId, mode: "engine" })]);
    const claimed = await claim();
    const plan = await store.read(claimed);
    expect(plan).toMatchObject({ phase: "offered", target: { runtimeId: `r1-${"2".repeat(64)}` } });
    expect((await pool.query("SELECT current_generation,status FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0])
      .toEqual({ current_generation: 1, status: "busy" });
    expect((await pool.query("SELECT 1 FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1", [fixture.workspaceId])).rowCount).toBe(0);
  });

  it("persists the verified stage receipt and releases HU's real claim while the source keeps serving", async () => {
    const run = vi.fn(async (_resource, input) => ({ schema: input.schema, operation: "stage" as const,
      transitionId: input.transitionId, fence: input.fence, scope: input.scope, outcome: "staged" as const }));
    const worker = new CloudRuntimeStagingWorker({ store, transitions, run, artifacts: {
      presignGet: async (_key, ttl) => ({ url: "https://objects.example.test/staging",
        expiresAt: new Date(Date.now() + ttl * 1000).toISOString() }),
    } });
    const stop = worker.start();
    try {
      await expect.poll(async () => (await pool.query("SELECT phase,worker_id FROM cloud_workspace_runtime_transitions")).rows)
        .toEqual([{ phase: "staged", worker_id: null }]);
      expect(run).toHaveBeenCalledOnce();
      expect((await pool.query("SELECT current_generation,status FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0])
        .toEqual({ current_generation: 1, status: "busy" });
      expect((await pool.query("SELECT state FROM cloud_workspace_engine_instances WHERE id=$1", [fixture.engineInstanceId])).rows[0])
        .toEqual({ state: "ready" });
    } finally { await stop(); }
  });

  it("recovers an expired offer under a fresh idempotency key without looping inside its retry window", async () => {
    const first = (await store.discover(null, 16)).items[0]!;
    const owned = await claim();
    expect(await transitions.cancelStaging(owned)).toBe(true);
    expect((await store.discover(null, 16)).items).toEqual([]);
    // The journal permits shortening a deadline, never extending one. No
    // clock mocking or trigger bypass is needed to exercise expired recovery.
    await pool.query("UPDATE cloud_workspace_runtime_transitions SET stage_deadline_at=clock_timestamp() WHERE transition_id=$1", [owned.transitionId]);
    const retry = (await store.discover(null, 16)).items[0]!;
    expect(retry.operationId).not.toBe(first.operationId);
    expect((await store.discover(null, 16)).items[0]!.operationId).toBe(retry.operationId);
    expect(await transitions.offer(retry)).toMatchObject({ sourceGeneration: 1, candidateGeneration: 3, phase: "offered" });
    expect((await pool.query("SELECT current_generation,status FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0])
      .toEqual({ current_generation: 1, status: "busy" });
  });

  it("delivers empty qualification/release hints only after their transaction commits", async () => {
    const listener = await pool.connect(), notices: pg.Notification[] = [];
    listener.on("notification", notice => notices.push(notice));
    try {
      await listener.query("LISTEN zeros_cloud_runtime_staging_work");
      await expect(withSystemTx(pool, async tx => { await notifyRuntimeStaging(tx); throw new Error("rollback"); })).rejects.toThrow("rollback");
      await withSystemTx(pool, async tx => {
        await notifyRuntimeStaging(tx);
        expect(notices).toEqual([]);
      });
      await expect.poll(() => notices.map(notice => ({ channel: notice.channel, payload: notice.payload })))
        .toEqual([{ channel: "zeros_cloud_runtime_staging_work", payload: "" }]);
    } finally { listener.release(true); }
  });

  it.each(["revoked", "superseded", "source_stopped", "source_replaced", "foreign_org", "stale_claim"])("rejects %s at the final staging read", async change => {
    const owned = await claim();
    if (change === "revoked") await pool.query("UPDATE cloud_runtime_bundles SET revoked_at=now() WHERE runtime_id=$1", [`r1-${"2".repeat(64)}`]);
    if (change === "superseded") await withSystemTx(pool, tx => seedRuntimeBundle(tx, { digit: "3", releaseOrder: 3 }));
    if (change === "source_stopped") await pool.query("UPDATE cloud_workspaces SET desired_state='stopped' WHERE id=$1", [fixture.workspaceId]);
    if (change === "source_replaced") await pool.query("UPDATE cloud_workspace_engine_instances SET state='revoked',revoked_at=now() WHERE id=$1", [fixture.engineInstanceId]);
    if (change === "foreign_org") owned.organizationId = randomUUID();
    if (change === "stale_claim") owned.workerFence = randomUUID();
    expect(await store.read(owned)).toBeNull();
  });

  it("ignores unconfirmed and incompletely qualified releases, stopped workspaces and non-staff owners", async () => {
    await pool.query("UPDATE cloud_runtime_bundles SET revoked_at=now() WHERE runtime_id=$1", [`r1-${"2".repeat(64)}`]);
    await withSystemTx(pool, tx => seedRuntimeBundle(tx, { digit: "3", releaseOrder: 3, confirmed: false }));
    await withSystemTx(pool, tx => seedRuntimeBundle(tx, { digit: "4", releaseOrder: 4, kinds: ["claude-setup-token"] }));
    expect((await store.discover(null, 16)).items).toEqual([]);
    await withSystemTx(pool, tx => seedRuntimeBundle(tx, { digit: "5", releaseOrder: 5 }));
    expect((await store.discover(null, 16)).items).toHaveLength(1);
    await pool.query("UPDATE cloud_workspaces SET desired_state='stopped' WHERE id=$1", [fixture.workspaceId]);
    expect((await store.discover(null, 16)).items).toEqual([]);
    await pool.query("UPDATE cloud_workspaces SET desired_state='running' WHERE id=$1", [fixture.workspaceId]);
    await pool.query("UPDATE users SET staff_role=NULL WHERE id=$1", [fixture.userId]);
    expect((await store.discover(null, 16)).items).toEqual([]);
  });
});

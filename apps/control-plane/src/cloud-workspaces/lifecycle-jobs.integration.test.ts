import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { claimJobs, completeJob, type ClaimedJob } from "../job-queue.js";
import { withSystemTx } from "../db.js";
import { CloudWorkspaceReconciler } from "./reconciler.js";
import type { CloudWorkspaceProvider } from "./provider.js";
import { LIFECYCLE_JOB_KINDS, readLifecycleDueInMs, type LifecycleWork } from "./lifecycle-jobs.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const d = databaseUrl ? describe : describe.skip;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const provider = { name: "boat", async *listManaged() {} } as unknown as CloudWorkspaceProvider;
const scope = { provider: null, driftIntervalMs: 60_000 };

d("lifecycle jobs", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString: databaseUrl, max: 6 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => { await resetMigratedTestDatabase(pool); });

  const reconciler = () => new CloudWorkspaceReconciler({ pool, provider, intervalMs: 60_000, logger });
  type JobRow = { state: string; delay_ms: number; rerun_ms: number | null; payload: Record<string, unknown> };
  async function job(work: LifecycleWork, workspaceId: string | null): Promise<JobRow | undefined> {
    return (await pool.query<JobRow>(`SELECT state, payload,
        (extract(epoch FROM (run_at-now()))*1000)::float8 AS delay_ms, (extract(epoch FROM (rerun_at-now()))*1000)::float8 AS rerun_ms
      FROM control_plane_jobs WHERE kind=$1 AND dedupe_key=$2 AND state IN ('queued','running')`,
    [LIFECYCLE_JOB_KINDS[work], workspaceId ? `workspace:${workspaceId}` : "singleton"])).rows[0];
  }
  async function claim(work: LifecycleWork): Promise<ClaimedJob[]> {
    return (await claimJobs(pool, { owner: "lifecycle-test", limit: 100, kinds: [{ kind: LIFECYCLE_JOB_KINDS[work], leaseMs: 60_000 }] })).jobs;
  }
  // One claim round: the jobs due now, not the ones their runs requeue.
  async function runDue(work: LifecycleWork, worker = reconciler()): Promise<number> {
    const jobs = await claim(work);
    for (const claimed of jobs) {
      await worker.runJob(claimed);
      await completeJob(pool, claimed);
    }
    return jobs.length;
  }
  const engineLease = (f: { engineInstanceId: string }, interval: string) => pool.query(
    `UPDATE cloud_workspace_engine_instances SET last_heartbeat_at=now()-interval '1 hour',
      lease_expires_at=now()+$2::interval WHERE id=$1`, [f.engineInstanceId, interval]);

  it("enqueues a deadline in its writer's transaction and moves a queued job only earlier", async () => {
    const f = await seedReadyCloudWorkspace(pool);
    expect(await job("engineHealth", f.workspaceId)).toMatchObject({ state: "queued" });
    expect(await runDue("engineHealth")).toBe(1);
    // Rescheduled at the engine's lease expiry, the exact next due time.
    const scheduled = await job("engineHealth", f.workspaceId);
    expect(scheduled?.delay_ms).toBeCloseTo((await readLifecycleDueInMs(pool, "engineHealth", f.workspaceId, scope))!, -3);
    // Renewals only move the deadline later and write no job.
    await engineLease(f, "10 minutes");
    expect((await job("engineHealth", f.workspaceId))?.delay_ms).toBeCloseTo(scheduled!.delay_ms, -3);
    // A shortened lease moves it earlier; a rolled-back writer leaves nothing.
    const writer = await pool.connect();
    try {
      await writer.query("BEGIN");
      await writer.query("UPDATE cloud_workspace_engine_instances SET lease_expires_at=now()+interval '1 second' WHERE id=$1", [f.engineInstanceId]);
      await writer.query("ROLLBACK");
    } finally { writer.release(); }
    expect((await job("engineHealth", f.workspaceId))?.delay_ms).toBeCloseTo(scheduled!.delay_ms, -3);
    await engineLease(f, "1 second");
    expect((await job("engineHealth", f.workspaceId))?.delay_ms).toBeLessThanOrEqual(1_000);
  });

  it("runs due work once for its own workspace and removes the job when nothing remains pending", async () => {
    const expired = await seedReadyCloudWorkspace(pool);
    const healthy = await seedReadyCloudWorkspace(pool);
    await runDue("engineHealth");
    await engineLease(expired, "-1 second");
    expect((await job("engineHealth", expired.workspaceId))?.delay_ms).toBeLessThanOrEqual(0);
    // The healthy workspace's job is not due; only the expired one runs.
    expect(await runDue("engineHealth")).toBe(1);
    const intents = await pool.query<{ workspace_id: string; operation: string }>(
      "SELECT workspace_id, operation FROM cloud_workspace_lifecycle_intents WHERE state IN ('queued','dispatching','observing')");
    expect(intents.rows).toEqual([{ workspace_id: expired.workspaceId, operation: "stop" }]);
    // The run's own revocation requested one more run, which finds the stop
    // excluding engine health and removes the job. The stop itself has a
    // lifecycle job due now.
    expect(await runDue("engineHealth")).toBe(1);
    expect(await job("engineHealth", expired.workspaceId)).toBeUndefined();
    expect(await job("engineHealth", healthy.workspaceId)).toMatchObject({ state: "queued" });
    expect((await job("lifecycle", expired.workspaceId))?.delay_ms).toBeLessThanOrEqual(0);
    expect(await runDue("engineHealth")).toBe(0);
  });

  it("drops a superseded intent's job and wakes the work its exclusion was holding back", async () => {
    const f = await seedReadyCloudWorkspace(pool);
    await runDue("engineHealth");
    await runDue("drift");
    const intentId = randomUUID();
    await withSystemTx(pool, tx => tx.query(`INSERT INTO cloud_workspace_lifecycle_intents
      (id, workspace_id, org_id, generation, operation, idempotency_key, request_sha256, next_attempt_at)
      VALUES ($1::uuid, $2, $3, 1, 'stop', $1::text, $4, now()+interval '1 hour')`, [intentId, f.workspaceId, f.organizationId, randomBytes(32)]));
    expect((await job("lifecycle", f.workspaceId))?.delay_ms).toBeGreaterThan(3_500_000);
    await pool.query("UPDATE cloud_workspace_lifecycle_intents SET state='superseded', completed_at=now() WHERE id=$1", [intentId]);
    expect((await job("lifecycle", f.workspaceId))?.delay_ms).toBeLessThanOrEqual(0);
    expect((await job("engineHealth", f.workspaceId))?.delay_ms).toBeLessThanOrEqual(0);
    expect(await runDue("lifecycle")).toBe(1);
    expect(await job("lifecycle", f.workspaceId)).toBeUndefined();
  });

  it("reads the slow drift cadence once a workspace settles stopped and the fast one while running", async () => {
    const f = await seedReadyCloudWorkspace(pool);
    const slowScope = { provider: null, driftIntervalMs: 60_000, stoppedDriftIntervalMs: 6 * 60 * 60_000 };
    await pool.query(`UPDATE cloud_workspace_provider_bindings
      SET last_observed_at=now(), next_drift_check_at=now()-interval '1 second' WHERE workspace_id=$1`, [f.workspaceId]);
    const running = await readLifecycleDueInMs(pool, "drift", f.workspaceId, slowScope);
    expect(running).toBeGreaterThan(0);
    expect(running).toBeLessThanOrEqual(60_000);
    await pool.query("UPDATE cloud_workspaces SET desired_state='stopped', status='stopped' WHERE id=$1", [f.workspaceId]);
    expect(await readLifecycleDueInMs(pool, "drift", f.workspaceId, slowScope)).toBeGreaterThan(5 * 60 * 60_000);
  });

  it("runs the hourly diagnostic retention as its own job", async () => {
    await pool.query("UPDATE cloud_workspace_diagnostic_cleanup SET next_run_at=now()-interval '1 second'");
    expect((await job("diagnostics", null))?.delay_ms).toBeLessThanOrEqual(0);
    expect(await runDue("diagnostics")).toBe(1);
    expect((await pool.query("SELECT next_run_at > now()+interval '30 minutes' AS later FROM cloud_workspace_diagnostic_cleanup")).rows[0]).toEqual({ later: true });
    expect((await job("diagnostics", null))?.delay_ms).toBeGreaterThan(30 * 60_000);
  });

  it("records a deadline written during a run as that job's next run", async () => {
    const f = await seedReadyCloudWorkspace(pool);
    const [running] = await claim("engineHealth");
    await engineLease(f, "2 seconds");
    expect((await job("engineHealth", f.workspaceId))?.rerun_ms).toBeLessThanOrEqual(2_000);
    await reconciler().runJob(running!);
    expect(await completeJob(pool, running!)).toBe("requeued");
    expect((await job("engineHealth", f.workspaceId))?.delay_ms).toBeLessThanOrEqual(2_000);
  });

  it("leaves work a shutdown interrupted due now instead of dropping its job", async () => {
    const f = await seedReadyCloudWorkspace(pool);
    await engineLease(f, "-1 second");
    const [running] = await claim("engineHealth");
    const worker = reconciler();
    await worker.stop();
    await worker.runJob(running!);
    expect(await completeJob(pool, running!)).toBe("requeued");
    expect((await job("engineHealth", f.workspaceId))?.delay_ms).toBeLessThanOrEqual(0);
    expect((await pool.query("SELECT 1 FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 AND operation='stop'", [f.workspaceId])).rowCount).toBe(0);
  });

  it("retries a job whose worker lost its lease", async () => {
    const f = await seedReadyCloudWorkspace(pool);
    const [first] = await claim("engineHealth");
    expect(first?.workspaceId).toBe(f.workspaceId);
    await pool.query("UPDATE control_plane_jobs SET locked_until=now()-interval '1 second' WHERE id=$1", [first!.id]);
    const [retry] = await claim("engineHealth");
    expect(retry).toMatchObject({ id: first!.id, attempts: 2 });
    expect(await completeJob(pool, first!)).toBe("lost");
  });

  it("backs off a due job whose claim is contended instead of spinning", async () => {
    const f = await seedReadyCloudWorkspace(pool);
    await engineLease(f, "-1 second");
    const [contended] = await claim("engineHealth");
    const locker = await pool.connect();
    try {
      await locker.query("BEGIN");
      await locker.query("SELECT 1 FROM organizations WHERE id=$1 FOR UPDATE", [f.organizationId]);
      await reconciler().runJob(contended!);
      expect(await completeJob(pool, contended!)).toBe("requeued");
      const backedOff = await job("engineHealth", f.workspaceId);
      expect(backedOff?.payload).toEqual({ emptyRuns: 1 });
      expect(backedOff?.delay_ms).toBeGreaterThan(500);
      expect(backedOff?.delay_ms).toBeLessThanOrEqual(1_000);
    } finally { await locker.query("ROLLBACK"); locker.release(); }
    // A domain write resets the streak and wakes the job now.
    await pool.query("UPDATE cloud_workspace_engine_instances SET state='revoked', revoked_at=now() WHERE id=$1", [f.engineInstanceId]);
    expect(await job("engineHealth", f.workspaceId)).toMatchObject({ payload: {} });
    expect((await job("engineHealth", f.workspaceId))?.delay_ms).toBeLessThanOrEqual(0);
  });

  it("audits pending deadlines whose job was lost, then finds nothing to repair", async () => {
    const f = await seedReadyCloudWorkspace(pool);
    const worker = reconciler();
    // The test reset restores rows without firing triggers.
    await worker.auditJobs();
    await pool.query("UPDATE cloud_workspace_paid_authority_checks SET next_check_at=now()+interval '10 minutes' WHERE workspace_id=$1", [f.workspaceId]);
    // The earlier job runs early, finds nothing due and moves to the check.
    expect(await runDue("paidAuthority", worker)).toBe(1);
    expect((await job("paidAuthority", f.workspaceId))?.delay_ms).toBeGreaterThan(590_000);
    expect(await worker.auditJobs()).toEqual({});
    await pool.query("DELETE FROM control_plane_jobs");
    const repaired = await worker.auditJobs();
    expect(repaired).toMatchObject({ paidAuthority: 1, engineHealth: 1, drift: 1, diagnostics: 1 });
    expect((await job("paidAuthority", f.workspaceId))?.delay_ms).toBeGreaterThan(590_000);
    expect(await worker.auditJobs()).toEqual({});
  });
});

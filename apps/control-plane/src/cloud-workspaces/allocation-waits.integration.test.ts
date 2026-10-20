import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { seedReadyCloudWorkspace, type ReadyCloudWorkspaceFixture } from "./test-fixtures.js";
import { DatabaseManagedComputeCreditLedger } from "./compute-credits.js";
import { CloudWorkspaceComputeLeaseCoordinator, type ManagedComputeStart } from "./compute-leases.js";
import { CloudWorkspaceReconciler } from "./reconciler.js";
import { readLifecycleDueInMs } from "./lifecycle-jobs.js";
import { runDueLifecycleJobs } from "./lifecycle-job-test-utils.js";
import { lifecycleDatabaseCost } from "./lifecycle-cost-test-fixtures.js";
import { CloudProviderError, type CloudProviderResource, type CloudWorkspaceProvider } from "./provider.js";
import { withSystemTx } from "../db.js";
import { claimJobs, completeJob } from "../job-queue.js";
import { computeMicroUsd } from "./provider-compute.js";
import { DatabaseCloudAgentExecutionService } from "./agent-executions.js";
import { CloudAgentBootCredentialResponseSchema } from "./agent-boot-contract.js";
import { commitFinalSaveFixture, sealFinalSaveFixture } from "./final-save-test-fixtures.js";
import { enqueueWorkspaceCheckpointRequest } from "./checkpoint-requests.js";
import { ensureFinalSaveRecovery, finalSaveProven } from "./final-save-recovery.js";
import { confirmWorkspaceDeletion } from "./deletion-test-fixtures.js";
import { CloudWorkspaceOperationsWorker } from "./operations.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const policy = { provider: "boat", policyId: "allocation-wait-fixture", secondsPerDollar: 100_000,
  minimumTtlSeconds: 600, maximumTtlSeconds: 900, requestMarginSeconds: 60 };
const logger = { info() {}, warn() {}, error() {} };
const dueScope = { provider: null, driftIntervalMs: 1_000 };

database("T6 exact allocation dependency waits", () => {
  let pool: pg.Pool, fixture: ReadyCloudWorkspaceFixture;
  let prior: ManagedComputeStart, resource: CloudProviderResource;
  let coordinator: CloudWorkspaceComputeLeaseCoordinator;
  const provider = {
    name: "boat", create: vi.fn(), start: vi.fn(), stop: vi.fn(), archive: vi.fn(), delete: vi.fn(),
    computeWeight: vi.fn(() => ({ numerator: 1, denominator: 1 })),
    createWithComputeLease: vi.fn(async () => resource), startWithComputeLease: vi.fn(async () => resource),
    readComputeUsage: vi.fn(), renewComputeLease: vi.fn(),
    inspect: vi.fn(async () => resource), find: vi.fn(async () => [resource]),
    verifyAbsence: vi.fn(async () => false), async *listManaged() {},
  };
  const asProvider = () => provider as unknown as CloudWorkspaceProvider;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    vi.resetAllMocks();
    await resetMigratedTestDatabase(pool);
    fixture = await seedReadyCloudWorkspace(pool);
    await pool.query("UPDATE managed_compute_provider_requirements SET require_credit=true WHERE provider='boat'");
    const id = randomUUID();
    await pool.query(`INSERT INTO cloud_workspace_lifecycle_intents
      (id,workspace_id,org_id,generation,requested_by,operation,idempotency_key,request_sha256)
      VALUES($1::uuid,$2,$3,1,$4,'create',$1::text,$5)`,
    [id, fixture.workspaceId, fixture.organizationId, fixture.userId, randomBytes(32)]);
    prior = { workspaceId: fixture.workspaceId, organizationId: fixture.organizationId, generation: 1,
      intentId: id, idempotencyKey: id, imageRef: "fixture", architecture: "linux/amd64",
      cpuMillicores: 2_000, memoryMiB: 4_096, storageMiB: 20_480 };
    resource = { workspaceId: fixture.workspaceId, generation: 1, resourceId: `sandbox-${fixture.workspaceId}`,
      state: "running", target: null, metadata: { computeLeaseExpiresAt: new Date(Date.now() + 850_000).toISOString() } };
    provider.computeWeight.mockReturnValue({ numerator: 1, denominator: 1 });
    provider.createWithComputeLease.mockImplementation(async () => resource);
    provider.startWithComputeLease.mockImplementation(async () => {
      resource = { ...resource, state: "running", metadata: { computeLeaseExpiresAt: new Date(Date.now() + 850_000).toISOString() } };
      return resource;
    });
    provider.inspect.mockImplementation(async () => resource);
    provider.find.mockImplementation(async () => [resource]);
    provider.verifyAbsence.mockResolvedValue(false);
    provider.readComputeUsage.mockImplementation(async (id: string, window: { since: Date; until: Date }) => ({
      resourceId: id, since: window.since.toISOString(), until: window.until.toISOString(), billableSeconds: 600,
      secondsPerDollar: 100_000, listPriceMicroUsd: computeMicroUsd(600, 100_000), running: false,
    }));
    const ledger = new DatabaseManagedComputeCreditLedger({ pool, workosEnabled: false });
    await ledger.grant({ organizationId: fixture.organizationId, userId: fixture.userId,
      startsAt: new Date(Date.now() - 3_600_000), endsAt: new Date(Date.now() + 3_600_000),
      amountMicroUsd: 100_000, policyId: "fixture-credit", idempotencyKey: randomUUID() });
    coordinator = new CloudWorkspaceComputeLeaseCoordinator({ pool, provider: asProvider(), workosEnabled: false, policy });
    await coordinator.allocate(prior, asProvider(), null);
    await pool.query("UPDATE cloud_workspace_lifecycle_intents SET state='succeeded',completed_at=now() WHERE id=$1", [id]);
    vi.clearAllMocks();
  });

  async function wake(running = false) {
    resource = { ...resource, state: running ? "running" : "stopped" };
    const id = randomUUID();
    await pool.query("UPDATE cloud_workspaces SET status='waking' WHERE id=$1", [fixture.workspaceId]);
    await pool.query(`INSERT INTO cloud_workspace_lifecycle_intents
      (id,workspace_id,org_id,generation,requested_by,operation,idempotency_key,request_sha256)
      VALUES($1::uuid,$2,$3,1,$4,'wake',$1::text,$5)`,
    [id, fixture.workspaceId, fixture.organizationId, fixture.userId, randomBytes(32)]);
    return id;
  }
  const worker = (db = pool, enabled = true) => new CloudWorkspaceReconciler({ pool: db, provider: asProvider(),
    computePolicy: policy, workosEnabled: false, logger, intervalMs: 1_000,
    ...{ rolloutFlags: { enabled: (org: string, flag: string) => enabled && org === fixture.organizationId && flag === "lifecycle_allocation_waits",
      anyEnabled: () => enabled } },
  });
  const intent = async (id: string) => (await pool.query(`SELECT state,attempt_count,error_code,lease_owner,lease_expires_at,
    created_at,dispatched_at,next_attempt_at,updated_at FROM cloud_workspace_lifecycle_intents WHERE id=$1`, [id])).rows[0];
  async function edge(id: string) {
    // A missing expansion produces an assertion red on the unchanged parent,
    // rather than disguising a SQL/import error as the scheduling regression.
    if (!(await pool.query("SELECT to_regclass('cloud_workspace_lifecycle_allocation_waits') AS table_name")).rows[0].table_name) return undefined;
    return (await pool.query("SELECT * FROM cloud_workspace_lifecycle_allocation_waits WHERE lifecycle_intent_id=$1", [id])).rows[0];
  }
  const status = (id: string) => withSystemTx(pool, async tx =>
    (await tx.query("SELECT cloud_lifecycle_allocation_wait_status($1) AS state", [id])).rows[0].state as string);
  const due = () => readLifecycleDueInMs(pool, "lifecycle", fixture.workspaceId, dueScope);
  const lease = async () => (await pool.query("SELECT state,settled_at,stopped_observed_at FROM managed_compute_allocation_leases WHERE id=$1", [prior.intentId])).rows[0];
  async function settlePrevious(db = pool) {
    await pool.query("UPDATE managed_compute_allocation_leases SET requested_at=requested_at-interval '10 minutes',next_check_at=now() WHERE id=$1", [prior.intentId]);
    await pool.query(`UPDATE managed_compute_credit_reservations SET meter_since=meter_since-interval '10 minutes',
      meter_through=meter_through-interval '10 minutes' WHERE id=$1`, [prior.intentId]);
    const checker = new CloudWorkspaceComputeLeaseCoordinator({ pool: db, provider: asProvider(), workosEnabled: false, policy, logger });
    expect(await checker.runOnce(fixture.workspaceId)).toBe(true);
    expect((await lease()).state).not.toBe("settled");
    // Advance the observed database clock for the second independent pass;
    // the first pass above proves the real five-second final-meter floor.
    await pool.query(`UPDATE managed_compute_allocation_leases SET stopped_observed_at=clock_timestamp()-interval '10 seconds',
      next_check_at=clock_timestamp() WHERE id=$1`, [prior.intentId]);
    expect(await checker.runOnce(fixture.workspaceId)).toBe(true);
    expect((await lease()).state).toBe("settled");
    expect((await pool.query("SELECT 1 FROM managed_compute_credit_reservations WHERE id=$1 AND state='open'", [prior.intentId])).rowCount).toBe(0);
  }

  async function allocationOwner(known = true) {
    await pool.query(`INSERT INTO cloud_workspace_allocation_owners
      (workspace_id,org_id,provider_resource_id,original_generation,current_generation,allocation_lease_id)
      SELECT workspace_id,org_id,provider_resource_id,1,1,CASE WHEN $2 THEN id END
      FROM managed_compute_allocation_leases WHERE id=$1`, [prior.intentId, known]);
  }

  it("parks a real refused allocation without repeated provider attempts or failure backoff", async () => {
    const id = await wake(), cost = lifecycleDatabaseCost(pool), reconciler = worker(cost.pool);
    try {
      expect(await reconciler.runOnce(fixture.workspaceId)).toBe(true);
      const parked = await intent(id), firstCost = cost.snapshot();
      console.info("[t6-c2-wait]", JSON.stringify({ version: 1, stage: "first-refusal", database: firstCost,
        retryDelayMs: parked.next_attempt_at.getTime() - parked.updated_at.getTime() }));
      expect(parked).toMatchObject({ state: "observing", error_code: null, attempt_count: 1,
        lease_owner: null, lease_expires_at: null });
      expect(await edge(id)).toMatchObject({ state: "pending", allocation_lease_id: prior.intentId });
      expect(await readLifecycleDueInMs(pool, "lifecycle", fixture.workspaceId, dueScope)).toBeNull();
      const inspects = provider.inspect.mock.calls.length, weights = provider.computeWeight.mock.calls.length;
      for (let pass = 0; pass < 3; pass++) expect(await reconciler.runOnce(fixture.workspaceId)).toBe(false);
      const pendingCost = cost.snapshot();
      console.info("[t6-c2-wait]", JSON.stringify({ version: 1, stage: "three-pending-passes",
        checkouts: pendingCost.checkouts - firstCost.checkouts, roundTrips: pendingCost.roundTrips - firstCost.roundTrips,
        statements: pendingCost.statements - firstCost.statements, queryMs: pendingCost.queryMs - firstCost.queryMs,
        heldMs: pendingCost.heldMs - firstCost.heldMs, elapsedMs: pendingCost.elapsedMs - firstCost.elapsedMs }));
      await runDueLifecycleJobs(pool, reconciler, ["lifecycle"]);
      expect(await intent(id)).toEqual(parked);
      expect(provider.inspect).toHaveBeenCalledTimes(inspects);
      expect(provider.computeWeight).toHaveBeenCalledTimes(weights);
      expect(provider.startWithComputeLease).not.toHaveBeenCalled();
      expect((await pool.query("SELECT 1 FROM audit_log WHERE action='cloud_workspace.wake_retry_scheduled' AND subject->>'intentId'=$1", [id])).rowCount).toBe(0);
      expect(cost.snapshot().checkedOut).toBe(0);
    } finally { await reconciler.stop(); }
  });

  it("retains the legacy retry when the writer flag is off", async () => {
    const id = await wake(), cost = lifecycleDatabaseCost(pool), reconciler = worker(cost.pool, false);
    try {
      expect(await reconciler.runOnce(fixture.workspaceId)).toBe(true);
      const row = await intent(id);
      expect(row).toMatchObject({ state: "observing", error_code: "compute_previous_lease_pending", attempt_count: 1 });
      expect(row.next_attempt_at.getTime() - row.updated_at.getTime()).toBe(1_000);
      expect(await edge(id)).toBeUndefined();
      const firstCost = cost.snapshot();
      console.info("[t6-c2-wait]", JSON.stringify({ version: 1, stage: "legacy-first-refusal", database: firstCost,
        retryDelayMs: row.next_attempt_at.getTime() - row.updated_at.getTime() }));
      // Move only test scheduling time. The actual allocator repeats its work
      // in each pass; these fixture UPDATEs are outside the measured port.
      for (let pass = 0; pass < 3; pass++) {
        await pool.query("UPDATE cloud_workspace_lifecycle_intents SET next_attempt_at=clock_timestamp() WHERE id=$1", [id]);
        expect(await reconciler.runOnce(fixture.workspaceId)).toBe(true);
      }
      expect(await intent(id)).toMatchObject({ state: "observing", error_code: "compute_previous_lease_pending", attempt_count: 4 });
      const retryCost = cost.snapshot();
      console.info("[t6-c2-wait]", JSON.stringify({ version: 1, stage: "three-legacy-retries",
        checkouts: retryCost.checkouts - firstCost.checkouts, roundTrips: retryCost.roundTrips - firstCost.roundTrips,
        statements: retryCost.statements - firstCost.statements, queryMs: retryCost.queryMs - firstCost.queryMs,
        heldMs: retryCost.heldMs - firstCost.heldMs, elapsedMs: retryCost.elapsedMs - firstCost.elapsedMs }));
    } finally { await reconciler.stop(); }
  });

  it("keeps funded running reuse legal before considering a previous lease wait", async () => {
    const id = await wake(true), reconciler = worker();
    try {
      expect(await reconciler.runOnce(fixture.workspaceId)).toBe(true);
      expect(await intent(id)).toMatchObject({ state: "succeeded", error_code: null });
      expect(await edge(id)).toBeUndefined();
      expect(provider.startWithComputeLease).not.toHaveBeenCalled();
      expect(provider.createWithComputeLease).not.toHaveBeenCalled();
    } finally { await reconciler.stop(); }
  });

  it.each(["lease", "owner"])("parks a foreign allocation with a held %s row without waiting under workspace locks", async held => {
    if (held === "owner") await allocationOwner();
    const id = await wake(), holder = await pool.connect();
    const bounded = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2, options: "-c lock_timeout=500ms" });
    const reconciler = worker(bounded);
    try {
      await holder.query("BEGIN");
      await holder.query(held === "lease" ? "SELECT 1 FROM managed_compute_allocation_leases WHERE id=$1 FOR UPDATE"
        : "SELECT 1 FROM cloud_workspace_allocation_owners WHERE allocation_lease_id=$1 FOR UPDATE", [prior.intentId]);
      expect(await reconciler.runOnce(fixture.workspaceId)).toBe(true);
      expect(await intent(id)).toMatchObject({ state: "observing", error_code: null, lease_owner: null });
      expect(await edge(id)).toMatchObject({ state: "pending", allocation_lease_id: prior.intentId });
      // No hidden FK/key-share lock on the lease; the same transaction can
      // subsequently obtain the parent while this edge remains committed.
      await holder.query("SET LOCAL lock_timeout='500ms'");
      await holder.query("SELECT 1 FROM cloud_workspaces WHERE id=$1 FOR UPDATE", [fixture.workspaceId]);
      expect(provider.startWithComputeLease).not.toHaveBeenCalled();
    } finally {
      await holder.query("ROLLBACK"); holder.release(); await reconciler.stop(); await bounded.end();
    }
  });

  it("continues from exact independent settlement with no error retry timer, even after disabling the writer", async () => {
    const id = await wake(), reconciler = worker();
    let settledCommitAt: number | undefined, startedAt: number | undefined, settlementWrite = false;
    const cost = lifecycleDatabaseCost(pool, async sql => {
      if (sql.includes("SET state='settled',settled_at=")) settlementWrite = true;
      if (settlementWrite && settledCommitAt === undefined && sql === "COMMIT") settledCommitAt = performance.now();
    });
    try {
      await reconciler.runOnce(fixture.workspaceId);
      const original = await intent(id);
      await runDueLifecycleJobs(pool, reconciler, ["lifecycle"]);
      expect(await due()).toBeNull();
      await settlePrevious(cost.pool);
      expect(await due()).toBeLessThanOrEqual(0);
      expect(await status(id)).toBe("ready");
      const start = provider.startWithComputeLease.getMockImplementation()!;
      provider.startWithComputeLease.mockImplementation(async () => {
        startedAt = performance.now();
        expect(settledCommitAt).toBeDefined();
        return start();
      });
      const afterDisable = worker(pool, false);
      try { await runDueLifecycleJobs(pool, afterDisable, ["lifecycle"]); } finally { await afterDisable.stop(); }
      expect(await intent(id)).toMatchObject({ state: "succeeded", attempt_count: 2, error_code: null,
        created_at: original.created_at, dispatched_at: original.dispatched_at });
      expect(await edge(id)).toMatchObject({ state: "retired", allocation_lease_id: prior.intentId });
      expect(provider.startWithComputeLease).toHaveBeenCalledOnce();
      expect(startedAt! - settledCommitAt!).toBeGreaterThanOrEqual(0);
      console.info("[t6-c2-wait]", JSON.stringify({ version: 1, stage: "settlement-continuation",
        settlementAckToStartMs: startedAt! - settledCommitAt!, database: cost.snapshot() }));
    } finally { await reconciler.stop(); }
  });

  it("keeps settlement-before-edge live through the edge's own durable enqueue", async () => {
    const id = await wake();
    let afterRefusal = false, edgeWasAbsent = false;
    const observed = lifecycleDatabaseCost(pool, async sql => {
      if (!afterRefusal && sql.includes("UPDATE managed_compute_allocation_leases SET next_check_at=clock_timestamp()")) afterRefusal = true;
      else if (afterRefusal && sql === "COMMIT") {
        afterRefusal = false;
        edgeWasAbsent = (await edge(id)) === undefined;
        await settlePrevious();
      }
    });
    const reconciler = worker(observed.pool);
    try {
      expect(await reconciler.runOnce(fixture.workspaceId)).toBe(true);
      expect(edgeWasAbsent).toBe(true);
      expect(await edge(id)).toMatchObject({ state: "pending" });
      expect(await status(id)).toBe("ready");
      expect((await pool.query("SELECT 1 FROM control_plane_jobs WHERE kind='cloud_lifecycle_intent' AND workspace_id=$1 AND state='queued'", [fixture.workspaceId])).rowCount).toBe(1);
      await runDueLifecycleJobs(pool, reconciler, ["lifecycle"]);
      expect(await intent(id)).toMatchObject({ state: "succeeded" });
      expect(provider.startWithComputeLease).toHaveBeenCalledOnce();
    } finally { await reconciler.stop(); }
  });

  it("retains a wakeup when settlement and edge publication cross before either commit is visible", async () => {
    const id = await wake();
    const attemptPool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1,
      application_name: "allocation-wait-publication-fixture", options: "-c lock_timeout=4000ms" });
    const releaseAttempt = Promise.withResolvers<void>(), releaseSettlement = Promise.withResolvers<void>();
    let refusing = false, refused = false, settlementHeld = false, settlementPid = 0;
    let attemptFinished = false, attemptResult: boolean | undefined, attemptError: unknown, settlementError: unknown;
    const attemptCost = lifecycleDatabaseCost(attemptPool, async sql => {
      if (!refused && sql.includes("UPDATE managed_compute_allocation_leases SET next_check_at=clock_timestamp()")) refusing = true;
      else if (refusing && sql === "COMMIT") {
        refusing = false; refused = true;
        await releaseAttempt.promise;
      }
    });
    const settlementCost = lifecycleDatabaseCost(pool, async (sql, client) => {
      if (sql.includes("SET state='settled',settled_at=")) {
        settlementPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
        settlementHeld = true;
        await releaseSettlement.promise;
      }
    });
    const reconciler = worker(attemptCost.pool);
    const attempt = reconciler.runOnce(fixture.workspaceId).then(result => {
      attemptResult = result; attemptFinished = true;
    }, error => { attemptError = error; attemptFinished = true; });
    let settlement: Promise<void> | undefined;
    try {
      await expect.poll(() => refused, { timeout: 2_000 }).toBe(true);
      expect(await edge(id)).toBeUndefined();
      settlement = settlePrevious(settlementCost.pool).catch(error => { settlementError = error; });
      await expect.poll(() => settlementHeld, { timeout: 2_000 }).toBe(true);
      expect((await lease()).state).not.toBe("settled");
      releaseAttempt.resolve();
      // Correct publication serializes on the coalesced queue row. The old
      // conditional producer lets the edge commit and its job drain against
      // the still-uncommitted lease. Observe the actual lock, not a sleep.
      await expect.poll(async () => attemptFinished || (await pool.query(`SELECT 1 FROM pg_stat_activity
        WHERE datname=current_database() AND application_name='allocation-wait-publication-fixture'
          AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))`, [settlementPid])).rowCount === 1,
      { timeout: 2_000 }).toBe(true);
      if (attemptFinished) {
        expect(attemptError).toBeUndefined(); expect(attemptResult).toBe(true);
        expect(await edge(id)).toMatchObject({ state: "pending" });
        await runDueLifecycleJobs(pool, reconciler, ["lifecycle"]);
        expect((await pool.query(`SELECT 1 FROM control_plane_jobs WHERE kind='cloud_lifecycle_intent'
          AND workspace_id=$1 AND state IN ('queued','running')`, [fixture.workspaceId])).rowCount).toBe(0);
      }
      releaseSettlement.resolve();
      await Promise.all([attempt, settlement]);
      expect(attemptError).toBeUndefined(); expect(settlementError).toBeUndefined();
      expect(attemptResult).toBe(true); expect(await status(id)).toBe("ready");
      expect((await pool.query(`SELECT 1 FROM control_plane_jobs WHERE kind='cloud_lifecycle_intent'
        AND workspace_id=$1 AND state='queued'`, [fixture.workspaceId])).rowCount).toBe(1);
      // No audit or timer repair: the transactional queue alone resumes it.
      await runDueLifecycleJobs(pool, reconciler, ["lifecycle"]);
      expect(await intent(id)).toMatchObject({ state: "succeeded" });
      expect(provider.startWithComputeLease).toHaveBeenCalledOnce();
    } finally {
      releaseAttempt.resolve(); releaseSettlement.resolve();
      await Promise.allSettled([attempt, ...(settlement ? [settlement] : [])]);
      await reconciler.stop(); await attemptPool.end();
    }
  }, 12_000);

  it("retains settlement published during a running job and repairs a lost enqueue after restart", async () => {
    const id = await wake(), reconciler = worker();
    try {
      await reconciler.runOnce(fixture.workspaceId);
      const jobs = await claimJobs(pool, { owner: "allocation-wait-fixture", limit: 1,
        kinds: [{ kind: "cloud_lifecycle_intent", leaseMs: 60_000 }] });
      expect(jobs.jobs).toHaveLength(1);
      await reconciler.runJob(jobs.jobs[0]!);
      await settlePrevious();
      expect(await completeJob(pool, jobs.jobs[0]!)).toBe("requeued");
      await pool.query("DELETE FROM control_plane_jobs WHERE kind='cloud_lifecycle_intent' AND workspace_id=$1", [fixture.workspaceId]);
      const replacement = worker(pool, false);
      try {
        const repaired = await replacement.auditJobs();
        expect(repaired.lifecycle).toBe(1);
        await runDueLifecycleJobs(pool, replacement, ["lifecycle"]);
        expect(await intent(id)).toMatchObject({ state: "succeeded", attempt_count: 2 });
      } finally { await replacement.stop(); }
      expect(provider.startWithComputeLease).toHaveBeenCalledOnce();
    } finally { await reconciler.stop(); }
  });

  it.each(["authority", "billing", "binding", "prerequisite"])("retires a changed %s scope without adopting new authority", async change => {
    const id = await wake(), reconciler = worker();
    try {
      await reconciler.runOnce(fixture.workspaceId);
      const frozen = await edge(id);
      await runDueLifecycleJobs(pool, reconciler, ["lifecycle"]);
      if (change === "authority") await pool.query("UPDATE cloud_workspaces SET authority_epoch=authority_epoch+1 WHERE id=$1", [fixture.workspaceId]);
      if (change === "billing") await withSystemTx(pool, async tx => {
        await tx.query("UPDATE workspace_billing_epochs SET ended_at=clock_timestamp() WHERE workspace_id=$1 AND ended_at IS NULL", [fixture.workspaceId]);
        await tx.query(`INSERT INTO workspace_billing_epochs(workspace_id,billing_epoch,org_id,billing_owner_user_id,
          entitlement_scope,entitlement_plan,entitlement_revision,created_by)
          SELECT workspace_id,2,org_id,billing_owner_user_id,entitlement_scope,entitlement_plan,entitlement_revision,created_by
          FROM workspace_billing_epochs WHERE workspace_id=$1 AND billing_epoch=1`, [fixture.workspaceId]);
        await tx.query("UPDATE cloud_workspaces SET current_billing_epoch=2 WHERE id=$1", [fixture.workspaceId]);
      });
      if (change === "binding") await pool.query("UPDATE cloud_workspace_provider_bindings SET provider_resource_id='replacement-fixture' WHERE workspace_id=$1", [fixture.workspaceId]);
      if (change === "prerequisite") await pool.query("UPDATE cloud_workspace_lifecycle_intents SET resume_after_intent_id=$2 WHERE id=$1", [id, prior.intentId]);
      expect(await due()).toBeLessThanOrEqual(0);
      const before = (await pool.query("SELECT status,authority_epoch,last_error_code FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0];
      await runDueLifecycleJobs(pool, reconciler, ["lifecycle"]);
      expect(await intent(id)).toMatchObject({ state: "superseded", error_code: null });
      const { state: _state, resolved_at: _resolved, ...scope } = await edge(id);
      const { state: _oldState, resolved_at: _oldResolved, ...originalScope } = frozen;
      expect(scope).toEqual(originalScope);
      expect((await pool.query("SELECT status,authority_epoch,last_error_code FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0]).toEqual(before);
      expect(provider.startWithComputeLease).not.toHaveBeenCalled();
    } finally { await reconciler.stop(); }
  });

  it("rejects an old dispatch UPDATE even when its worker ignores RETURNING", async () => {
    const id = await wake(), reconciler = worker();
    try {
      await reconciler.runOnce(fixture.workspaceId);
      await expect(withSystemTx(pool, tx => tx.query(`UPDATE cloud_workspace_lifecycle_intents SET state='dispatching',
        attempt_count=attempt_count+1,lease_owner='old-worker',lease_expires_at=now()+interval '1 minute' WHERE id=$1`, [id])))
        .rejects.toMatchObject({ code: "23514" });
      expect(await intent(id)).toMatchObject({ state: "observing", attempt_count: 1, lease_owner: null });
      expect(provider.startWithComputeLease).not.toHaveBeenCalled();
    } finally { await reconciler.stop(); }
  });

  it("keeps another live claim's expiry as the due floor for a ready wait", async () => {
    const id = await wake(), reconciler = worker();
    try {
      await reconciler.runOnce(fixture.workspaceId);
      await settlePrevious();
      const other = randomUUID();
      await pool.query(`INSERT INTO cloud_workspace_lifecycle_intents
        (id,workspace_id,org_id,generation,requested_by,operation,idempotency_key,request_sha256,
          state,affects_workspace,lease_owner,lease_expires_at,dispatched_at)
        VALUES($1::uuid,$2,$3,1,$4,'wake',$1::text,$5,'dispatching',true,'other-worker',
          clock_timestamp()+interval '1 minute',clock_timestamp())`,
      [other, fixture.workspaceId, fixture.organizationId, fixture.userId, randomBytes(32)]);
      expect(await status(id)).toBe("ready");
      expect(await reconciler.runOnce(fixture.workspaceId)).toBe(false);
      expect(await due()).toBeGreaterThan(55_000);
      expect(provider.startWithComputeLease).not.toHaveBeenCalled();
    } finally { await reconciler.stop(); }
  });

  it.each(["owner", "binding"])("refuses a replacement %s after continuation provider I/O without publishing success", async changed => {
    const id = await wake(), reconciler = worker();
    const originalSetups = (await pool.query("SELECT id,state FROM cloud_workspace_setup_runs WHERE workspace_id=$1 ORDER BY id", [fixture.workspaceId])).rows;
    try {
      await reconciler.runOnce(fixture.workspaceId);
      await settlePrevious();
      const start = provider.startWithComputeLease.getMockImplementation()!;
      provider.startWithComputeLease.mockImplementationOnce(async () => {
        const reply = await start();
        if (changed === "owner") {
          await pool.query(`INSERT INTO cloud_workspace_allocation_owners
            (workspace_id,org_id,provider_resource_id,original_generation,current_generation,allocation_lease_id)
            SELECT workspace_id,org_id,provider_resource_id,1,1,id FROM managed_compute_allocation_leases WHERE id=$1`, [prior.intentId]);
        } else await pool.query("UPDATE cloud_workspace_provider_bindings SET provider_resource_id='replacement-fixture' WHERE workspace_id=$1", [fixture.workspaceId]);
        return reply;
      });
      await reconciler.runOnce(fixture.workspaceId);
      expect(await intent(id)).toMatchObject({ state: "superseded", error_code: null });
      expect((await pool.query("SELECT status,last_error_code FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0])
        .toEqual({ status: "waking", last_error_code: null });
      expect((await pool.query("SELECT id,state FROM cloud_workspace_setup_runs WHERE workspace_id=$1 ORDER BY id", [fixture.workspaceId])).rows).toEqual(originalSetups);
    } finally { await reconciler.stop(); }
  });

  it.each(["authority", "binding"])("fences a changed %s between the last funded check and result publication", async changed => {
    const id = await wake();
    let armed = false, releaseWritten = false, mutationCount = 0;
    const observed = lifecycleDatabaseCost(pool, async sql => {
      if (!armed) return;
      if (sql.includes("SET lease_owner=NULL,lease_expires_at=NULL,next_check_at=now()")) releaseWritten = true;
      if (releaseWritten && sql === "COMMIT") {
        armed = false;
        mutationCount++;
        if (changed === "authority") await pool.query("UPDATE cloud_workspaces SET authority_epoch=authority_epoch+1 WHERE id=$1", [fixture.workspaceId]);
        else await pool.query("UPDATE cloud_workspace_provider_bindings SET provider_resource_id='replacement-fixture' WHERE workspace_id=$1", [fixture.workspaceId]);
      }
    });
    const reconciler = worker(observed.pool);
    try {
      await reconciler.runOnce(fixture.workspaceId);
      await settlePrevious();
      armed = true;
      await reconciler.runOnce(fixture.workspaceId);
      expect(mutationCount).toBe(1);
      expect(await intent(id)).toMatchObject({ state: "superseded", error_code: null });
      expect((await pool.query("SELECT status,last_error_code FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0])
        .toEqual({ status: "waking", last_error_code: null });
      if (changed === "binding") expect((await pool.query("SELECT provider_resource_id FROM cloud_workspace_provider_bindings WHERE workspace_id=$1", [fixture.workspaceId])).rows[0].provider_resource_id).toBe("replacement-fixture");
    } finally { await reconciler.stop(); }
  });

  it("retains the ordinary refusal when allocation ownership is incomplete", async () => {
    await allocationOwner(false);
    const id = await wake(), reconciler = worker();
    try {
      await reconciler.runOnce(fixture.workspaceId);
      expect(await intent(id)).toMatchObject({ state: "observing", error_code: "compute_previous_lease_pending" });
      expect(await edge(id)).toBeUndefined();
      expect(provider.startWithComputeLease).not.toHaveBeenCalled();
    } finally { await reconciler.stop(); }
  });

  it("does not use old settlement to accept a different funded allocation reusing the same resource", async () => {
    const id = await wake(), reconciler = worker();
    try {
      await reconciler.runOnce(fixture.workspaceId);
      await settlePrevious();
      const newer = await wake();
      await coordinator.allocate({ ...prior, intentId: newer, idempotencyKey: newer }, asProvider(), resource);
      await pool.query("UPDATE cloud_workspace_lifecycle_intents SET state='succeeded',completed_at=now() WHERE id=$1", [newer]);
      const starts = provider.startWithComputeLease.mock.calls.length;
      await reconciler.runOnce(fixture.workspaceId);
      expect(await intent(id)).toMatchObject({ state: "superseded", error_code: null });
      expect(provider.startWithComputeLease).toHaveBeenCalledTimes(starts);
      expect((await pool.query("SELECT state FROM managed_compute_allocation_leases WHERE id=$1", [newer])).rows[0].state).toBe("active");
    } finally { await reconciler.stop(); }
  });

  it.each(["connection", "version"])("rejects %s revocation after continuation inspect before funding or start", async changed => {
    const id = await wake(), reconciler = worker();
    let mutationError: unknown;
    try {
      await reconciler.runOnce(fixture.workspaceId);
      await settlePrevious();
      provider.inspect.mockImplementationOnce(async () => {
        try {
        if (changed === "connection") await pool.query(`UPDATE provider_connections SET state='revoked',revoked_at=clock_timestamp()
          WHERE id=(SELECT provider_connection_id FROM cloud_workspace_generations WHERE workspace_id=$1 AND generation=1)`, [fixture.workspaceId]);
        else await pool.query(`UPDATE provider_connection_versions SET retired_at=clock_timestamp()
          WHERE (connection_id,version)=(SELECT provider_connection_id,provider_connection_version
            FROM cloud_workspace_generations WHERE workspace_id=$1 AND generation=1)`, [fixture.workspaceId]);
        } catch (error) { mutationError = error; throw error; }
        return resource;
      });
      await reconciler.runOnce(fixture.workspaceId);
      expect(mutationError).toBeUndefined();
      expect(await intent(id)).toMatchObject({ state: "superseded", error_code: null });
      expect(provider.startWithComputeLease).not.toHaveBeenCalled();
      expect((await pool.query("SELECT 1 FROM managed_compute_allocation_leases WHERE id=$1", [id])).rowCount).toBe(0);
    } finally { await reconciler.stop(); }
  });

  it("coalesces two refused starts on one settled allocation into one new provider start", async () => {
    const first = await wake(), second = await wake(), reconciler = worker();
    try {
      expect(await reconciler.runOnce(fixture.workspaceId)).toBe(true);
      expect(await reconciler.runOnce(fixture.workspaceId)).toBe(true);
      expect(await edge(first)).toMatchObject({ state: "pending", allocation_lease_id: prior.intentId });
      expect(await edge(second)).toMatchObject({ state: "pending", allocation_lease_id: prior.intentId });
      expect(await reconciler.runOnce(fixture.workspaceId)).toBe(false);
      await settlePrevious();
      await runDueLifecycleJobs(pool, reconciler, ["lifecycle"]);
      expect([(await intent(first)).state, (await intent(second)).state].sort()).toEqual(["succeeded", "superseded"]);
      expect(provider.startWithComputeLease).toHaveBeenCalledOnce();
      expect((await pool.query("SELECT count(*)::integer AS count FROM managed_compute_credit_reservations WHERE workspace_id=$1 AND state='open'", [fixture.workspaceId])).rows[0].count).toBe(1);
    } finally { await reconciler.stop(); }
  });

  it("requires closure of the exact reservation independently of a settled lease row", async () => {
    const id = await wake(), reconciler = worker();
    try {
      await reconciler.runOnce(fixture.workspaceId);
      await runDueLifecycleJobs(pool, reconciler, ["lifecycle"]);
      await pool.query("UPDATE managed_compute_allocation_leases SET state='settled',settled_at=clock_timestamp() WHERE id=$1", [prior.intentId]);
      expect(await status(id)).toBe("pending");
      await runDueLifecycleJobs(pool, reconciler, ["lifecycle"]);
      expect(await due()).toBeNull();
      expect(await intent(id)).toMatchObject({ state: "observing", attempt_count: 1 });
      expect(provider.startWithComputeLease).not.toHaveBeenCalled();
    } finally { await reconciler.stop(); }
  });

  it.each(["generation", "connection", "version", "owner", "lease"])("durably enqueues %s invalidation after an unchanged wait has gone idle", async changed => {
    if (changed === "owner") await allocationOwner();
    const id = await wake(), reconciler = worker();
    try {
      await reconciler.runOnce(fixture.workspaceId);
      await runDueLifecycleJobs(pool, reconciler, ["lifecycle"]);
      expect((await pool.query("SELECT 1 FROM control_plane_jobs WHERE kind='cloud_lifecycle_intent' AND workspace_id=$1", [fixture.workspaceId])).rowCount).toBe(0);
      if (changed === "generation") await pool.query("UPDATE cloud_workspace_generations SET retired_at=clock_timestamp() WHERE workspace_id=$1 AND generation=1", [fixture.workspaceId]);
      if (changed === "connection") await pool.query(`UPDATE provider_connections SET state='revoked',revoked_at=clock_timestamp()
        WHERE id=(SELECT provider_connection_id FROM cloud_workspace_generations WHERE workspace_id=$1 AND generation=1)`, [fixture.workspaceId]);
      if (changed === "version") await pool.query(`UPDATE provider_connection_versions SET retired_at=clock_timestamp()
        WHERE (connection_id,version)=(SELECT provider_connection_id,provider_connection_version
          FROM cloud_workspace_generations WHERE workspace_id=$1 AND generation=1)`, [fixture.workspaceId]);
      if (changed === "owner") await pool.query("DELETE FROM cloud_workspace_allocation_owners WHERE workspace_id=$1", [fixture.workspaceId]);
      if (changed === "lease") await pool.query("DELETE FROM managed_compute_allocation_leases WHERE id=$1", [prior.intentId]);
      expect(await status(id)).toBe("invalid");
      expect((await pool.query("SELECT 1 FROM control_plane_jobs WHERE kind='cloud_lifecycle_intent' AND workspace_id=$1 AND state='queued'", [fixture.workspaceId])).rowCount).toBe(1);
      await runDueLifecycleJobs(pool, reconciler, ["lifecycle"]);
      expect(await intent(id)).toMatchObject({ state: "superseded", error_code: null });
      expect(provider.startWithComputeLease).not.toHaveBeenCalled();
    } finally { await reconciler.stop(); }
  });

  it.each(["expired", "replacement", "scope"])("refuses a %s claim after the funded reservation commits", async changed => {
    const id = await wake();
    let armed = false, funded = false, mutations = 0;
    let mutationError: unknown;
    const observed = lifecycleDatabaseCost(pool, async sql => {
      if (!armed) return;
      if (sql.includes("UPDATE managed_compute_allocation_leases SET funded_until=greatest")) funded = true;
      if (funded && sql === "COMMIT") {
        armed = false; mutations++;
        try {
        if (changed === "scope") await pool.query("UPDATE cloud_workspaces SET authority_epoch=authority_epoch+2 WHERE id=$1", [fixture.workspaceId]);
        else await withSystemTx(pool, tx => tx.query(`UPDATE cloud_workspace_lifecycle_intents SET
          lease_owner=CASE WHEN $2 THEN 'successor-worker' ELSE lease_owner END,
          attempt_count=attempt_count+CASE WHEN $2 THEN 1 ELSE 0 END,
          lease_expires_at=clock_timestamp()+CASE WHEN $2 THEN interval '1 minute' ELSE interval '-1 second' END WHERE id=$1`, [id, changed === "replacement"]));
        } catch (error) { mutationError = error; throw error; }
      }
    });
    const reconciler = worker(observed.pool);
    try {
      await reconciler.runOnce(fixture.workspaceId);
      await settlePrevious();
      armed = true;
      await reconciler.runOnce(fixture.workspaceId);
      expect(mutations).toBe(1);
      expect(mutationError).toBeUndefined();
      expect(provider.startWithComputeLease).not.toHaveBeenCalled();
      if (changed === "scope") expect(await intent(id)).toMatchObject({ state: "superseded", error_code: null });
      else expect(await intent(id)).toMatchObject({ state: "dispatching", attempt_count: changed === "replacement" ? 3 : 2 });
      // Reservation custody remains until the independent metering path proves
      // absence/stopped; cancellation never manufactures settlement.
      expect((await pool.query("SELECT state FROM managed_compute_credit_reservations WHERE id=$1", [id])).rows[0].state).toBe("open");
    } finally { await reconciler.stop(); }
  });

  it("requires positive readiness for resolution and retains rate-limit floors after resolving", async () => {
    const id = await wake(), reconciler = worker();
    try {
      await reconciler.runOnce(fixture.workspaceId);
      await expect(withSystemTx(pool, tx => tx.query(`UPDATE cloud_workspace_lifecycle_allocation_waits
        SET state='resolved',resolved_at=clock_timestamp() WHERE lifecycle_intent_id=$1`, [id])))
        .rejects.toMatchObject({ code: "23514" });
      await settlePrevious();
      provider.inspect.mockRejectedValueOnce(new CloudProviderError("provider_rate_limited", "fixture rate limit", true, { retryAfterMs: 45_000 }));
      await reconciler.runOnce(fixture.workspaceId);
      const resolved = await edge(id), afterError = await intent(id);
      expect(resolved.state).toBe("resolved");
      expect(afterError).toMatchObject({ state: "observing", attempt_count: 2, error_code: "provider_rate_limited" });
      expect(afterError.next_attempt_at.getTime() - afterError.updated_at.getTime()).toBe(45_000);
      expect(await due()).toBeGreaterThan(44_000);
      await expect(withSystemTx(pool, tx => tx.query(`UPDATE cloud_workspace_lifecycle_allocation_waits
        SET state='pending',resolved_at=NULL WHERE lifecycle_intent_id=$1`, [id]))).rejects.toMatchObject({ code: "23514" });
      await expect(withSystemTx(pool, tx => tx.query(`UPDATE cloud_workspace_lifecycle_allocation_waits
        SET resolved_at=resolved_at+interval '1 second' WHERE lifecycle_intent_id=$1`, [id]))).rejects.toMatchObject({ code: "23514" });
      expect(provider.startWithComputeLease).not.toHaveBeenCalled();
    } finally { await reconciler.stop(); }
  });

  it("keeps the wait immutable and system-only without a monetary foreign key", async () => {
    const id = await wake(), reconciler = worker();
    try {
      await reconciler.runOnce(fixture.workspaceId);
      for (const field of ["allocation_lease_id=gen_random_uuid()", "owner_user_id=gen_random_uuid()",
        "authority_epoch=authority_epoch+2", "created_at=created_at+interval '1 second'", "resume_after_intent_id=gen_random_uuid()"])
        await expect(withSystemTx(pool, tx => tx.query(`UPDATE cloud_workspace_lifecycle_allocation_waits SET ${field} WHERE lifecycle_intent_id=$1`, [id])))
          .rejects.toMatchObject({ code: "23514" });
      expect((await pool.query(`SELECT 1 FROM pg_constraint WHERE conrelid='cloud_workspace_lifecycle_allocation_waits'::regclass
        AND contype='f' AND confrelid IN ('managed_compute_allocation_leases'::regclass,'cloud_workspace_allocation_owners'::regclass)`)).rowCount).toBe(0);
      const frozen = await edge(id), tenant = await pool.connect();
      try {
        await tenant.query("BEGIN; SET LOCAL ROLE zeros_app; SELECT set_config('app.system','off',true)");
        expect((await tenant.query("SELECT * FROM cloud_workspace_lifecycle_allocation_waits")).rows).toEqual([]);
        expect((await tenant.query("SELECT cloud_lifecycle_allocation_wait_status($1) AS state", [id])).rows[0].state).toBeNull();
        await expect(tenant.query(`INSERT INTO cloud_workspace_lifecycle_allocation_waits
          SELECT * FROM jsonb_populate_record(NULL::cloud_workspace_lifecycle_allocation_waits,$1::jsonb)`, [JSON.stringify(frozen)]))
          .rejects.toMatchObject({ code: "42501" });
      } finally { await tenant.query("ROLLBACK"); tenant.release(); }
      expect(await edge(id)).toEqual(frozen);
    } finally { await reconciler.stop(); }
  });

  async function savedSourceIntents() {
    const scope = { workspaceId: fixture.workspaceId, organizationId: fixture.organizationId, generation: 1,
      engineInstanceId: fixture.engineInstanceId };
    const engine = { ...scope, heartbeatToken: fixture.heartbeatToken };
    await pool.query("UPDATE cloud_workspace_engine_instances SET cloud_local_commands_version=1 WHERE id=$1", [fixture.engineInstanceId]);
    const execution = new DatabaseCloudAgentExecutionService(pool, { currentKeyVersion: 1, keys: { 1: randomBytes(32).toString("base64url") } }, false);
    const boot = CloudAgentBootCredentialResponseSchema.parse(await execution.boot(engine, "bootstrap", { ...scope, version: 1, mode: "boot-owner-v1" }));
    await execution.boot(engine, "activate", { ...scope, version: 1, mode: "boot-owner-v1",
      bootId: boot.bootId, writerEpoch: boot.writerEpoch, expectedCacheRevision: boot.cacheRevision });
    await sealFinalSaveFixture(pool, engine);
    const stopId = randomUUID();
    await withSystemTx(pool, async tx => {
    await tx.query(`INSERT INTO cloud_workspace_lifecycle_intents
      (id,workspace_id,org_id,generation,requested_by,operation,idempotency_key,request_sha256)
      VALUES($1::uuid,$2,$3,1,$4,'stop',$1::text,$5)`, [stopId, fixture.workspaceId, fixture.organizationId, fixture.userId, randomBytes(32)]);
    await enqueueWorkspaceCheckpointRequest(tx, { ...scope, requestedBy: fixture.userId, lifecycleIntentId: stopId,
      reason: "before_stop", idempotencyKey: `allocation-wait.${stopId}` });
    });
    // An accepted final capture keeps its original engine admission while the
    // dependent wake queues. Only the saved Stop later advertises waking.
    const id = randomUUID();
    await pool.query(`INSERT INTO cloud_workspace_lifecycle_intents
      (id,workspace_id,org_id,generation,requested_by,operation,idempotency_key,request_sha256)
      VALUES($1::uuid,$2,$3,1,$4,'wake',$1::text,$5)`, [id, fixture.workspaceId, fixture.organizationId, fixture.userId, randomBytes(32)]);
    provider.stop.mockImplementation(async () => (resource = { ...resource, state: "stopped" }));
    return { id, stopId, engine };
  }

  it.each(["settlement", "saved-retirement"])("requires both exact settlement and a saved retired predecessor, with %s first", async first => {
    const { id, stopId, engine } = await savedSourceIntents(), reconciler = worker();
    try {
      if (first === "settlement") { resource = { ...resource, state: "stopped" }; await settlePrevious(); }
      await reconciler.runOnce(fixture.workspaceId);
      expect(provider.stop).not.toHaveBeenCalled();
      expect(provider.startWithComputeLease).not.toHaveBeenCalled();
      expect(await edge(id)).toBeUndefined();
      // This source has no funded admission left for new uploads once its
      // allocation settles. Positive settlement alone cannot authorize a stop
      // or start; the independent saved-first case proves normal continuation.
      if (first === "settlement") {
        expect((await pool.query("SELECT state FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=$1", [stopId])).rows[0].state).toBe("capturing");
        return;
      }
      await commitFinalSaveFixture(pool, engine, { intentId: stopId, userId: fixture.userId, reason: "before_stop" });
      expect(await reconciler.runOnce(fixture.workspaceId)).toBe(true);
      expect(await intent(stopId)).toMatchObject({ state: "succeeded" });
      expect((await pool.query("SELECT retired_at FROM cloud_agent_boot_bindings WHERE engine_instance_id=$1", [fixture.engineInstanceId])).rows[0].retired_at).toBeInstanceOf(Date);
      if (first === "saved-retirement") {
        expect(await reconciler.runOnce(fixture.workspaceId)).toBe(true);
        expect(await edge(id)).toMatchObject({ state: "pending", resume_after_intent_id: stopId });
        expect(await status(id)).toBe("pending");
        expect(provider.startWithComputeLease).not.toHaveBeenCalled();
        await settlePrevious();
      }
      await runDueLifecycleJobs(pool, reconciler, ["lifecycle"]);
      expect(await intent(id)).toMatchObject({ state: "succeeded", error_code: null });
      expect(provider.startWithComputeLease).toHaveBeenCalledOnce();
      expect(provider.stop).toHaveBeenCalledOnce();
    } finally { await reconciler.stop(); }
  });

  it.each(["checkpoint", "registration", "token", "writer"])("rechecks historical %s proof after funding without reviving its source", async changed => {
    const { id, stopId, engine } = await savedSourceIntents();
    let armed = false, funded = false, mutations = 0, mutationError: unknown;
    const observed = lifecycleDatabaseCost(pool, async sql => {
      if (!armed) return;
      if (sql.includes("UPDATE managed_compute_allocation_leases SET funded_until=greatest")) funded = true;
      if (funded && sql === "COMMIT") {
        armed = false; mutations++;
        try {
          expect(await edge(id)).toMatchObject({ state: "resolved" });
          if (changed === "checkpoint") await withSystemTx(pool, tx => tx.query(`UPDATE workspace_checkpoints SET state='invalid',invalidated_at=clock_timestamp()
            WHERE id=(SELECT prerequisite_checkpoint_id FROM cloud_workspace_lifecycle_allocation_waits WHERE lifecycle_intent_id=$1)`, [id]));
          if (changed === "registration") await withSystemTx(pool, tx => tx.query("UPDATE cloud_workspace_engine_instances SET registered_at=clock_timestamp() WHERE id=$1", [engine.engineInstanceId]));
          if (changed === "token") await withSystemTx(pool, tx => tx.query("UPDATE cloud_workspace_engine_instances SET heartbeat_token_hash=$2 WHERE id=$1", [engine.engineInstanceId, randomBytes(32)]));
          if (changed === "writer") await withSystemTx(pool, tx => tx.query(`INSERT INTO cloud_workspace_local_command_writers
            (workspace_id,org_id,generation,engine_instance_id,boot_id,writer_epoch,funding_owner_user_id,funding_owner_epoch,state,activated_at)
            VALUES($1,$2,1,$3,$4,$5,$6,1,'active',clock_timestamp())`,
          [fixture.workspaceId, fixture.organizationId, engine.engineInstanceId, randomUUID(), randomUUID(), fixture.userId]));
        } catch (error) { mutationError = error; throw error; }
      }
    });
    const reconciler = worker(observed.pool);
    try {
      await reconciler.runOnce(fixture.workspaceId);
      await commitFinalSaveFixture(pool, engine, { intentId: stopId, userId: fixture.userId, reason: "before_stop" });
      await reconciler.runOnce(fixture.workspaceId);
      expect(await intent(stopId)).toMatchObject({ state: "succeeded" });
      await reconciler.runOnce(fixture.workspaceId);
      expect(await edge(id)).toMatchObject({ state: "pending" });
      await settlePrevious();
      armed = true;
      await reconciler.runOnce(fixture.workspaceId);
      expect(mutations).toBe(1); expect(mutationError).toBeUndefined();
      expect(provider.startWithComputeLease).not.toHaveBeenCalled();
      expect(await intent(id)).toMatchObject({ state: "superseded", error_code: null });
      expect((await pool.query("SELECT state FROM managed_compute_credit_reservations WHERE id=$1", [id])).rows[0].state).toBe("open");
      expect((await pool.query("SELECT retired_at FROM cloud_agent_boot_bindings WHERE engine_instance_id=$1", [engine.engineInstanceId])).rows[0].retired_at).toBeInstanceOf(Date);
    } finally { await reconciler.stop(); }
  });

  it("purges a retired wait at the existing saved Delete erasure boundary", async () => {
    const { id, stopId, engine } = await savedSourceIntents(), reconciler = worker();
    try {
      await reconciler.runOnce(fixture.workspaceId);
      await commitFinalSaveFixture(pool, engine, { intentId: stopId, userId: fixture.userId, reason: "before_stop" });
      await reconciler.runOnce(fixture.workspaceId);
      await reconciler.runOnce(fixture.workspaceId);
      expect(await edge(id)).toMatchObject({ state: "pending" });
      await settlePrevious();
      const deletion = randomUUID();
      await withSystemTx(pool, async tx => {
        await tx.query("SELECT id FROM organizations WHERE id=$1 FOR SHARE", [fixture.organizationId]);
        await tx.query("SELECT id FROM cloud_workspaces WHERE id=$1 FOR UPDATE", [fixture.workspaceId]);
        await tx.query(`INSERT INTO cloud_workspace_lifecycle_intents
          (id,workspace_id,org_id,generation,requested_by,operation,idempotency_key,request_sha256)
          VALUES($1::uuid,$2,$3,1,$4,'delete',$1::text,$5)`,
        [deletion, fixture.workspaceId, fixture.organizationId, fixture.userId, randomBytes(32)]);
        await ensureFinalSaveRecovery(tx, deletion);
        expect(await finalSaveProven(tx, deletion)).toBe(true);
      });
      await confirmWorkspaceDeletion(pool, fixture);
      provider.delete.mockImplementation(async () => (resource = { ...resource, state: "deleted" }));
      provider.verifyAbsence.mockResolvedValue(true);
      await runDueLifecycleJobs(pool, reconciler, ["lifecycle"]);
      expect(await edge(id)).toMatchObject({ state: "retired" });
      expect(await withSystemTx(pool, tx => finalSaveProven(tx, deletion))).toBe(true);
      const errors = vi.fn();
      const erasure = new CloudWorkspaceOperationsWorker(pool, { deleteUnreferencedSystem: async () => "already_deleted" },
        { workerId: "allocation-wait-erasure", logger: { error: errors } });
      await erasure.runOnce();
      expect(errors).not.toHaveBeenCalled();
      expect((await pool.query("SELECT state FROM workspace_deletion_jobs WHERE workspace_id=$1", [fixture.workspaceId])).rows[0].state).toBe("succeeded");
      expect((await pool.query("SELECT data_deleted_at FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0].data_deleted_at).toBeInstanceOf(Date);
      expect(await edge(id)).toBeUndefined();
      expect((await lease()).state).toBe("settled");
      expect(provider.startWithComputeLease).not.toHaveBeenCalled();
    } finally { await reconciler.stop(); }
  });
  it.each([
    { missing: "lease", settleBeforePublication: false },
    { missing: "both", settleBeforePublication: false },
    { missing: "binding", settleBeforePublication: true },
    { missing: "lease", settleBeforePublication: true },
    { missing: "both", settleBeforePublication: true },
  ])("keeps incomplete $missing identity on ordinary retry across settlement/publication ($settleBeforePublication)", async ({ missing, settleBeforePublication }) => {
    await withSystemTx(pool, async tx => {
      if (missing !== "lease") expect((await tx.query(`UPDATE cloud_workspace_provider_bindings
        SET provider_resource_id=NULL WHERE workspace_id=$1 RETURNING workspace_id`, [fixture.workspaceId])).rowCount).toBe(1);
      // A lost allocation-result publication leaves the funded lease in
      // authorized state; an active lease is required to have a resource.
      if (missing !== "binding") expect((await tx.query(`UPDATE managed_compute_allocation_leases
        SET state='authorized',provider_resource_id=NULL,provider_expires_at=NULL
        WHERE id=$1 RETURNING id`, [prior.intentId])).rowCount).toBe(1);
    });
    const id = await wake();
    const original = await intent(id);
    let refused = false, settlements = 0, settlementError: unknown;
    const observed = lifecycleDatabaseCost(pool, async sql => {
      if (!settleBeforePublication || settlements > 0) return;
      if (sql.includes("UPDATE managed_compute_allocation_leases SET next_check_at=clock_timestamp()")) refused = true;
      else if (refused && sql === "COMMIT") {
        refused = false; settlements++;
        try { await settlePrevious(); } catch (error) { settlementError = error; throw error; }
      }
    });
    const reconciler = worker(observed.pool);
    try {
      expect(await reconciler.runOnce(fixture.workspaceId)).toBe(true);
      expect(settlements).toBe(settleBeforePublication ? 1 : 0);
      expect(settlementError).toBeUndefined();
      expect.soft(await edge(id)).toBeUndefined();
      const retry = await intent(id);
      expect.soft(retry).toMatchObject({ state: "observing", error_code: "compute_previous_lease_pending",
        attempt_count: 1, lease_owner: null, lease_expires_at: null, created_at: original.created_at });
      expect.soft(retry.next_attempt_at.getTime() - retry.updated_at.getTime()).toBe(1_000);
      expect(provider.startWithComputeLease).not.toHaveBeenCalled();
      if (!settleBeforePublication) await settlePrevious();
      expect((await pool.query(`SELECT binding.provider_resource_id AS binding_resource_id,
        lease.provider_resource_id AS allocation_resource_id FROM cloud_workspace_provider_bindings binding
        JOIN managed_compute_allocation_leases lease ON lease.workspace_id=binding.workspace_id
        WHERE binding.workspace_id=$1 AND lease.id=$2`, [fixture.workspaceId, prior.intentId])).rows[0])
        .toEqual({ binding_resource_id: resource.resourceId, allocation_resource_id: resource.resourceId });
      // A settlement before failure publication cannot nudge its later retry.
      // Drive that persisted timer without sleeping or changing authority.
      await pool.query(`UPDATE cloud_workspace_lifecycle_intents SET next_attempt_at=clock_timestamp()
        WHERE id=$1 AND state='observing'`, [id]);
      expect(await reconciler.runOnce(fixture.workspaceId)).toBe(true);
      expect(await intent(id)).toMatchObject({ state: "succeeded", error_code: null, created_at: original.created_at });
      expect(provider.startWithComputeLease).toHaveBeenCalledOnce();
      expect(await edge(id)).toBeUndefined();
    } finally { await reconciler.stop(); }
  });

  it.each([
    {unbound:false,enabled:true},
    {unbound:true,enabled:true},
    {unbound:true,enabled:false},
  ])("W2 F1 retains incomplete-binding retry and resumes after independent settlement ($unbound/$enabled)", async ({unbound,enabled}) => {
    if(unbound) {
      const changed=await withSystemTx(pool,tx=>tx.query(
        "UPDATE cloud_workspace_provider_bindings SET provider_resource_id=NULL WHERE workspace_id=$1 RETURNING workspace_id",[fixture.workspaceId]));
      expect(changed.rowCount).toBe(1);
    }
    const id=await wake(),reconciler=worker(pool,enabled);
    try {
      expect(await reconciler.runOnce(fixture.workspaceId)).toBe(true);
      const wait=await edge(id);
      if(unbound||!enabled) {
        expect.soft(wait).toBeUndefined();
        expect.soft(await intent(id)).toMatchObject({state:"observing",error_code:"compute_previous_lease_pending",attempt_count:1});
      } else expect(wait).toMatchObject({state:"pending",provider_resource_id:resource.resourceId});
      await settlePrevious();
      expect((await pool.query("SELECT provider_resource_id FROM cloud_workspace_provider_bindings WHERE workspace_id=$1",[fixture.workspaceId])).rows[0].provider_resource_id).toBe(resource.resourceId);
      console.info("[w2-f1-binding]",JSON.stringify({unbound,enabled,edgeWritten:wait!==undefined,
        dependencyAfterSettlement:wait===undefined?"absent":await status(id)}));
      expect(await reconciler.runOnce(fixture.workspaceId)).toBe(true);
      expect(await intent(id)).toMatchObject({state:"succeeded",error_code:null});
      expect(provider.startWithComputeLease).toHaveBeenCalledOnce();
    } finally {await reconciler.stop();}
  });

});

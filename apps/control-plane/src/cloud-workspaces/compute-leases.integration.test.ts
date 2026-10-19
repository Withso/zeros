import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { Hono } from "hono";
import type { AuthedUser } from "../auth.js";
import type { CloudWorkspaceBackendConfig } from "../config.js";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { withSystemTx, withUserTx, createPool, DatabaseConnectionLostError } from "../db.js";
import { CloudWorkspaceCheckpointRequestWorker, completeWorkspaceCheckpointRequest } from "./checkpoint-requests.js";
import {
  seedProviderLossAttestation,
  seedReadyCloudWorkspace,
  type ReadyCloudWorkspaceFixture,
} from "./test-fixtures.js";
import { DatabaseManagedComputeCreditLedger } from "./compute-credits.js";
import {
  CloudWorkspaceComputeLeaseCoordinator,
  type ManagedComputeStart,
} from "./compute-leases.js";
import {
  CloudProviderError,
  type CloudWorkspaceAccessProvider,
  type CloudProviderIdentity,
  type CloudProviderResource,
  type CloudWorkspaceProvider,
} from "./provider.js";
import { DatabaseCloudWorkspaceProviderResolver, type CloudWorkspaceProviderResolver } from "./provider-resolver.js";
import { CloudWorkspaceProviderRegistry } from "./provider-registry.js";
import { requestManagedComputeStop } from "./compute-credit-stop.js";
import { DatabaseCloudIdleStop } from "./idle-stop.js";
import { previousBackendWake } from "./lifecycle-compatibility-fixtures.js";
import { computeMicroUsd } from "./provider-compute.js";
import { DatabaseCloudWorkspaceHealthService } from "./health.js";
import { CloudWorkspaceReconciler } from "./reconciler.js";
import { DatabaseCloudProviderOperationStore } from "./provider-operation-store.js";
import { recoverCloudDiagnostic, retainCloudDiagnostic } from "./cloud-diagnostic-store.js";
import { createCloudWorkspaceRoutes } from "./routes.js";
import { stopUnavailableCloudEngine } from "./engine-health.js";
import { readCloudWorkerNextDelay } from "./worker-deadlines.js";
import { auditLifecycleJobs, readLifecycleDueInMs } from "./lifecycle-jobs.js";
import { claimJobs, completeJob } from "../job-queue.js";

/** Inject a real server-side transaction abort into the original DB calls.
 * All statement/value authority and transaction lifecycle stay production-owned. */
function abortingPool(base: pg.Pool, input: {
  code: "40P01" | "40001";
  count: number;
  when: (sql: string, history: readonly string[]) => boolean;
  afterAbort?: () => Promise<void>;
}) {
  const observed = { aborts: 0, rollbacks: 0 };
  const pool = new Proxy(base, { get(target, key) {
    if (key === "connect") return async () => {
      const client = await target.connect(), history: string[] = [];
      return new Proxy(client, { get(target, key) {
        if (key === "query") return async (...args: unknown[]) => {
          const sql = typeof args[0] === "string" ? args[0] : (args[0] as {text?: string}).text ?? "";
          if (sql === "ROLLBACK") observed.rollbacks++;
          if (observed.aborts < input.count && input.when(sql, history)) {
            observed.aborts++;
            try {
              return await target.query("DO $abort$ BEGIN RAISE EXCEPTION USING ERRCODE='" + input.code + "', MESSAGE='compute transaction rollback fixture'; END $abort$");
            } catch (error) {
              await input.afterAbort?.();
              throw error;
            }
          }
          history.push(sql);
          return Reflect.apply(target.query, target, args);
        };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return { pool, observed };
}

/** Real local PostgreSQL failures at the metering transaction boundary. */
function interruptedLedgerPool(base: pg.Pool, kind: "connection_lost" | "statement_timeout" | "committed_connection_lost", at: "meter" | "reserve" = "meter") {
  const observed = { interruptions: 0, connectionEnded: false };
  const pool = new Proxy(base, { get(target, key) {
    if (key === "connect") return async () => {
      const client = await target.connect();
      let metered = false;
      return new Proxy(client, { get(target, key) {
        if (key === "query") return async (...args: unknown[]) => {
          const sql = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string }).text ?? "";
          const write = at === "meter" ? sql.includes("SET debited_micro_usd=debited_micro_usd+$2")
            : sql.includes("UPDATE managed_compute_credit_periods SET reserved_micro_usd=reserved_micro_usd+$2");
          if (write) metered = true;
          const interrupt = observed.interruptions === 0 && (kind === "committed_connection_lost"
            ? metered && sql === "COMMIT" : write);
          if (interrupt) {
            observed.interruptions++;
            const committed = kind === "committed_connection_lost" ? await Reflect.apply(target.query, target, args) : undefined;
            if (kind !== "statement_timeout") {
              const pid = (await target.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
              const ended = new Promise<void>(resolve => target.once("end", () => { observed.connectionEnded = true; resolve(); }));
              await base.query("SELECT pg_terminate_backend($1)", [pid]);
              await ended;
              if (kind === "committed_connection_lost") return committed;
            } else {
              await target.query("SET LOCAL statement_timeout='2ms'");
              await target.query("SELECT pg_sleep(1)");
            }
          }
          return Reflect.apply(target.query, target, args);
        };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return { pool, observed };
}

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("managed compute lifecycle admission", () => {
  let pool: pg.Pool,
    f: ReadyCloudWorkspaceFixture,
    ledger: DatabaseManagedComputeCreditLedger,
    coordinator: CloudWorkspaceComputeLeaseCoordinator;
  let input: ManagedComputeStart, provider: ReturnType<typeof makeProvider>;
  const policy = {
    provider: "boat",
    policyId: "qualification-price-v1",
    secondsPerDollar: 100000,
    minimumTtlSeconds: 600,
    maximumTtlSeconds: 900,
    requestMarginSeconds: 60,
  };
  const resource = (ttl = 900): CloudProviderResource => ({
    workspaceId: f.workspaceId,
    generation: 1,
    resourceId: `sandbox-${f.workspaceId}`,
    state: "running",
    target: null,
    metadata: {
      computeLeaseExpiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    },
  });
  function makeProvider() {
    return {
      name: "boat",
      create: vi.fn(async () => resource()),
      start: vi.fn(async () => resource()),
      computeWeight: vi.fn(() => ({ numerator: 1, denominator: 1 })),
      createWithComputeLease: vi.fn(
        async (_input: ManagedComputeStart, ttl: number) => resource(ttl),
      ),
      startWithComputeLease: vi.fn(async (_id: string, ttl: number) =>
        resource(ttl),
      ),
      renewComputeLease: vi.fn(async (_id: string, ttl: number) => ({
        expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
      })),
      readComputeUsage: vi.fn(
        async (id: string, window?: { since: Date; until?: Date }) => ({
          resourceId: id,
          since: window!.since.toISOString(),
          until: window!.until!.toISOString(),
          billableSeconds: 600,
          secondsPerDollar: 100000,
          listPriceMicroUsd: computeMicroUsd(600, 100000),
          running: true,
        }),
      ),
      inspect: vi.fn(async () => resource()),
      find: vi.fn(async () => [resource()]),
      verifyAbsence: vi.fn(async (_identity: CloudProviderIdentity) => false),
      stop: vi.fn(),
      archive: vi.fn(),
      delete: vi.fn(),
    };
  }
  const resolver = () =>
    ({
      resolve: async () => ({ provider }),
    }) as unknown as CloudWorkspaceProviderResolver;
  const asProvider = () => provider as unknown as CloudWorkspaceProvider;
  beforeAll(() => {
    pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 8,
    });
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    f = await seedReadyCloudWorkspace(pool);
    await pool.query(
      "UPDATE managed_compute_provider_requirements SET require_credit=true WHERE provider='boat'",
    );
    await pool.query(
      "UPDATE cloud_workspace_provider_bindings SET provider_resource_id=NULL WHERE workspace_id=$1",
      [f.workspaceId],
    );
    const id = randomUUID();
    await pool.query(
      `INSERT INTO cloud_workspace_lifecycle_intents(id,workspace_id,generation,org_id,requested_by,operation,idempotency_key,request_sha256)
      VALUES ($1,$2,1,$3,$4,'create',$5,$6)`,
      [
        id,
        f.workspaceId,
        f.organizationId,
        f.userId,
        randomUUID(),
        randomBytes(32),
      ],
    );
    input = {
      workspaceId: f.workspaceId,
      organizationId: f.organizationId,
      generation: 1,
      intentId: id,
      idempotencyKey: id,
      imageRef: "fixture",
      architecture: "linux/amd64",
      cpuMillicores: 4000,
      memoryMiB: 8192,
      storageMiB: 40960,
    };
    provider = makeProvider();
    ledger = new DatabaseManagedComputeCreditLedger({
      pool,
      workosEnabled: false,
    });
    coordinator = new CloudWorkspaceComputeLeaseCoordinator({
      pool,
      providerResolver: resolver(),
      workosEnabled: false,
      policy,
      usageMeterWindowMs: 0,
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  const grant = () =>
    ledger.grant({
      organizationId: f.organizationId,
      userId: f.userId,
      startsAt: new Date(Date.now() - 3600_000),
      endsAt: new Date(Date.now() + 3600_000),
      amountMicroUsd: 20_000,
      policyId: "seat-credit-v1",
      idempotencyKey: randomUUID(),
    });
  const balance = () =>
    ledger.balanceSystem({
      organizationId: f.organizationId,
      userId: f.userId,
    });
  async function ready() {
    await grant();
    const next = await coordinator.allocate(input, asProvider(), null);
    await pool.query(
      "UPDATE cloud_workspace_provider_bindings SET provider_resource_id=$2 WHERE workspace_id=$1",
      [f.workspaceId, next.resourceId],
    );
  }
  async function age() {
    await pool.query(
      "UPDATE managed_compute_allocation_leases SET requested_at=requested_at-interval '10 minutes',next_check_at=now() WHERE id=$1",
      [input.intentId],
    );
    await pool.query(
      "UPDATE managed_compute_credit_reservations SET meter_since=meter_since-interval '10 minutes',meter_through=meter_through-interval '10 minutes' WHERE id=$1",
      [input.intentId],
    );
  }

  function originalResolver(db: pg.Pool) {
    return new DatabaseCloudWorkspaceProviderResolver({ pool: db, workosEnabled: false,
      registry: new CloudWorkspaceProviderRegistry([{name: "boat", hosted: {
        provider: provider as unknown as CloudWorkspaceProvider & CloudWorkspaceAccessProvider,
      }}]) });
  }
  function originalCoordinator(db: pg.Pool) {
    return new CloudWorkspaceComputeLeaseCoordinator({pool: db, providerResolver: originalResolver(db), workosEnabled: false, policy, usageMeterWindowMs: 0});
  }
  const providerLookup = (sql: string) => sql.startsWith("SELECT connection.id AS connection_id");
  async function expectNoStop() {
    expect((await pool.query("SELECT desired_state FROM cloud_workspaces WHERE id=$1", [f.workspaceId])).rows[0].desired_state).toBe("running");
    expect((await pool.query("SELECT state,stop_intent_id FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId])).rows[0]).toMatchObject({state: "active", stop_intent_id: null});
    expect((await pool.query("SELECT count(*) FROM workspace_checkpoint_requests WHERE workspace_id=$1", [f.workspaceId])).rows[0].count).toBe("0");
    expect((await pool.query("SELECT count(*) FROM cloud_workspace_diagnostic_incidents WHERE operation_id=$1 AND stop_initiated_at IS NOT NULL", [input.intentId])).rows[0].count).toBe("0");
  }

  it.each(["40P01", "40001"] as const)("recovers an original provider-lookup %s before metering without a safety stop", async code => {
    await ready(); await age();
    const db = abortingPool(pool, {code, count: 1, when: providerLookup});
    await expect(originalCoordinator(db.pool).runOnce()).resolves.toBe(true);
    expect(db.observed.aborts).toBe(1);
    expect(db.observed.rollbacks).toBe(1);
    expect(provider.inspect).toHaveBeenCalledOnce();
    expect(provider.readComputeUsage).toHaveBeenCalledOnce();
    await expectNoStop();
    expect((await balance())[0]!.debitedMicroUsd).toBe(6000);
    expect((await balance())[0]!.reservedMicroUsd).toBeGreaterThan(0);
  });

  it.each(["40P01", "40001"] as const)("backs off after bounded original %s lookup aborts without releasing funds or replaying I/O", async code => {
    await ready(); await age();
    const held = (await balance())[0]!.reservedMicroUsd;
    const db = abortingPool(pool, {code, count: 3, when: providerLookup});
    const worker = originalCoordinator(db.pool);
    await expect(worker.runOnce()).resolves.toBe(true);
    expect(db.observed.aborts).toBe(3);
    expect(db.observed.rollbacks).toBe(3);
    expect(provider.inspect).not.toHaveBeenCalled();
    expect(provider.readComputeUsage).not.toHaveBeenCalled();
    expect((await balance())[0]!.reservedMicroUsd).toBe(held);
    await expectNoStop();
    const lease = (await pool.query("SELECT *,clock_timestamp() AS observed_now FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId])).rows[0];
    expect(lease.lease_owner).toBeNull();
    expect(lease.lease_expires_at).toBeNull();
    expect(lease.last_error_code).toBe("control_plane_unavailable");
    expect(lease.next_check_at.getTime()).toBeGreaterThan(lease.observed_now.getTime());
    expect(lease.next_check_at.getTime()).toBeLessThanOrEqual(Math.min(lease.funded_until.getTime(), lease.provider_expires_at.getTime()) - 315000);
    await pool.query("UPDATE managed_compute_allocation_leases SET next_check_at=now() WHERE id=$1", [input.intentId]);
    await worker.runOnce();
    expect(provider.inspect).toHaveBeenCalledOnce();
    expect(provider.readComputeUsage).toHaveBeenCalledOnce();
    expect((await balance())[0]!.debitedMicroUsd).toBe(6000);
    expect((await pool.query("SELECT last_error_code,first_error_at FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId])).rows[0]).toMatchObject({last_error_code: null, first_error_at: null});
    await expectNoStop();
  });

  it.each(["funded_until", "provider_expires_at"] as const)("does not defer transient DB failures past the %s checkpoint reserve", async deadline => {
    await ready(); await age();
    await pool.query("UPDATE managed_compute_allocation_leases SET " + deadline + "=now()+interval '5 minutes'" +
      (deadline === "funded_until" ? ",provider_expires_at=least(provider_expires_at,now()+interval '5 minutes')" : "") + " WHERE id=$1", [input.intentId]);
    const db = abortingPool(pool, {code: "40P01", count: 3, when: providerLookup});
    await originalCoordinator(db.pool).runOnce();
    expect(db.observed.aborts).toBe(3);
    expect((await pool.query("SELECT state,stop_intent_id FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId])).rows[0]).toMatchObject({state: "draining", stop_intent_id: expect.any(String)});
    expect(provider.renewComputeLease).not.toHaveBeenCalled();
    expect((await balance())[0]!.reservedMicroUsd).toBeGreaterThan(0);
  });

  it("rechecks revoked engine authority after transaction retries before accepting another finite recheck", async () => {
    await ready(); await age();
    const db = abortingPool(pool, {code: "40001", count: 3, when: providerLookup,
      afterAbort: async () => { await pool.query("UPDATE cloud_workspace_engine_instances SET revoked_at=now(),state='revoked' WHERE id=$1", [f.engineInstanceId]); }});
    await originalCoordinator(db.pool).runOnce();
    expect((await pool.query("SELECT state FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId])).rows[0].state).toBe("draining");
    expect(provider.renewComputeLease).not.toHaveBeenCalled();
    expect((await balance())[0]!.reservedMicroUsd).toBeGreaterThan(0);
  });

  it("uses the fresh shortened provider deadline after transient lookup retries to force the direct stop", async () => {
    await ready(); await age();
    const db = abortingPool(pool, {code: "40P01", count: 3, when: providerLookup,
      afterAbort: async () => { await pool.query("UPDATE managed_compute_allocation_leases SET provider_expires_at=clock_timestamp()+interval '40 seconds' WHERE id=$1", [input.intentId]); }});
    await originalCoordinator(db.pool).runOnce();
    expect((await pool.query("SELECT desired_state,status FROM cloud_workspaces WHERE id=$1", [f.workspaceId])).rows[0]).toEqual({desired_state: "stopped", status: "stopping"});
    expect((await pool.query("SELECT count(*) FROM workspace_checkpoint_requests WHERE workspace_id=$1", [f.workspaceId])).rows[0].count).toBe("0");
    expect((await pool.query("SELECT first_cause FROM cloud_workspace_diagnostic_incidents WHERE operation_id=$1", [input.intentId])).rows[0].first_cause).toMatchObject({sqlState: "40P01", decision: "direct_stop"});
    expect((await balance())[0]!.reservedMicroUsd).toBeGreaterThan(0);
    expect(provider.renewComputeLease).not.toHaveBeenCalled();
  });

  it("cannot stop or clear a claim replaced during transient transaction aborts", async () => {
    await ready(); await age();
    const db = abortingPool(pool, {code: "40P01", count: 3, when: providerLookup,
      afterAbort: async () => { await pool.query("UPDATE managed_compute_allocation_leases SET lease_owner='other-original-worker',lease_expires_at=clock_timestamp()+interval '5 minutes' WHERE id=$1", [input.intentId]); }});
    await originalCoordinator(db.pool).runOnce();
    expect((await pool.query("SELECT lease_owner,state,stop_intent_id FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId])).rows[0]).toMatchObject({lease_owner: "other-original-worker", state: "active", stop_intent_id: null});
    expect(provider.inspect).not.toHaveBeenCalled();
    expect(provider.renewComputeLease).not.toHaveBeenCalled();
  });

  it.each(["40P01", "40001"] as const)("retries a %s ledger commit abort without rereading the provider meter or double debit", async code => {
    await ready(); await age();
    const db = abortingPool(pool, {code, count: 1, when: (sql, history) => sql === "COMMIT" && history.some(q => q.startsWith("UPDATE managed_compute_credit_periods SET"))});
    await originalCoordinator(db.pool).runOnce();
    expect(db.observed.aborts).toBe(1);
    expect(provider.readComputeUsage).toHaveBeenCalledOnce();
    expect((await balance())[0]!.debitedMicroUsd).toBe(6000);
    expect((await pool.query("SELECT count(*) FROM managed_compute_credit_events WHERE reservation_id=$1 AND kind='debit'", [input.intentId])).rows[0].count).toBe("1");
    await expectNoStop();
  });

  it.each(["40P01", "40001"] as const)("retries a %s stop-admission rollback with one original intent/checkpoint/audit", async code => {
    await ready(); await age();
    provider.readComputeUsage.mockRejectedValueOnce(Object.assign(new Error("permanent safety fixture"), {code: "23514"}));
    const db = abortingPool(pool, {code, count: 1, when: (sql, history) => sql === "COMMIT" && history.some(q => q.startsWith("INSERT INTO cloud_workspace_lifecycle_intents") && q.includes("'stop'"))});
    await expect(originalCoordinator(db.pool).runOnce()).resolves.toBe(true);
    expect(db.observed.aborts).toBe(1);
    expect(provider.readComputeUsage).toHaveBeenCalledOnce();
    expect((await pool.query("SELECT count(*) FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 AND operation='stop'", [f.workspaceId])).rows[0].count).toBe("1");
    expect((await pool.query("SELECT count(*) FROM workspace_checkpoint_requests WHERE workspace_id=$1", [f.workspaceId])).rows[0].count).toBe("1");
    expect((await pool.query("SELECT count(*) FROM audit_log WHERE action='cloud_workspace.compute_stop_requested'")).rows[0].count).toBe("1");
    expect((await balance())[0]!.reservedMicroUsd).toBeGreaterThan(0);
  });

  async function publicWorkspace() {
    const app = new Hono();
    app.use("*", async (c,next) => { c.set("user", {id:f.userId} as AuthedUser); await next(); });
    app.route("/", createCloudWorkspaceRoutes(pool, null, {workosEnabled:false}));
    const response = await app.request(`/v1/cloud-workspaces/${f.workspaceId}`);
    expect(response.status).toBe(200);
    return (await response.json()).workspace;
  }
  async function publicWorkspaceError() {
    return (await publicWorkspace()).error;
  }

  async function userStop() {
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("user", { id: f.userId } as AuthedUser); await next(); });
    app.route("/", createCloudWorkspaceRoutes(pool, null, { workosEnabled: false }));
    const response = await app.request(`/v1/organizations/${f.organizationId}/cloud-workspaces/${f.workspaceId}/stop`, {
      method: "POST", headers: { "Idempotency-Key": randomUUID() },
    });
    expect(response.status).toBe(202);
    return (await pool.query<{ id: string }>("SELECT id FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 AND operation='stop'", [f.workspaceId])).rows[0]!.id;
  }

  it.each(["force", "deadline", "expiry worker"] as const)("retains a mandatory drain and its deadline after capture cancellation until %s", async escalation => {
    await ready(); await age();
    await requestManagedComputeStop(pool, { leaseId: input.intentId, reason: "compute_reconciliation_failed" });
    const request = (await pool.query(`SELECT request.id,request.lifecycle_intent_id,request.deadline_at
      FROM workspace_checkpoint_requests request WHERE request.workspace_id=$1`, [f.workspaceId])).rows[0];
    const idle = new DatabaseCloudIdleStop(pool, false);
    const engine = { workspaceId: f.workspaceId, organizationId: f.organizationId, generation: 1,
      engineInstanceId: f.engineInstanceId, heartbeatToken: f.heartbeatToken };
    await idle.cancel(engine, request.id);
    await idle.cancel(engine, request.id);
    for (let n = 0; n < 2; n++) {
      await pool.query("UPDATE managed_compute_allocation_leases SET next_check_at=now() WHERE id=$1", [input.intentId]);
      expect(await coordinator.runOnce()).toBe(true);
    }
    expect((await pool.query("SELECT id,state FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 AND operation='stop'", [f.workspaceId])).rows)
      .toEqual([{ id: request.lifecycle_intent_id, state: "queued" }]);
    expect((await pool.query("SELECT id,state,deadline_at,checkpoint_id FROM workspace_checkpoint_requests WHERE workspace_id=$1", [f.workspaceId])).rows)
      .toEqual([{ id: request.id, state: "cancelled", deadline_at: request.deadline_at, checkpoint_id: null }]);
    const captureDue = await readCloudWorkerNextDelay(pool, "checkpoints");
    expect(captureDue).not.toBeNull();
    expect(captureDue).toBeGreaterThan(0);
    expect(captureDue).toBeLessThanOrEqual(request.deadline_at.getTime() - Date.now() + 1_000);

    if (escalation !== "force") await pool.query("UPDATE workspace_checkpoint_requests SET created_at=now()-interval '6 minutes',deadline_at=now()-interval '1 second' WHERE id=$1", [request.id]);
    if (escalation === "expiry worker") await new CloudWorkspaceCheckpointRequestWorker(pool).expireOnce();
    else await requestManagedComputeStop(pool, { leaseId: input.intentId, reason: "compute_reconciliation_failed", force: escalation === "force" });
    expect((await pool.query("SELECT state,error_code,checkpoint_id FROM workspace_checkpoint_requests WHERE id=$1", [request.id])).rows[0])
      .toEqual({ state: "cancelled", error_code: "stop_unsealed", checkpoint_id: null });
    expect(await readCloudWorkerNextDelay(pool, "checkpoints")).toBeNull();
    provider.stop.mockResolvedValue({ ...resource(), state: "stopped" });
    await new CloudWorkspaceReconciler({ pool, provider: asProvider(), intervalMs: 1000, workosEnabled: false }).runOnce();
    expect(provider.stop).toHaveBeenCalledOnce();
    expect((await pool.query("SELECT id,state FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 AND operation='stop'", [f.workspaceId])).rows)
      .toEqual([{ id: request.lifecycle_intent_id, state: "succeeded" }]);
    expect((await pool.query("SELECT count(*)::int AS count FROM audit_log WHERE action='cloud_workspace.compute_stop_requested' AND subject->>'workspaceId'=$1", [f.workspaceId])).rows[0].count).toBe(1);
  });

  it.each(["current", "previous"] as const)("keeps an unsealed mandatory drain as the prerequisite of a %s owner wake", async backend => {
    await ready();
    await requestManagedComputeStop(pool, { leaseId: input.intentId, reason: "compute_reconciliation_failed" });
    const request = (await pool.query("SELECT id,lifecycle_intent_id,deadline_at FROM workspace_checkpoint_requests WHERE workspace_id=$1", [f.workspaceId])).rows[0];
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("user", { id: f.userId } as AuthedUser); await next(); });
    const config = { provider: "boat", imageRef: "fixture-image", architecture: "linux/amd64", cpuMillicores: 2000,
      memoryMiB: 4096, storageMiB: 20480, sourceCommit: "b".repeat(40), settingsSecretEncryptionKeys: {},
      currentSettingsSecretEncryptionKeyVersion: null } as CloudWorkspaceBackendConfig;
    app.route("/", createCloudWorkspaceRoutes(pool, config, { workosEnabled: false }));
    const wake = backend === "previous" ? { id: await withSystemTx(pool, tx => previousBackendWake(tx, f)) } : await (async () => {
      const response = await app.request(`/v1/organizations/${f.organizationId}/cloud-workspaces/${f.workspaceId}/wake`, {
        method: "POST", headers: { "Idempotency-Key": randomUUID() },
      });
      expect(response.status).toBe(202);
      return (await response.json()).intent;
    })();
    expect((await pool.query("SELECT state,resume_after_intent_id FROM cloud_workspace_lifecycle_intents WHERE id=$1", [wake.id])).rows[0])
      .toEqual({ state: "queued", resume_after_intent_id: request.lifecycle_intent_id });
    expect((await pool.query("SELECT state,deadline_at FROM workspace_checkpoint_requests WHERE id=$1", [request.id])).rows[0])
      .toEqual({ state: "queued", deadline_at: request.deadline_at });
    expect((await pool.query("SELECT state,affects_workspace FROM cloud_workspace_lifecycle_intents WHERE id=$1", [request.lifecycle_intent_id])).rows[0])
      .toEqual({ state: "queued", affects_workspace: false });
    await requestManagedComputeStop(pool, { leaseId: input.intentId, reason: "compute_reconciliation_failed", force: true });
    expect((await pool.query("SELECT desired_state,status FROM cloud_workspaces WHERE id=$1", [f.workspaceId])).rows[0])
      .toEqual({ desired_state: "running", status: "waking" });
    provider.stop.mockResolvedValue({ ...resource(), state: "stopped" });
    await new CloudWorkspaceReconciler({ pool, provider: asProvider(), intervalMs: 1000, workosEnabled: false }).runOnce();
    expect((await pool.query("SELECT state FROM cloud_workspace_lifecycle_intents WHERE id=$1", [request.lifecycle_intent_id])).rows[0].state).toBe("succeeded");
    expect((await pool.query("SELECT state FROM cloud_workspace_lifecycle_intents WHERE id=$1", [wake.id])).rows[0].state).toBe("queued");
  });

  it("retries a mandatory drain whose capture was expired by an older worker", async () => {
    await ready();
    await requestManagedComputeStop(pool, { leaseId: input.intentId, reason: "compute_reconciliation_failed" });
    const request = (await pool.query(`UPDATE workspace_checkpoint_requests SET state='expired',
      created_at=now()-interval '6 minutes',deadline_at=now()-interval '1 second',
      completed_at=now(),error_code='checkpoint_deadline_exceeded' WHERE workspace_id=$1
      RETURNING id,lifecycle_intent_id,deadline_at`, [f.workspaceId])).rows[0];
    await pool.query(`UPDATE cloud_workspace_lifecycle_intents SET state='failed',completed_at=now(),
      error_code='checkpoint_deadline_exceeded' WHERE id=$1`, [request.lifecycle_intent_id]);
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("user", { id: f.userId } as AuthedUser); await next(); });
    const config = { provider: "boat", imageRef: "fixture-image", architecture: "linux/amd64", cpuMillicores: 2000,
      memoryMiB: 4096, storageMiB: 20480, sourceCommit: "b".repeat(40), settingsSecretEncryptionKeys: {},
      currentSettingsSecretEncryptionKeyVersion: null } as CloudWorkspaceBackendConfig;
    app.route("/", createCloudWorkspaceRoutes(pool, config, { workosEnabled: false }));
    const response = await app.request(`/v1/organizations/${f.organizationId}/cloud-workspaces/${f.workspaceId}/wake`, {
      method: "POST", headers: { "Idempotency-Key": randomUUID() },
    });
    expect(response.status).toBe(202);
    const wake = (await response.json()).intent;
    expect((await pool.query("SELECT state,resume_after_intent_id FROM cloud_workspace_lifecycle_intents WHERE id=$1", [wake.id])).rows[0])
      .toEqual({ state: "queued", resume_after_intent_id: request.lifecycle_intent_id });
    expect((await pool.query("SELECT state,error_code,deadline_at,checkpoint_id FROM workspace_checkpoint_requests WHERE id=$1", [request.id])).rows[0])
      .toEqual({ state: "cancelled", error_code: "stop_unsealed", deadline_at: request.deadline_at, checkpoint_id: null });
    provider.stop.mockResolvedValue({ ...resource(), state: "stopped" });
    await new CloudWorkspaceReconciler({ pool, provider: asProvider(), intervalMs: 1000, workosEnabled: false }).runOnce();
    expect(provider.stop).toHaveBeenCalledOnce();
    expect((await pool.query("SELECT state FROM cloud_workspace_lifecycle_intents WHERE id=$1", [request.lifecycle_intent_id])).rows[0].state).toBe("succeeded");
    expect((await pool.query("SELECT desired_state,status FROM cloud_workspaces WHERE id=$1", [f.workspaceId])).rows[0])
      .toEqual({ desired_state: "running", status: "waking" });
  });

  it("keeps a successor engine warm despite a settled historical failed mandatory drain", async () => {
    await ready();
    await requestManagedComputeStop(pool, { leaseId: input.intentId, reason: "compute_reconciliation_failed" });
    const request = (await pool.query("SELECT id,lifecycle_intent_id FROM workspace_checkpoint_requests WHERE workspace_id=$1", [f.workspaceId])).rows[0];
    // Persist the failed prior cycle as an older worker could leave it. The
    // ready fixture represents the successor engine enrolled after that cycle.
    await pool.query("UPDATE workspace_checkpoint_requests SET state='expired',completed_at=now(),error_code='checkpoint_deadline_exceeded' WHERE id=$1", [request.id]);
    await pool.query("UPDATE cloud_workspace_lifecycle_intents SET state='failed',completed_at=now() WHERE id=$1", [request.lifecycle_intent_id]);
    await pool.query("UPDATE managed_compute_allocation_leases SET state='settled',settled_at=now(),stopped_observed_at=now() WHERE id=$1", [input.intentId]);
    await pool.query("UPDATE cloud_workspace_engine_instances SET created_at=clock_timestamp() WHERE id=$1", [f.engineInstanceId]);
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("user", { id: f.userId } as AuthedUser); await next(); });
    const config = { provider: "boat", imageRef: "fixture-image", architecture: "linux/amd64", cpuMillicores: 2000,
      memoryMiB: 4096, storageMiB: 20480, sourceCommit: "b".repeat(40), settingsSecretEncryptionKeys: {},
      currentSettingsSecretEncryptionKeyVersion: null } as CloudWorkspaceBackendConfig;
    app.route("/", createCloudWorkspaceRoutes(pool, config, { workosEnabled: false }));
    const response = await app.request(`/v1/organizations/${f.organizationId}/cloud-workspaces/${f.workspaceId}/wake`, {
      method: "POST", headers: { "Idempotency-Key": randomUUID() },
    });
    expect(response.status).toBe(202);
    expect((await response.json()).intent.state).toBe("succeeded");
    expect((await pool.query("SELECT state FROM cloud_workspace_lifecycle_intents WHERE id=$1", [request.lifecycle_intent_id])).rows[0].state).toBe("failed");
    expect((await pool.query("SELECT state,revoked_at FROM cloud_workspace_engine_instances WHERE id=$1", [f.engineInstanceId])).rows[0])
      .toEqual({ state: "ready", revoked_at: null });
  });

  it("adopts a slow user stop across lease ticks without cancelling its final checkpoint", async () => {
    await ready(); await age();
    const intentId = await userStop();
    const checkpoint = (await pool.query("SELECT id,deadline_at FROM workspace_checkpoint_requests WHERE lifecycle_intent_id=$1", [intentId])).rows[0];
    expect(checkpoint).toBeDefined();
    for (let n = 0; n < 2; n++) {
      // A safety observation begins draining while the user's capture is in flight.
      await pool.query("UPDATE managed_compute_allocation_leases SET state='draining',next_check_at=now() WHERE id=$1", [input.intentId]);
      expect(await coordinator.runOnce()).toBe(true);
    }
    expect((await pool.query("SELECT id,state,error_code FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 AND operation='stop'", [f.workspaceId])).rows)
      .toEqual([{ id: intentId, state: "queued", error_code: null }]);
    expect((await pool.query("SELECT id,state,deadline_at FROM workspace_checkpoint_requests WHERE lifecycle_intent_id=$1", [intentId])).rows)
      .toEqual([{ id: checkpoint.id, state: "queued", deadline_at: checkpoint.deadline_at }]);
    expect((await pool.query("SELECT stop_intent_id,last_error_code FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId])).rows[0])
      .toEqual({ stop_intent_id: intentId, last_error_code: null });
    const reconciler = new CloudWorkspaceReconciler({ pool, provider: asProvider(), intervalMs: 1000, workosEnabled: false });
    await reconciler.runOnce();
    expect(provider.stop).not.toHaveBeenCalled();
    expect((await pool.query("SELECT state,revoked_at FROM cloud_workspace_engine_instances WHERE id=$1", [f.engineInstanceId])).rows[0])
      .toEqual({ state: "ready", revoked_at: null });
  });

  it("does not supersede an observing user stop or classify desired stopped as unavailable", async () => {
    await ready(); await age();
    // A stop admitted before engine readiness has no checkpoint gate. A later
    // lease observation still must not issue another provider lifecycle intent.
    await pool.query("UPDATE cloud_workspaces SET status='setting_up' WHERE id=$1", [f.workspaceId]);
    const intentId = await userStop();
    await pool.query("UPDATE cloud_workspace_lifecycle_intents SET state='observing' WHERE id=$1", [intentId]);
    await coordinator.runOnce();
    expect((await pool.query("SELECT id,state,error_code FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 AND operation='stop'", [f.workspaceId])).rows)
      .toEqual([{ id: intentId, state: "observing", error_code: null }]);
    expect((await pool.query("SELECT stop_intent_id,last_error_code FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId])).rows[0])
      .toEqual({ stop_intent_id: intentId, last_error_code: null });
    expect((await pool.query("SELECT count(*)::int count FROM cloud_workspace_diagnostic_incidents WHERE workspace_id=$1", [f.workspaceId])).rows[0].count).toBe(0);
  });

  it("records stop_unsealed before a forced provider stop after the seal deadline without replacing the user intent", async () => {
    await ready(); await age();
    const intentId = await userStop();
    await pool.query("UPDATE workspace_checkpoint_requests SET created_at=now()-interval '6 minutes',deadline_at=now()-interval '1 second' WHERE lifecycle_intent_id=$1", [intentId]);
    const force = () => requestManagedComputeStop(pool, { leaseId: input.intentId, reason: "compute_credit_exhausted", force: true });
    await force();
    const epoch = (await pool.query("SELECT authority_epoch FROM cloud_workspaces WHERE id=$1", [f.workspaceId])).rows[0].authority_epoch;
    await force();
    expect((await pool.query("SELECT authority_epoch FROM cloud_workspaces WHERE id=$1", [f.workspaceId])).rows[0].authority_epoch).toBe(epoch);
    expect((await pool.query("SELECT id,state FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 AND operation='stop'", [f.workspaceId])).rows)
      .toEqual([{ id: intentId, state: "queued" }]);
    expect((await pool.query("SELECT state,error_code,checkpoint_id FROM workspace_checkpoint_requests WHERE lifecycle_intent_id=$1", [intentId])).rows)
      .toEqual([{ state: "cancelled", error_code: "stop_unsealed", checkpoint_id: null }]);
    const requestId = (await pool.query("SELECT id FROM workspace_checkpoint_requests WHERE lifecycle_intent_id=$1", [intentId])).rows[0].id;
    // A late capture cannot turn a cancelled gate into durable success.
    await expect(withSystemTx(pool, tx => completeWorkspaceCheckpointRequest(tx, {
      workspaceId: f.workspaceId, organizationId: f.organizationId, generation: 1,
      requestId, checkpointId: randomUUID(), reason: "before_stop",
    }))).rejects.toThrow();
    const receipts = () => pool.query("SELECT subject FROM audit_log WHERE action='cloud_workspace.stop_unsealed' AND subject->>'intentId'=$1", [intentId]);
    provider.stop.mockImplementation(async () => {
      expect((await receipts()).rows).toEqual([{ subject: expect.objectContaining({ intentId, generation: 1, outcome: "stop_unsealed" }) }]);
      return { ...resource(), state: "stopped" };
    });
    const reconciler = new CloudWorkspaceReconciler({ pool, provider: asProvider(), intervalMs: 1000, workosEnabled: false });
    await reconciler.runOnce();
    expect(provider.stop).toHaveBeenCalledOnce();
    expect((await receipts()).rowCount).toBe(1);
    expect((await pool.query("SELECT state FROM cloud_workspace_lifecycle_intents WHERE id=$1", [intentId])).rows[0].state).toBe("succeeded");
  });

  it("does not let delete settlement bypass an in-flight user checkpoint", async () => {
    await ready(); await age();
    const intentId = await userStop();
    provider.stop.mockResolvedValue({ ...resource(), state: "stopped" });
    expect(await coordinator.beforeDelete(input, asProvider(), resource())).toBe(false);
    expect(provider.stop).not.toHaveBeenCalled();
    expect((await pool.query("SELECT state,error_code FROM workspace_checkpoint_requests WHERE lifecycle_intent_id=$1", [intentId])).rows[0])
      .toEqual({ state: "queued", error_code: null });
    expect((await pool.query("SELECT count(*)::int count FROM audit_log WHERE action='cloud_workspace.stop_unsealed'")).rows[0].count).toBe(0);
  });

  it("requests a final checkpoint when delete settlement has no admitted stop", async () => {
    await ready();
    provider.stop.mockResolvedValue({ ...resource(), state: "stopped" });
    expect(await coordinator.beforeDelete(input, asProvider(), resource())).toBe(false);
    expect(provider.stop).not.toHaveBeenCalled();
    expect((await pool.query("SELECT state,reason FROM workspace_checkpoint_requests WHERE workspace_id=$1", [f.workspaceId])).rows)
      .toEqual([{ state: "queued", reason: "before_stop" }]);
    expect((await pool.query("SELECT count(*)::int count FROM audit_log WHERE action='cloud_workspace.stop_unsealed'")).rows[0].count).toBe(0);
  });

  async function failSetup(code: string, log = "") {
    await pool.query(`UPDATE cloud_workspace_setup_runs SET state='failed',completed_at=now(),
      lease_owner=NULL,lease_expires_at=NULL,error_code=$2,log_excerpt=$3 WHERE workspace_id=$1`,
    [f.workspaceId, code, log]);
    await pool.query("UPDATE cloud_workspaces SET status='failed',last_error_code=$2 WHERE id=$1", [f.workspaceId, code]);
  }

  it.each([
    ["setup_image_contract_invalid", "image_integrity_rejected", "cloud_workspace_image_integrity_rejected", ""],
    ["setup_command_failed", "safety_failure", "cloud_workspace_safety_failure", "Setup script exited unsuccessfully"],
  ])("preserves the latest failed setup cause %s at the authority check and after cleanup", async (code, reason, publicCode, log) => {
    await ready();
    await failSetup(code, log);
    await coordinator.runOnce();
    expect(provider.renewComputeLease).not.toHaveBeenCalled();
    expect((await pool.query("SELECT last_error_code FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId])).rows[0].last_error_code).toBe(code);
    const incident = (await pool.query("SELECT id,reason,first_cause FROM cloud_workspace_diagnostic_incidents WHERE operation_id=$1", [input.intentId])).rows[0];
    expect(incident).toMatchObject({ reason, first_cause: { phase: "authority_check", code } });
    expect(await publicWorkspace()).toMatchObject({
      setupFailure: { code, hasLog: log.length > 0 },
      error: { code: publicCode, message: expect.stringContaining(incident.id) },
    });
    await pool.query("UPDATE cloud_workspaces SET status='stopped',last_error_code=NULL,last_error_message=NULL WHERE id=$1", [f.workspaceId]);
    expect(await publicWorkspace()).toMatchObject({ setupFailure: { code, hasLog: log.length > 0 } });
  });

  it("does not preserve an unknown setup code or expose it in the workspace document", async () => {
    await ready();
    await failSetup("unrecognized_failure");
    await coordinator.runOnce();
    expect((await pool.query("SELECT last_error_code FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId])).rows[0].last_error_code).toBe("compute_scope_unavailable");
    expect(await publicWorkspace()).toMatchObject({ setupFailure: { code: "compute_reconciliation_failed", hasLog: false } });
    expect(JSON.stringify(await publicWorkspace())).not.toContain("unrecognized_failure");
  });

  it("preserves the failed setup cause if cleanup already changed the lifecycle status", async () => {
    await ready();
    await failSetup("setup_image_contract_invalid");
    await pool.query("UPDATE cloud_workspaces SET status='stopping',desired_state='stopped' WHERE id=$1", [f.workspaceId]);
    await coordinator.runOnce();
    expect((await pool.query("SELECT last_error_code FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId])).rows[0].last_error_code).toBe("setup_image_contract_invalid");
  });

  it.each(["queued", "succeeded"])("ignores an older failed setup when the latest attempt is %s", async state => {
    await ready();
    await failSetup("setup_image_contract_invalid");
    await pool.query(`INSERT INTO cloud_workspace_setup_runs(workspace_id,generation,org_id,attempt,state,completed_at)
      VALUES ($1,1,$2,2,$3::cloud_workspace_setup_state,CASE WHEN $3::text='succeeded' THEN now() ELSE NULL END)`, [f.workspaceId, f.organizationId, state]);
    await coordinator.runOnce();
    expect((await pool.query("SELECT last_error_code FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId])).rows[0].last_error_code).toBe("compute_scope_unavailable");
    expect((await publicWorkspace()).setupFailure).toBeNull();
  });

  it("does not attribute an older generation's setup failure to the current generation", async () => {
    await ready();
    await failSetup("setup_image_contract_invalid");
    await pool.query(`INSERT INTO cloud_workspace_generations(workspace_id,generation,org_id,provider,image_ref,architecture,
      cpu_millicores,memory_mib,storage_mib,created_by,provider_connection_id)
      SELECT workspace_id,2,org_id,provider,image_ref,architecture,cpu_millicores,memory_mib,storage_mib,created_by,provider_connection_id
      FROM cloud_workspace_generations WHERE workspace_id=$1 AND generation=1`, [f.workspaceId]);
    await pool.query(`INSERT INTO cloud_workspace_provider_bindings(workspace_id,generation,org_id,provider,observed_state)
      SELECT workspace_id,2,org_id,provider,'stopped' FROM cloud_workspace_provider_bindings WHERE workspace_id=$1 AND generation=1`, [f.workspaceId]);
    await pool.query("UPDATE cloud_workspaces SET current_generation=2 WHERE id=$1", [f.workspaceId]);
    await coordinator.runOnce();
    expect((await pool.query("SELECT last_error_code FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId])).rows[0].last_error_code).toBe("compute_scope_unavailable");
    expect((await publicWorkspace()).setupFailure).toBeNull();
  });

  it("preserves the initiating budget stop through pending checkpoint, repeated drain, failure and settlement", async () => {
    await ready(); await age();
    await requestManagedComputeStop(pool, {leaseId:input.intentId,reason:"compute_credit_exhausted"});
    const incident = async () => (await pool.query("SELECT id,reason,first_cause,terminal_cause,occurrence_count FROM cloud_workspace_diagnostic_incidents WHERE operation_id=$1",[input.intentId])).rows[0];
    const original = await incident();
    expect(original.reason).toBe("budget_stop");
    expect((await pool.query("SELECT state FROM workspace_checkpoint_requests WHERE workspace_id=$1",[f.workspaceId])).rows[0].state).toBe("queued");
    for (let n=0;n<2;n++) {
      await pool.query("UPDATE managed_compute_allocation_leases SET next_check_at=now() WHERE id=$1",[input.intentId]);
      await coordinator.runOnce();
    }
    expect(await incident()).toEqual(original);
    provider.readComputeUsage.mockRejectedValueOnce(new TypeError("synthetic drain observation"));
    await pool.query("UPDATE managed_compute_allocation_leases SET next_check_at=now() WHERE id=$1",[input.intentId]);
    await coordinator.runOnce();
    expect(await incident()).toMatchObject({id:original.id,reason:"budget_stop",terminal_cause:original.terminal_cause});
    // Finite-lease fallback is still required; it reuses the initiating cause.
    await requestManagedComputeStop(pool,{leaseId:input.intentId,reason:"compute_scope_unavailable",force:true});
    expect(await publicWorkspaceError()).toMatchObject({code:"cloud_compute_allowance_exhausted",message:expect.stringContaining(original.id)});
    stoppedMeter();
    await pool.query("UPDATE managed_compute_allocation_leases SET stopped_observed_at=now()-interval '10 seconds',next_check_at=now() WHERE id=$1",[input.intentId]);
    await coordinator.runOnce();
    await pool.query("UPDATE cloud_workspaces SET status='stopped',last_error_code=NULL,last_error_message=NULL WHERE id=$1",[f.workspaceId]);
    expect((await pool.query("SELECT state FROM managed_compute_allocation_leases WHERE id=$1",[input.intentId])).rows[0].state).toBe("settled");
    expect(await publicWorkspaceError()).toMatchObject({code:"cloud_compute_allowance_exhausted",message:expect.stringContaining(original.id)});
    // Ready clears the public error at its committed boundary, even if private
    // recovery bookkeeping has not run before another ordinary stop.
    await pool.query("UPDATE cloud_workspaces SET status='ready',desired_state='running' WHERE id=$1",[f.workspaceId]);
    await pool.query("UPDATE cloud_workspaces SET status='stopped',desired_state='stopped' WHERE id=$1",[f.workspaceId]);
    expect(await publicWorkspaceError()).toBeNull();
  });

  it("keeps an initiating engine-expiry stop visible through generic compute drain observations", async () => {
    await ready(); await age();
    // A compute incident can predate the engine stop but only become terminal
    // later. Incident creation order is not the order in which stops started.
    await retainCloudDiagnostic(pool,{workspaceId:f.workspaceId,organizationId:f.organizationId,generation:1,operationKind:"compute",operationId:input.intentId},
      {phase:"provider_inspect",code:"provider_temporarily_unavailable",errorClass:"provider",retryable:true,decision:"retry"});
    await recoverCloudDiagnostic(pool,{workspaceId:f.workspaceId,organizationId:f.organizationId,generation:1});
    await pool.query("UPDATE cloud_workspace_lifecycle_intents SET state='succeeded',completed_at=now() WHERE id=$1",[input.intentId]);
    await pool.query("UPDATE cloud_workspace_engine_instances SET last_heartbeat_at=now()-interval '2 minutes',lease_expires_at=now()-interval '1 minute' WHERE id=$1",[f.engineInstanceId]);
    expect(await stopUnavailableCloudEngine(pool,null)).toBe(true);
    const original = await publicWorkspaceError();
    expect(original.code).toBe("cloud_workspace_engine_expired");
    provider.readComputeUsage.mockRejectedValueOnce(new TypeError("synthetic drain observation"));
    await coordinator.runOnce();
    expect(await publicWorkspaceError()).toEqual(original);
  });

  it("routes the lifecycle reconciler's create through the funded allocation boundary",async()=>{
    await grant();provider.find.mockResolvedValue([]);
    const reconciler=new CloudWorkspaceReconciler({pool,provider:asProvider(),providerResolver:resolver(),computePolicy:policy,workosEnabled:false,intervalMs:1000});
    expect(await reconciler.runOnce()).toBe(true);
    expect(provider.createWithComputeLease).toHaveBeenCalledTimes(1);expect(provider.create).not.toHaveBeenCalled();
    expect((await balance())[0]!.reservedMicroUsd).toBeGreaterThan(0);
    expect((await pool.query("SELECT state FROM cloud_workspace_lifecycle_intents WHERE id=$1",[input.intentId])).rows[0].state).toBe('succeeded');
  });

  it("meters cumulative usage and commits additional credit before extending the provider deadline", async () => {
    await ready();
    await age();
    provider.inspect.mockResolvedValue(resource(200));
    provider.renewComputeLease.mockImplementationOnce(async (_id, ttl) => {
      expect((await balance())[0]).toMatchObject({ debitedMicroUsd: 6000 });
      expect((await balance())[0]!.reservedMicroUsd).toBeGreaterThanOrEqual(
        9000,
      );
      return { expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
    });
    expect(await coordinator.runOnce()).toBe(true);
    expect(provider.renewComputeLease).toHaveBeenCalledTimes(1);
    expect(
      (
        await pool.query(
          "SELECT state,last_error_code FROM managed_compute_allocation_leases WHERE id=$1",
          [input.intentId],
        )
      ).rows[0],
    ).toEqual({ state: "active", last_error_code: null });
    const before = (await balance())[0]!.debitedMicroUsd;
    await pool.query(
      "UPDATE managed_compute_allocation_leases SET next_check_at=now() WHERE id=$1",
      [input.intentId],
    );
    provider.inspect.mockResolvedValue(resource(900));
    await coordinator.runOnce();
    expect((await balance())[0]!.debitedMicroUsd).toBe(before);
  });
  it("does not fund renewal after the ready engine's lease expires", async () => {
    await ready();
    await age();
    provider.inspect.mockResolvedValue(resource(200));
    await pool.query(`UPDATE cloud_workspace_engine_instances
      SET registered_at=now()-interval '2 minutes',last_heartbeat_at=now()-interval '2 minutes',
          lease_expires_at=now()-interval '1 second' WHERE id=$1`, [f.engineInstanceId]);
    await coordinator.runOnce();
    expect(provider.renewComputeLease).not.toHaveBeenCalled();
    expect((await pool.query("SELECT state FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId])).rows[0].state).toBe("draining");
    expect((await pool.query("SELECT desired_state FROM cloud_workspaces WHERE id=$1", [f.workspaceId])).rows[0].desired_state).toBe("stopped");
    expect((await pool.query("SELECT count(*)::int AS n FROM workspace_checkpoint_requests WHERE workspace_id=$1", [f.workspaceId])).rows[0].n).toBe(0);
  });

  it("does not renew a short lease on every meter poll",async()=>{
    coordinator=new CloudWorkspaceComputeLeaseCoordinator({pool,providerResolver:resolver(),workosEnabled:false,policy:{...policy,minimumTtlSeconds:60,maximumTtlSeconds:60},usageMeterWindowMs:0});
    await ready();provider.inspect.mockResolvedValue(resource(60));await coordinator.runOnce();
    expect(provider.renewComputeLease).not.toHaveBeenCalled();
  });
  it.each([
    ["provider_request_failed", 503],
    ["provider_request_timeout", undefined],
    ["provider_request_unavailable", undefined],
  ] as const)("retries an active allocation after %s and renews promptly on recovery", async (code, httpStatus) => {
    await ready();
    await age();
    const running = resource();
    const previousIncident = await retainCloudDiagnostic(pool, {
      workspaceId: f.workspaceId, organizationId: f.organizationId, generation: 1,
      operationKind: "compute", operationId: input.intentId,
    }, { phase: "provider_inspect", code, errorClass: "provider", retryable: true, decision: "retry" });
    const initial = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(initial);
    vi.spyOn(coordinator as unknown as { now(): Promise<number> }, "now").mockImplementation(async () => Date.now());
    provider.inspect.mockRejectedValueOnce(new CloudProviderError(code, "private-provider-body", true, { httpStatus }));
    await coordinator.runOnce();
    expect((await pool.query("SELECT state,last_error_code FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId])).rows[0])
      .toEqual({ state: "active", last_error_code: code });
    expect((await pool.query("SELECT 1 FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 AND operation='stop'", [f.workspaceId])).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM workspace_checkpoint_requests WHERE workspace_id=$1", [f.workspaceId])).rowCount).toBe(0);
    expect((await pool.query("SELECT recovered_at,occurrence_count FROM cloud_workspace_diagnostic_incidents WHERE id=$1", [previousIncident])).rows[0])
      .toMatchObject({ recovered_at: null, occurrence_count: "1" });
    expect(await publicWorkspaceError()).toBeNull();
    expect(Number((await nextCheck()).from_now)).toBeGreaterThan(10);
    expect(provider.renewComputeLease).not.toHaveBeenCalled();

    vi.setSystemTime(initial + 30_000);
    provider.inspect.mockResolvedValue(running);
    await pool.query("UPDATE managed_compute_allocation_leases SET next_check_at=clock_timestamp() WHERE id=$1", [input.intentId]);
    await coordinator.runOnce();
    expect(provider.renewComputeLease).toHaveBeenCalledTimes(1);
    expect((await pool.query("SELECT state,last_error_code,first_error_at,provider_expires_at FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId])).rows[0])
      .toMatchObject({ state: "active", last_error_code: null, first_error_at: null, provider_expires_at: new Date(initial + 930_000) });
    expect((await pool.query("SELECT recovered_at FROM cloud_workspace_diagnostic_incidents WHERE id=$1", [previousIncident])).rows[0].recovered_at).not.toBeNull();
  });
  it.each(["funded_until", "provider_expires_at"] as const)("bounds outage backoff by %s and checkpoints before its deadline", async deadline => {
    await ready();
    const initial = Date.now();
    const expires = initial + 340_000;
    // The schema requires the confirmed provider TTL to fit inside funding.
    await pool.query(`UPDATE managed_compute_allocation_leases SET
      ${deadline === "funded_until" ? "funded_until=$2," : ""} provider_expires_at=$2,
      first_error_at=clock_timestamp()-interval '1 hour' WHERE id=$1`, [input.intentId, new Date(expires)]);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(initial);
    vi.spyOn(coordinator as unknown as { now(): Promise<number> }, "now").mockImplementation(async () => Date.now());
    provider.inspect.mockRejectedValue(new CloudProviderError("provider_request_failed", "private-provider-body", true, { httpStatus: 503 }));
    await coordinator.runOnce();
    const lease = (await pool.query("SELECT state,next_check_at FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId])).rows[0];
    expect(lease.state).toBe("active");
    expect(lease.next_check_at.getTime()).toBeLessThanOrEqual(expires - 315_000);
    expect((await pool.query("SELECT 1 FROM cloud_workspace_diagnostic_incidents WHERE operation_id=$1", [input.intentId])).rowCount).toBe(0);

    vi.setSystemTime(expires - 315_000);
    await pool.query("UPDATE managed_compute_allocation_leases SET next_check_at=clock_timestamp() WHERE id=$1", [input.intentId]);
    await coordinator.runOnce();
    expect((await pool.query("SELECT state FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId])).rows[0].state).toBe("draining");
    const checkpoint = (await pool.query("SELECT state,deadline_at FROM workspace_checkpoint_requests WHERE workspace_id=$1", [f.workspaceId])).rows[0];
    expect(checkpoint).toMatchObject({ state: "queued" });
    expect(checkpoint.deadline_at.getTime()).toBeLessThan(expires);
    const incident = (await pool.query("SELECT id,reason,first_cause FROM cloud_workspace_diagnostic_incidents WHERE operation_id=$1", [input.intentId])).rows[0];
    expect(incident).toMatchObject({ first_cause: { code: "provider_request_failed", httpClass: "5xx", stopReason: "provider_outage", decision: "checkpoint" } });
    // Escalation must preserve the outage reason and reference.
    vi.setSystemTime(expires - 40_000);
    await pool.query("UPDATE managed_compute_allocation_leases SET next_check_at=clock_timestamp() WHERE id=$1", [input.intentId]);
    await coordinator.runOnce();
    expect((await pool.query("SELECT desired_state,status,last_error_message FROM cloud_workspaces WHERE id=$1", [f.workspaceId])).rows[0])
      .toMatchObject({ desired_state: "stopped", status: "stopping", last_error_message: expect.stringContaining("provider outage") });
    expect(await publicWorkspaceError()).toEqual({ code: "cloud_workspace_provider_outage",
      message: `Workspace stopped because a provider outage exhausted its compute lease runway (incident ${incident.id})` });
    expect((await pool.query("SELECT state FROM workspace_checkpoint_requests WHERE workspace_id=$1", [f.workspaceId])).rows[0].state).toBe("cancelled");
  });
  it("keeps outage backoff and recovery pending when funding succeeds but provider renewal still fails", async () => {
    await ready();
    await age();
    await pool.query(`UPDATE managed_compute_allocation_leases SET provider_expires_at=clock_timestamp()+interval '500 seconds',
      first_error_at=clock_timestamp()-interval '2 minutes',last_error_code='provider_request_failed' WHERE id=$1`, [input.intentId]);
    const original = (await pool.query("SELECT first_error_at FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId])).rows[0].first_error_at;
    const incidentId = await retainCloudDiagnostic(pool, {
      workspaceId: f.workspaceId, organizationId: f.organizationId, generation: 1,
      operationKind: "compute", operationId: input.intentId,
    }, { phase: "provider_inspect", code: "provider_request_failed", errorClass: "provider", retryable: true, decision: "retry" });
    provider.inspect.mockResolvedValue(resource(500));
    provider.renewComputeLease.mockRejectedValue(new CloudProviderError("provider_request_failed", "fixture", true, { httpStatus: 503 }));
    await coordinator.runOnce();
    expect(provider.renewComputeLease).toHaveBeenCalledTimes(1);
    expect((await pool.query("SELECT state,first_error_at FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId])).rows[0])
      .toEqual({ state: "active", first_error_at: original });
    expect(Number((await nextCheck()).from_now)).toBeGreaterThan(110);
    expect((await pool.query("SELECT recovered_at,occurrence_count FROM cloud_workspace_diagnostic_incidents WHERE id=$1", [incidentId])).rows[0])
      .toEqual({ recovered_at: null, occurrence_count: "1" });
  });
  it("does not defer non-retryable failures or attested provider loss despite ample runway", async () => {
    await ready();
    provider.inspect.mockRejectedValue(new CloudProviderError("provider_resource_lost", "fixture", false));
    await coordinator.runOnce();
    expect((await pool.query("SELECT state FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId])).rows[0].state).toBe("draining");
  });
  it("does not defer a provider outage after engine authority expires", async () => {
    await ready();
    await pool.query(`UPDATE cloud_workspace_engine_instances SET registered_at=clock_timestamp()-interval '2 minutes',
      last_heartbeat_at=clock_timestamp()-interval '2 minutes',lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [f.engineInstanceId]);
    provider.inspect.mockRejectedValue(new CloudProviderError("provider_request_failed", "fixture", true, { httpStatus: 503 }));
    await coordinator.runOnce();
    expect((await pool.query("SELECT state FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId])).rows[0].state).toBe("draining");
  });
  it("keeps reservations and queues a checkpoint stop when provider metering exhausts the runway", async () => {
    await ready();
    await age();
    await pool.query("UPDATE managed_compute_allocation_leases SET provider_expires_at=clock_timestamp()+interval '5 minutes' WHERE id=$1", [input.intentId]);
    provider.readComputeUsage.mockRejectedValue(
      new CloudProviderError("provider_usage_unavailable", "fixture", true),
    );
    await coordinator.runOnce();
    expect(provider.renewComputeLease).not.toHaveBeenCalled();
    expect((await balance())[0]!.reservedMicroUsd).toBeGreaterThan(0);
    expect(
      (
        await pool.query(
          "SELECT state FROM managed_compute_allocation_leases WHERE id=$1",
          [input.intentId],
        )
      ).rows[0].state,
    ).toBe("draining");
    expect(
      (
        await pool.query(
          "SELECT state FROM workspace_checkpoint_requests WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rows[0].state,
    ).toBe("queued");
  });
  it.each(["connection_lost", "statement_timeout", "committed_connection_lost"] as const)("OF19 retains prepaid running compute after a real ledger %s", async kind => {
    await ready(); await age();
    const interrupted = interruptedLedgerPool(pool, kind);
    const observedErrors: Array<{ name: string; code: unknown }> = [];
    const originalMeter = DatabaseManagedComputeCreditLedger.prototype.meter;
    vi.spyOn(DatabaseManagedComputeCreditLedger.prototype, "meter").mockImplementation(async function (this: DatabaseManagedComputeCreditLedger, input) {
      try { return await originalMeter.call(this, input); }
      catch (error) {
        observedErrors.push({ name: (error as Error).name, code: (error as { code?: unknown }).code });
        throw error;
      }
    });
    const log = vi.fn();
    const broken = new CloudWorkspaceComputeLeaseCoordinator({ pool: interrupted.pool, providerResolver: resolver(), workosEnabled: false, policy, usageMeterWindowMs: 0, logger: { error: log } });
    expect(await broken.runOnce()).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("control_plane_unavailable, meter_commit"));
    expect(interrupted.observed.interruptions).toBe(1);
    expect(observedErrors).toEqual([kind !== "statement_timeout"
      ? { name: "DatabaseConnectionLostError", code: "database_connection_lost" }
      : { name: "error", code: "57014" }]);
    expect((await pool.query("SELECT state,stop_intent_id FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId])).rows[0])
      .toEqual({ state: "active", stop_intent_id: null });
    expect((await pool.query("SELECT count(*)::int AS n FROM workspace_checkpoint_requests WHERE workspace_id=$1", [f.workspaceId])).rows[0].n).toBe(0);
    expect(provider.stop).not.toHaveBeenCalled();
    expect(provider.renewComputeLease).not.toHaveBeenCalled();
    expect((await balance())[0]!.reservedMicroUsd).toBeGreaterThan(0);
    const retryDelay = Number((await nextCheck()).from_now);
    expect(retryDelay).toBeGreaterThan(0);
    expect(retryDelay).toBeLessThanOrEqual(300);
    await pool.query("UPDATE managed_compute_allocation_leases SET next_check_at=clock_timestamp() WHERE id=$1", [input.intentId]);
    expect(await broken.runOnce()).toBe(true);
    expect((await pool.query("SELECT state,last_error_code,first_error_at FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId])).rows[0])
      .toEqual({ state: "active", last_error_code: null, first_error_at: null });
    expect((await balance())[0]!.debitedMicroUsd).toBe(6000);
    expect((await pool.query("SELECT count(*)::int AS n FROM managed_compute_credit_events WHERE reservation_id=$1 AND kind='debit'", [input.intentId])).rows[0].n).toBe(1);
    expect(pool.waitingCount).toBe(0);
  });

  it("OF19 re-observes an ambiguously committed reservation before renewing and never duplicates funding", async () => {
    await ready(); await age();
    const expires = new Date(Date.now() + 400_000);
    provider.inspect.mockResolvedValue({ ...resource(), metadata: { computeLeaseExpiresAt: expires.toISOString() } });
    await pool.query("UPDATE managed_compute_allocation_leases SET provider_expires_at=$2 WHERE id=$1", [input.intentId, expires]);
    const interrupted = interruptedLedgerPool(pool, "committed_connection_lost", "reserve");
    const worker = new CloudWorkspaceComputeLeaseCoordinator({ pool: interrupted.pool, providerResolver: resolver(), workosEnabled: false, policy, usageMeterWindowMs: 0 });
    await worker.runOnce();
    expect(interrupted.observed.interruptions).toBe(1);
    await expectNoStop();
    expect(provider.renewComputeLease).not.toHaveBeenCalled();
    const reservations = () => pool.query("SELECT id,period_id,authorized_micro_usd,reserved_micro_usd,debited_micro_usd FROM managed_compute_credit_reservations WHERE id=$1", [input.intentId]);
    const committed = (await reservations()).rows;
    expect(committed).toHaveLength(1);
    await pool.query("UPDATE managed_compute_allocation_leases SET next_check_at=clock_timestamp() WHERE id=$1", [input.intentId]);
    await worker.runOnce();
    const recovered = (await reservations()).rows;
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ id: committed[0].id, period_id: committed[0].period_id });
    // A fresh plan may reserve a few extra seconds; it must re-use all money
    // already committed, not add the original reservation again.
    expect(Number(recovered[0].authorized_micro_usd) - Number(committed[0].authorized_micro_usd)).toBeLessThan(500);
    expect(Number(recovered[0].reserved_micro_usd) + Number(recovered[0].debited_micro_usd)).toBe(Number(recovered[0].authorized_micro_usd));
    expect(provider.renewComputeLease).toHaveBeenCalledOnce();
    expect(provider.createWithComputeLease).toHaveBeenCalledOnce();
    expect(provider.startWithComputeLease).not.toHaveBeenCalled();
  });

  it.each(["api", "worker"] as const)("OF19 keeps funded compute after a real %s pool acquire timeout", async kind => {
    await ready(); await age();
    const base = kind === "api" ? createPool(process.env.TEST_DATABASE_URL!, { workload: "api", maxConnections: 1 })
      : new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1, connectionTimeoutMillis: 25 });
    let armed = false, failed = false;
    const wrapped = new Proxy(base, { get(target, key) {
      if (key === "connect") return async () => {
        if (armed && !failed) {
          failed = true;
          const held = await target.connect();
          try { return await target.connect(); } finally { held.release(); }
        }
        return target.connect();
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const originalMeter = DatabaseManagedComputeCreditLedger.prototype.meter;
    vi.spyOn(DatabaseManagedComputeCreditLedger.prototype, "meter").mockImplementation(async function (this: DatabaseManagedComputeCreditLedger, input) {
      armed = true;
      return originalMeter.call(this, input);
    });
    try {
      const worker = new CloudWorkspaceComputeLeaseCoordinator({ pool: wrapped, providerResolver: resolver(), workosEnabled: false, policy, usageMeterWindowMs: 0 });
      await worker.runOnce();
      expect(failed).toBe(true);
      await expectNoStop();
      expect((await pool.query("SELECT last_error_code FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId])).rows[0].last_error_code).toBe("control_plane_unavailable");
      expect(provider.renewComputeLease).not.toHaveBeenCalled();
      expect(base.waitingCount).toBe(0);
    } finally { await base.end(); }
  });

  it.each(["40001", "40P01"] as const)("OF19 classifies exhausted %s as unavailable without replaying provider I/O", async code => {
    await ready(); await age();
    const db = abortingPool(pool, { code, count: 3, when: providerLookup });
    await originalCoordinator(db.pool).runOnce();
    expect(db.observed.aborts).toBe(3);
    await expectNoStop();
    expect((await pool.query("SELECT last_error_code FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId])).rows[0].last_error_code).toBe("control_plane_unavailable");
    expect(provider.inspect).not.toHaveBeenCalled();
    expect(provider.renewComputeLease).not.toHaveBeenCalled();
  });

  it.each([false, true])("OF19 unavailable re-observation is unknown, including unavailable database clock=%s", async clockUnavailable => {
    await ready(); await age();
    const interrupted = interruptedLedgerPool(pool, "connection_lost");
    const worker = new CloudWorkspaceComputeLeaseCoordinator({ pool: interrupted.pool, providerResolver: resolver(), workosEnabled: false, policy, usageMeterWindowMs: 0 });
    vi.spyOn(worker as unknown as { activeAllocationRetry(): Promise<boolean> }, "activeAllocationRetry").mockRejectedValue(new DatabaseConnectionLostError());
    if (clockUnavailable) {
      vi.spyOn(worker as unknown as { now(): Promise<number> }, "now").mockRejectedValue(new DatabaseConnectionLostError());
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 86_400_000);
    }
    await expect(worker.runOnce()).resolves.toBe(true);
    await expectNoStop();
    expect(provider.renewComputeLease).not.toHaveBeenCalled();
    const row = (await pool.query("SELECT *,clock_timestamp() AS observed_now FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId])).rows[0];
    expect(row.next_check_at.getTime()).toBeGreaterThan(row.observed_now.getTime());
    expect(row.next_check_at.getTime()).toBeLessThanOrEqual(Math.min(row.funded_until.getTime(), row.provider_expires_at.getTime()) - 315000);
    expect(row.last_error_code).toBe("control_plane_unavailable");
  });

  it.each(["funded_until", "provider_expires_at"] as const)("OF19 stops at the confirmed %s checkpoint margin with a closed CP-unavailable incident", async deadline => {
    await ready(); await age();
    await pool.query("UPDATE managed_compute_allocation_leases SET " + deadline + "=statement_timestamp()+interval '5 minutes'" +
      (deadline === "funded_until" ? ",provider_expires_at=least(provider_expires_at,statement_timestamp()+interval '5 minutes')" : "") + " WHERE id=$1", [input.intentId]);
    const interrupted = interruptedLedgerPool(pool, "connection_lost");
    await new CloudWorkspaceComputeLeaseCoordinator({ pool: interrupted.pool, providerResolver: resolver(), workosEnabled: false, policy, usageMeterWindowMs: 0 }).runOnce();
    expect((await pool.query("SELECT state FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId])).rows[0].state).toBe("draining");
    const incident = (await pool.query("SELECT first_cause FROM cloud_workspace_diagnostic_incidents WHERE operation_id=$1", [input.intentId])).rows[0];
    expect(incident.first_cause).toMatchObject({ code: "control_plane_unavailable", errorClass: "database", stopReason: "control_plane_unavailable", decision: "checkpoint", site: "meter_commit" });
    // Public errors remain hidden while the final checkpoint still preserves
    // the ready workspace. A later finite-deadline escalation keeps its cause.
    await requestManagedComputeStop(pool, { leaseId: input.intentId, reason: "compute_scope_unavailable", force: true });
    expect(await publicWorkspaceError()).toMatchObject({ code: "cloud_workspace_control_plane_unavailable" });
    expect(provider.renewComputeLease).not.toHaveBeenCalled();
    expect((await balance())[0]!.reservedMicroUsd).toBeGreaterThan(0);
  });

  it("OF19 never turns an outage fallback into a stop for a different allocation generation", async () => {
    await ready(); await age();
    await pool.query("UPDATE managed_compute_allocation_leases SET lease_owner='compute:original-proof',lease_expires_at=clock_timestamp()+interval '5 minutes' WHERE id=$1", [input.intentId]);
    await requestManagedComputeStop(pool, { leaseId: input.intentId, reason: "control_plane_unavailable",
      expectedLeaseOwner: "compute:original-proof", expectedGeneration: 2 });
    await expectNoStop();
    expect((await pool.query("SELECT lease_owner FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId])).rows[0].lease_owner).toBe("compute:original-proof");
  });

  it("OF19 still refuses a known revoked engine after a real ledger connection loss", async () => {
    await ready(); await age();
    await pool.query("UPDATE cloud_workspace_engine_instances SET revoked_at=clock_timestamp(),state='revoked' WHERE id=$1", [f.engineInstanceId]);
    const interrupted = interruptedLedgerPool(pool, "connection_lost");
    await new CloudWorkspaceComputeLeaseCoordinator({ pool: interrupted.pool, providerResolver: resolver(), workosEnabled: false, policy, usageMeterWindowMs: 0 }).runOnce();
    expect((await pool.query("SELECT state FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId])).rows[0].state).toBe("draining");
    expect(provider.renewComputeLease).not.toHaveBeenCalled();
  });

  it("OF19 keeps permanent ledger corruption on the safety path", async () => {
    await ready(); await age();
    vi.spyOn(DatabaseManagedComputeCreditLedger.prototype, "meter").mockRejectedValueOnce(Object.assign(new Error("private-corruption-canary"), { code: "23514" }));
    await coordinator.runOnce();
    expect((await pool.query("SELECT state FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId])).rows[0].state).toBe("draining");
    const incident = (await pool.query("SELECT reason,first_cause FROM cloud_workspace_diagnostic_incidents WHERE operation_id=$1", [input.intentId])).rows[0];
    expect(incident).toMatchObject({ reason: "safety_failure", first_cause: { sqlState: "23514" } });
    expect(incident.first_cause.stopReason).not.toBe("control_plane_unavailable");
    expect(JSON.stringify(incident)).not.toContain("private-corruption-canary");
    expect(provider.renewComputeLease).not.toHaveBeenCalled();
  });

  it("retains a typed incident before safety stop and after settlement", async () => {
    await ready(); await age();
    provider.readComputeUsage.mockRejectedValueOnce(Object.assign(new Error("credential-canary"), { code: "23514" }));
    await coordinator.runOnce();
    const incident = (await pool.query("SELECT * FROM cloud_workspace_diagnostic_incidents WHERE operation_id=$1", [input.intentId])).rows[0];
    expect(incident).toMatchObject({ reason: "safety_failure", first_cause: { phase: "meter_read", sqlState: "23514" }, occurrence_count: "1" });
    expect(JSON.stringify(incident)).not.toContain("credential-canary");
    expect((await pool.query("SELECT subject FROM audit_log WHERE action='cloud_workspace.compute_stop_requested' ORDER BY created_at DESC LIMIT 1")).rows[0]?.subject).toMatchObject({ incidentId: incident.id });
    provider.inspect.mockResolvedValue({ ...resource(), state: "stopped" });
    provider.readComputeUsage.mockImplementation(async (id, window) => ({ resourceId: id, since: window!.since.toISOString(), until: window!.until!.toISOString(), billableSeconds: 600,
      secondsPerDollar: 100000, listPriceMicroUsd: computeMicroUsd(600, 100000), running: false }));
    await pool.query("UPDATE managed_compute_allocation_leases SET next_check_at=now(),stopped_observed_at=now()-interval '10 seconds' WHERE id=$1",[input.intentId]);
    coordinator = new CloudWorkspaceComputeLeaseCoordinator({ pool,providerResolver:resolver(),workosEnabled:false,policy,usageMeterWindowMs:0 });
    await coordinator.runOnce();
    expect((await pool.query("SELECT state,last_error_code FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId])).rows[0]).toEqual({ state: "settled", last_error_code: null });
    expect((await pool.query("SELECT id,first_cause FROM cloud_workspace_diagnostic_incidents WHERE operation_id=$1", [input.intentId])).rows[0]).toMatchObject({ id: incident.id, first_cause: { sqlState: "23514" } });
  });
  it("still requests a safety stop if diagnostic storage is unavailable", async () => {
    await ready(); await age();
    await pool.query("DROP TABLE cloud_workspace_diagnostic_incidents");
    provider.inspect.mockRejectedValueOnce(new TypeError("credential-canary"));
    await coordinator.runOnce();
    expect((await pool.query("SELECT state,stop_intent_id FROM managed_compute_allocation_leases WHERE id=$1",[input.intentId])).rows[0]).toMatchObject({ state:"draining",stop_intent_id:expect.any(String) });
    expect(Number((await pool.query("SELECT storage_failures FROM cloud_workspace_diagnostic_cleanup")).rows[0].storage_failures)).toBeGreaterThan(0);
  });
  it("does not report recovery before provider renewal has succeeded", async () => {
    await ready(); await age();
    const id = await retainCloudDiagnostic(pool, { workspaceId:f.workspaceId, organizationId:f.organizationId,
      generation:1, operationKind:"engine", operationId:f.engineInstanceId },
    { phase:"authority_check", code:"engine_unavailable", errorClass:"unknown", retryable:false });
    provider.inspect.mockResolvedValue(resource(30));
    provider.renewComputeLease.mockRejectedValueOnce(new TypeError("synthetic renewal failure"));
    await coordinator.runOnce();
    expect((await pool.query("SELECT recovered_at FROM cloud_workspace_diagnostic_incidents WHERE id=$1",[id])).rows[0].recovered_at).toBeNull();
  });
  it.each(["provider_inspect","ledger_commit","authority_check","provider_renew","final_settlement"] as const)("retains the actual %s failure phase",async phase=>{
    await ready(); await age();
    let restore: (()=>void)|undefined;
    if(phase==="provider_inspect") provider.inspect.mockRejectedValueOnce(new CloudProviderError("provider_request_failed","credential-canary",false));
    if(phase==="ledger_commit") {
      const spy=vi.spyOn(DatabaseManagedComputeCreditLedger.prototype,"meter").mockRejectedValueOnce(Object.assign(new Error("credential-canary"),{code:"23514"}));
      restore=()=>spy.mockRestore();
    }
    if(phase==="provider_renew") {
      provider.inspect.mockResolvedValue(resource(30));
      provider.renewComputeLease.mockRejectedValueOnce(new TypeError("credential-canary"));
    }
    if(phase==="authority_check") {
      const spy=vi.spyOn(coordinator as unknown as {scope():Promise<never>},"scope").mockRejectedValueOnce(Object.assign(new Error("credential-canary"),{code:"23514"}));
      restore=()=>spy.mockRestore();
    }
    if(phase==="final_settlement") {
      stoppedMeter();
      await pool.query("UPDATE managed_compute_allocation_leases SET stopped_observed_at=now()-interval '10 seconds' WHERE id=$1",[input.intentId]);
      const spy=vi.spyOn(coordinator as unknown as {settle():Promise<void>},"settle").mockRejectedValueOnce(Object.assign(new Error("credential-canary"),{code:"23514"}));
      restore=()=>spy.mockRestore();
    }
    try {
      await coordinator.runOnce();
      const incident=(await pool.query("SELECT first_cause FROM cloud_workspace_diagnostic_incidents WHERE operation_id=$1",[input.intentId])).rows[0];
      expect(incident?.first_cause.phase).toBe(phase);
      expect(JSON.stringify(incident)).not.toContain("credential-canary");
      if(phase==="ledger_commit") expect(incident.first_cause.sqlState).toBe("23514");
    } finally { restore?.(); }
  });
  it("uses the direct stop fallback when too little funded time remains for a checkpoint", async () => {
    await ready();
    await age();
    await pool.query(
      "UPDATE managed_compute_allocation_leases SET provider_expires_at=now()+interval '40 seconds' WHERE id=$1",
      [input.intentId],
    );
    provider.readComputeUsage.mockRejectedValue(
      new CloudProviderError("provider_usage_unavailable", "fixture", true),
    );
    await expect(coordinator.runOnce()).resolves.toBe(true);
    expect(
      (
        await pool.query(
          "SELECT desired_state,status FROM cloud_workspaces WHERE id=$1",
          [f.workspaceId],
        )
      ).rows[0],
    ).toEqual({ desired_state: "stopped", status: "stopping" });
  });
  it("does not treat paused billing on a running VM as stopped settlement", async () => {
    await ready();
    await age();
    provider.readComputeUsage.mockImplementation(async (id, window) => ({
      resourceId: id,
      since: window!.since.toISOString(),
      until: window!.until!.toISOString(),
      billableSeconds: 600,
      secondsPerDollar: 100000,
      listPriceMicroUsd: 6000,
      running: false,
    }));
    await coordinator.runOnce();
    expect((await balance())[0]!.reservedMicroUsd).toBeGreaterThan(0);
    expect(
      (
        await pool.query(
          "SELECT state FROM managed_compute_allocation_leases WHERE id=$1",
          [input.intentId],
        )
      ).rows[0].state,
    ).toBe("active");
  });
  it("settles an independently stopped VM after a meter covering its stopped observation", async () => {
    await ready();
    await age();
    provider.inspect.mockResolvedValue({ ...resource(), state: "archived" });
    provider.readComputeUsage.mockImplementation(async (id, window) => ({
      resourceId: id,
      since: window!.since.toISOString(),
      until: window!.until!.toISOString(),
      billableSeconds: 600,
      secondsPerDollar: 100000,
      listPriceMicroUsd: 6000,
      running: false,
    }));
    await coordinator.runOnce();
    expect((await balance())[0]!.reservedMicroUsd).toBeGreaterThan(0);
    await pool.query(
      "UPDATE managed_compute_allocation_leases SET stopped_observed_at=now()-interval '10 seconds',next_check_at=now() WHERE id=$1",
      [input.intentId],
    );
    await coordinator.runOnce();
    expect((await balance())[0]).toMatchObject({
      debitedMicroUsd: 6000,
      reservedMicroUsd: 0,
      availableMicroUsd: 14000,
    });
    expect(
      (
        await pool.query(
          "SELECT state FROM managed_compute_allocation_leases WHERE id=$1",
          [input.intentId],
        )
      ).rows[0].state,
    ).toBe("settled");
  });
  it("settles at the last confirmed meter only once a lower final reading persists 15 minutes after the stop", async () => {
    await ready();
    await age();
    provider.inspect.mockResolvedValue(resource(200));
    await coordinator.runOnce();
    expect((await balance())[0]).toMatchObject({ debitedMicroUsd: 6000 });
    provider.inspect.mockResolvedValue({ ...resource(), state: "archived" });
    provider.readComputeUsage.mockImplementation(async (id, window) => ({
      resourceId: id,
      since: window!.since.toISOString(),
      until: window!.until!.toISOString(),
      billableSeconds: 0,
      secondsPerDollar: 100000,
      listPriceMicroUsd: 0,
      running: false,
    }));
    await coordinator.runOnce();
    // An older, unrelated failure streak must not shorten the grace.
    await pool.query(
      "UPDATE managed_compute_allocation_leases SET last_error_code='compute_final_meter_unavailable',first_error_at=now()-interval '1 hour' WHERE id=$1",
      [input.intentId],
    );
    const pass = async (stopAge: string) => {
      await pool.query(
        "UPDATE managed_compute_allocation_leases SET stopped_observed_at=now()-$2::interval,next_check_at=now() WHERE id=$1",
        [input.intentId, stopAge],
      );
      await coordinator.runOnce();
      return (await pool.query<{ state: string; last_error_code: string | null; reservation: string; billable: string; final_reason: string | null }>(
        `SELECT lease.state,lease.last_error_code,reservation.state AS reservation,reservation.billable_seconds AS billable,reservation.final_reason
        FROM managed_compute_allocation_leases lease JOIN managed_compute_credit_reservations reservation ON reservation.id=lease.id WHERE lease.id=$1`,
        [input.intentId],
      )).rows[0]!;
    };
    for (const stopAge of ["10 seconds", "10 seconds", "14 minutes"])
      expect(await pass(stopAge)).toMatchObject({ last_error_code: "compute_credit_meter_rejected", reservation: "open", billable: "600" });
    expect((await balance())[0]!.reservedMicroUsd).toBeGreaterThan(0);
    expect(await pass("16 minutes")).toMatchObject({
      state: "settled", last_error_code: null, reservation: "final", billable: "600", final_reason: "allocation_stopped",
    });
    expect((await balance())[0]).toMatchObject({ debitedMicroUsd: 6000, reservedMicroUsd: 0, availableMicroUsd: 14000 });
  });
  it("keeps a stopped VM unsettled when its lower final reading is otherwise invalid", async () => {
    await ready();
    await age();
    provider.inspect.mockResolvedValue(resource(200));
    await coordinator.runOnce();
    provider.inspect.mockResolvedValue({ ...resource(), state: "archived" });
    provider.readComputeUsage.mockImplementation(async (id, window) => ({
      resourceId: id,
      since: window!.since.toISOString(),
      until: window!.until!.toISOString(),
      billableSeconds: 0,
      secondsPerDollar: 50000,
      listPriceMicroUsd: 0,
      running: false,
    }));
    await coordinator.runOnce();
    for (let attempt = 0; attempt < 2; attempt++) {
      await pool.query(
        "UPDATE managed_compute_allocation_leases SET stopped_observed_at=now()-interval '1 hour',next_check_at=now() WHERE id=$1",
        [input.intentId],
      );
      await coordinator.runOnce();
    }
    expect((await pool.query(
      `SELECT lease.state<>'settled' AS unsettled,lease.last_error_code,reservation.state AS reservation
      FROM managed_compute_allocation_leases lease JOIN managed_compute_credit_reservations reservation ON reservation.id=lease.id WHERE lease.id=$1`,
      [input.intentId],
    )).rows[0]).toEqual({ unsettled: true, last_error_code: "compute_credit_meter_rejected", reservation: "open" });
    expect((await balance())[0]).toMatchObject({ debitedMicroUsd: 6000 });
  });
  const stoppedMeter = () => {
    provider.inspect.mockResolvedValue({ ...resource(), state: "archived" });
    provider.readComputeUsage.mockImplementation(async (id, window) => ({
      resourceId: id,
      since: window!.since.toISOString(),
      until: window!.until!.toISOString(),
      billableSeconds: 600,
      secondsPerDollar: 100000,
      listPriceMicroUsd: 6000,
      running: false,
    }));
  };
  const nextCheck = async () =>
    (
      await pool.query<{ after_stop: string | null; from_now: string; state: string }>(
        `SELECT extract(epoch FROM next_check_at-stopped_observed_at) AS after_stop,
          extract(epoch FROM next_check_at-clock_timestamp()) AS from_now, state
        FROM managed_compute_allocation_leases WHERE id=$1`,
        [input.intentId],
      )
    ).rows[0]!;
  it("re-checks a newly stopped allocation as soon as its final meter can cover the stop", async () => {
    await ready();
    await age();
    stoppedMeter();
    await coordinator.runOnce();
    const row = await nextCheck();
    expect(row.state).not.toBe("settled");
    expect(Number(row.after_stop)).toBeGreaterThanOrEqual(5);
    expect(Number(row.after_stop)).toBeLessThan(10);
  });
  it("re-checks a draining allocation after a managed Stop as soon as it can settle", async () => {
    await ready();
    await age();
    await requestManagedComputeStop(pool, { leaseId: input.intentId, reason: "compute_scope_unavailable", force: true });
    expect((await pool.query("SELECT state,last_error_code FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId])).rows[0])
      .toMatchObject({ state: "draining", last_error_code: "compute_scope_unavailable" });
    stoppedMeter();
    await pool.query("UPDATE managed_compute_allocation_leases SET next_check_at=now() WHERE id=$1", [input.intentId]);
    await coordinator.runOnce();
    const row = await nextCheck();
    expect(row.state).not.toBe("settled");
    expect(Number(row.after_stop)).toBeGreaterThanOrEqual(5);
    expect(Number(row.after_stop)).toBeLessThan(10);
  });
  it("keeps the normal cadence for running allocations and failing settlement retries", async () => {
    await ready();
    await age();
    await pool.query("UPDATE managed_compute_allocation_leases SET next_check_at=now() WHERE id=$1", [input.intentId]);
    await coordinator.runOnce();
    expect(Number((await nextCheck()).from_now)).toBeGreaterThan(12);
    stoppedMeter();
    provider.readComputeUsage.mockRejectedValue(new CloudProviderError("provider_request_unavailable", "meter unavailable", true));
    await pool.query("UPDATE managed_compute_allocation_leases SET next_check_at=now() WHERE id=$1", [input.intentId]);
    await coordinator.runOnce();
    const failing = await nextCheck();
    expect(failing.state).not.toBe("settled");
    expect(Number(failing.from_now)).toBeGreaterThan(12);
  });

  async function drainingWithRunway(seconds: number, funding = false) {
    await ready(); await age();
    await requestManagedComputeStop(pool, { leaseId: input.intentId, reason: "compute_reconciliation_failed" });
    // Confirmed provider time must fit inside funding; the funding-bound case
    // shortens both rather than constructing an impossible lease.
    await pool.query(`UPDATE managed_compute_allocation_leases SET
      provider_expires_at=statement_timestamp()+($2*interval '1 second'),
      funded_until=CASE WHEN $3 THEN statement_timestamp()+($2*interval '1 second') ELSE funded_until END,
      first_error_at=clock_timestamp()-interval '10 minutes',next_check_at=clock_timestamp() WHERE id=$1`,
    [input.intentId, seconds, funding]);
    return (await pool.query<{ id: string; checkpoint_id: string }>(
      `SELECT lease.stop_intent_id AS id,request.id AS checkpoint_id FROM managed_compute_allocation_leases lease
       JOIN workspace_checkpoint_requests request ON request.lifecycle_intent_id=lease.stop_intent_id WHERE lease.id=$1`,
      [input.intentId])).rows[0]!;
  }

  it.each([false, true])("bounds failed drain backoff at its confirmed force deadline (funding=%s)", async funding => {
    await drainingWithRunway(137, funding);
    provider.inspect.mockRejectedValue(new CloudProviderError("provider_response_invalid", "private-provider-canary", true));
    await coordinator.runOnce();
    const row = (await pool.query(`SELECT state,stopped_observed_at,
      next_check_at<=least(provider_expires_at,funded_until)-interval '45 seconds' AS bounded,
      next_check_at>clock_timestamp() AS future FROM managed_compute_allocation_leases WHERE id=$1`, [input.intentId])).rows[0];
    expect(row).toMatchObject({ state: "draining", stopped_observed_at: null, bounded: true, future: true });
    expect(provider.renewComputeLease).not.toHaveBeenCalled();
    expect((await balance())[0]!.reservedMicroUsd).toBeGreaterThan(0);
  });

  it("bounds successful drain polling at a force deadline closer than the normal cadence", async () => {
    await drainingWithRunway(55);
    await coordinator.runOnce();
    expect((await pool.query(`SELECT next_check_at<=provider_expires_at-interval '45 seconds' AS bounded
      FROM managed_compute_allocation_leases WHERE id=$1`, [input.intentId])).rows[0].bounded).toBe(true);
    expect(provider.renewComputeLease).not.toHaveBeenCalled();
  });

  it("bounds failed drain backoff by its earlier original checkpoint deadline", async () => {
    const stop = await drainingWithRunway(600);
    await pool.query("UPDATE workspace_checkpoint_requests SET deadline_at=clock_timestamp()+interval '20 seconds' WHERE id=$1", [stop.checkpoint_id]);
    provider.inspect.mockRejectedValue(new TypeError("private-inspect-canary"));
    await coordinator.runOnce();
    expect((await pool.query(`SELECT lease.next_check_at<=request.deadline_at AS bounded
      FROM managed_compute_allocation_leases lease JOIN workspace_checkpoint_requests request ON request.id=$2
      WHERE lease.id=$1`, [input.intentId, stop.checkpoint_id])).rows[0].bounded).toBe(true);
    expect((await pool.query("SELECT stop_intent_id FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId])).rows[0].stop_intent_id).toBe(stop.id);
  });

  it.each(["force", "checkpoint"] as const)("escalates a due %s drain before a held provider inspection", async boundary => {
    const stop = await drainingWithRunway(boundary === "force" ? 44 : 600);
    if (boundary === "checkpoint") await pool.query(`UPDATE workspace_checkpoint_requests
      SET created_at=clock_timestamp()-interval '1 minute',deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [stop.checkpoint_id]);
    let release!: (value: CloudProviderResource) => void, inspected!: () => void;
    const reached = new Promise<void>(resolve => { inspected = resolve; });
    provider.inspect.mockImplementationOnce(() => { inspected(); return new Promise(resolve => { release = resolve; }); });
    const flight = coordinator.runOnce();
    try {
      await reached;
      expect((await pool.query("SELECT state,error_code FROM workspace_checkpoint_requests WHERE id=$1", [stop.checkpoint_id])).rows[0])
        .toMatchObject({ state: "cancelled", error_code: "stop_unsealed" });
      expect((await pool.query("SELECT revoked_at FROM cloud_workspace_engine_instances WHERE id=$1", [f.engineInstanceId])).rows[0].revoked_at).not.toBeNull();
      expect((await pool.query("SELECT stop_intent_id FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId])).rows[0].stop_intent_id).toBe(stop.id);
    } finally { release(resource()); await flight; }
    expect(provider.renewComputeLease).not.toHaveBeenCalled();
    expect((await pool.query(`SELECT next_check_at>updated_at AND next_check_at<=updated_at+interval '16 seconds' AS bounded
      FROM managed_compute_allocation_leases WHERE id=$1`, [input.intentId])).rows[0].bounded).toBe(true);
    provider.stop.mockResolvedValue({ ...resource(), state: "stopped" });
    const reconciler = new CloudWorkspaceReconciler({ pool, provider: asProvider(), intervalMs: 1000, workosEnabled: false });
    await reconciler.runOnce();
    expect(provider.stop).toHaveBeenCalledOnce();
    expect((await pool.query("SELECT state FROM cloud_workspace_lifecycle_intents WHERE id=$1", [stop.id])).rows[0].state).toBe("succeeded");
    expect((await pool.query("SELECT checkpoint_id,error_code FROM workspace_checkpoint_requests WHERE id=$1", [stop.checkpoint_id])).rows[0])
      .toMatchObject({ checkpoint_id: null, error_code: "stop_unsealed" });
  });

  it("keeps a re-check requested after stop escalation while inspection is pending", async () => {
    const stop = await drainingWithRunway(44);
    let release!: (value: CloudProviderResource) => void, inspected!: () => void;
    const reached = new Promise<void>(resolve => { inspected = resolve; });
    provider.inspect.mockImplementationOnce(() => { inspected(); return new Promise(resolve => { release = resolve; }); });
    const flight = coordinator.runOnce();
    try {
      await reached;
      expect((await pool.query("SELECT error_code FROM workspace_checkpoint_requests WHERE id=$1", [stop.checkpoint_id])).rows[0].error_code)
        .toBe("stop_unsealed");
      await pool.query("UPDATE managed_compute_allocation_leases SET next_check_at=clock_timestamp() WHERE id=$1", [input.intentId]);
    } finally { release(resource()); await flight; }
    expect(Number((await nextCheck()).from_now)).toBeLessThanOrEqual(0);
  });

  it("keeps a re-check requested before stop escalation acquires the lease", async () => {
    const stop = await drainingWithRunway(44);
    const db = abortingPool(pool, { code: "40001", count: 1,
      when: sql => sql.includes("SELECT 1 FROM managed_compute_allocation_leases lease") && sql.includes("state='draining'"),
      afterAbort: async () => { await pool.query("UPDATE managed_compute_allocation_leases SET next_check_at=clock_timestamp() WHERE id=$1", [input.intentId]); },
    });
    await originalCoordinator(db.pool).runOnce();
    expect(db.observed.aborts).toBe(1);
    expect((await pool.query("SELECT error_code FROM workspace_checkpoint_requests WHERE id=$1", [stop.checkpoint_id])).rows[0].error_code)
      .toBe("stop_unsealed");
    expect(Number((await nextCheck()).from_now)).toBeLessThanOrEqual(0);
  });

  it("retains settlement backoff after positive stopped proof with expired compute deadlines", async () => {
    await drainingWithRunway(-30, true);
    stoppedMeter();
    provider.readComputeUsage.mockRejectedValue(new CloudProviderError("provider_request_unavailable", "private-meter-canary", true));
    await coordinator.runOnce();
    const row = await nextCheck();
    expect(row.state).toBe("draining");
    expect(row.after_stop).not.toBeNull();
    expect(Number(row.from_now)).toBeGreaterThan(290);
    expect(Number(row.from_now)).toBeLessThanOrEqual(300);
    expect((await balance())[0]!.reservedMicroUsd).toBeGreaterThan(0);
  });

  it.each([12, -30])("bounds post-escalation retries by the remaining TTL without hot polling after expiry (runway=%i)", async seconds => {
    const stop = await drainingWithRunway(seconds, true);
    provider.inspect.mockRejectedValue(new CloudProviderError("provider_request_unavailable", "private-inspect-canary", true));
    await coordinator.runOnce();
    expect((await pool.query("SELECT state,error_code FROM workspace_checkpoint_requests WHERE id=$1", [stop.checkpoint_id])).rows[0])
      .toMatchObject({ state: "cancelled", error_code: "stop_unsealed" });
    const row = (await pool.query(`SELECT stopped_observed_at,extract(epoch FROM next_check_at-clock_timestamp()) AS delay,
      next_check_at<=provider_expires_at AS bounded FROM managed_compute_allocation_leases WHERE id=$1`, [input.intentId])).rows[0];
    expect(row.stopped_observed_at).toBeNull();
    expect(Number(row.delay)).toBeGreaterThan(seconds > 0 ? 9 : 290);
    if (seconds > 0) expect(row.bounded).toBe(true);
  });

  it("bounds a draining database failure without replaying provider I/O", async () => {
    await drainingWithRunway(137);
    const db = abortingPool(pool, { code: "40P01", count: 3, when: providerLookup });
    await originalCoordinator(db.pool).runOnce();
    expect(db.observed.aborts).toBe(3);
    expect(provider.inspect).not.toHaveBeenCalled();
    expect((await pool.query(`SELECT next_check_at<=provider_expires_at-interval '45 seconds' AS bounded
      FROM managed_compute_allocation_leases WHERE id=$1`, [input.intentId])).rows[0].bounded).toBe(true);
  });

  it.each(["claim", "generation"] as const)("cannot change a successor %s or its schedule after a late drain inspection failure", async changed => {
    const stop = await drainingWithRunway(137);
    let successor!: { lease_owner: string; next_check_at: Date };
    let setupError: unknown;
    provider.inspect.mockImplementationOnce(async () => {
      try {
        if (changed === "generation") {
          await pool.query(`INSERT INTO cloud_workspace_generations(workspace_id,generation,org_id,provider,image_ref,architecture,
          cpu_millicores,memory_mib,storage_mib,created_by,provider_connection_id,provider_connection_version,sandbox_class,source_commit,
          runtime_id,runtime_manifest_sha256,runtime_base_image_id,runtime_base_compatibility_id,runtime_profile,runtime_engine_protocol_version)
          SELECT workspace_id,2,org_id,provider,image_ref,architecture,cpu_millicores,memory_mib,storage_mib,created_by,provider_connection_id,
          provider_connection_version,sandbox_class,source_commit,runtime_id,runtime_manifest_sha256,runtime_base_image_id,runtime_base_compatibility_id,runtime_profile,runtime_engine_protocol_version
          FROM cloud_workspace_generations WHERE workspace_id=$1 AND generation=1`, [f.workspaceId]);
          await pool.query(`INSERT INTO cloud_workspace_allocation_owners(workspace_id,org_id,provider_resource_id,original_generation,current_generation,allocation_lease_id)
          SELECT workspace_id,org_id,provider_resource_id,generation,2,id FROM managed_compute_allocation_leases WHERE id=$1
          ON CONFLICT(workspace_id,provider_resource_id) DO UPDATE SET current_generation=2`, [input.intentId]);
        }
        successor = (await pool.query(`UPDATE managed_compute_allocation_leases
        SET lease_owner=CASE WHEN $2 THEN 'compute:successor' ELSE lease_owner END,
          provider_expires_at=clock_timestamp()+interval '10 seconds',next_check_at=clock_timestamp()+interval '1 minute'
        WHERE id=$1 RETURNING lease_owner,next_check_at`, [input.intentId, changed === "claim"])).rows[0];
      } catch (error) { setupError = error; }
      throw new CloudProviderError("provider_response_invalid", "private-late-canary", true);
    });
    await coordinator.runOnce();
    expect(setupError).toBeUndefined();
    expect((await pool.query("SELECT lease_owner,next_check_at FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId])).rows[0]).toEqual(successor);
    expect((await pool.query("SELECT state,error_code FROM workspace_checkpoint_requests WHERE id=$1", [stop.checkpoint_id])).rows[0])
      .toMatchObject({ state: "queued", error_code: null });
    expect((await pool.query("SELECT revoked_at FROM cloud_workspace_engine_instances WHERE id=$1", [f.engineInstanceId])).rows[0].revoked_at).toBeNull();
  });

  it("re-checks a healthy running allocation at its renewal point instead of every 15 s", async () => {
    await ready();
    await age();
    provider.inspect.mockResolvedValue(resource(800));
    await pool.query("UPDATE managed_compute_allocation_leases SET next_check_at=now() WHERE id=$1", [input.intentId]);
    await coordinator.runOnce();
    // The provider deadline is 800 s away; its renewal point, 450 s before it, is 350 s away.
    const at = Number((await nextCheck()).from_now);
    expect(at).toBeGreaterThan(345);
    expect(at).toBeLessThan(355);
    expect(provider.renewComputeLease).not.toHaveBeenCalled();
  });
  it("never schedules a healthy running re-check more than 10 minutes ahead", async () => {
    coordinator = new CloudWorkspaceComputeLeaseCoordinator({pool,providerResolver:resolver(),workosEnabled:false,policy:{...policy,maximumTtlSeconds:3600},usageMeterWindowMs:0});
    // A 3500 s deadline needs more than the default 2000 s grant, and ready() cannot add
    // one: its grant has different period bounds, which the ledger rejects as an overlap.
    await ledger.grant({organizationId:f.organizationId,userId:f.userId,startsAt:new Date(Date.now()-3600_000),endsAt:new Date(Date.now()+7200_000),amountMicroUsd:40_000,policyId:"seat-credit-v1",idempotencyKey:randomUUID()});
    const next = await coordinator.allocate(input, asProvider(), null);
    await pool.query("UPDATE cloud_workspace_provider_bindings SET provider_resource_id=$2 WHERE workspace_id=$1", [f.workspaceId, next.resourceId]);
    await age();
    provider.inspect.mockResolvedValue(resource(3500));
    await pool.query("UPDATE managed_compute_allocation_leases SET next_check_at=now() WHERE id=$1", [input.intentId]);
    await coordinator.runOnce();
    const at = Number((await nextCheck()).from_now);
    expect(at).toBeGreaterThan(595);
    expect(at).toBeLessThan(605);
    expect(provider.renewComputeLease).not.toHaveBeenCalled();
  });
  it("keeps the 15 s floor when the renewal point is close", async () => {
    coordinator = new CloudWorkspaceComputeLeaseCoordinator({pool,providerResolver:resolver(),workosEnabled:false,policy:{...policy,maximumTtlSeconds:600},usageMeterWindowMs:0});
    await ready();
    await age();
    // 320 s to the deadline is past the 300 s renewal point, so no renewal yet.
    provider.inspect.mockResolvedValue(resource(320));
    await pool.query("UPDATE managed_compute_allocation_leases SET next_check_at=now() WHERE id=$1", [input.intentId]);
    await coordinator.runOnce();
    const at = Number((await nextCheck()).from_now);
    expect(at).toBeGreaterThan(10);
    expect(at).toBeLessThan(20);
    expect(provider.renewComputeLease).not.toHaveBeenCalled();
  });
  it("re-checks a renewed allocation from its new deadline", async () => {
    await ready();
    await age();
    provider.inspect.mockResolvedValue(resource(200));
    provider.renewComputeLease.mockImplementationOnce(async () => ({ expiresAt: new Date(Date.now() + 900_000).toISOString() }));
    expect(await coordinator.runOnce()).toBe(true);
    expect(provider.renewComputeLease).toHaveBeenCalledTimes(1);
    // The renewed deadline is 900 s away, so its renewal point is 450 s away.
    const at = Number((await nextCheck()).from_now);
    expect(at).toBeGreaterThan(445);
    expect(at).toBeLessThan(455);
  });
  it("re-checks unsettled leases at once when the workspace lifecycle changes", async () => {
    await ready();
    const jobKey = `workspace:${f.workspaceId}`;
    // The workspace projection trigger needs a row for any generation it moves to.
    await pool.query(`INSERT INTO cloud_workspace_generations (workspace_id,generation,org_id,provider,image_ref,architecture,cpu_millicores,memory_mib,storage_mib,source_commit,
        created_by,provider_connection_id,runtime_id,runtime_manifest_sha256,runtime_base_image_id,runtime_base_compatibility_id,runtime_profile,runtime_engine_protocol_version)
      SELECT workspace_id,2,org_id,provider,image_ref,architecture,cpu_millicores,memory_mib,storage_mib,source_commit,
        created_by,provider_connection_id,runtime_id,runtime_manifest_sha256,runtime_base_image_id,runtime_base_compatibility_id,runtime_profile,runtime_engine_protocol_version
      FROM cloud_workspace_generations WHERE workspace_id=$1 AND generation=1`, [f.workspaceId]);
    // Each change runs in a transaction that is rolled back, starting from a
    // lease and its compute job that are both an hour away.
    const change = async (statement: string, settle = false) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("UPDATE control_plane_jobs SET run_at=clock_timestamp()+interval '1 hour' WHERE kind='cloud_compute_lease' AND dedupe_key=$1 AND state IN ('queued','running')", [jobKey]);
        await client.query("UPDATE managed_compute_allocation_leases SET next_check_at=clock_timestamp()+interval '1 hour' WHERE id=$1", [input.intentId]);
        if (settle) await client.query("UPDATE managed_compute_allocation_leases SET state='settled',settled_at=clock_timestamp() WHERE id=$1", [input.intentId]);
        await client.query(statement, [f.workspaceId]);
        return (await client.query<{ lease_due: boolean; job_due: boolean }>(
          `SELECT (SELECT next_check_at<=clock_timestamp() FROM managed_compute_allocation_leases WHERE id=$1) AS lease_due,
            (SELECT run_at<=clock_timestamp() FROM control_plane_jobs WHERE kind='cloud_compute_lease' AND dedupe_key=$2 AND state IN ('queued','running')) AS job_due`,
          [input.intentId, jobKey],
        )).rows[0];
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    };
    expect(await change("UPDATE cloud_workspaces SET desired_state='stopped' WHERE id=$1")).toEqual({ lease_due: true, job_due: true });
    expect(await change("UPDATE cloud_workspaces SET current_generation=current_generation+1 WHERE id=$1")).toEqual({ lease_due: true, job_due: true });
    expect(await change("UPDATE cloud_workspaces SET status='failed' WHERE id=$1")).toEqual({ lease_due: true, job_due: true });
    expect(await change("UPDATE cloud_workspaces SET status='busy' WHERE id=$1")).toEqual({ lease_due: false, job_due: false });
    expect(await change("UPDATE cloud_workspaces SET desired_state=desired_state WHERE id=$1")).toEqual({ lease_due: false, job_due: false });
    expect(await change("UPDATE cloud_workspaces SET desired_state='stopped' WHERE id=$1", true)).toEqual({ lease_due: false, job_due: false });
  });
  describe("accepted stopped compute rechecks", () => {
    const scope = { provider: null, driftIntervalMs: 1000 };
    const due = () => readLifecycleDueInMs(pool, "compute", f.workspaceId, scope);
    const reconciler = (db = pool) => new CloudWorkspaceReconciler({
      pool: db, provider: asProvider(), workosEnabled: false, intervalMs: 1000,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    async function stopping(operation: "stop" | "archive" | "delete" = "stop", internal = false) {
      await ready(); await age();
      await pool.query("UPDATE cloud_workspace_lifecycle_intents SET state='succeeded',completed_at=now() WHERE id=$1", [input.intentId]);
      await pool.query(`UPDATE cloud_workspaces SET desired_state=$2,status=$3 WHERE id=$1`,
        [f.workspaceId, operation === "delete" ? "deleted" : operation === "archive" ? "archived" : "stopped",
          operation === "delete" ? "deleting" : operation === "archive" ? "archiving" : "stopping"]);
      await pool.query("UPDATE cloud_workspace_provider_bindings SET observed_state='stopping' WHERE workspace_id=$1", [f.workspaceId]);
      const intentId = randomUUID();
      await pool.query(`INSERT INTO cloud_workspace_lifecycle_intents
        (id,workspace_id,generation,org_id,operation,idempotency_key,request_sha256,affects_workspace)
        VALUES($1::uuid,$2,1,$3,$4,$1::text,$5,$6)`, [intentId, f.workspaceId, f.organizationId, operation, randomBytes(32), !internal]);
      await pool.query("UPDATE managed_compute_allocation_leases SET next_check_at=clock_timestamp()+interval '10 minutes' WHERE id=$1", [input.intentId]);
      await pool.query("UPDATE control_plane_jobs SET run_at=clock_timestamp()+interval '10 minutes' WHERE kind='cloud_compute_lease' AND workspace_id=$1", [f.workspaceId]);
      provider.stop.mockResolvedValue({ ...resource(), state: "stopped" });
      provider.archive.mockResolvedValue({ ...resource(), state: "archived" });
      return intentId;
    }

    it.each([
      { operation: "stop", internal: false },
      { operation: "archive", internal: false },
      { operation: "stop", internal: true },
    ] as const)("makes accepted $operation (internal=$internal) promptly eligible without borrowing its stopped proof", async ({ operation, internal }) => {
      const intentId = await stopping(operation, internal);
      expect(await due()).toBeGreaterThan(590_000);
      expect(await reconciler().runOnce(f.workspaceId)).toBe(true);
      expect((await pool.query("SELECT state FROM cloud_workspace_lifecycle_intents WHERE id=$1", [intentId])).rows[0].state).toBe("succeeded");
      expect(await due()).toBeLessThanOrEqual(0);
      expect((await pool.query("SELECT run_at<=clock_timestamp() AS due FROM control_plane_jobs WHERE kind='cloud_compute_lease' AND workspace_id=$1", [f.workspaceId])).rows[0].due).toBe(true);
      expect((await pool.query("SELECT stopped_observed_at FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId])).rows[0].stopped_observed_at).toBeNull();
      // An old lifecycle timestamp is not a final-meter proof.
      await pool.query("UPDATE cloud_workspace_provider_bindings SET last_observed_at=now()-interval '1 day' WHERE workspace_id=$1", [f.workspaceId]);
      stoppedMeter(); provider.inspect.mockClear();
      expect(await coordinator.runOnce(f.workspaceId)).toBe(true);
      expect(provider.inspect).toHaveBeenCalledOnce();
      const check = await nextCheck();
      expect(check.state).not.toBe("settled");
      expect(Number(check.after_stop)).toBeCloseTo(6, 2);
      expect((await balance())[0]!.reservedMicroUsd).toBeGreaterThan(0);
      expect(await coordinator.runOnce(f.workspaceId)).toBe(false);
    });

    it("commits a stopped result while another transaction holds the compute row, then recovers its request", async () => {
      const intentId = await stopping();
      const holder = await pool.connect();
      const writer = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: "-c lock_timeout=1000" });
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT 1 FROM managed_compute_allocation_leases WHERE id=$1 FOR UPDATE", [input.intentId]);
        expect(await reconciler(writer).runOnce(f.workspaceId)).toBe(true);
        expect((await pool.query("SELECT state FROM cloud_workspace_lifecycle_intents WHERE id=$1", [intentId])).rows[0].state).toBe("succeeded");
        expect(await due()).toBeLessThanOrEqual(0);
      } finally { await holder.query("ROLLBACK"); holder.release(); await writer.end(); }
      stoppedMeter();
      expect(await originalCoordinator(pool).runOnce(f.workspaceId)).toBe(true);
      expect(await originalCoordinator(pool).runOnce(f.workspaceId)).toBe(false);
    });

    it("retains a stop accepted during compute I/O for a fresh independent pass after restart", async () => {
      await stopping();
      await pool.query("UPDATE managed_compute_allocation_leases SET next_check_at=clock_timestamp() WHERE id=$1", [input.intentId]);
      let release!: (value: CloudProviderResource) => void, reached!: () => void;
      const inspecting = new Promise<void>(resolve => { reached = resolve; });
      provider.inspect.mockImplementationOnce(() => { reached(); return new Promise(resolve => { release = resolve; }); });
      const flight = coordinator.runOnce(f.workspaceId);
      try {
        await inspecting;
        expect(await reconciler().runOnce(f.workspaceId)).toBe(true);
        expect(await originalCoordinator(pool).runOnce(f.workspaceId)).toBe(false);
      } finally { release(resource()); await flight; }
      expect(await due()).toBeLessThanOrEqual(0);
      stoppedMeter(); provider.inspect.mockClear();
      expect(await originalCoordinator(pool).runOnce(f.workspaceId)).toBe(true);
      expect(provider.inspect).toHaveBeenCalledOnce();
      expect(await originalCoordinator(pool).runOnce(f.workspaceId)).toBe(false);
    });

    it("makes an accepted stopped drift observation promptly eligible", async () => {
      const intentId = await stopping();
      await pool.query("UPDATE cloud_workspace_lifecycle_intents SET state='succeeded',completed_at=now() WHERE id=$1", [intentId]);
      await pool.query("UPDATE cloud_workspace_provider_bindings SET last_observed_at=now()-interval '1 day',next_drift_check_at=now() WHERE workspace_id=$1", [f.workspaceId]);
      stoppedMeter();
      expect(await reconciler().reconcileDriftOnce(f.workspaceId)).toBe(true);
      expect(await due()).toBeLessThanOrEqual(0);
      expect(await coordinator.runOnce(f.workspaceId)).toBe(true);
    });

    it("requests a check for positive stopped evidence retained during a storage-blocked delete", async () => {
      await stopping("delete");
      // Isolate the accepted blocked-delete result boundary; final-meter and
      // beforeDelete accounting controls run separately in this same suite.
      vi.spyOn(CloudWorkspaceComputeLeaseCoordinator.prototype, "beforeDelete").mockResolvedValueOnce(true);
      stoppedMeter();
      provider.delete.mockRejectedValue(new CloudProviderError("provider_deletion_blocked", "Storage deletion is pending", true));
      expect(await reconciler().runOnce(f.workspaceId)).toBe(true);
      expect((await pool.query("SELECT observed_state,deletion_verified_at FROM cloud_workspace_provider_bindings WHERE workspace_id=$1", [f.workspaceId])).rows[0])
        .toMatchObject({ observed_state: "archived", deletion_verified_at: null });
      expect(await due()).toBeLessThanOrEqual(0);
      expect((await pool.query("SELECT stopped_observed_at,state FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId])).rows[0])
        .toEqual({ stopped_observed_at: null, state: "active" });
    });

    const marker = async () => (await pool.query(`SELECT requested_sequence,handled_sequence,observed_stopped
      FROM cloud_workspace_compute_rechecks WHERE allocation_lease_id=$1`, [input.intentId])).rows[0];
    async function drift(state: "running" | "archived") {
      await pool.query("UPDATE cloud_workspace_provider_bindings SET last_observed_at=now()-interval '1 day',next_drift_check_at=now() WHERE workspace_id=$1", [f.workspaceId]);
      provider.inspect.mockResolvedValueOnce({ ...resource(), state });
      expect(await reconciler().reconcileDriftOnce(f.workspaceId)).toBe(true);
    }

    it("coalesces repeated archived observations after handling them without an immediate loop", async () => {
      await stopping(); await reconciler().runOnce(f.workspaceId);
      stoppedMeter(); await coordinator.runOnce(f.workspaceId);
      expect(await marker()).toEqual({ requested_sequence: "1", handled_sequence: "1", observed_stopped: true });
      const before = await nextCheck();
      await drift("archived"); await drift("archived");
      expect(await marker()).toEqual({ requested_sequence: "1", handled_sequence: "1", observed_stopped: true });
      expect((await nextCheck()).after_stop).toBe(before.after_stop);
      expect(await coordinator.runOnce(f.workspaceId)).toBe(false);
    });

    it("acknowledges only the captured sequence and retains a second stop accepted in flight", async () => {
      await stopping(); await reconciler().runOnce(f.workspaceId);
      let release!: (value: CloudProviderResource) => void, reached!: () => void;
      const inspecting = new Promise<void>(resolve => { reached = resolve; });
      provider.inspect.mockImplementationOnce(() => { reached(); return new Promise(resolve => { release = resolve; }); });
      const flight = coordinator.runOnce(f.workspaceId);
      try {
        await inspecting;
        await drift("running"); // Accepted non-stopped observation starts a new episode.
        expect(await reconciler().runOnce(f.workspaceId)).toBe(true);
        expect(await marker()).toMatchObject({ requested_sequence: "2", handled_sequence: "0" });
      } finally { release(resource()); await flight; }
      expect(await marker()).toMatchObject({ requested_sequence: "2", handled_sequence: "1" });
      expect(await due()).toBeLessThanOrEqual(0);
      stoppedMeter();
      expect(await originalCoordinator(pool).runOnce(f.workspaceId)).toBe(true);
      expect(await marker()).toMatchObject({ requested_sequence: "2", handled_sequence: "2" });
      expect(await originalCoordinator(pool).runOnce(f.workspaceId)).toBe(false);
    });

    it("keeps both an established error floor and a new in-flight Retry-After ahead of a pending request", async () => {
      await stopping(); await reconciler().runOnce(f.workspaceId);
      await pool.query(`UPDATE managed_compute_allocation_leases SET first_error_at=now(),last_error_code='provider_request_unavailable',
        next_check_at=now()+interval '2 minutes' WHERE id=$1`, [input.intentId]);
      expect(await due()).toBeGreaterThan(119_000);
      expect(await coordinator.runOnce(f.workspaceId)).toBe(false);
      await pool.query("UPDATE managed_compute_allocation_leases SET next_check_at=now() WHERE id=$1", [input.intentId]);
      let release!: () => void, reached!: () => void;
      const inspecting = new Promise<void>(resolve => { reached = resolve; });
      provider.inspect.mockImplementationOnce(async () => {
        reached(); await new Promise<void>(resolve => { release = resolve; });
        throw new CloudProviderError("provider_request_unavailable", "Provider retry fixture", true, { retryAfterMs: 120_000 });
      });
      const flight = coordinator.runOnce(f.workspaceId);
      try {
        await inspecting;
        await drift("running"); await reconciler().runOnce(f.workspaceId);
      } finally { release(); await flight; }
      expect(await marker()).toMatchObject({ requested_sequence: "2", handled_sequence: "0" });
      expect(await due()).toBeGreaterThan(119_000);
      expect(await originalCoordinator(pool).runOnce(f.workspaceId)).toBe(false);
      await pool.query("UPDATE managed_compute_allocation_leases SET next_check_at=now() WHERE id=$1", [input.intentId]);
      stoppedMeter();
      expect(await originalCoordinator(pool).runOnce(f.workspaceId)).toBe(true);
      expect(await marker()).toMatchObject({ requested_sequence: "2", handled_sequence: "2" });
    });

    it("keeps the captured request after claim loss and lets the replacement recover it", async () => {
      await stopping(); await reconciler().runOnce(f.workspaceId);
      provider.inspect.mockImplementationOnce(async () => {
        await pool.query(`UPDATE managed_compute_allocation_leases SET lease_owner='replacement',
          lease_expires_at=now()+interval '1 minute' WHERE id=$1`, [input.intentId]);
        return { ...resource(), state: "archived" };
      });
      expect(await coordinator.runOnce(f.workspaceId)).toBe(true);
      expect(await marker()).toMatchObject({ requested_sequence: "1", handled_sequence: "0" });
      expect(await originalCoordinator(pool).runOnce(f.workspaceId)).toBe(false);
      await pool.query("UPDATE managed_compute_allocation_leases SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [input.intentId]);
      stoppedMeter();
      expect(await originalCoordinator(pool).runOnce(f.workspaceId)).toBe(true);
      expect(await marker()).toMatchObject({ requested_sequence: "1", handled_sequence: "1" });
    });

    it.each(["before", "after"] as const)("recovers bookkeeping uncertainty %s COMMIT without losing a request or spinning", async boundary => {
      await stopping(); await reconciler().runOnce(f.workspaceId);
      stoppedMeter();
      let interrupted = false;
      const db = new Proxy(pool, { get(target, key) {
        if (key === "connect") return async () => {
          const client = await target.connect(); let acknowledgement = false;
          return new Proxy(client, { get(target, key) {
            if (key === "query") return async (...args: unknown[]) => {
              const sql = typeof args[0] === "string" ? args[0] : "";
              if (sql.includes("SET handled_sequence=")) acknowledgement = true;
              if (!interrupted && acknowledgement && sql === "COMMIT") {
                interrupted = true;
                if (boundary === "after") await Reflect.apply(target.query, target, args);
                throw new DatabaseConnectionLostError();
              }
              return Reflect.apply(target.query, target, args);
            };
            const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
          } });
        };
        const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
      } });
      await expect(originalCoordinator(db).runOnce(f.workspaceId)).rejects.toBeInstanceOf(DatabaseConnectionLostError);
      expect(interrupted).toBe(true);
      expect(await marker()).toMatchObject({ requested_sequence: "1", handled_sequence: boundary === "after" ? "1" : "0" });
      expect(await originalCoordinator(pool).runOnce(f.workspaceId)).toBe(false);
      if (boundary === "before") {
        await pool.query("UPDATE managed_compute_allocation_leases SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [input.intentId]);
        // The independent stopped observation committed before bookkeeping.
        // Recovery keeps its six-second meter schedule, not the old ten-minute check.
        expect(await due()).toBeGreaterThan(0);
        expect(await due()).toBeLessThanOrEqual(6_000);
        await pool.query("UPDATE managed_compute_allocation_leases SET stopped_observed_at=now()-interval '6 seconds' WHERE id=$1", [input.intentId]);
        expect(await originalCoordinator(pool).runOnce(f.workspaceId)).toBe(true);
        expect(await marker()).toMatchObject({ requested_sequence: "1", handled_sequence: "1" });
        expect(await originalCoordinator(pool).runOnce(f.workspaceId)).toBe(false);
      }
    });

    it("recovers lost enqueues and preserves a rerun recorded on an already-running compute job", async () => {
      await stopping();
      await pool.query("UPDATE control_plane_jobs SET run_at=now() WHERE kind='cloud_compute_lease' AND workspace_id=$1", [f.workspaceId]);
      const jobs = await claimJobs(pool, { owner: "recheck-fixture", limit: 1, kinds: [{ kind: "cloud_compute_lease", leaseMs: 60_000 }] });
      expect(jobs.jobs).toHaveLength(1);
      await reconciler().runOnce(f.workspaceId);
      expect(await completeJob(pool, jobs.jobs[0]!)).toBe("requeued");
      await pool.query("DELETE FROM control_plane_jobs WHERE kind='cloud_compute_lease' AND workspace_id=$1", [f.workspaceId]);
      expect(await auditLifecycleJobs(pool, scope)).toMatchObject({ compute: 1 });
      expect(await auditLifecycleJobs(pool, scope)).toEqual({});
      stoppedMeter();
      expect(await coordinator.runOnce(f.workspaceId)).toBe(true);
      expect(await coordinator.runOnce(f.workspaceId)).toBe(false);
    });

    it("keeps scheduling data invisible and unwritable to user transactions, including its own org", async () => {
      await stopping(); await reconciler().runOnce(f.workspaceId);
      expect(await withUserTx(pool, f.userId, tx => tx.query("SELECT * FROM cloud_workspace_compute_rechecks")))
        .toMatchObject({ rowCount: 0 });
      expect(await withUserTx(pool, f.userId, tx => tx.query("UPDATE cloud_workspace_compute_rechecks SET handled_sequence=requested_sequence")))
        .toMatchObject({ rowCount: 0 });
      const other = await seedReadyCloudWorkspace(pool);
      expect(await withUserTx(pool, other.userId, tx => tx.query("SELECT * FROM cloud_workspace_compute_rechecks")))
        .toMatchObject({ rowCount: 0 });
      await expect(withUserTx(pool, f.userId, tx => tx.query(`INSERT INTO cloud_workspace_compute_rechecks
        (allocation_lease_id,workspace_id,org_id,generation,owner_revision,observed_stopped,requested_sequence)
        VALUES($1,$2,$3,1,0,true,1)`, [randomUUID(), f.workspaceId, f.organizationId])))
        .rejects.toMatchObject({ code: "42501" });
      expect(await marker()).toMatchObject({ requested_sequence: "1", handled_sequence: "0" });
    });

    it.each(["lost claim", "expired claim", "replaced resource", "foreign labels", "changed account"] as const)("ignores stopped evidence with a %s", async changed => {
      const intentId = await stopping();
      provider.stop.mockImplementationOnce(async () => {
        if (changed === "lost claim") await pool.query("UPDATE cloud_workspace_lifecycle_intents SET lease_owner='replacement' WHERE id=$1", [intentId]);
        if (changed === "expired claim") await pool.query("UPDATE cloud_workspace_lifecycle_intents SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [intentId]);
        if (changed === "replaced resource") await pool.query("UPDATE cloud_workspace_provider_bindings SET provider_resource_id='replacement-resource' WHERE workspace_id=$1", [f.workspaceId]);
        if (changed === "changed account") {
          await pool.query(`INSERT INTO provider_connection_versions(connection_id,org_id,version,credential_source,endpoint)
            SELECT provider_connection_id,org_id,2,'hosted','https://provider.fixture.example'
            FROM cloud_workspace_provider_bindings WHERE workspace_id=$1`, [f.workspaceId]);
          await pool.query("UPDATE cloud_workspace_provider_bindings SET provider_connection_version=2 WHERE workspace_id=$1", [f.workspaceId]);
        }
        return { ...resource(), state: "stopped", ...(changed === "foreign labels" ? { workspaceId: randomUUID() } : {}) };
      });
      await reconciler().runOnce(f.workspaceId);
      expect(await marker()).toBeUndefined();
      // An unrelated terminal failure may invoke the existing 0160 trigger;
      // the new exact-allocation signal must still be absent.
      if (changed !== "foreign labels") expect(await due()).toBeGreaterThan(590_000);
    });

    async function secondGeneration() {
      await pool.query(`INSERT INTO cloud_workspace_generations(workspace_id,generation,org_id,provider,image_ref,architecture,
        cpu_millicores,memory_mib,storage_mib,created_by,provider_connection_id,provider_connection_version,sandbox_class,source_commit,
        runtime_id,runtime_manifest_sha256,runtime_base_image_id,runtime_base_compatibility_id,runtime_profile,runtime_engine_protocol_version)
        SELECT workspace_id,2,org_id,provider,image_ref,architecture,cpu_millicores,memory_mib,storage_mib,created_by,provider_connection_id,
          provider_connection_version,sandbox_class,source_commit,runtime_id,runtime_manifest_sha256,runtime_base_image_id,runtime_base_compatibility_id,
          runtime_profile,runtime_engine_protocol_version FROM cloud_workspace_generations WHERE workspace_id=$1 AND generation=1`, [f.workspaceId]);
    }
    async function allocationOwner(generation: number) {
      await pool.query(`INSERT INTO cloud_workspace_allocation_owners
        (workspace_id,org_id,provider_resource_id,original_generation,current_generation,allocation_lease_id)
        SELECT workspace_id,org_id,provider_resource_id,1,$2,id FROM managed_compute_allocation_leases WHERE id=$1`, [input.intentId, generation]);
    }

    it.each([
      { observation: "lifecycle", owner: false }, { observation: "lifecycle", owner: true },
      { observation: "drift", owner: false }, { observation: "drift", owner: true },
    ] as const)("does not signal a replacement allocation reusing the resource/generation during $observation I/O (owner=$owner)", async ({ observation, owner }) => {
      const stopId = await stopping();
      if (owner) await allocationOwner(1);
      if (observation === "drift") {
        await pool.query("UPDATE cloud_workspace_lifecycle_intents SET state='succeeded',completed_at=now() WHERE id=$1", [stopId]);
        await pool.query("UPDATE cloud_workspace_provider_bindings SET last_observed_at=now()-interval '1 day',next_drift_check_at=now() WHERE workspace_id=$1", [f.workspaceId]);
      }
      const replacementId = randomUUID();
      let replacementError: unknown;
      const replaceAllocation = async () => {
        await withSystemTx(pool, async tx => {
          await tx.query("UPDATE managed_compute_allocation_leases SET state='settled',settled_at=now() WHERE id=$1", [input.intentId]);
          await tx.query(`INSERT INTO cloud_workspace_lifecycle_intents
            (id,workspace_id,generation,org_id,operation,idempotency_key,request_sha256,state,completed_at)
            VALUES($1::uuid,$2,1,$3,'wake',$1::text,$4,'succeeded',now())`, [replacementId, f.workspaceId, f.organizationId, randomBytes(32)]);
          await tx.query(`INSERT INTO managed_compute_allocation_leases
            (id,workspace_id,org_id,generation,billing_epoch,user_id,lifecycle_intent_id,provider,provider_resource_id,
              policy_id,seconds_per_dollar,weight_numerator,weight_denominator,ttl_seconds,requested_at,
              funded_until,provider_expires_at,state,next_check_at)
            SELECT $2,workspace_id,org_id,generation,billing_epoch,user_id,$2,provider,provider_resource_id,
              policy_id,seconds_per_dollar,weight_numerator,weight_denominator,ttl_seconds,requested_at,
              funded_until,provider_expires_at,'active',clock_timestamp()+interval '10 minutes'
            FROM managed_compute_allocation_leases WHERE id=$1`, [input.intentId, replacementId]);
          if (owner) await tx.query("UPDATE cloud_workspace_allocation_owners SET allocation_lease_id=$2 WHERE allocation_lease_id=$1", [input.intentId, replacementId]);
        }).catch(error => { replacementError = error; throw error; });
        return { ...resource(), state: "stopped" as const };
      };
      if (observation === "lifecycle") {
        provider.stop.mockImplementationOnce(replaceAllocation);
        expect(await reconciler().runOnce(f.workspaceId)).toBe(true);
      } else {
        provider.inspect.mockImplementationOnce(replaceAllocation);
        expect(await reconciler().reconcileDriftOnce(f.workspaceId)).toBe(true);
      }
      expect(replacementError).toBeUndefined();
      expect((await pool.query("SELECT state FROM managed_compute_allocation_leases WHERE id=$1", [replacementId])).rows[0]?.state).toBe("active");
      expect((await pool.query("SELECT allocation_lease_id FROM cloud_workspace_compute_rechecks WHERE workspace_id=$1", [f.workspaceId])).rows).toEqual([]);
      expect(await due()).toBeGreaterThan(590_000);
    });

    it.each(["activated", "rolling_back"] as const)("retains an unhandled request behind a live %s runtime transition", async phase => {
      await stopping(); await reconciler().runOnce(f.workspaceId);
      await secondGeneration(); await allocationOwner(1);
      const transitionId = randomUUID();
      await pool.query(`INSERT INTO cloud_workspace_generation_transitions
        (id,workspace_id,org_id,requested_by,operation,source_generation,template_generation,candidate_generation,state,execution_mode)
        VALUES($1,$2,$3,$4,'upgrade',1,1,2,'draining','retain_allocation')`, [transitionId, f.workspaceId, f.organizationId, f.userId]);
      await pool.query(`INSERT INTO cloud_workspace_runtime_transitions
        (transition_id,workspace_id,org_id,operation_id,source_engine_instance_id,provider_resource_id,mode,phase,
          source_active,target_descriptor,activation_deadline_at,rollback_deadline_at)
        VALUES($1,$2,$3,$1,$4,$5,'engine',$6,'{}','{}',now()+interval '1 minute',now()+interval '1 minute')`,
      [transitionId, f.workspaceId, f.organizationId, f.engineInstanceId, resource().resourceId, phase]);
      expect(await due()).toBeGreaterThan(59_000);
      expect(await originalCoordinator(pool).runOnce(f.workspaceId)).toBe(false);
      expect(await marker()).toMatchObject({ requested_sequence: "1", handled_sequence: "0" });
      await pool.query("UPDATE cloud_workspace_runtime_transitions SET phase='cancelled',completed_at=now() WHERE transition_id=$1", [transitionId]);
      expect(await due()).toBeLessThanOrEqual(0);
      stoppedMeter();
      expect(await originalCoordinator(pool).runOnce(f.workspaceId)).toBe(true);
    });

    it("resolves a transferred allocation through its owner while preserving its original labels and billing generation", async () => {
      const stopId = await stopping();
      await pool.query("UPDATE cloud_workspace_lifecycle_intents SET state='succeeded',completed_at=now() WHERE id=$1", [stopId]);
      await secondGeneration(); await allocationOwner(2);
      await pool.query("UPDATE cloud_workspace_provider_bindings SET provider_resource_id=NULL WHERE workspace_id=$1", [f.workspaceId]);
      await pool.query(`INSERT INTO cloud_workspace_provider_bindings(workspace_id,org_id,generation,provider,provider_resource_id,observed_state)
        VALUES($1,$2,2,'boat',$3,'stopping')`, [f.workspaceId, f.organizationId, resource().resourceId]);
      await pool.query("UPDATE cloud_workspaces SET current_generation=2 WHERE id=$1", [f.workspaceId]);
      await pool.query("UPDATE managed_compute_allocation_leases SET next_check_at=now()+interval '10 minutes' WHERE id=$1", [input.intentId]);
      stoppedMeter();
      const worker = new CloudWorkspaceReconciler({ pool, provider: asProvider(), providerResolver: originalResolver(pool), workosEnabled: false });
      expect(await worker.reconcileDriftOnce(f.workspaceId)).toBe(true);
      expect(await due()).toBeLessThanOrEqual(0);
      expect((await pool.query("SELECT generation FROM cloud_workspace_compute_rechecks WHERE allocation_lease_id=$1", [input.intentId])).rows[0].generation).toBe(2);
      expect(await originalCoordinator(pool).runOnce(f.workspaceId)).toBe(true);
      expect((await pool.query("SELECT generation,stopped_observed_at IS NOT NULL AS inspected FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId])).rows[0])
        .toEqual({ generation: 1, inspected: true });
      expect((await pool.query("SELECT original_generation,current_generation FROM cloud_workspace_allocation_owners WHERE allocation_lease_id=$1", [input.intentId])).rows[0])
        .toEqual({ original_generation: 1, current_generation: 2 });
    });

    it("ignores a late stopped observation and pending hint from the previous allocation owner", async () => {
      await stopping(); await reconciler().runOnce(f.workspaceId);
      await secondGeneration(); await allocationOwner(2);
      expect(await due()).toBeGreaterThan(590_000);
      await drift("archived"); // Old binding still exists, but no longer owns the allocation.
      expect(await marker()).toMatchObject({ requested_sequence: "1", handled_sequence: "0" });
      expect(await due()).toBeGreaterThan(590_000);
    });

    it("leaves a new request pending across an old worker's claim and completion", async () => {
      await stopping();
      // Pre-expansion claim/update shapes: no sequence is read or acknowledged.
      await pool.query(`UPDATE managed_compute_allocation_leases SET lease_owner='old-worker',lease_expires_at=now()+interval '5 minutes'
        WHERE id=$1`, [input.intentId]);
      await reconciler().runOnce(f.workspaceId);
      expect(await coordinator.runOnce(f.workspaceId)).toBe(false);
      await pool.query(`UPDATE managed_compute_allocation_leases SET lease_owner=NULL,lease_expires_at=NULL,
        next_check_at=now()+interval '10 minutes' WHERE id=$1 AND lease_owner='old-worker'`, [input.intentId]);
      expect(await marker()).toMatchObject({ requested_sequence: "1", handled_sequence: "0" });
      expect(await due()).toBeLessThanOrEqual(0);
      stoppedMeter();
      expect(await originalCoordinator(pool).runOnce(f.workspaceId)).toBe(true);
    });

    it("does not signal a settled allocation or retain an observation whose transaction rolled back", async () => {
      const stopId = await stopping();
      const db = abortingPool(pool, { code: "40001", count: 1, when: sql => sql.includes("INSERT INTO audit_log") });
      await reconciler(db.pool).runOnce(f.workspaceId);
      expect(db.observed.aborts).toBe(1);
      expect(await marker()).toBeUndefined();
      expect((await pool.query("SELECT stopped_observed_at FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId])).rows[0].stopped_observed_at).toBeNull();
      // A finalized allocation has no scheduling work to request.
      await pool.query("UPDATE cloud_workspace_lifecycle_intents SET state='succeeded',completed_at=now(),lease_owner=NULL,lease_expires_at=NULL WHERE id=$1", [stopId]);
      await pool.query("UPDATE managed_compute_allocation_leases SET state='settled',settled_at=now() WHERE id=$1", [input.intentId]);
      await drift("archived");
      expect(await marker()).toBeUndefined();
    });
  });
  it("re-checks an unsettled previous allocation at once when a start is refused for it", async () => {
    await ready();
    await pool.query("UPDATE managed_compute_allocation_leases SET next_check_at=clock_timestamp()+interval '1 hour' WHERE id=$1", [input.intentId]);
    await pool.query("UPDATE cloud_workspace_lifecycle_intents SET state='succeeded',completed_at=now() WHERE id=$1", [input.intentId]);
    const next = randomUUID();
    await pool.query(
      `INSERT INTO cloud_workspace_lifecycle_intents(id,workspace_id,generation,org_id,requested_by,operation,idempotency_key,request_sha256)
      VALUES ($1,$2,1,$3,$4,'wake',$5,$6)`,
      [next, f.workspaceId, f.organizationId, f.userId, randomUUID(), randomBytes(32)],
    );
    await expect(coordinator.allocate({ ...input, intentId: next, idempotencyKey: next }, asProvider(), null))
      .rejects.toMatchObject({ code: "compute_previous_lease_pending" });
    expect((await pool.query("SELECT next_check_at<=clock_timestamp() AS due FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId])).rows[0]).toEqual({ due: true });
  });
  // A worker's claim: owned, due when it was claimed, and not yet released.
  const claimByOtherWorker = async () => (await pool.query<{ at: string }>(
    `UPDATE managed_compute_allocation_leases SET lease_owner='other-worker',lease_expires_at=clock_timestamp()+interval '5 minutes',
      next_check_at=clock_timestamp()-interval '1 second' WHERE id=$1 RETURNING next_check_at::text AS at`,
    [input.intentId],
  )).rows[0]!.at;
  const pokedSince = async (db: pg.Pool | pg.PoolClient, at: string) => (await db.query<{ poked: boolean }>(
    "SELECT next_check_at>$2::timestamptz AS poked FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId, at],
  )).rows[0]!.poked;
  it("keeps a re-check requested while a check is running", async () => {
    await ready();
    await age();
    // A lifecycle change, refused start or provider loss lands during the provider call.
    provider.inspect.mockImplementation(async () => {
      await pool.query("UPDATE managed_compute_allocation_leases SET next_check_at=clock_timestamp() WHERE id=$1", [input.intentId]);
      return resource(800);
    });
    expect(await coordinator.runOnce()).toBe(true);
    expect(provider.inspect).toHaveBeenCalled();
    expect(Number((await nextCheck()).from_now)).toBeLessThanOrEqual(0);
  });
  it("re-checks a lease under check when the workspace lifecycle changes", async () => {
    await ready();
    const at = await claimByOtherWorker();
    const writer = await pool.connect();
    try {
      await writer.query("BEGIN");
      await writer.query("UPDATE cloud_workspaces SET desired_state='stopped' WHERE id=$1", [f.workspaceId]);
      expect(await pokedSince(writer, at)).toBe(true);
    } finally {
      await writer.query("ROLLBACK").catch(() => undefined);
      writer.release();
    }
  });
  it("never waits for a lease row lock when the workspace lifecycle changes", async () => {
    await ready();
    await pool.query("UPDATE managed_compute_allocation_leases SET next_check_at=clock_timestamp()+interval '1 hour' WHERE id=$1", [input.intentId]);
    const holder = await pool.connect(), writer = await pool.connect();
    try {
      // A short transaction of the lease's check holds its row.
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM managed_compute_allocation_leases WHERE id=$1 FOR UPDATE", [input.intentId]);
      await writer.query("BEGIN");
      await writer.query("SET LOCAL lock_timeout='1s'");
      await writer.query("UPDATE cloud_workspaces SET desired_state='stopped' WHERE id=$1", [f.workspaceId]);
      // Skipped rather than waited for: the held lease keeps its schedule.
      expect((await writer.query(
        "SELECT next_check_at>clock_timestamp()+interval '50 minutes' AS scheduled FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId],
      )).rows[0]).toEqual({ scheduled: true });
    } finally {
      await writer.query("ROLLBACK").catch(() => undefined);
      await holder.query("ROLLBACK").catch(() => undefined);
      writer.release();
      holder.release();
    }
  });
  it("re-checks a previous allocation under check when a start is refused for it", async () => {
    await ready();
    const at = await claimByOtherWorker();
    await pool.query("UPDATE cloud_workspace_lifecycle_intents SET state='succeeded',completed_at=now() WHERE id=$1", [input.intentId]);
    const next = randomUUID();
    await pool.query(
      `INSERT INTO cloud_workspace_lifecycle_intents(id,workspace_id,generation,org_id,requested_by,operation,idempotency_key,request_sha256)
      VALUES ($1,$2,1,$3,$4,'wake',$5,$6)`,
      [next, f.workspaceId, f.organizationId, f.userId, randomUUID(), randomBytes(32)],
    );
    await expect(coordinator.allocate({ ...input, intentId: next, idempotencyKey: next }, asProvider(), null))
      .rejects.toMatchObject({ code: "compute_previous_lease_pending" });
    expect(await pokedSince(pool, at)).toBe(true);
  });
  it.each(["16 seconds", "-16 seconds"])("wakes only a start refused for the unsettled allocation (previous due=%s)", async previousDue => {
    await ready();
    await age();
    stoppedMeter();
    await coordinator.runOnce();
    await pool.query(
      "UPDATE cloud_workspace_lifecycle_intents SET state='succeeded',completed_at=now() WHERE id=$1",
      [input.intentId],
    );
    const waiting = randomUUID(), throttled = randomUUID();
    for (const [id, code] of [[waiting, "compute_previous_lease_pending"], [throttled, "provider_rate_limited"]] as const)
      await pool.query(
        `INSERT INTO cloud_workspace_lifecycle_intents(id,workspace_id,generation,org_id,requested_by,operation,idempotency_key,request_sha256,
          state,error_code,next_attempt_at)
        VALUES ($1,$2,1,$3,$4,'wake',$5,$6,'observing',$7,now()+interval '16 seconds')`,
        [id, f.workspaceId, f.organizationId, f.userId, randomUUID(), randomBytes(32), code],
      );
    await pool.query("UPDATE cloud_workspace_lifecycle_intents SET next_attempt_at=now()+$2::interval WHERE id=$1", [waiting, previousDue]);
    await pool.query(
      "UPDATE managed_compute_allocation_leases SET stopped_observed_at=now()-interval '10 seconds',next_check_at=now() WHERE id=$1",
      [input.intentId],
    );
    await coordinator.runOnce();
    expect((await nextCheck()).state).toBe("settled");
    const due = async (id: string) => (
      await pool.query<{ due: boolean }>(
        "SELECT next_attempt_at<=clock_timestamp() AS due FROM cloud_workspace_lifecycle_intents WHERE id=$1",
        [id],
      )
    ).rows[0]!.due;
    expect(await due(waiting)).toBe(true);
    expect(await due(throttled)).toBe(false);
    expect(await readLifecycleDueInMs(pool, "lifecycle", f.workspaceId, { provider: null, driftIntervalMs: 1000 })).toBeLessThanOrEqual(0);
  });
  it("retains credit when disappearance is unconfirmed", async () => {
    await ready();
    provider.inspect.mockResolvedValue(
      null as unknown as CloudProviderResource,
    );
    await coordinator.runOnce();
    expect((await balance())[0]!.reservedMicroUsd).toBeGreaterThan(0);
    expect(
      (
        await pool.query(
          "SELECT state FROM managed_compute_allocation_leases WHERE id=$1",
          [input.intentId],
        )
      ).rows[0].state,
    ).toBe("draining");
  });
  it("finalizes an attested lost allocation at its last provider meter", async () => {
    await ready();
    await age();
    const journal = new DatabaseCloudProviderOperationStore(pool, "boat", "credit-journal-test");
    await journal.prepareCreate({ ...input, requestSha256: "a".repeat(64) });
    await journal.bindResource(input, resource().resourceId);
    await coordinator.runOnce();
    expect((await balance())[0]).toMatchObject({ debitedMicroUsd: 6000 });
    // The provider loses the allocation together with its usage meter.
    provider.inspect.mockResolvedValue(null as unknown as CloudProviderResource);
    provider.verifyAbsence.mockResolvedValue(true);
    provider.readComputeUsage.mockRejectedValue(new CloudProviderError("provider_not_found", "Allocation lost", false));
    const lease = () => pool.query("SELECT state,last_error_code FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId]);
    await pool.query("UPDATE managed_compute_allocation_leases SET next_check_at=now() WHERE id=$1", [input.intentId]);
    await coordinator.runOnce();
    // A missing allocation alone is not a final meter.
    expect((await lease()).rows[0]).toEqual({ state: "draining", last_error_code: "compute_final_meter_unavailable" });
    expect((await balance())[0]!.reservedMicroUsd).toBeGreaterThan(0);
    await seedProviderLossAttestation(pool, { provider: "boat", accountScope: "credit-journal-test", workspaceId: f.workspaceId,
      resourceId: resource().resourceId, attestedBy: f.userId });
    await pool.query("UPDATE managed_compute_allocation_leases SET next_check_at=now() WHERE id=$1", [input.intentId]);
    await coordinator.runOnce();
    expect((await lease()).rows[0]).toEqual({ state: "settled", last_error_code: null });
    // Only metered usage is billed; the unmetered remainder is released.
    expect((await balance())[0]).toMatchObject({ debitedMicroUsd: 6000, reservedMicroUsd: 0, availableMicroUsd: 14000 });
    expect((await pool.query("SELECT state,final_reason FROM managed_compute_credit_reservations WHERE id=$1", [input.intentId])).rows)
      .toEqual([{ state: "final", final_reason: "allocation_lost" }]);
    expect(provider.readComputeUsage).toHaveBeenCalledTimes(1);
  });
  it("does not finalize an allocation from a loss recorded for a different resource", async () => {
    await ready();
    const other = new DatabaseCloudProviderOperationStore(pool, "boat", "credit-journal-test");
    await other.prepareCreate({ ...input, requestSha256: "a".repeat(64) });
    await other.bindResource(input, "sandbox-some-other-allocation");
    await seedProviderLossAttestation(pool, { provider: "boat", accountScope: "credit-journal-test", workspaceId: f.workspaceId,
      resourceId: "sandbox-some-other-allocation", attestedBy: f.userId });
    await pool.query("UPDATE managed_compute_allocation_leases SET provider_resource_id=$2 WHERE id=$1", [input.intentId, resource().resourceId]);
    provider.inspect.mockResolvedValue(null as unknown as CloudProviderResource);
    provider.verifyAbsence.mockResolvedValue(true);
    await coordinator.runOnce();
    expect((await pool.query("SELECT state,last_error_code FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId])).rows[0])
      .toEqual({ state: "draining", last_error_code: "compute_final_meter_unavailable" });
    expect((await balance())[0]!.reservedMicroUsd).toBeGreaterThan(0);
  });
  it("settles an attested lost allocation that its lease never recorded", async () => {
    await ready();
    const journal = new DatabaseCloudProviderOperationStore(pool, "boat", "credit-journal-test");
    await journal.prepareCreate({ ...input, requestSha256: "a".repeat(64) });
    await journal.bindResource(input, resource().resourceId);
    // The allocation was bound before its draining lease recorded it, then lost.
    await pool.query("UPDATE managed_compute_allocation_leases SET state='draining',provider_resource_id=NULL,provider_expires_at=NULL WHERE id=$1",
      [input.intentId]);
    provider.find.mockResolvedValue([]);
    provider.verifyAbsence.mockResolvedValue(true);
    const lease = () => pool.query("SELECT state,last_error_code FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId]);
    await coordinator.runOnce();
    expect((await lease()).rows[0]).toMatchObject({ last_error_code: "compute_final_meter_unavailable" });
    await seedProviderLossAttestation(pool, { provider: "boat", accountScope: "credit-journal-test", workspaceId: f.workspaceId,
      resourceId: resource().resourceId, attestedBy: f.userId });
    await pool.query("UPDATE managed_compute_allocation_leases SET next_check_at=now() WHERE id=$1", [input.intentId]);
    await coordinator.runOnce();
    expect((await lease()).rows[0]).toEqual({ state: "settled", last_error_code: null });
    expect((await pool.query("SELECT state,final_reason FROM managed_compute_credit_reservations WHERE id=$1", [input.intentId])).rows)
      .toEqual([{ state: "final", final_reason: "allocation_lost" }]);
    expect((await balance())[0]).toMatchObject({ debitedMicroUsd: 0, reservedMicroUsd: 0 });
  });
  it("backs off a persistently failing reconciliation instead of requesting a stop every poll", async () => {
    await ready();
    provider.inspect.mockRejectedValue(new CloudProviderError("provider_not_found", "Allocation lost", false));
    const stops = async () => Number((await pool.query(
      "SELECT count(*) AS n FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 AND operation='stop'", [f.workspaceId],
    )).rows[0].n);
    await coordinator.runOnce();
    expect(Number((await nextCheck()).from_now)).toBeLessThan(16);
    expect(await stops()).toBe(1);
    await pool.query("UPDATE managed_compute_allocation_leases SET first_error_at=clock_timestamp()-interval '2 minutes',next_check_at=now() WHERE id=$1", [input.intentId]);
    await coordinator.runOnce();
    const backedOff = Number((await nextCheck()).from_now);
    expect(backedOff).toBeGreaterThan(110);
    expect(backedOff).toBeLessThan(125);
    await pool.query("UPDATE managed_compute_allocation_leases SET first_error_at=clock_timestamp()-interval '1 hour',next_check_at=now() WHERE id=$1", [input.intentId]);
    await coordinator.runOnce();
    const capped = Number((await nextCheck()).from_now);
    expect(capped).toBeGreaterThan(290);
    expect(capped).toBeLessThanOrEqual(300);
    // Nothing else re-checks the lease while it waits.
    expect(await coordinator.runOnce()).toBe(false);
    expect(await stops()).toBeLessThanOrEqual(3);
  });
  it("reports a persistent settlement failure even while retries refresh the lease", async () => {
    await ready();
    await pool.query(
      "UPDATE managed_compute_allocation_leases SET last_error_code='compute_final_meter_unavailable',first_error_at=now()-interval '6 minutes',updated_at=now(),next_check_at=now()+interval '15 seconds' WHERE id=$1",
      [input.intentId],
    );
    const health = await new DatabaseCloudWorkspaceHealthService(pool, {
      setupExecutionEnabled: false,
      durabilityEnabled: false,
      outboxDeliveryEnabled: false,
    }).read();
    expect(health.reasons).toContain("compute_settlement_stalled");
    expect(JSON.stringify(health)).not.toContain(f.workspaceId);
  });
  it("stops after the bounded fallback and defers deletion while usage settlement is pending", async () => {
    await ready();
    await pool.query("UPDATE managed_compute_allocation_leases SET provider_expires_at=now()+interval '30 seconds' WHERE id=$1", [input.intentId]);
    provider.stop.mockResolvedValue({ ...resource(), state: "archived" });
    expect(await coordinator.beforeDelete(input, asProvider(), resource())).toBe(false);
    expect(provider.stop).not.toHaveBeenCalled();
    expect(
      await coordinator.beforeDelete(input, asProvider(), resource()),
    ).toBe(false);
    expect(provider.stop).toHaveBeenCalledTimes(1);
    expect(provider.delete).not.toHaveBeenCalled();
    expect((await balance())[0]!.reservedMicroUsd).toBeGreaterThan(0);
  });

  it("requests a funded final checkpoint before stopping, and does not fabricate checkpoint success at the deadline", async () => {
    await ready();
    await requestManagedComputeStop(pool, {
      leaseId: input.intentId,
      reason: "compute_credit_exhausted",
    });
    expect(
      (
        await pool.query(
          "SELECT state,reason FROM workspace_checkpoint_requests WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rows,
    ).toEqual([{ state: "queued", reason: "before_stop" }]);
    expect(
      (
        await pool.query(
          "SELECT desired_state,status FROM cloud_workspaces WHERE id=$1",
          [f.workspaceId],
        )
      ).rows[0],
    ).toEqual({ desired_state: "running", status: "ready" });
    await requestManagedComputeStop(pool, {
      leaseId: input.intentId,
      reason: "compute_credit_exhausted",
      force: true,
    });
    expect(
      (
        await pool.query(
          "SELECT state FROM workspace_checkpoint_requests WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rows,
    ).toEqual([{ state: "cancelled" }]);
    expect(
      (
        await pool.query(
          "SELECT desired_state,status FROM cloud_workspaces WHERE id=$1",
          [f.workspaceId],
        )
      ).rows[0],
    ).toEqual({ desired_state: "stopped", status: "stopping" });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 AND operation='delete'",
          [f.workspaceId],
        )
      ).rows[0].count,
    ).toBe(0);
  });
  it("does not let a caller's idempotency key suppress a required budget stop", async () => {
    await ready();
    await pool.query(
      `INSERT INTO cloud_workspace_lifecycle_intents(id,workspace_id,generation,org_id,requested_by,operation,idempotency_key,request_sha256,state,completed_at)
      VALUES ($1,$2,1,$3,$4,'wake',$5,$6,'succeeded',now())`,
      [
        randomUUID(),
        f.workspaceId,
        f.organizationId,
        f.userId,
        `system:compute-stop:${input.intentId}`,
        randomBytes(32),
      ],
    );
    await requestManagedComputeStop(pool, {
      leaseId: input.intentId,
      reason: "compute_credit_exhausted",
    });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 AND operation='stop' AND state='queued'",
          [f.workspaceId],
        )
      ).rows[0].count,
    ).toBe(1);
  });
  it("does not queue another stop after a completed stop while settlement is pending", async () => {
    await ready();
    await requestManagedComputeStop(pool, {
      leaseId: input.intentId,
      reason: "compute_credit_exhausted",
      force: true,
    });
    await pool.query(
      "UPDATE cloud_workspace_lifecycle_intents SET state='succeeded',completed_at=now() WHERE workspace_id=$1 AND operation='stop'",
      [f.workspaceId],
    );
    await pool.query(
      "UPDATE cloud_workspaces SET status='stopped' WHERE id=$1",
      [f.workspaceId],
    );
    await requestManagedComputeStop(pool, {
      leaseId: input.intentId,
      reason: "compute_credit_exhausted",
      force: true,
    });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 AND operation='stop'",
          [f.workspaceId],
        )
      ).rows[0].count,
    ).toBe(1);
  });
  it("requeues a budget stop when an intervening lifecycle request supersedes it", async () => {
    await ready();
    await requestManagedComputeStop(pool, {
      leaseId: input.intentId,
      reason: "compute_credit_exhausted",
    });
    await pool.query(
      "UPDATE cloud_workspace_lifecycle_intents SET state='superseded',completed_at=now() WHERE workspace_id=$1 AND operation='stop'",
      [f.workspaceId],
    );
    await pool.query(
      "UPDATE workspace_checkpoint_requests SET state='cancelled',completed_at=now() WHERE workspace_id=$1",
      [f.workspaceId],
    );
    await requestManagedComputeStop(pool, {
      leaseId: input.intentId,
      reason: "compute_credit_exhausted",
    });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 AND operation='stop' AND state='queued'",
          [f.workspaceId],
        )
      ).rows[0].count,
    ).toBe(1);
  });

  it("does not call the provider when no seat credit is funded", async () => {
    await expect(
      coordinator.allocate(input, asProvider(), null),
    ).rejects.toMatchObject({ code: "compute_credit_exhausted" });
    expect(provider.createWithComputeLease).not.toHaveBeenCalled();
    expect(provider.create).not.toHaveBeenCalled();
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM managed_compute_credit_reservations",
        )
      ).rows[0].count,
    ).toBe(0);
  });
  it("commits the hold before allocation and requires both spending and provider identity for execution", async () => {
    await grant();
    provider.createWithComputeLease.mockImplementationOnce(
      async (_request, ttl) => {
        expect((await balance())[0]!.reservedMicroUsd).toBeGreaterThanOrEqual(
          9600,
        );
        expect(ttl).toBe(900);
        return resource(ttl);
      },
    );
    const next = await coordinator.allocate(input, asProvider(), null);
    expect(next.state).toBe("running");
    expect(
      (
        await pool.query(
          "SELECT cloud_workspace_compute_authority_live($1,1) AS live",
          [f.workspaceId],
        )
      ).rows[0].live,
    ).toBe(false);
    await pool.query(
      "UPDATE cloud_workspace_provider_bindings SET provider_resource_id=$2 WHERE workspace_id=$1",
      [f.workspaceId, next.resourceId],
    );
    expect(
      (
        await pool.query(
          "SELECT cloud_workspace_runtime_authority_live($1,1,$2,false) AS live",
          [f.workspaceId, f.userId],
        )
      ).rows[0].live,
    ).toBe(true);
    await pool.query(
      "UPDATE managed_compute_allocation_leases SET provider_expires_at=now()-interval '1 second' WHERE id=$1",
      [input.intentId],
    );
    expect(
      (
        await pool.query(
          "SELECT cloud_workspace_runtime_authority_live($1,1,$2,false) AS live",
          [f.workspaceId, f.userId],
        )
      ).rows[0].live,
    ).toBe(false);
  });
  it("retains the exact finite request and credit after a lost provider reply", async () => {
    await grant();
    provider.createWithComputeLease.mockRejectedValueOnce(
      new CloudProviderError("provider_timeout", "fixture timeout", true),
    );
    await expect(
      coordinator.allocate(input, asProvider(), null),
    ).rejects.toMatchObject({ code: "provider_timeout" });
    expect((await balance())[0]!.reservedMicroUsd).toBeGreaterThanOrEqual(9600);
    expect(
      (await pool.query("SELECT state FROM managed_compute_allocation_leases"))
        .rows[0].state,
    ).toBe("authorized");
    await expect(
      coordinator.allocate(input, asProvider(), null),
    ).resolves.toMatchObject({ state: "running" });
    expect(
      provider.createWithComputeLease.mock.calls.map((c) => [
        c[0].idempotencyKey,
        c[1],
      ]),
    ).toEqual([
      [input.idempotencyKey, 900],
      [input.idempotencyKey, 900],
    ]);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM managed_compute_reservation_scopes",
        )
      ).rows[0].count,
    ).toBe(1);
  });
  it.each(["provider_timeout", "provider_rate_limited"])(
    "preserves an unbound funded retry when metering races %s recovery",
    async (code) => {
      await grant();
      provider.find.mockResolvedValue([]);
      provider.createWithComputeLease.mockRejectedValueOnce(
        new CloudProviderError(code, "Retryable allocation response", true),
      );
      await expect(coordinator.allocate(input, asProvider(), null)).rejects.toMatchObject({ code });
      const reserved = (await balance())[0]!.reservedMicroUsd;
      await coordinator.runOnce();
      expect((await pool.query(
        "SELECT state,stop_intent_id FROM managed_compute_allocation_leases WHERE id=$1",
        [input.intentId],
      )).rows[0]).toEqual({ state: "authorized", stop_intent_id: null });
      expect((await balance())[0]!.reservedMicroUsd).toBe(reserved);
      expect((await pool.query(
        "SELECT desired_state FROM cloud_workspaces WHERE id=$1", [f.workspaceId],
      )).rows[0].desired_state).toBe("running");
      await expect(coordinator.allocate(input, asProvider(), null)).resolves.toMatchObject({ state: "running" });
      expect(provider.createWithComputeLease.mock.calls.map(([request, ttl]) => [request.idempotencyKey, ttl])).toEqual([
        [input.idempotencyKey, 900], [input.idempotencyKey, 900],
      ]);
    },
  );
  it("does not settle a still-pending allocation merely because the provider currently reports absence", async () => {
    await grant();
    provider.find.mockResolvedValue([]);
    provider.verifyAbsence.mockResolvedValue(true);
    provider.createWithComputeLease.mockRejectedValueOnce(new CloudProviderError("provider_rate_limited", "Retryable allocation response", true));
    await expect(coordinator.allocate(input, asProvider(), null)).rejects.toMatchObject({ code: "provider_rate_limited" });
    const reserved = (await balance())[0]!.reservedMicroUsd;
    await coordinator.runOnce();
    expect((await pool.query("SELECT state FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId])).rows[0].state).toBe("authorized");
    expect((await balance())[0]!.reservedMicroUsd).toBe(reserved);
    await expect(coordinator.allocate(input, asProvider(), null)).resolves.toMatchObject({ state: "running" });
  });

  it.each([false,true])("settles a rejected create only with a complete dispatch journal (earlier unknown=%s)",async earlierUnknown=>{
    await grant();
    const journal=new DatabaseCloudProviderOperationStore(pool,"boat","credit-journal-test");
    provider.find.mockResolvedValue([]);
    provider.verifyAbsence.mockImplementation(identity=>journal.closeUnallocatedCreate(identity));
    provider.createWithComputeLease.mockImplementationOnce(async()=>{
      await journal.prepareCreate({...input,requestSha256:"a".repeat(64)});
      if(earlierUnknown)await journal.beginCreateAttempt(input,randomUUID());
      const attempt=randomUUID();await journal.beginCreateAttempt(input,attempt);
      await journal.recordCreateRejection(input,attempt,"trial_compute_limit_reached");
      throw new CloudProviderError("provider_budget_exhausted","Allocation rejected",false);
    });
    const reconciler=new CloudWorkspaceReconciler({pool,provider:asProvider(),providerResolver:resolver(),computePolicy:policy,workosEnabled:false,intervalMs:1000});
    expect(await reconciler.runOnce()).toBe(true);
    expect((await pool.query("SELECT state FROM cloud_workspace_lifecycle_intents WHERE id=$1",[input.intentId])).rows[0].state).toBe("failed");
    expect((await balance())[0]!.reservedMicroUsd).toBeGreaterThan(0);
    expect(await coordinator.runOnce()).toBe(true);
    const after=(await balance())[0]!;
    expect(after.debitedMicroUsd).toBe(0);
    if(earlierUnknown){
      expect(after.reservedMicroUsd).toBeGreaterThan(0);
      expect((await journal.find(input))!.createClosedAt).toBeNull();
    }else{
      expect(after.reservedMicroUsd).toBe(0);
      expect((await journal.find(input))!.createClosedAt).not.toBeNull();
      expect((await pool.query("SELECT state FROM managed_compute_allocation_leases WHERE id=$1",[input.intentId])).rows[0].state).toBe("settled");
      expect(await coordinator.runOnce()).toBe(false);
      expect((await balance())[0]!.reservedMicroUsd).toBe(0);
    }
  });
  it.each(["expired", "unfunded", "revoked", "terminal", "stopped"])(
    "does not defer ambiguous allocation cleanup after its authority becomes %s", async change => {
      await grant();
      provider.find.mockResolvedValue([]);
      provider.createWithComputeLease.mockRejectedValueOnce(new CloudProviderError("provider_timeout", "Ambiguous allocation", true));
      await expect(coordinator.allocate(input, asProvider(), null)).rejects.toMatchObject({ code: "provider_timeout" });
      if (change === "expired") await pool.query("UPDATE managed_compute_allocation_leases SET requested_at=now()-interval '46 minutes' WHERE id=$1", [input.intentId]);
      if (change === "unfunded") await pool.query("UPDATE managed_compute_allocation_leases SET funded_until=clock_timestamp()+interval '20 seconds' WHERE id=$1", [input.intentId]);
      if (change === "revoked") await pool.query("UPDATE organization_seat_assignments SET state='released',released_at=now() WHERE org_id=$1", [f.organizationId]);
      if (change === "terminal") await pool.query("UPDATE cloud_workspace_lifecycle_intents SET state='failed',completed_at=now() WHERE id=$1", [input.intentId]);
      if (change === "stopped") await pool.query("UPDATE cloud_workspaces SET desired_state='stopped',status='stopping' WHERE id=$1", [f.workspaceId]);
      await coordinator.runOnce();
      const lease = (await pool.query("SELECT state,stop_intent_id FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId])).rows[0];
      expect(lease.state).toBe("draining");
      expect(lease.stop_intent_id).not.toBeNull();
      expect((await balance())[0]!.reservedMicroUsd).toBeGreaterThan(0);
      expect(provider.createWithComputeLease).toHaveBeenCalledTimes(1);
    },
  );
  it("does not dispatch or refund an expired ambiguous allocation even when more credit is available", async () => {
    await grant();
    provider.createWithComputeLease.mockRejectedValueOnce(new CloudProviderError("provider_timeout", "Ambiguous allocation", true));
    await expect(coordinator.allocate(input, asProvider(), null)).rejects.toMatchObject({ code: "provider_timeout" });
    await pool.query("UPDATE managed_compute_allocation_leases SET requested_at=now()-interval '46 minutes' WHERE id=$1", [input.intentId]);
    await expect(coordinator.allocate(input, asProvider(), null)).rejects.toMatchObject({ code: "compute_allocation_retry_expired" });
    expect(provider.createWithComputeLease).toHaveBeenCalledTimes(1);
    expect((await balance())[0]!.reservedMicroUsd).toBeGreaterThan(0);
  });
  it("stops an allocation billed to another wallet instead of running it to its TTL", async () => {
    await grant();
    provider.find.mockResolvedValue([]);
    provider.createWithComputeLease.mockRejectedValueOnce(new CloudProviderError("provider_billing_scope_mismatch", "Wrong wallet", false));
    await expect(coordinator.allocate(input, asProvider(), null)).rejects.toMatchObject({ code: "provider_billing_scope_mismatch" });
    const lease = (await pool.query("SELECT state,stop_intent_id FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId])).rows[0];
    expect(lease.state).toBe("draining");
    expect(lease.stop_intent_id).not.toBeNull();
    expect(provider.createWithComputeLease).toHaveBeenCalledTimes(1);
  });
  it("preserves funded wake retries while the existing VM is still archived", async () => {
    await grant();
    await pool.query("UPDATE cloud_workspace_lifecycle_intents SET operation='wake' WHERE id=$1", [input.intentId]);
    const archived = {...resource(), state: "archived" as const};
    provider.find.mockResolvedValue([archived]);
    provider.startWithComputeLease.mockRejectedValueOnce(new CloudProviderError("provider_rate_limited", "Retryable wake", true));
    await expect(coordinator.allocate(input, asProvider(), archived)).rejects.toMatchObject({ code: "provider_rate_limited" });
    await coordinator.runOnce();
    expect((await pool.query("SELECT state FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId])).rows[0].state).toBe("authorized");
    expect(provider.readComputeUsage).not.toHaveBeenCalled();
    await expect(coordinator.allocate(input, asProvider(), archived)).resolves.toMatchObject({ state: "running" });
  });
  it("does not let an expired metering claimant stop an allocation recovered by another worker", async () => {
    await grant();
    provider.createWithComputeLease.mockRejectedValueOnce(new CloudProviderError("provider_timeout", "Ambiguous allocation", true));
    await expect(coordinator.allocate(input, asProvider(), null)).rejects.toMatchObject({ code: "provider_timeout" });
    provider.find.mockImplementationOnce(async () => {
      await pool.query("UPDATE managed_compute_allocation_leases SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [input.intentId]);
      const retry = new CloudWorkspaceComputeLeaseCoordinator({pool,providerResolver:resolver(),workosEnabled:false,policy,usageMeterWindowMs:0});
      await retry.allocate(input, asProvider(), null);
      throw new CloudProviderError("provider_timeout", "Late response from expired claimant", true);
    });
    await coordinator.runOnce();
    expect((await pool.query("SELECT state,stop_intent_id FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId])).rows[0])
      .toEqual({state:"active",stop_intent_id:null});
    expect((await pool.query("SELECT desired_state FROM cloud_workspaces WHERE id=$1", [f.workspaceId])).rows[0].desired_state).toBe("running");
  });
  it("does not let a stale absence result release another compute claimant's reservation", async () => {
    await grant();
    provider.createWithComputeLease.mockRejectedValueOnce(new CloudProviderError("provider_timeout", "Ambiguous allocation", true));
    await expect(coordinator.allocate(input, asProvider(), null)).rejects.toMatchObject({ code: "provider_timeout" });
    await pool.query("UPDATE managed_compute_allocation_leases SET lease_owner='compute:replacement',lease_expires_at=now()+interval '5 minutes' WHERE id=$1", [input.intentId]);
    const period = (await pool.query("SELECT period_id FROM managed_compute_credit_reservations WHERE id=$1", [input.intentId])).rows[0].period_id;
    const request = {reservationId:input.intentId,periodId:period,allocationLeaseClaim:{owner:"compute:expired"}};
    const before = (await balance())[0]!.reservedMicroUsd;
    await expect(ledger.releaseUnallocated(request)).rejects.toMatchObject({code:"compute_lease_superseded"});
    expect((await balance())[0]!.reservedMicroUsd).toBe(before);
    expect((await pool.query("SELECT state FROM managed_compute_credit_reservations WHERE id=$1", [input.intentId])).rows[0].state).toBe("open");
  });
  it("refuses running allocations that have no funded finite provider deadline", async () => {
    await expect(
      coordinator.observeRunning(input, asProvider(), resource()),
    ).rejects.toMatchObject({ code: "compute_lease_unfunded" });
    await grant();
    provider.createWithComputeLease.mockResolvedValueOnce({
      ...resource(),
      metadata: {},
    });
    await expect(
      coordinator.allocate(input, asProvider(), null),
    ).rejects.toMatchObject({ code: "compute_lease_unconfirmed" });
    expect((await balance())[0]!.reservedMicroUsd).toBeGreaterThan(0);
    expect(
      (await pool.query("SELECT state FROM managed_compute_allocation_leases"))
        .rows[0].state,
    ).toBe("authorized");
  });
  it("rejects a provider deadline beyond the funded window", async () => {
    await grant();
    provider.createWithComputeLease.mockResolvedValueOnce(resource(3600));
    await expect(
      coordinator.allocate(input, asProvider(), null),
    ).rejects.toMatchObject({ code: "compute_lease_unconfirmed" });
    expect(
      (
        await pool.query(
          "SELECT cloud_workspace_compute_authority_live($1,1) AS live",
          [f.workspaceId],
        )
      ).rows[0].live,
    ).toBe(false);
  });
  it("checks paid authority again after provider I/O", async () => {
    await grant();
    provider.createWithComputeLease.mockImplementationOnce(async () => {
      await pool.query(
        "UPDATE organization_seat_assignments SET state='released',released_at=now() WHERE org_id=$1",
        [f.organizationId],
      );
      return resource();
    });
    await expect(
      coordinator.allocate(input, asProvider(), null),
    ).rejects.toMatchObject({ code: "compute_lease_unfunded" });
    expect(
      (
        await pool.query(
          "SELECT cloud_workspace_compute_authority_live($1,1) AS live",
          [f.workspaceId],
        )
      ).rows[0].live,
    ).toBe(false);
    expect((await balance())[0]!.reservedMicroUsd).toBeGreaterThan(0);
  });
  it("keeps customer-delegated compute out of managed reservations", async () => {
    await pool.query(
      `UPDATE provider_connection_versions SET credential_source='delegated',endpoint='https://api.fixture.test',
      key_version=1,nonce=$2,ciphertext=$3,auth_tag=$4,credential_sha256=$5 WHERE org_id=$1`,
      [
        f.organizationId,
        randomBytes(12),
        randomBytes(32),
        randomBytes(16),
        randomBytes(32),
      ],
    );
    await coordinator.allocate(input, asProvider(), null);
    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(provider.createWithComputeLease).not.toHaveBeenCalled();
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM managed_compute_allocation_leases",
        )
      ).rows[0].count,
    ).toBe(0);
  });
  describe("hourly usage metering", () => {
    const hourly = () => new CloudWorkspaceComputeLeaseCoordinator({ pool, providerResolver: resolver(), workosEnabled: false, policy, usageMeterWindowMs: 3_600_000 });
    const backdateMeter = (interval: string) => pool.query(
      `UPDATE managed_compute_credit_reservations SET meter_since=meter_since-$2::interval,meter_through=meter_through-$2::interval WHERE id=$1`,
      [input.intentId, interval]);
    const due = () => pool.query("UPDATE managed_compute_allocation_leases SET next_check_at=now() WHERE id=$1", [input.intentId]);
    it("reads Boat usage for a running allocation at most once per hour", async () => {
      await ready(); await age();
      await hourly().runOnce();
      expect(provider.readComputeUsage).not.toHaveBeenCalled();
      expect((await balance())[0]!.debitedMicroUsd).toBe(0);
      await backdateMeter("55 minutes"); await due();
      const { meter_since } = (await pool.query<{ meter_since: Date }>("SELECT meter_since FROM managed_compute_credit_reservations WHERE id=$1", [input.intentId])).rows[0]!;
      await hourly().runOnce();
      expect(provider.readComputeUsage).toHaveBeenCalledOnce();
      expect(provider.readComputeUsage.mock.calls[0]![1]!.since).toEqual(meter_since);
      expect((await balance())[0]!.debitedMicroUsd).toBe(6000);
      await due(); await hourly().runOnce();
      expect(provider.readComputeUsage).toHaveBeenCalledOnce();
    });
    it("meters a stopped allocation at once regardless of the hourly window", async () => {
      await ready(); await age(); stoppedMeter();
      await hourly().runOnce();
      expect(provider.readComputeUsage).not.toHaveBeenCalled();
      await pool.query("UPDATE managed_compute_allocation_leases SET stopped_observed_at=now()-interval '10 seconds',next_check_at=now() WHERE id=$1", [input.intentId]);
      await hourly().runOnce();
      expect(provider.readComputeUsage).toHaveBeenCalledOnce();
      expect((await pool.query("SELECT state,final_reason FROM managed_compute_credit_reservations WHERE id=$1", [input.intentId])).rows[0]).toEqual({ state: "final", final_reason: "allocation_stopped" });
    });
    it("does not debit twice when an hourly meter commit loses its connection", async () => {
      await ready(); await age(); await backdateMeter("55 minutes");
      const interrupted = interruptedLedgerPool(pool, "committed_connection_lost");
      await new CloudWorkspaceComputeLeaseCoordinator({ pool: interrupted.pool, providerResolver: resolver(), workosEnabled: false, policy, usageMeterWindowMs: 3_600_000 }).runOnce().catch(() => undefined);
      expect(interrupted.observed.interruptions).toBe(1);
      await pool.query("UPDATE managed_compute_allocation_leases SET lease_owner=NULL,lease_expires_at=NULL,next_check_at=now() WHERE id=$1", [input.intentId]);
      await hourly().runOnce();
      expect((await balance())[0]!.debitedMicroUsd).toBe(6000);
      expect((await pool.query("SELECT count(*)::int AS n FROM managed_compute_credit_events WHERE reservation_id=$1 AND kind='debit'", [input.intentId])).rows[0].n).toBe(1);
      expect(provider.readComputeUsage).toHaveBeenCalledOnce();
    });
    it("still stops at the budget when the hourly window has not elapsed", async () => {
      await ready(); await age(); provider.inspect.mockResolvedValue(resource(200));
      await pool.query("UPDATE managed_compute_credit_periods SET granted_micro_usd=debited_micro_usd+reserved_micro_usd WHERE org_id=$1", [f.organizationId]);
      await hourly().runOnce();
      expect(provider.readComputeUsage).not.toHaveBeenCalled();
      expect(provider.renewComputeLease).not.toHaveBeenCalled();
      expect((await pool.query("SELECT state,last_error_code FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId])).rows[0]).toMatchObject({ state: "draining" });
      expect((await balance())[0]!.reservedMicroUsd).toBeGreaterThan(0);
    });
  });
  describe("usage disagreement", () => {
    const usage = (seconds: number) => provider.readComputeUsage.mockImplementationOnce(async (id, window) => ({
      resourceId: id, since: window!.since.toISOString(), until: window!.until!.toISOString(),
      billableSeconds: seconds, secondsPerDollar: 100000, listPriceMicroUsd: computeMicroUsd(seconds, 100000), running: true,
    }));
    const disagreements = async () => (await pool.query(
      "SELECT direction,provider_seconds::int AS provider,expected_seconds::int AS expected FROM managed_compute_usage_disagreements WHERE reservation_id=$1 ORDER BY detected_at",
      [input.intentId])).rows;
    const health = () => new DatabaseCloudWorkspaceHealthService(pool, { setupExecutionEnabled: false, durabilityEnabled: false, outboxDeliveryEnabled: false }).read();
    it("records nothing when Boat usage matches the weighted wall-clock time", async () => {
      await ready(); await age(); usage(600); await coordinator.runOnce();
      expect(await disagreements()).toEqual([]);
      expect((await health()).reasons).not.toContain("compute_usage_disagreement");
    });
    it("records an over-report beyond the tolerance and still bills the provider reading", async () => {
      await ready(); await age(); usage(700); await coordinator.runOnce();
      const rows = await disagreements();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ direction: "over", provider: 700 });
      expect(rows[0].expected).toBeGreaterThanOrEqual(590);
      expect(rows[0].expected).toBeLessThanOrEqual(615);
      expect((await balance())[0]!.debitedMicroUsd).toBe(7000);
      const audits = (await pool.query("SELECT subject FROM audit_log WHERE org_id=$1 AND action='cloud_compute.usage_disagreement'", [f.organizationId])).rows;
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ subject: { workspaceId: f.workspaceId, direction: "over", providerSeconds: 700 } });
      expect((await health()).reasons).toContain("compute_usage_disagreement");
      expect(JSON.stringify(await health())).not.toContain(f.workspaceId);
    });
    it("records an under-report only after the first window of a running allocation", async () => {
      await ready(); await age(); usage(600); await coordinator.runOnce();
      await age(); usage(610); await coordinator.runOnce();
      const rows = await disagreements();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ direction: "under", provider: 10 });
      expect(rows[0].expected).toBeGreaterThanOrEqual(590);
      expect(rows[0].expected).toBeLessThanOrEqual(615);
    });
    it("does not flag a short first window as an under-report", async () => {
      await ready(); await age(); usage(10); await coordinator.runOnce();
      expect(await disagreements()).toEqual([]);
    });
  });
});

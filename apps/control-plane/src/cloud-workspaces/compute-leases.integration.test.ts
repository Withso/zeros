import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { Hono } from "hono";
import type { AuthedUser } from "../auth.js";
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
import { computeMicroUsd } from "./provider-compute.js";
import { DatabaseCloudWorkspaceHealthService } from "./health.js";
import { CloudWorkspaceReconciler } from "./reconciler.js";
import { DatabaseCloudProviderOperationStore } from "./provider-operation-store.js";
import { recoverCloudDiagnostic, retainCloudDiagnostic } from "./cloud-diagnostic-store.js";
import { createCloudWorkspaceRoutes } from "./routes.js";
import { stopUnavailableCloudEngine } from "./engine-health.js";

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
    return new CloudWorkspaceComputeLeaseCoordinator({pool: db, providerResolver: originalResolver(db), workosEnabled: false, policy});
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
    expect(lease.last_error_code).toBe("compute_reconciliation_failed");
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
    coordinator=new CloudWorkspaceComputeLeaseCoordinator({pool,providerResolver:resolver(),workosEnabled:false,policy:{...policy,minimumTtlSeconds:60,maximumTtlSeconds:60}});
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
    coordinator = new CloudWorkspaceComputeLeaseCoordinator({ pool,providerResolver:resolver(),workosEnabled:false,policy });
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
  it("wakes only a start that was refused for the unsettled allocation", async () => {
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
  it("stops and defers deletion while usage settlement is pending", async () => {
    await ready();
    provider.stop.mockResolvedValue({ ...resource(), state: "archived" });
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
      const retry = new CloudWorkspaceComputeLeaseCoordinator({pool,providerResolver:resolver(),workosEnabled:false,policy});
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
});

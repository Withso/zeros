import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { runMigrations } from "../migrate.js";
import {
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
  type CloudProviderIdentity,
  type CloudProviderResource,
  type CloudWorkspaceProvider,
} from "./provider.js";
import type { CloudWorkspaceProviderResolver } from "./provider-resolver.js";
import { requestManagedComputeStop } from "./compute-credit-stop.js";
import { computeMicroUsd } from "./provider-compute.js";
import { DatabaseCloudWorkspaceHealthService } from "./health.js";
import { CloudWorkspaceReconciler } from "./reconciler.js";
import { DatabaseCloudProviderOperationStore } from "./provider-operation-store.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("managed compute lifecycle admission", () => {
  let pool: pg.Pool,
    f: ReadyCloudWorkspaceFixture,
    ledger: DatabaseManagedComputeCreditLedger,
    coordinator: CloudWorkspaceComputeLeaseCoordinator;
  let input: ManagedComputeStart, provider: ReturnType<typeof makeProvider>;
  const policy = {
    provider: "daytona",
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
      name: "daytona",
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
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool);
    f = await seedReadyCloudWorkspace(pool);
    await pool.query(
      "UPDATE managed_compute_provider_requirements SET require_credit=true WHERE provider='daytona'",
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
  it("keeps reservations and queues a checkpoint stop when the provider meter fails", async () => {
    await ready();
    await age();
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
    const journal=new DatabaseCloudProviderOperationStore(pool,"daytona","credit-journal-test");
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
      `UPDATE provider_connection_versions SET credential_source='delegated',endpoint='https://app.daytona.io/api',
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

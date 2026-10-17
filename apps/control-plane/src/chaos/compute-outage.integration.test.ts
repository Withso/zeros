import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
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
  seedReadyCloudWorkspace,
  type ReadyCloudWorkspaceFixture,
} from "../cloud-workspaces/test-fixtures.js";
import { DatabaseManagedComputeCreditLedger } from "../cloud-workspaces/compute-credits.js";
import {
  CloudWorkspaceComputeLeaseCoordinator,
  type ManagedComputeStart,
} from "../cloud-workspaces/compute-leases.js";
import {
  CloudProviderError,
  type CloudProviderIdentity,
  type CloudProviderResource,
  type CloudWorkspaceProvider,
} from "../cloud-workspaces/provider.js";
import type { CloudWorkspaceProviderResolver } from "../cloud-workspaces/provider-resolver.js";
import { computeMicroUsd } from "../cloud-workspaces/provider-compute.js";
import { faultInjectingPool } from "./fault-pool.js";

vi.setConfig({ testTimeout: 30_000 });

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("managed compute lease through a database outage and provider waits", () => {
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
  async function expectNoStop() {
    expect((await pool.query("SELECT desired_state FROM cloud_workspaces WHERE id=$1", [f.workspaceId])).rows[0].desired_state).toBe("running");
    expect((await pool.query("SELECT state,stop_intent_id FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId])).rows[0]).toMatchObject({state: "active", stop_intent_id: null});
    expect((await pool.query("SELECT count(*) FROM workspace_checkpoint_requests WHERE workspace_id=$1", [f.workspaceId])).rows[0].count).toBe("0");
    expect((await pool.query("SELECT count(*) FROM cloud_workspace_diagnostic_incidents WHERE operation_id=$1 AND stop_initiated_at IS NOT NULL", [input.intentId])).rows[0].count).toBe("0");
  }
  const fromNow = async () => Number((await pool.query<{ s: string }>(
    "SELECT extract(epoch FROM next_check_at-clock_timestamp()) AS s FROM managed_compute_allocation_leases WHERE id=$1",
    [input.intentId])).rows[0]!.s);

  it("keeps an active allocation and its holds through a database outage that starts mid-check", async () => {
    await ready(); await age();
    const held = (await balance())[0]!.reservedMicroUsd;
    const fault = faultInjectingPool(pool);
    const worker = new CloudWorkspaceComputeLeaseCoordinator({ pool: fault.pool, providerResolver: resolver(), workosEnabled: false, policy });
    provider.inspect.mockImplementationOnce(async () => { fault.down(); return resource(); });
    await expect(worker.runOnce()).rejects.toMatchObject({ code: "database_acquire_unavailable" });
    expect(fault.failures.connects).toBeGreaterThan(0);
    fault.up();
    expect(provider.stop).not.toHaveBeenCalled();
    expect(provider.archive).not.toHaveBeenCalled();
    await expectNoStop();
    expect((await balance())[0]!.reservedMicroUsd).toBe(held);
    // An outage that outlasts the five-minute claim lets another worker take the lease over.
    await pool.query("UPDATE managed_compute_allocation_leases SET lease_expires_at=clock_timestamp()-interval '1 second',next_check_at=clock_timestamp() WHERE id=$1", [input.intentId]);
    expect(await new CloudWorkspaceComputeLeaseCoordinator({ pool, providerResolver: resolver(), workosEnabled: false, policy }).runOnce()).toBe(true);
    await expectNoStop();
    expect((await pool.query("SELECT last_error_code,lease_owner FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId])).rows[0]).toMatchObject({ last_error_code: null, lease_owner: null });
    expect(provider.stop).not.toHaveBeenCalled();
  });

  it("waits out a provider Retry-After before re-checking an active allocation", async () => {
    await ready(); await age();
    provider.inspect.mockRejectedValueOnce(new CloudProviderError("provider_rate_limited", "Boat API request did not succeed", true, { httpStatus: 429, retryAfterMs: 120_000 }));
    await coordinator.runOnce();
    const wait = await fromNow();
    expect(wait).toBeGreaterThanOrEqual(115);
    expect(wait).toBeLessThanOrEqual(125);
    expect((await pool.query<{ state: string }>("SELECT state FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId])).rows[0]!.state).toBe("active");
    await expectNoStop();
  });

  it("waits out a capacity wait on a 503", async () => {
    await ready(); await age();
    provider.inspect.mockRejectedValueOnce(new CloudProviderError("provider_request_failed", "Boat API request did not succeed", true, { httpStatus: 503, retryAfterMs: 30_000 }));
    await coordinator.runOnce();
    const wait = await fromNow();
    expect(wait).toBeGreaterThanOrEqual(26);
    expect(wait).toBeLessThanOrEqual(34);
    expect((await pool.query<{ state: string }>("SELECT state FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId])).rows[0]!.state).toBe("active");
    await expectNoStop();
  });

  it("keeps the 15 s floor when the provider wait is shorter", async () => {
    await ready(); await age();
    provider.inspect.mockRejectedValueOnce(new CloudProviderError("provider_rate_limited", "Boat API request did not succeed", true, { httpStatus: 429, retryAfterMs: 2_000 }));
    await coordinator.runOnce();
    const wait = await fromNow();
    expect(wait).toBeGreaterThanOrEqual(12);
    expect(wait).toBeLessThanOrEqual(18);
  });

  it("never waits past the checkpoint margin for a provider wait", async () => {
    await ready(); await age();
    // Provider deadline 360 s out: the runway bound is 360 - 315 = 45 s.
    await pool.query("UPDATE managed_compute_allocation_leases SET provider_expires_at=clock_timestamp()+interval '360 seconds' WHERE id=$1", [input.intentId]);
    provider.inspect.mockRejectedValueOnce(new CloudProviderError("provider_rate_limited", "Boat API request did not succeed", true, { httpStatus: 429, retryAfterMs: 120_000 }));
    await coordinator.runOnce();
    const wait = await fromNow();
    expect(wait).toBeGreaterThanOrEqual(38);
    expect(wait).toBeLessThanOrEqual(50);
    expect((await pool.query<{ state: string }>("SELECT state FROM managed_compute_allocation_leases WHERE id=$1", [input.intentId])).rows[0]!.state).toBe("active");
  });
});

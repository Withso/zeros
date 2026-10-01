import { randomBytes, randomUUID } from "node:crypto";
import { Hono } from "hono";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthedUser } from "../auth.js";
import { HttpError } from "../authz.js";
import type { CloudWorkspaceBackendConfig } from "../config.js";
import { withSystemTx, withUserTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { DatabaseManagedComputeCreditLedger } from "./compute-credits.js";
import { lockComputeUserFunding, prepareComputeUserPeriods } from "./compute-funding.js";
import { CloudWorkspaceComputeLeaseCoordinator, type ManagedComputeStart } from "./compute-leases.js";
import { DatabaseProMonthlyAllowance, PRO_STANDARD_SECONDS, readProComputeUsage } from "./pro-allowance.js";
import { computeMicroUsd } from "./provider-compute.js";
import type { CloudWorkspaceProviderResolver } from "./provider-resolver.js";
import type { CloudWorkspaceProvider } from "./provider.js";
import { createCloudWorkspaceRoutes } from "./routes.js";
import { seedReadyCloudWorkspace, type ReadyCloudWorkspaceFixture } from "./test-fixtures.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const policy = {
  provider: "daytona", policyId: "staff-compute-test-v1", secondsPerDollar: 100_000,
  minimumTtlSeconds: 600, maximumTtlSeconds: 900, requestMarginSeconds: 60,
};
const standardAmount = computeMicroUsd(PRO_STANDARD_SECONDS, policy.secondsPerDollar);

suite("uncapped staff machine-hour funding", () => {
  let admin: pg.Pool, runtime: pg.Pool, ledger: DatabaseManagedComputeCreditLedger;
  let fixture: ReadyCloudWorkspaceFixture, allowance: DatabaseProMonthlyAllowance;
  const runtimeRole = `staff_runtime_${randomUUID().replaceAll("-", "")}`;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8 });
    await admin.query(`CREATE ROLE ${runtimeRole} LOGIN NOINHERIT`);
    await admin.query(`GRANT zeros_app TO ${runtimeRole}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.username = runtimeRole;
    runtime = new pg.Pool({ connectionString: url.toString(), max: 8 });
    ledger = new DatabaseManagedComputeCreditLedger({ pool: runtime, workosEnabled: false });
    allowance = new DatabaseProMonthlyAllowance(runtime, policy);
  });
  afterAll(async () => {
    await runtime?.end();
    await admin?.query(`DROP ROLE ${runtimeRole}`);
    await admin?.end();
  });
  beforeEach(async () => {
    await resetMigratedTestDatabase(admin);
    fixture = await seedReadyCloudWorkspace(admin);
    await configure(fixture);
    const anchor = new Date(Date.now() - 25 * 86_400_000);
    await admin.query("UPDATE account_entitlements SET valid_from=$2,valid_until=clock_timestamp()+interval '1 year' WHERE user_id=$1", [fixture.userId, anchor]);
    await admin.query("UPDATE managed_compute_pro_accounts SET anchor_at=$2 WHERE user_id=$1", [fixture.userId, anchor]);
  });

  async function configure(target: ReadyCloudWorkspaceFixture) {
    await admin.query("UPDATE organization_entitlements SET plan='pro',seat_limit=NULL WHERE org_id=$1", [target.organizationId]);
    await admin.query("UPDATE workspace_billing_epochs SET entitlement_scope='account',entitlement_plan='pro' WHERE workspace_id=$1", [target.workspaceId]);
    await admin.query("UPDATE managed_compute_provider_requirements SET require_credit=true WHERE provider='daytona'");
    await admin.query("UPDATE cloud_workspace_provider_bindings SET provider_resource_id=NULL WHERE workspace_id=$1", [target.workspaceId]);
    await admin.query(`INSERT INTO cloud_workspace_quotas(org_id,max_workspaces,max_running_workspaces,max_cpu_millicores,max_memory_mib,max_storage_mib)
      VALUES($1,2,2,8000,16384,40960) ON CONFLICT(org_id) DO NOTHING`, [target.organizationId]);
  }

  async function child(target = fixture) {
    const issued = await allowance.ensure(target.userId);
    expect(issued.state).toBe("ready");
    await withSystemTx(runtime, async transaction => {
      await lockComputeUserFunding(transaction, target.userId);
      await prepareComputeUserPeriods(transaction, { userId: target.userId, organizationId: target.organizationId });
    });
    return (await admin.query("SELECT * FROM managed_compute_credit_periods WHERE org_id=$1 AND funding_period_id=$2", [target.organizationId, issued.periodId])).rows[0];
  }

  async function exhaust(target = fixture) {
    const period = await child(target);
    const reservationId = randomUUID();
    const until = new Date(period.starts_at.getTime() + PRO_STANDARD_SECONDS * 1000);
    await ledger.reserve({
      organizationId: target.organizationId, workspaceId: target.workspaceId, generation: 1, billingEpoch: 1,
      reservationId, policyId: policy.policyId, secondsPerDollar: policy.secondsPerDollar,
      allocations: [{ periodId: period.id, meterSince: period.starts_at, coveredUntil: until, authorizationMicroUsd: standardAmount }],
    });
    await admin.query("UPDATE cloud_workspace_provider_bindings SET provider_resource_id=$2 WHERE workspace_id=$1", [target.workspaceId, `sandbox-${target.workspaceId}`]);
    await ledger.meter({
      reservationId, periodId: period.id,
      usage: { resourceId: `sandbox-${target.workspaceId}`, since: period.starts_at.toISOString(), until: until.toISOString(),
        billableSeconds: PRO_STANDARD_SECONDS, secondsPerDollar: policy.secondsPerDollar, listPriceMicroUsd: standardAmount, running: false },
      finalReason: "allocation_stopped",
    });
    await admin.query("UPDATE cloud_workspace_provider_bindings SET provider_resource_id=NULL WHERE workspace_id=$1", [target.workspaceId]);
    return period;
  }

  async function machine(target = fixture, existingIntentId?: string) {
    const intentId = existingIntentId ?? randomUUID();
    if (!existingIntentId) await admin.query(`INSERT INTO cloud_workspace_lifecycle_intents(id,workspace_id,generation,org_id,requested_by,operation,idempotency_key,request_sha256)
      VALUES($1,$2,1,$3,$4,'create',$5,$6)`, [intentId, target.workspaceId, target.organizationId, target.userId, randomUUID(), randomBytes(32)]);
    const input: ManagedComputeStart = {
      workspaceId: target.workspaceId, organizationId: target.organizationId, generation: 1, intentId, idempotencyKey: intentId,
      imageRef: "staff-test-image", architecture: "linux/amd64", cpuMillicores: 4000, memoryMiB: 8192, storageMiB: 20480,
    };
    const resource = (ttl = 900) => ({ workspaceId: target.workspaceId, generation: 1, resourceId: `sandbox-${target.workspaceId}`,
      state: "running" as const, target: null, metadata: { computeLeaseExpiresAt: new Date(Date.now() + ttl * 1000).toISOString() } });
    const provider = {
      name: "daytona", create: vi.fn(async () => resource()), start: vi.fn(async () => resource()),
      computeWeight: vi.fn(() => ({ numerator: 1, denominator: 1 })),
      createWithComputeLease: vi.fn(async (_input: ManagedComputeStart, ttl: number) => resource(ttl)),
      startWithComputeLease: vi.fn(async (_resource: string, ttl: number) => resource(ttl)),
      renewComputeLease: vi.fn(async (_resource: string, ttl: number) => ({ expiresAt: new Date(Date.now() + ttl * 1000).toISOString() })),
      readComputeUsage: vi.fn(async (resourceId: string, window: { since: Date; until: Date }) => ({ resourceId,
        since: window.since.toISOString(), until: window.until.toISOString(), billableSeconds: 600,
        secondsPerDollar: policy.secondsPerDollar, listPriceMicroUsd: 6000, running: true })),
      inspect: vi.fn(async () => resource(360)), find: vi.fn(async () => [resource()]),
      verifyAbsence: vi.fn(async () => false), stop: vi.fn(), archive: vi.fn(), delete: vi.fn(),
    };
    const coordinator = new CloudWorkspaceComputeLeaseCoordinator({ pool: runtime, workosEnabled: false, policy,
      providerResolver: { resolve: async () => ({ provider }) } as unknown as CloudWorkspaceProviderResolver });
    return { input, provider, coordinator,
      start: () => coordinator.allocate(input, provider as unknown as CloudWorkspaceProvider, null) };
  }

  async function http() {
    const account = await withSystemTx(runtime, async transaction => (await transaction.query<{
      email: string; display_name: string | null; auth_revision: string;
      auth_status: AuthedUser["accountStatus"]; staff_role: AuthedUser["staffRole"];
    }>("SELECT email,display_name,auth_revision,auth_status,staff_role FROM users WHERE id=$1", [fixture.userId])).rows[0]!);
    const actor: AuthedUser = {
      id: fixture.userId, identity: { provider: "workos", subject: `workos|${fixture.userId}` },
      email: account.email, displayName: account.display_name, avatarUrl: null, accountRevision: Number(account.auth_revision),
      accountStatus: account.auth_status, staffRole: account.staff_role,
      authentication: { sessionId: null, clientKind: "legacy", authTime: null, tokenExpiresAt: null },
    };
    const config: CloudWorkspaceBackendConfig = {
      provider: "daytona", computePolicy: policy, apiKey: "placeholder", apiUrl: "https://api.example.test", target: "test",
      snapshotId: "staff-test-image", imageRef: "staff-test-image", architecture: "linux/amd64",
      cpuMillicores: 4000, memoryMiB: 8192, storageMiB: 20480, sourceCommit: null,
      operationTimeoutSeconds: 30, autoArchiveMinutes: 10080, reconcileIntervalMs: 1000,
      providerCredentialKeys: {}, settingsSecretEncryptionKeys: {}, currentSettingsSecretEncryptionKeyVersion: null,
      settingsSecretKeyV1: null, access: { allowedSshHosts: [], allowedPreviewHostSuffixes: [], previewBaseDomain: null },
      durability: null, outbox: null, setupExecution: null,
    };
    const app = new Hono();
    app.use("*", async (context, next) => { context.set("user", actor); await next(); });
    app.route("/", createCloudWorkspaceRoutes(runtime, config, { workosEnabled: false }));
    app.onError((error, context) => {
      if (error instanceof HttpError) return context.json({ error: { code: error.code } }, error.status);
      throw error;
    });
    return app;
  }

  async function totals() {
    return (await admin.query(`SELECT root.granted_micro_usd::text AS granted,coalesce(usage.debited,0)::text AS debited,
      coalesce(usage.reserved,0)::text AS reserved,coalesce(receipts.total,0)::text AS receipts,receipts.count::int AS receipt_count
      FROM managed_compute_user_periods root
      LEFT JOIN LATERAL(SELECT sum(debited_micro_usd) AS debited,sum(reserved_micro_usd) AS reserved
        FROM managed_compute_credit_periods WHERE funding_period_id=root.id) usage ON true
      LEFT JOIN LATERAL(SELECT sum(amount_micro_usd) AS total,count(*) AS count FROM (
        SELECT amount_micro_usd FROM managed_compute_funding_receipts WHERE period_id=root.id
        UNION ALL SELECT amount_micro_usd FROM managed_compute_staff_allowance_receipts WHERE funding_period_id=root.id
      ) recorded) receipts ON true
      WHERE root.user_id=$1 ORDER BY root.starts_at`, [fixture.userId])).rows;
  }

  async function bindAndAge(running: Awaited<ReturnType<typeof machine>>) {
    await admin.query("UPDATE cloud_workspace_provider_bindings SET provider_resource_id=$2 WHERE workspace_id=$1", [running.input.workspaceId, `sandbox-${running.input.workspaceId}`]);
    await admin.query("UPDATE managed_compute_allocation_leases SET requested_at=requested_at-interval '10 minutes',next_check_at=clock_timestamp() WHERE id=$1", [running.input.intentId]);
    await admin.query("UPDATE managed_compute_credit_reservations SET meter_since=meter_since-interval '10 minutes',meter_through=meter_through-interval '10 minutes' WHERE id=$1", [running.input.intentId]);
  }

  it.each(["developer", "platform_owner"])("funds exact finite lease demand beyond 500 hours for active %s", async staffRole => {
    await admin.query("UPDATE users SET staff_role=$2::staff_role WHERE id=$1", [fixture.userId, staffRole]);
    await exhaust();
    const running = await machine();
    await expect(running.start()).resolves.toMatchObject({ state: "running" });
    expect(running.provider.createWithComputeLease).toHaveBeenCalledWith(expect.objectContaining({ cpuMillicores: 4000, memoryMiB: 8192 }), 900);
    const [total] = await totals();
    expect(Number(total.granted)).toBe(standardAmount + Number(total.reserved));
    expect(total.receipts).toBe(total.granted);
    expect(total.debited).toBe(String(standardAmount));
    expect(total.receipt_count).toBe(2);
    expect(Number(total.reserved)).toBeLessThanOrEqual(10_000);
  });

  it("serializes concurrent cross-organization requests on the same user's demand ledger", async () => {
    await exhaust();
    const other = await seedReadyCloudWorkspace(admin, { ownerUserId: fixture.userId });
    await configure(other);
    const first = await machine(), second = await machine(other);
    await expect(Promise.all([first.start(), second.start()])).resolves.toHaveLength(2);
    const [total] = await totals();
    expect(total.receipt_count).toBe(3);
    expect(Number(total.granted)).toBe(standardAmount + Number(total.reserved));
    expect(total.receipts).toBe(total.granted);
    expect((await admin.query("SELECT count(DISTINCT org_id)::int AS count FROM managed_compute_credit_reservations WHERE state='open'")).rows[0].count).toBe(2);
    expect((await admin.query("SELECT DISTINCT user_id FROM managed_compute_funding_receipts")).rows).toEqual([{ user_id: fixture.userId }]);
  });

  it("funds staff without a separately paid Pro entitlement", async () => {
    await admin.query("UPDATE account_entitlements SET status='expired',revision=revision+1 WHERE user_id=$1", [fixture.userId]);
    await withSystemTx(runtime, transaction => transaction.query(`UPDATE workspace_billing_epochs
      SET entitlement_revision=(SELECT revision FROM cloud_workspace_pro_entitlement($1)) WHERE workspace_id=$2`, [fixture.userId, fixture.workspaceId]));
    await exhaust();
    const running = await machine();
    await expect(running.start()).resolves.toMatchObject({ state: "running" });
    const [total] = await totals();
    expect(total.receipts).toBe(total.granted);
    expect(Number(total.granted)).toBe(standardAmount + Number(total.reserved));
    expect(await readProComputeUsage(runtime, fixture.userId)).toMatchObject({ state: "ready", availablePercent: 0 });
  });

  it.each(["developer", "platform_owner"])("preserves HTTP start capability and admits an exhausted %s's queued wake", async staffRole => {
    await admin.query("UPDATE users SET staff_role=$2::staff_role WHERE id=$1", [fixture.userId, staffRole]);
    await exhaust();
    await admin.query("UPDATE cloud_workspaces SET status='stopped',desired_state='stopped' WHERE id=$1", [fixture.workspaceId]);
    const app = await http();
    const response = await app.request(`/v1/cloud-workspaces/${fixture.workspaceId}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.workspace.capabilities).toMatchObject({ canStart: true, startUnavailableReason: null });
    expect(JSON.stringify(body)).not.toMatch(/MicroUsd|Percent|staff_allowance|staff_revision/);
    const wake = await app.request(`/v1/organizations/${fixture.organizationId}/cloud-workspaces/${fixture.workspaceId}/wake`, {
      method: "POST", headers: { "Idempotency-Key": randomUUID() },
    });
    const queued = await wake.json();
    expect(wake.status, queued.error?.code).toBe(202);
    const running = await machine(fixture, queued.lifecycleIntentId);
    await expect(running.start()).resolves.toMatchObject({ state: "running" });
    expect(running.provider.createWithComputeLease).toHaveBeenCalledTimes(1);
    expect((await totals())[0].receipt_count).toBe(2);
  });

  it("keeps HTTP start capability pending until a real monthly period exists", async () => {
    await admin.query("UPDATE cloud_workspaces SET status='stopped',desired_state='stopped' WHERE id=$1", [fixture.workspaceId]);
    const app = await http();
    const response = await app.request(`/v1/cloud-workspaces/${fixture.workspaceId}`);
    expect(response.status).toBe(200);
    expect((await response.json()).workspace.capabilities).toMatchObject({ canStart: false, startUnavailableReason: "allowance_pending" });
    expect(await totals()).toEqual([]);
  });

  it("retains infrastructure quota rejection for an exhausted staff sponsor", async () => {
    await exhaust();
    await admin.query("UPDATE cloud_workspaces SET status='stopped',desired_state='stopped' WHERE id=$1", [fixture.workspaceId]);
    await admin.query("UPDATE cloud_workspace_quotas SET max_cpu_millicores=250 WHERE org_id=$1", [fixture.organizationId]);
    const app = await http();
    const wake = await app.request(`/v1/organizations/${fixture.organizationId}/cloud-workspaces/${fixture.workspaceId}/wake`, {
      method: "POST", headers: { "Idempotency-Key": randomUUID() },
    });
    expect(wake.status).toBe(409);
    expect(await wake.json()).toMatchObject({ error: { code: "cloud_quota_exceeded" } });
    expect(await totals()).toMatchObject([{ granted: String(standardAmount), receipt_count: 1 }]);
    expect((await admin.query("SELECT 1 FROM managed_compute_allocation_leases WHERE user_id=$1", [fixture.userId])).rowCount).toBe(0);
  });

  it("does not grant or debit again when an identical reservation is replayed concurrently", async () => {
    await exhaust();
    const running = await machine();
    await running.start();
    const before = await totals();
    const reservation = (await admin.query("SELECT * FROM managed_compute_credit_reservations WHERE id=$1", [running.input.intentId])).rows[0];
    const request = { organizationId: fixture.organizationId, workspaceId: fixture.workspaceId, generation: 1, billingEpoch: 1,
      reservationId: running.input.intentId, policyId: policy.policyId, secondsPerDollar: policy.secondsPerDollar,
      allocations: [{ periodId: reservation.period_id, meterSince: reservation.meter_since,
        coveredUntil: reservation.covered_until, authorizationMicroUsd: Number(reservation.authorized_micro_usd) }] };
    await Promise.all([ledger.reserve(request), ledger.reserve(request)]);
    expect(await totals()).toEqual(before);
  });

  it("renews with metered user-owned accounting beyond the original allowance", async () => {
    await exhaust();
    const running = await machine();
    await running.start();
    await bindAndAge(running);
    expect(await running.coordinator.runOnce()).toBe(true);
    expect(running.provider.renewComputeLease).toHaveBeenCalledWith(`sandbox-${fixture.workspaceId}`, 900);
    const [total] = await totals();
    expect(Number(total.debited)).toBe(standardAmount + 6000);
    expect(Number(total.granted)).toBe(Number(total.debited) + Number(total.reserved));
    expect(total.receipts).toBe(total.granted);
    expect(total.receipt_count).toBe(3);
  });

  it("funds only the exhausted boundary segment and issues the next monthly receipt once", async () => {
    const anchor = new Date(Date.now() + 20_000);
    anchor.setUTCMonth(anchor.getUTCMonth() - 1);
    await admin.query("UPDATE account_entitlements SET valid_from=$2 WHERE user_id=$1", [fixture.userId, anchor]);
    await admin.query("UPDATE managed_compute_pro_accounts SET anchor_at=$2 WHERE user_id=$1", [fixture.userId, anchor]);
    await exhaust();
    const running = await machine();
    await running.start();
    await Promise.all([allowance.ensure(fixture.userId), allowance.ensure(fixture.userId)]);
    const periods = await totals();
    expect(periods).toHaveLength(2);
    expect(periods[0].receipt_count).toBe(2);
    expect(Number(periods[0].granted)).toBe(standardAmount + Number(periods[0].reserved));
    expect(periods[1].receipt_count).toBe(1);
    expect(periods[1].granted).toBe(String(standardAmount));
    expect(Number(periods[1].reserved)).toBeGreaterThan(0);
  });

  it("keeps ordinary paid Pro capped at 500 hours", async () => {
    await admin.query("UPDATE users SET staff_role=NULL WHERE id=$1", [fixture.userId]);
    await exhaust();
    const running = await machine();
    await expect(running.start()).rejects.toMatchObject({ code: "compute_credit_exhausted" });
    expect(running.provider.createWithComputeLease).not.toHaveBeenCalled();
    expect(await totals()).toMatchObject([{ granted: String(standardAmount), receipt_count: 1, reserved: "0" }]);
    await admin.query("UPDATE cloud_workspaces SET status='stopped',desired_state='stopped' WHERE id=$1", [fixture.workspaceId]);
    const app = await http();
    const response = await app.request(`/v1/cloud-workspaces/${fixture.workspaceId}`);
    expect(response.status).toBe(200);
    expect((await response.json()).workspace.capabilities).toMatchObject({ canStart: false, startUnavailableReason: "allowance_exhausted" });
  });

  it.each(["staff", "benefit", "suspended", "deleted"])("withdraws demand funding on live %s revocation even with separately paid Pro", async revocation => {
    const other = await seedReadyCloudWorkspace(admin, { ownerUserId: fixture.userId });
    await configure(other);
    await exhaust();
    const running = await machine();
    await running.start();
    await bindAndAge(running);
    if (revocation === "staff") await admin.query("UPDATE users SET staff_role=NULL WHERE id=$1", [fixture.userId]);
    if (revocation === "benefit") await admin.query("UPDATE staff_pro_benefits SET revoked_at=clock_timestamp(),revision=revision+1 WHERE user_id=$1", [fixture.userId]);
    if (revocation === "suspended") await admin.query("UPDATE users SET auth_status='suspended',auth_revision=auth_revision+1 WHERE id=$1", [fixture.userId]);
    if (revocation === "deleted") await admin.query("UPDATE users SET auth_status='deleted',deleted_at=clock_timestamp(),auth_revision=auth_revision+1 WHERE id=$1", [fixture.userId]);
    const before = (await totals()).map(total => total.granted);
    expect(await running.coordinator.runOnce()).toBe(true);
    expect(running.provider.renewComputeLease).not.toHaveBeenCalled();
    expect((await admin.query("SELECT state FROM managed_compute_allocation_leases WHERE id=$1", [running.input.intentId])).rows[0].state).toBe("draining");
    if (revocation === "deleted") expect((await admin.query("SELECT desired_state FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0].desired_state).toBe("deleted");
    expect((await totals()).map(total => total.granted)).toEqual(before);
    const next = await machine(other);
    await expect(next.start()).rejects.toBeDefined();
    expect(next.provider.createWithComputeLease).not.toHaveBeenCalled();
  });

  it("cannot spend returned staff extensions after demotion with paid Pro still active", async () => {
    await exhaust();
    const running = await machine();
    await running.start();
    const period = (await admin.query("SELECT period_id FROM managed_compute_credit_reservations WHERE id=$1", [running.input.intentId])).rows[0].period_id;
    await ledger.releaseUnallocated({ reservationId: running.input.intentId, periodId: period });
    await admin.query("UPDATE users SET staff_role=NULL WHERE id=$1", [fixture.userId]);
    const before = await totals();
    const original = (await admin.query("SELECT starts_at,ends_at FROM managed_compute_credit_periods WHERE id=$1", [period])).rows[0];
    await expect(ledger.reserve({ organizationId: fixture.organizationId, workspaceId: fixture.workspaceId, generation: 1, billingEpoch: 1,
      reservationId: randomUUID(), policyId: policy.policyId, secondsPerDollar: policy.secondsPerDollar,
      allocations: [{ periodId: period, meterSince: new Date(), coveredUntil: new Date(Date.now() + 60_000), authorizationMicroUsd: 600 }] })).rejects.toMatchObject({ code: "compute_credit_exhausted" });
    expect(await totals()).toEqual(before);
    expect(original.ends_at.getTime()).toBeGreaterThan(Date.now());
    expect(await readProComputeUsage(runtime, fixture.userId)).toMatchObject({ state: "exhausted", usedPercent: 100, availablePercent: 0 });
  });

  it("does not advertise returned staff funding as ordinary paid Pro start capacity after demotion", async () => {
    await exhaust();
    const running = await machine();
    await running.start();
    const periodId = (await admin.query("SELECT period_id FROM managed_compute_credit_reservations WHERE id=$1", [running.input.intentId])).rows[0].period_id;
    await ledger.releaseUnallocated({ reservationId: running.input.intentId, periodId });
    await admin.query("UPDATE users SET staff_role=NULL WHERE id=$1", [fixture.userId]);
    await admin.query("UPDATE cloud_workspaces SET status='stopped',desired_state='stopped' WHERE id=$1", [fixture.workspaceId]);
    const app = await http();
    const response = await app.request(`/v1/cloud-workspaces/${fixture.workspaceId}`);
    expect(response.status).toBe(200);
    expect((await response.json()).workspace.capabilities).toMatchObject({ canStart: false, startUnavailableReason: "allowance_exhausted" });
  });

  it("withdraws renewal from concurrent active workspaces in different Organizations after demotion", async () => {
    await exhaust();
    const other = await seedReadyCloudWorkspace(admin, { ownerUserId: fixture.userId });
    await configure(other);
    const first = await machine(), second = await machine(other);
    await Promise.all([first.start(), second.start()]);
    await Promise.all([bindAndAge(first), bindAndAge(second)]);
    const providers = new Map([[first.input.workspaceId, first.provider], [second.input.workspaceId, second.provider]]);
    const worker = () => new CloudWorkspaceComputeLeaseCoordinator({ pool: runtime, workosEnabled: false, policy,
      providerResolver: { resolve: async ({ workspaceId }: { workspaceId: string }) => ({ provider: providers.get(workspaceId) }) } as unknown as CloudWorkspaceProviderResolver });
    await admin.query("UPDATE users SET staff_role=NULL WHERE id=$1", [fixture.userId]);
    const before = await totals();
    expect(await Promise.all([worker().runOnce(), worker().runOnce()])).toEqual([true, true]);
    expect(first.provider.renewComputeLease).not.toHaveBeenCalled();
    expect(second.provider.renewComputeLease).not.toHaveBeenCalled();
    expect((await admin.query("SELECT state FROM managed_compute_allocation_leases WHERE user_id=$1", [fixture.userId])).rows).toEqual([{ state: "draining" }, { state: "draining" }]);
    expect((await totals()).map(total => [total.granted, total.receipt_count])).toEqual(before.map(total => [total.granted, total.receipt_count]));
    expect(await readProComputeUsage(runtime, fixture.userId)).toMatchObject({ state: "exhausted", availablePercent: 0 });
  });

  it("requires a real bounded allocation lease before a staff-only demand receipt can be issued", async () => {
    const period = await exhaust();
    const before = await totals();
    await expect(ledger.reserve({ organizationId: fixture.organizationId, workspaceId: fixture.workspaceId, generation: 1, billingEpoch: 1,
      reservationId: randomUUID(), policyId: policy.policyId, secondsPerDollar: policy.secondsPerDollar,
      allocations: [{ periodId: period.id, meterSince: new Date(), coveredUntil: new Date(Date.now() + 60_000), authorizationMicroUsd: 1_000_000_000 }] })).rejects.toBeDefined();
    expect(await totals()).toEqual(before);
  });

  it("rejects inflated demand even with the correct live allocation claim", async () => {
    await exhaust();
    const running = await machine();
    await running.start();
    const prior = (await admin.query("SELECT * FROM managed_compute_credit_reservations WHERE id=$1", [running.input.intentId])).rows[0];
    await admin.query("UPDATE managed_compute_allocation_leases SET lease_owner='staff-test-claim',lease_expires_at=clock_timestamp()+interval '5 minutes' WHERE id=$1", [running.input.intentId]);
    const before = await totals();
    await expect(ledger.reserve({ organizationId: fixture.organizationId, workspaceId: fixture.workspaceId, generation: 1, billingEpoch: 1,
      reservationId: running.input.intentId, policyId: policy.policyId, secondsPerDollar: policy.secondsPerDollar, allocationLeaseClaim: { owner: "staff-test-claim" },
      allocations: [{ periodId: prior.period_id, meterSince: prior.meter_since, coveredUntil: new Date(prior.covered_until.getTime() + 60_000), authorizationMicroUsd: 1_000_000_000 }] })).rejects.toMatchObject({ code: "compute_credit_staff_demand_rejected" });
    expect(await totals()).toEqual(before);
  });

  it("rejects a correctly priced staff claim beyond the maximum finite horizon", async () => {
    await exhaust();
    const running = await machine();
    await running.start();
    const prior = (await admin.query("SELECT * FROM managed_compute_credit_reservations WHERE id=$1", [running.input.intentId])).rows[0];
    await admin.query("UPDATE managed_compute_allocation_leases SET lease_owner='staff-test-claim',lease_expires_at=clock_timestamp()+interval '5 minutes' WHERE id=$1", [running.input.intentId]);
    const before = await totals(), coveredUntil = new Date(Date.now() + 5_500_000);
    const authorization = computeMicroUsd(Math.ceil((coveredUntil.getTime() - prior.meter_through.getTime()) / 1000), policy.secondsPerDollar);
    await expect(ledger.reserve({ organizationId: fixture.organizationId, workspaceId: fixture.workspaceId, generation: 1, billingEpoch: 1,
      reservationId: running.input.intentId, policyId: policy.policyId, secondsPerDollar: policy.secondsPerDollar, allocationLeaseClaim: { owner: "staff-test-claim" },
      allocations: [{ periodId: prior.period_id, meterSince: prior.meter_since, coveredUntil, authorizationMicroUsd: authorization }] })).rejects.toMatchObject({ code: "compute_credit_staff_demand_rejected" });
    expect(await totals()).toEqual(before);
  });

  it("rolls back a demand receipt and grant if a later reservation segment fails", async () => {
    await exhaust();
    const running = await machine();
    await running.start();
    const prior = (await admin.query("SELECT * FROM managed_compute_credit_reservations WHERE id=$1", [running.input.intentId])).rows[0];
    await admin.query("UPDATE managed_compute_allocation_leases SET lease_owner='staff-test-claim',lease_expires_at=clock_timestamp()+interval '5 minutes' WHERE id=$1", [running.input.intentId]);
    const before = await totals();
    await expect(ledger.reserve({ organizationId: fixture.organizationId, workspaceId: fixture.workspaceId, generation: 1, billingEpoch: 1,
      reservationId: running.input.intentId, policyId: policy.policyId, secondsPerDollar: policy.secondsPerDollar, allocationLeaseClaim: { owner: "staff-test-claim" },
      allocations: [{ periodId: prior.period_id, meterSince: prior.meter_since, coveredUntil: new Date(prior.covered_until.getTime() + 60_000), authorizationMicroUsd: Number(prior.authorized_micro_usd) + 600 },
        { periodId: "ffffffff-ffff-ffff-ffff-ffffffffffff", meterSince: new Date(), coveredUntil: new Date(Date.now() + 60_000), authorizationMicroUsd: 600 }] })).rejects.toMatchObject({ code: "compute_credit_period_unavailable" });
    expect(await totals()).toEqual(before);
  });

  it("rechecks staff after forecasting and before granting or allocating", async () => {
    await exhaust();
    const running = await machine();
    const original = DatabaseManagedComputeCreditLedger.prototype.reserve;
    const intercepted = vi.spyOn(DatabaseManagedComputeCreditLedger.prototype, "reserve").mockImplementationOnce(async function (request) {
      await admin.query("UPDATE users SET staff_role=NULL WHERE id=$1", [fixture.userId]);
      return original.call(this, request);
    });
    try {
      await expect(running.start()).rejects.toMatchObject({ code: "compute_credit_exhausted" });
      expect(running.provider.createWithComputeLease).not.toHaveBeenCalled();
      expect(await totals()).toMatchObject([{ granted: String(standardAmount), receipt_count: 1, reserved: "0" }]);
    } finally { intercepted.mockRestore(); }
  });

  it("rechecks staff again after funding before dispatching paid compute", async () => {
    await exhaust();
    const running = await machine();
    const original = DatabaseManagedComputeCreditLedger.prototype.reserve;
    const intercepted = vi.spyOn(DatabaseManagedComputeCreditLedger.prototype, "reserve").mockImplementationOnce(async function (request) {
      const result = await original.call(this, request);
      await admin.query("UPDATE users SET staff_role=NULL WHERE id=$1", [fixture.userId]);
      return result;
    });
    try {
      await expect(running.start()).rejects.toMatchObject({ code: "compute_lease_superseded" });
      expect(running.provider.createWithComputeLease).not.toHaveBeenCalled();
      expect(await readProComputeUsage(runtime, fixture.userId)).toMatchObject({ state: "exhausted", availablePercent: 0 });
    } finally { intercepted.mockRestore(); }
  });

  it("keeps staff receipts immutable and invisible to customer runtime contexts", async () => {
    await exhaust();
    const running = await machine();
    await running.start();
    const before = await totals();
    const modified = await withSystemTx(runtime, transaction => transaction.query("UPDATE managed_compute_staff_allowance_receipts SET amount_micro_usd=amount_micro_usd+1 RETURNING id"));
    const removed = await withSystemTx(runtime, transaction => transaction.query("DELETE FROM managed_compute_staff_allowance_receipts WHERE user_id=$1 RETURNING id", [fixture.userId]));
    expect(modified.rowCount).toBe(0);
    expect(removed.rowCount).toBe(0);
    await expect(withSystemTx(runtime, transaction => transaction.query("TRUNCATE managed_compute_staff_allowance_receipts"))).rejects.toMatchObject({ code: "42501" });
    expect((await withUserTx(runtime, fixture.userId, transaction => transaction.query("SELECT * FROM managed_compute_staff_allowance_receipts"))).rowCount).toBe(0);
    expect(await totals()).toEqual(before);
    await admin.query("UPDATE users SET staff_role=NULL WHERE id=$1", [fixture.userId]);
    await admin.query("UPDATE managed_compute_allocation_leases SET lease_owner='staff-test-claim',lease_expires_at=clock_timestamp()+interval '5 minutes' WHERE id=$1", [running.input.intentId]);
    const receipt = (await admin.query("SELECT * FROM managed_compute_staff_allowance_receipts")).rows[0];
    await expect(withSystemTx(runtime, transaction => transaction.query(`INSERT INTO managed_compute_staff_allowance_receipts(id,funding_period_id,user_id,child_period_id,allocation_lease_id,
      allocation_claim_owner,staff_revision,amount_micro_usd,grant_after_micro_usd,request_sha256) VALUES($1,$2,$3,$4,$5,'staff-test-claim',$6,1,$7,$8)`,
      [randomUUID(), receipt.funding_period_id, fixture.userId, receipt.child_period_id, running.input.intentId, receipt.staff_revision, Number(receipt.grant_after_micro_usd) + 1, randomBytes(32)]))).rejects.toMatchObject({ code: "42501" });
  });

  it("cannot self-promote or read another funding ledger with customer runtime authority", async () => {
    await child();
    await expect(withUserTx(runtime, fixture.userId, transaction => transaction.query("UPDATE users SET staff_role='platform_owner' WHERE id=$1", [fixture.userId]))).rejects.toMatchObject({ code: "42501" });
    const visible = await withUserTx(runtime, fixture.userId, transaction => transaction.query("SELECT * FROM managed_compute_funding_receipts"));
    expect(visible.rowCount).toBe(0);
    await expect(runtime.query("SELECT * FROM public.managed_compute_staff_allowance_receipts")).rejects.toMatchObject({ code: "42501" });
    expect(await withSystemTx(runtime, async transaction => (await transaction.query("SELECT current_user AS role")).rows[0].role)).toBe("zeros_app");
  });
});

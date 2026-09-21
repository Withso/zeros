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
import { withSystemTx, withUserTx } from "../db.js";
import { runMigrations } from "../migrate.js";
import {
  seedReadyCloudWorkspace,
  type ReadyCloudWorkspaceFixture,
} from "./test-fixtures.js";
import { DatabaseManagedComputeCreditLedger } from "./compute-credits.js";
import { computeMicroUsd } from "./provider-compute.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("managed compute credit ledger", () => {
  let pool: pg.Pool,
    f: ReadyCloudWorkspaceFixture,
    ledger: DatabaseManagedComputeCreditLedger,
    now: number;
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
    now = Date.now();
    ledger = new DatabaseManagedComputeCreditLedger({
      pool,
      workosEnabled: false,
    });
  });
  const account = () => ({
    organizationId: f.organizationId,
    userId: f.userId,
  });
  const grant = (amountMicroUsd = 20_000, changes = {}) =>
    ledger.grant({
      ...account(),
      startsAt: new Date(now - 3600_000),
      endsAt: new Date(now + 3600_000),
      amountMicroUsd,
      policyId: "seat-credit-v1",
      idempotencyKey: randomUUID(),
      ...changes,
    });
  const allocation = (periodId: string, authorizationMicroUsd = 10_000) => ({
    periodId,
    authorizationMicroUsd,
    meterSince: new Date(now - 600_000),
    coveredUntil: new Date(now + 600_000),
  });
  const reserve = (periodId: string, amount = 10_000, changes = {}) =>
    ledger.reserve({
      organizationId: f.organizationId,
      workspaceId: f.workspaceId,
      generation: 1,
      billingEpoch: 1,
      reservationId: randomUUID(),
      policyId: "allocated-time-v1",
      secondsPerDollar: 100_000,
      allocations: [allocation(periodId, amount)],
      ...changes,
    });
  const usage = (seconds = 50, changes = {}) => ({
    resourceId: `sandbox-${f.workspaceId}`,
    since: new Date(now - 600_000).toISOString(),
    until: new Date(now - 600_000 + seconds * 1000).toISOString(),
    billableSeconds: seconds,
    secondsPerDollar: 100_000,
    listPriceMicroUsd: computeMicroUsd(seconds, 100_000),
    running: true,
    ...changes,
  });

  it("requires user-wide funding instead of minting independent Pro organization allowances",async()=>{
    await pool.query("UPDATE organization_entitlements SET plan='pro',seat_limit=NULL WHERE org_id=$1",[f.organizationId]);
    await expect(grant(20_000_000)).rejects.toMatchObject({code:"compute_credit_user_funding_required"});
  });

  it("grants once, rejects changed retries, and records an immutable ledger event", async () => {
    const idempotencyKey = randomUUID();
    const first = await grant(20_000_000, { idempotencyKey });
    expect(await grant(20_000_000, { idempotencyKey })).toEqual({
      ...first,
      replayed: true,
    });
    await expect(grant(21_000_000, { idempotencyKey })).rejects.toMatchObject({
      code: "compute_credit_conflict",
    });
    expect(await ledger.balanceSystem(account())).toMatchObject([
      { grantedMicroUsd: 20_000_000, availableMicroUsd: 20_000_000 },
    ]);
    expect(
      (
        await pool.query(
          "SELECT kind,amount_micro_usd FROM managed_compute_credit_events",
        )
      ).rows,
    ).toEqual([{ kind: "grant", amount_micro_usd: "20000000" }]);
    await expect(
      withSystemTx(pool, (tx) =>
        tx.query("UPDATE managed_compute_credit_events SET amount_micro_usd=1"),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    expect(
      (
        await withUserTx(pool, f.userId, (tx) =>
          tx.query("SELECT * FROM managed_compute_credit_periods"),
        )
      ).rows,
    ).toEqual([]);
  });
  it("keeps a balance visible to its owner after compute entitlement ends without exposing other members", async () => {
    await grant();
    await pool.query(
      "UPDATE organization_seat_assignments SET state='released',released_at=now() WHERE org_id=$1",
      [f.organizationId],
    );
    expect(await ledger.balanceForUser(account())).toMatchObject([
      { grantedMicroUsd: 20000, availableMicroUsd: 20000 },
    ]);
    expect(
      JSON.stringify(await ledger.balanceForUser(account())),
    ).not.toContain("exposureMicroUsd");
    await expect(
      ledger.balanceForUser({ organizationId: randomUUID(), userId: f.userId }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      ledger.balanceForUser({
        organizationId: f.organizationId,
        userId: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 404 });
    await pool.query("UPDATE users SET auth_status='identity_disabled' WHERE id=$1", [
      f.userId,
    ]);
    await expect(ledger.balanceForUser(account())).rejects.toMatchObject({
      status: 404,
    });
  });
  it("requires a live platform owner and the exact organization for an audited operator grant", async () => {
    const slug = (
      await pool.query("SELECT slug FROM organizations WHERE id=$1", [
        f.organizationId,
      ])
    ).rows[0].slug;
    const operator = {
      actorUserId: f.userId,
      expectedOrganizationSlug: slug,
      targetFingerprint: "a".repeat(64),
      reason: "Fixture receipt for paid seat credit",
    };
    await expect(grant(20000, { operator })).rejects.toMatchObject({
      code: "compute_credit_operator_rejected",
    });
    await pool.query(
      "UPDATE users SET staff_role='platform_owner' WHERE id=$1",
      [f.userId],
    );
    await expect(
      grant(20000, {
        operator: { ...operator, expectedOrganizationSlug: "wrong-org" },
      }),
    ).rejects.toMatchObject({ code: "compute_credit_operator_rejected" });
    await grant(20000, { operator });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM audit_log WHERE action='cloud_compute.credit_granted' AND org_id=$1",
          [f.organizationId],
        )
      ).rows[0].count,
    ).toBe(1);
  });
  it("serializes concurrent overlapping grant periods and permits adjacent periods", async () => {
    const results = await Promise.allSettled([
      grant(),
      grant(20_000, { startsAt: new Date(now - 1000) }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    await grant(20_000, {
      startsAt: new Date(now + 3600_000),
      endsAt: new Date(now + 7200_000),
    });
    expect(await ledger.balanceSystem(account())).toHaveLength(2);
  });
  it("reserves before allocation and prevents competing requests from overspending", async () => {
    const { periodId } = await grant(10_000);
    const results = await Promise.allSettled([
      reserve(periodId, 6_000),
      reserve(periodId, 6_000),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await ledger.balanceSystem(account())).toMatchObject([
      { debitedMicroUsd: 0, reservedMicroUsd: 6_000, availableMicroUsd: 4_000 },
    ]);
  });
  it("does not let a superseded allocation worker reserve more funds", async () => {
    const { periodId } = await grant();
    await expect(
      reserve(periodId, 1000, {
        allocationLeaseClaim: { owner: "superseded-worker" },
      }),
    ).rejects.toMatchObject({ code: "compute_lease_superseded" });
    expect(await ledger.balanceSystem(account())).toMatchObject([
      { reservedMicroUsd: 0 },
    ]);
  });
  it("retries and extends one reservation without duplicating its hold", async () => {
    const { periodId } = await grant(),
      reservationId = randomUUID();
    await reserve(periodId, 1000, { reservationId });
    await reserve(periodId, 1000, { reservationId });
    await reserve(periodId, 2000, { reservationId });
    expect(await ledger.balanceSystem(account())).toMatchObject([
      { reservedMicroUsd: 2000 },
    ]);
    await expect(
      reserve(periodId, 1000, { reservationId }),
    ).rejects.toMatchObject({ code: "compute_credit_conflict" });
    await expect(
      reserve(periodId, 2000, { reservationId, secondsPerDollar: 200_000 }),
    ).rejects.toMatchObject({ code: "compute_credit_conflict" });
  });
  it("rolls back every segment when the next billing period is not funded", async () => {
    const first = await grant(10_000);
    const next = await grant(100, {
      startsAt: new Date(now + 3600_000),
      endsAt: new Date(now + 7200_000),
    });
    await expect(
      reserve(first.periodId, 1000, {
        allocations: [
          allocation(first.periodId, 1000),
          {
            periodId: next.periodId,
            meterSince: new Date(now + 3600_000),
            coveredUntil: new Date(now + 3660_000),
            authorizationMicroUsd: 1000,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "compute_credit_exhausted" });
    expect(
      (await ledger.balanceSystem(account())).every(
        (p) => p.reservedMicroUsd === 0,
      ),
    ).toBe(true);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM managed_compute_credit_reservations",
        )
      ).rows[0].count,
    ).toBe(0);
  });
  it("does not pool another seat's funds or admit stale paid authority", async () => {
    const other = await seedReadyCloudWorkspace(pool);
    const { periodId } = await grant(20_000, { userId: other.userId });
    await expect(reserve(periodId)).rejects.toMatchObject({
      code: "compute_credit_period_unavailable",
    });
    const own = await grant();
    await pool.query(
      "UPDATE organization_seat_assignments SET state='released',released_at=now() WHERE org_id=$1",
      [f.organizationId],
    );
    await expect(reserve(own.periodId)).rejects.toMatchObject({
      code: "compute_credit_scope_rejected",
    });
  });
  it("rejects expired or out-of-period coverage", async () => {
    const expired = await grant(10_000, {
      startsAt: new Date(now - 7200_000),
      endsAt: new Date(now - 3600_000),
    });
    await expect(reserve(expired.periodId)).rejects.toMatchObject({
      code: "compute_credit_period_unavailable",
    });
    const current = await grant();
    await expect(
      reserve(current.periodId, 1000, {
        allocations: [
          {
            ...allocation(current.periodId),
            coveredUntil: new Date(now + 7200_000),
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "compute_credit_period_unavailable" });
    expect((await ledger.balanceSystem(account()))[0]?.availableMicroUsd).toBe(
      0,
    );
  });

  it("charges cumulative usage once and releases only confirmed unused credit", async () => {
    const { periodId } = await grant();
    const [r] = await reserve(periodId);
    const input = { reservationId: r!.reservationId, periodId, usage: usage() };
    const first = await ledger.meter(input);
    expect(first).toMatchObject({
      actualMicroUsd: 500,
      debitedMicroUsd: 500,
      reservedMicroUsd: 9500,
    });
    expect(await ledger.meter(input)).toEqual(first);
    await ledger.meter({ ...input, usage: usage(100) });
    expect(await ledger.meter(input)).toMatchObject({ actualMicroUsd: 1000 }); // delayed earlier poll
    const final = await ledger.meter({
      ...input,
      usage: usage(100, { running: false }),
      finalReason: "allocation_stopped",
    });
    expect(final).toMatchObject({
      state: "final",
      actualMicroUsd: 1000,
      debitedMicroUsd: 1000,
      reservedMicroUsd: 0,
    });
    expect(
      await ledger.meter({
        ...input,
        usage: usage(100, { running: false }),
        finalReason: "allocation_stopped",
      }),
    ).toEqual(final);
    expect(await ledger.balanceSystem(account())).toMatchObject([
      { debitedMicroUsd: 1000, reservedMicroUsd: 0, availableMicroUsd: 19_000 },
    ]);
    await expect(
      reserve(periodId, 20_000, { reservationId: r!.reservationId }),
    ).rejects.toMatchObject({ code: "compute_credit_conflict" });
  });
  it("records unexpected provider overrun as platform exposure without charging unapproved overages", async () => {
    const { periodId } = await grant(1000);
    const [r] = await reserve(periodId, 100);
    const input = {
      reservationId: r!.reservationId,
      periodId,
      usage: usage(20),
    };
    expect(await ledger.meter(input)).toMatchObject({
      actualMicroUsd: 200,
      debitedMicroUsd: 100,
      exposureMicroUsd: 100,
      reservedMicroUsd: 0,
    });
    expect(await ledger.balanceSystem(account())).toMatchObject([
      { availableMicroUsd: 900, exposureMicroUsd: 100 },
    ]);
    await reserve(periodId, 200, { reservationId: r!.reservationId });
    expect(
      await ledger.meter({
        ...input,
        usage: usage(30, { running: false }),
        finalReason: "allocation_stopped",
      }),
    ).toMatchObject({
      actualMicroUsd: 300,
      debitedMicroUsd: 200,
      exposureMicroUsd: 100,
      reservedMicroUsd: 0,
    });
    expect(await ledger.balanceSystem(account())).toMatchObject([
      { availableMicroUsd: 800, exposureMicroUsd: 100 },
    ]);
  });
  it("keeps reservations on missing, regressing, wrong-rate or wrong-allocation meter evidence", async () => {
    const { periodId } = await grant();
    const [r] = await reserve(periodId);
    const input = { reservationId: r!.reservationId, periodId, usage: usage() };
    await ledger.meter(input);
    for (const changed of [
      usage(30, { until: usage(60).until }),
      usage(50, { resourceId: "another-sandbox" }),
      usage(50, { secondsPerDollar: 50_000, listPriceMicroUsd: 1000 }),
      usage(50, { listPriceMicroUsd: 501 }),
      usage(50, { since: new Date(now - 601_000).toISOString() }),
      usage(50, { until: new Date(now + 10_000).toISOString() }),
    ]) {
      await expect(
        ledger.meter({ ...input, usage: changed }),
      ).rejects.toMatchObject({ code: "compute_credit_meter_rejected" });
    }
    await expect(
      ledger.meter({ ...input, finalReason: "allocation_stopped" }),
    ).rejects.toMatchObject({ code: "compute_credit_meter_rejected" });
    await expect(
      ledger.meter({
        ...input,
        usage: usage(40, { running: false }),
        finalReason: "allocation_stopped",
      }),
    ).rejects.toMatchObject({ code: "compute_credit_meter_rejected" });
    expect(await ledger.balanceSystem(account())).toMatchObject([
      { debitedMicroUsd: 500, reservedMicroUsd: 9500 },
    ]);
  });
  it("settles against the original payer after a billing epoch changes", async () => {
    const { periodId } = await grant();
    const [r] = await reserve(periodId);
    await withSystemTx(pool, async (tx) => {
      await tx.query(
        "UPDATE workspace_billing_epochs SET ended_at=now() WHERE workspace_id=$1 AND billing_epoch=1",
        [f.workspaceId],
      );
      await tx.query(
        `INSERT INTO workspace_billing_epochs(workspace_id,billing_epoch,org_id,billing_owner_user_id,entitlement_scope,entitlement_plan,entitlement_revision)
        SELECT workspace_id,2,org_id,billing_owner_user_id,entitlement_scope,entitlement_plan,entitlement_revision+1 FROM workspace_billing_epochs WHERE workspace_id=$1 AND billing_epoch=1`,
        [f.workspaceId],
      );
      await tx.query(
        "UPDATE cloud_workspaces SET current_billing_epoch=2,desired_state='stopped' WHERE id=$1",
        [f.workspaceId],
      );
    });
    await expect(
      reserve(periodId, 20_000, { reservationId: r!.reservationId }),
    ).rejects.toMatchObject({ code: "compute_credit_scope_rejected" });
    expect(
      await ledger.meter({
        reservationId: r!.reservationId,
        periodId,
        usage: usage(50, { running: false }),
        finalReason: "allocation_stopped",
      }),
    ).toMatchObject({ debitedMicroUsd: 500, reservedMicroUsd: 0 });
    expect(
      (
        await pool.query(
          "SELECT user_id,billing_epoch FROM managed_compute_credit_reservations",
        )
      ).rows,
    ).toEqual([{ user_id: f.userId, billing_epoch: "1" }]);
  });
  it("releases failed provisioning only before an allocation has ever been bound", async () => {
    const { periodId } = await grant();
    const [r] = await reserve(periodId);
    const input = { reservationId: r!.reservationId, periodId };
    await expect(ledger.releaseUnallocated(input)).rejects.toMatchObject({
      code: "compute_credit_conflict",
    });
    await pool.query(
      "UPDATE cloud_workspace_provider_bindings SET provider_resource_id=NULL WHERE workspace_id=$1",
      [f.workspaceId],
    );
    expect(await ledger.releaseUnallocated(input)).toMatchObject({
      state: "final",
      reservedMicroUsd: 0,
      debitedMicroUsd: 0,
    });
    expect(await ledger.releaseUnallocated(input)).toMatchObject({
      state: "final",
      reservedMicroUsd: 0,
    });
    expect(await ledger.balanceSystem(account())).toMatchObject([
      { availableMicroUsd: 20_000 },
    ]);
  });

  it("never reserves managed credits for delegated Daytona compute", async () => {
    const { periodId } = await grant();
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
    await pool.query(
      "UPDATE provider_connections SET credential_source='delegated' WHERE org_id=$1",
      [f.organizationId],
    );
    await expect(reserve(periodId)).rejects.toMatchObject({
      code: "compute_credit_scope_rejected",
    });
    expect(await ledger.balanceSystem(account())).toMatchObject([
      { reservedMicroUsd: 0, debitedMicroUsd: 0 },
    ]);
  });

  it("binds a reservation identity across concurrent requests from different accounts", async () => {
    const first = await grant(),
      other = await seedReadyCloudWorkspace(pool);
    const second = await grant(20_000, {
      organizationId: other.organizationId,
      userId: other.userId,
    });
    const reservationId = randomUUID();
    const results = await Promise.allSettled([
      reserve(first.periodId, 1000, { reservationId }),
      reserve(second.periodId, 1000, {
        reservationId,
        organizationId: other.organizationId,
        workspaceId: other.workspaceId,
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(
      (
        await pool.query(
          "SELECT count(DISTINCT workspace_id)::int AS count FROM managed_compute_credit_reservations WHERE id=$1",
          [reservationId],
        )
      ).rows[0].count,
    ).toBe(1);
  });

  it("enforces immutable reservation identity in the database as well as the coordinator", async () => {
    const first = await grant(),
      other = await seedReadyCloudWorkspace(pool);
    const second = await grant(20_000, {
      organizationId: other.organizationId,
      userId: other.userId,
    });
    const [r] = await reserve(first.periodId);
    await expect(
      pool.query(
        `INSERT INTO managed_compute_credit_reservations
      SELECT (jsonb_populate_record(NULL::managed_compute_credit_reservations,to_jsonb(r)||jsonb_build_object(
        'period_id',$2::text,'org_id',$3::text,'user_id',$4::text,'workspace_id',$5::text))).*
      FROM managed_compute_credit_reservations r WHERE id=$1`,
        [
          r!.reservationId,
          second.periodId,
          other.organizationId,
          other.userId,
          other.workspaceId,
        ],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("uses the database clock for credit periods and meter admission across coordinators", async () => {
    const { periodId } = await grant();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 7200_000);
    try {
      const [r] = await reserve(periodId);
      expect(await ledger.balanceSystem(account())).toMatchObject([
        { availableMicroUsd: 10_000 },
      ]);
      await expect(
        ledger.meter({
          reservationId: r!.reservationId,
          periodId,
          usage: usage(50, {
            until: new Date(now + 600_000).toISOString(),
          }),
        }),
      ).rejects.toMatchObject({ code: "compute_credit_meter_rejected" });
    } finally {
      clock.mockRestore();
    }
  });

  it("finalizes a closed period while the same allocation continues on later funding", async () => {
    const endsAt = new Date(now + 2000);
    const { periodId } = await grant(20000, { endsAt });
    const [r] = await reserve(periodId, 10000, {
      allocations: [{ ...allocation(periodId), coveredUntil: endsAt }],
    });
    const request = {
      reservationId: r!.reservationId,
      periodId,
      usage: usage(50, { until: endsAt.toISOString() }),
      finalReason: "period_ended" as const,
    };
    await expect(ledger.meter(request)).rejects.toMatchObject({
      code: "compute_credit_meter_rejected",
    });
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, endsAt.getTime() - Date.now() + 50)),
    );
    await expect(
      ledger.meter({ ...request, usage: usage(50) }),
    ).rejects.toMatchObject({ code: "compute_credit_meter_rejected" });
    expect(await ledger.meter(request)).toMatchObject({
      state: "final",
      debitedMicroUsd: 500,
      reservedMicroUsd: 0,
    });
    expect(await ledger.meter(request)).toMatchObject({
      state: "final",
      debitedMicroUsd: 500,
      reservedMicroUsd: 0,
    });
  });

  it("releases an unused future segment after confirmed stop, without inventing a provider meter", async () => {
    const { periodId } = await grant(20000, {
      startsAt: new Date(now + 3600_000),
      endsAt: new Date(now + 7200_000),
    });
    const [r] = await reserve(periodId, 10000, {
      allocations: [
        {
          periodId,
          authorizationMicroUsd: 10000,
          meterSince: new Date(now + 3600_000),
          coveredUntil: new Date(now + 4200_000),
        },
      ],
    });
    const request = {
      reservationId: r!.reservationId,
      periodId,
      resourceId: `sandbox-${f.workspaceId}`,
      reason: "allocation_stopped" as const,
    };
    await expect(
      ledger.releaseBeforeWindow({ ...request, resourceId: "wrong" }),
    ).rejects.toMatchObject({ code: "compute_credit_conflict" });
    expect(await ledger.releaseBeforeWindow(request)).toMatchObject({
      state: "final",
      reservedMicroUsd: 0,
      actualMicroUsd: 0,
    });
    expect(await ledger.releaseBeforeWindow(request)).toMatchObject({
      state: "final",
      reservedMicroUsd: 0,
    });
    const current = await grant();
    const [active] = await reserve(current.periodId);
    await expect(
      ledger.releaseBeforeWindow({
        ...request,
        reservationId: active!.reservationId,
        periodId: current.periodId,
      }),
    ).rejects.toMatchObject({ code: "compute_credit_conflict" });
  });
});

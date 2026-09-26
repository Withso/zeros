import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureUser } from "../auth.js";
import { withSystemTx } from "../db.js";
import { runMigrations } from "../migrate.js";
import {
  DatabaseProMonthlyAllowance,
  proMonthlyPeriod,
  readProComputeUsage,
} from "./pro-allowance.js";
import {
  allocateComputeUserFunding,
  DatabaseComputeUserFunding,
  lockComputeUserFunding,
  prepareComputeUserPeriods,
} from "./compute-funding.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const price = { policyId: "qualified-compute-v1", secondsPerDollar: 100_000 };
d("automatic individual Pro allowances", () => {
  let pool: pg.Pool, service: DatabaseProMonthlyAllowance;
  beforeAll(() => {
    pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 6,
    });
    service = new DatabaseProMonthlyAllowance(pool, price);
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await runMigrations(pool);
  });
  async function account() {
    const user = await ensureUser(pool, {
      provider: "workos",
      providerSubject: `user_${randomUUID()}`,
      email: `allowance-${randomUUID()}@example.test`,
      displayName: "Allowance test",
    });
    await pool.query(
      `INSERT INTO account_entitlements(user_id,plan,status,cloud_workspaces_allowed,source,valid_until)
      VALUES($1,'pro','active',true,'operator',clock_timestamp()+interval '1 year')`,
      [user.id],
    );
    return user.id;
  }
  it("issues one 500-hour equivalent receipt despite concurrent workers and admission retries", async () => {
    const userId = await account();
    expect(await readProComputeUsage(pool, userId)).toMatchObject({
      state: "pending",
      usedPercent: null,
    });
    expect(
      (await pool.query("SELECT 1 FROM managed_compute_funding_receipts"))
        .rowCount,
    ).toBe(0);
    const issued = await Promise.all(
      Array.from({ length: 6 }, () => service.ensure(userId)),
    );
    expect(new Set(issued.map((result) => result.periodId)).size).toBe(1);
    expect(issued.filter((result) => !result.replayed)).toHaveLength(1);
    expect(
      (
        await pool.query(
          "SELECT amount_micro_usd,source_kind FROM managed_compute_funding_receipts",
        )
      ).rows,
    ).toEqual([
      { amount_micro_usd: "18000000", source_kind: "pro_monthly_allowance" },
    ]);
    await service.reconcile();
    expect(
      (await pool.query("SELECT 1 FROM managed_compute_funding_receipts"))
        .rowCount,
    ).toBe(1);
    expect(await readProComputeUsage(pool, userId)).toMatchObject({
      state: "ready",
      usedPercent: 0,
      reservedPercent: 0,
      availablePercent: 100,
    });
  });
  it("preserves the anchor and allowance through paid/staff overlap, revoke and regrant", async () => {
    const userId = await account();
    const first = await service.ensure(userId);
    const anchor = (
      await pool.query(
        "SELECT anchor_at FROM managed_compute_pro_accounts WHERE user_id=$1",
        [userId],
      )
    ).rows[0].anchor_at;
    await pool.query("UPDATE users SET staff_role='developer' WHERE id=$1", [
      userId,
    ]);
    await pool.query(
      "UPDATE account_entitlements SET status='expired',revision=revision+1 WHERE user_id=$1",
      [userId],
    );
    expect(await service.ensure(userId)).toMatchObject({
      periodId: first.periodId,
      replayed: true,
    });
    await pool.query("UPDATE users SET staff_role=NULL WHERE id=$1", [userId]);
    expect(await service.ensure(userId)).toEqual({ state: "ineligible" });
    await pool.query(
      "UPDATE account_entitlements SET status='active',valid_from=clock_timestamp(),revision=revision+1 WHERE user_id=$1",
      [userId],
    );
    expect(await service.ensure(userId)).toMatchObject({
      periodId: first.periodId,
      replayed: true,
    });
    expect(
      (
        await pool.query(
          "SELECT anchor_at FROM managed_compute_pro_accounts WHERE user_id=$1",
          [userId],
        )
      ).rows[0].anchor_at,
    ).toEqual(anchor);
    expect(
      (await pool.query("SELECT 1 FROM managed_compute_pro_allowances"))
        .rowCount,
    ).toBe(1);
  });
  it("does not stack automatic funding on a pilot receipt or top up an automatic allowance", async () => {
    const userId = await account();
    await pool.query(
      "UPDATE users SET staff_role='platform_owner' WHERE id=$1",
      [userId],
    );
    const anchor = (
      await pool.query(
        "SELECT anchor_at FROM managed_compute_pro_accounts WHERE user_id=$1",
        [userId],
      )
    ).rows[0].anchor_at as Date;
    const period = proMonthlyPeriod(anchor, new Date())!;
    const receipt = {
      userId,
      ...period,
      amountMicroUsd: 1000,
      source: {
        kind: "operator" as const,
        id: randomUUID(),
        lineItemId: "pilot",
      },
      operator: {
        actorUserId: userId,
        reason: "Explicit isolated pilot allowance test",
        targetFingerprint: "a".repeat(64),
      },
    };
    await new DatabaseComputeUserFunding(pool).fund(receipt);
    expect(await service.ensure(userId)).toMatchObject({
      state: "legacy_conflict",
    });
    expect(
      (await pool.query("SELECT 1 FROM managed_compute_pro_allowances"))
        .rowCount,
    ).toBe(0);
    const other = await account();
    await service.ensure(other);
    const automatic = (
      await pool.query(
        "SELECT starts_at,ends_at FROM managed_compute_pro_allowances WHERE user_id=$1",
        [other],
      )
    ).rows[0];
    await expect(
      new DatabaseComputeUserFunding(pool).fund({
        ...receipt,
        userId: other,
        startsAt: automatic.starts_at,
        endsAt: automatic.ends_at,
        source: { ...receipt.source, id: randomUUID() },
      }),
    ).rejects.toMatchObject({
      code: "compute_credit_monthly_allowance_locked",
    });
  });
  it("counts global consumption and reservations, not credit moved between Organizations", async () => {
    const a = await seedReadyCloudWorkspace(pool),
      b = await seedReadyCloudWorkspace(pool, { ownerUserId: a.userId });
    await service.ensure(a.userId);
    const children = await withSystemTx(pool, async (tx) => {
      await lockComputeUserFunding(tx, a.userId);
      for (const org of [a.organizationId, b.organizationId])
        await prepareComputeUserPeriods(tx, {
          userId: a.userId,
          organizationId: org,
        });
      const rows = (
        await tx.query<{ id: string }>(
          "SELECT id FROM managed_compute_credit_periods WHERE user_id=$1 ORDER BY org_id",
          [a.userId],
        )
      ).rows;
      await allocateComputeUserFunding(tx, {
        userId: a.userId,
        periodId: rows[0]!.id,
        requiredAvailableMicroUsd: 9_000_000,
      });
      await allocateComputeUserFunding(tx, {
        userId: a.userId,
        periodId: rows[1]!.id,
        requiredAvailableMicroUsd: 4_500_000,
      });
      return rows;
    });
    expect(await readProComputeUsage(pool, a.userId)).toMatchObject({
      usedPercent: 0,
      reservedPercent: 0,
      availablePercent: 100,
    });
    await pool.query(
      "UPDATE managed_compute_credit_periods SET debited_micro_usd=4500000,reserved_micro_usd=4500000 WHERE id=$1",
      [children[0]!.id],
    );
    await pool.query(
      "UPDATE managed_compute_credit_periods SET reserved_micro_usd=4500000 WHERE id=$1",
      [children[1]!.id],
    );
    expect(await readProComputeUsage(pool, a.userId)).toMatchObject({
      usedPercent: 25,
      reservedPercent: 50,
      availablePercent: 25,
    });
    expect(await readProComputeUsage(pool, await account())).toMatchObject({
      state: "pending",
      usedPercent: null,
    });
  });
  it("pins the period price, skips expired-month catch-up, and does not grant to an expired account", async () => {
    const userId = await account();
    await pool.query(
      "UPDATE managed_compute_pro_accounts SET anchor_at=anchor_at-interval '4 months' WHERE user_id=$1",
      [userId],
    );
    await service.ensure(userId);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM managed_compute_pro_allowances",
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      await new DatabaseProMonthlyAllowance(pool, {
        ...price,
        secondsPerDollar: 90_000,
      }).ensure(userId),
    ).toMatchObject({ state: "policy_conflict" });
    expect(await readProComputeUsage(pool, userId)).toMatchObject({
      state: "unavailable",
      usedPercent: null,
    });
    const expired = await account();
    await pool.query(
      "UPDATE account_entitlements SET status='expired' WHERE user_id=$1",
      [expired],
    );
    expect(await service.ensure(expired)).toEqual({ state: "ineligible" });
    expect(
      (
        await pool.query(
          "SELECT 1 FROM managed_compute_user_periods WHERE user_id=$1",
          [expired],
        )
      ).rowCount,
    ).toBe(0);
  });
  async function pastAllowance(userId: string) {
    await pool.query(
      "UPDATE account_entitlements SET valid_from=clock_timestamp()-interval '2 months',valid_until=NULL WHERE user_id=$1",
      [userId],
    );
    await pool.query(
      "UPDATE managed_compute_pro_accounts SET anchor_at=(SELECT valid_from FROM account_entitlements WHERE user_id=$1) WHERE user_id=$1",
      [userId],
    );
    await withSystemTx(pool, async (tx) => {
      await lockComputeUserFunding(tx, userId);
      const entitlement = (
        await tx.query("SELECT * FROM cloud_workspace_pro_entitlement($1)", [
          userId,
        ])
      ).rows[0]!;
      const period = proMonthlyPeriod(
        entitlement.valid_from,
        entitlement.valid_from,
      )!;
      const id = randomUUID(),
        receipt = randomUUID();
      // Historical receipt fixture: unused balance must never roll forward.
      await tx.query(
        `INSERT INTO managed_compute_user_periods(id,user_id,starts_at,ends_at,granted_micro_usd)
        VALUES($1,$2,$3,$4,18000000)`,
        [id, userId, entitlement.valid_from, period.endsAt],
      );
      await tx.query(
        `INSERT INTO managed_compute_funding_receipts(id,period_id,user_id,source_kind,source_id,line_item_id,request_sha256,amount_micro_usd)
        VALUES($1,$2,$3::uuid,'pro_monthly_allowance',$3::uuid::text,'prior',decode(repeat('ab',32),'hex'),18000000)`,
        [receipt, id, userId],
      );
      await tx.query(
        `INSERT INTO managed_compute_pro_allowances(user_id,starts_at,ends_at,period_id,receipt_id,allowance_policy,standard_seconds,
        compute_policy_id,seconds_per_dollar,entitlement_source,entitlement_revision,entitlement_valid_from,entitlement_valid_until)
        VALUES($1,$2,$3,$4,$5,'pro-monthly-v1',1800000,$6,$7,$8,$9,$2,NULL)`,
        [
          userId,
          entitlement.valid_from,
          period.endsAt,
          id,
          receipt,
          price.policyId,
          price.secondsPerDollar,
          entitlement.source,
          entitlement.revision,
        ],
      );
    });
  }
  it("waits for paid renewal evidence and never rolls unused allowance into the next month", async () => {
    const userId = await account();
    await pastAllowance(userId);
    expect(await service.ensure(userId)).toMatchObject({
      state: "renewal_unconfirmed",
    });
    await pool.query(
      "UPDATE account_entitlements SET valid_until=clock_timestamp()+interval '1 month',revision=revision+1 WHERE user_id=$1",
      [userId],
    );
    expect(await service.ensure(userId)).toMatchObject({
      state: "ready",
      replayed: false,
    });
    expect(await readProComputeUsage(pool, userId)).toMatchObject({
      usedPercent: 0,
      reservedPercent: 0,
      availablePercent: 100,
    });
    expect(
      (
        await pool.query(
          "SELECT granted_micro_usd FROM managed_compute_user_periods WHERE user_id=$1 ORDER BY starts_at",
          [userId],
        )
      ).rows,
    ).toEqual([
      { granted_micro_usd: "18000000" },
      { granted_micro_usd: "18000000" },
    ]);
  });
  it("renews staff benefits even when an open-ended paid entitlement also exists", async () => {
    const userId = await account();
    await pastAllowance(userId);
    await pool.query("UPDATE users SET staff_role='developer' WHERE id=$1", [
      userId,
    ]);
    expect(await service.ensure(userId)).toMatchObject({
      state: "ready",
      replayed: false,
    });
    expect(
      (
        await pool.query(
          "SELECT entitlement_source FROM managed_compute_pro_allowances WHERE user_id=$1 ORDER BY starts_at DESC LIMIT 1",
          [userId],
        )
      ).rows[0].entitlement_source,
    ).toBe("staff");
  });
  it.each([false, true])(
    "prefunds a nearby boundary only with confirmed renewal (confirmed=%s)",
    async (confirmed) => {
      const userId = await account();
      const anchor = new Date(Date.now() + 45_000);
      anchor.setUTCMonth(anchor.getUTCMonth() - 1);
      await pool.query(
        "UPDATE account_entitlements SET valid_from=$2,valid_until=CASE WHEN $3 THEN clock_timestamp()+interval '1 year' ELSE NULL END WHERE user_id=$1",
        [userId, anchor, confirmed],
      );
      await pool.query(
        "UPDATE managed_compute_pro_accounts SET anchor_at=$2 WHERE user_id=$1",
        [userId, anchor],
      );
      const issuer = new DatabaseProMonthlyAllowance(pool, {
        ...price,
        maximumTtlSeconds: 60,
        requestMarginSeconds: 5,
      });
      await issuer.ensure(userId);
      await issuer.ensure(userId);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM managed_compute_pro_allowances WHERE user_id=$1",
            [userId],
          )
        ).rows[0].n,
      ).toBe(confirmed ? 2 : 1);
      expect(await readProComputeUsage(pool, userId)).toMatchObject({
        state: "ready",
        availablePercent: 100,
      });
    },
  );
});

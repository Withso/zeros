import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { withSystemTx, type Tx } from "../db.js";
import { HttpError } from "../authz.js";
import { lockComputeUserFunding } from "./compute-funding.js";
import { computeMicroUsd } from "./provider-compute.js";

export const PRO_STANDARD_SECONDS = 1_800_000;
export const PRO_ALLOWANCE_POLICY = "pro-monthly-v1";
type Price = {
  policyId: string;
  secondsPerDollar: number;
  maximumTtlSeconds?: number;
  requestMarginSeconds?: number;
};
type Entitlement = {
  revision: string;
  valid_from: Date;
  valid_until: Date | null;
  source: string;
};
type IssuanceState =
  | "ready"
  | "ineligible"
  | "legacy_conflict"
  | "renewal_unconfirmed"
  | "policy_conflict"
  | "pending";
type Issuance = {
  state: IssuanceState;
  periodId?: string;
  endsAt?: Date;
  replayed?: boolean;
};

/** Clamp each boundary from the original UTC anchor, never from the previous
 * month: January 31 -> February 28 -> March 31 (including time of day). */
export function proMonthlyPeriod(
  anchor: Date,
  at: Date,
): { startsAt: Date; endsAt: Date } | null {
  if (!Number.isFinite(anchor.getTime()) || !Number.isFinite(at.getTime()))
    throw new Error("Invalid allowance clock");
  if (at < anchor) return null;
  const boundary = (offset: number) => {
    const date = new Date(anchor);
    date.setUTCDate(1);
    date.setUTCMonth(anchor.getUTCMonth() + offset);
    const last = new Date(date);
    last.setUTCMonth(last.getUTCMonth() + 1, 0);
    date.setUTCDate(Math.min(anchor.getUTCDate(), last.getUTCDate()));
    return date;
  };
  let offset =
    (at.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
    at.getUTCMonth() -
    anchor.getUTCMonth();
  if (boundary(offset) > at) offset--;
  return { startsAt: boundary(offset), endsAt: boundary(offset + 1) };
}

function validatePrice(price: Price): number {
  if (
    !/^[A-Za-z0-9._:-]{1,128}$/.test(price.policyId) ||
    !Number.isSafeInteger(price.secondsPerDollar) ||
    price.secondsPerDollar < 1 ||
    price.secondsPerDollar > 1_000_000_000_000
  )
    throw new Error("Invalid Pro allowance price policy");
  const amount = computeMicroUsd(PRO_STANDARD_SECONDS, price.secondsPerDollar);
  if (amount > 1_000_000_000_000)
    throw new Error("Pro allowance exceeds supported funding capacity");
  return amount;
}

/** Trusted server policy only. This function never accepts a grant amount,
 * arbitrary period or receipt source from a customer. Caller holds the root
 * funding lock before any Organization, workspace or child-period lock. */
export async function ensureProMonthlyAllowance(
  tx: Tx,
  userId: string,
  price: Price,
): Promise<Issuance> {
  const amount = validatePrice(price);
  const now = (await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now"))
    .rows[0]!.now;
  const finish = async (result: Issuance): Promise<Issuance> => {
    const next =
      result.state === "ready" && result.endsAt
        ? result.endsAt
        : new Date(now.getTime() + 60 * 60_000);
    await tx.query(
      `UPDATE managed_compute_pro_allowance_queue SET next_check_at=$2,last_state=$3,updated_at=clock_timestamp()
      WHERE user_id=$1`,
      [userId, next, result.state],
    );
    return result;
  };
  const live = (
    await tx.query<Entitlement>(
      "SELECT * FROM cloud_workspace_pro_entitlement($1)",
      [userId],
    )
  ).rows[0];
  if (!live) return finish({ state: "ineligible" });
  // Complimentary renewal is independent of any separately paid record.
  // Prefer its audited evidence for funding without changing paid authority.
  const staff = (
    await tx.query<Entitlement>(
      `SELECT benefit.revision::text,benefit.valid_from,NULL::timestamptz AS valid_until,'staff' AS source
    FROM staff_pro_benefits benefit JOIN users account ON account.id=benefit.user_id
    WHERE benefit.user_id=$1 AND benefit.revoked_at IS NULL AND account.staff_role IN ('platform_owner','developer')
      AND account.auth_status='active' AND account.deleted_at IS NULL`,
      [userId],
    )
  ).rows[0];
  const entitlement = staff ?? live;
  const anchor = (
    await tx.query<{ anchor_at: Date }>(
      "SELECT anchor_at FROM managed_compute_pro_accounts WHERE user_id=$1",
      [userId],
    )
  ).rows[0];
  if (!anchor) return finish({ state: "pending" });
  const period = proMonthlyPeriod(anchor.anchor_at, now);
  if (!period) return finish({ state: "pending" });
  const issuePeriod = async (period: {
    startsAt: Date;
    endsAt: Date;
  }): Promise<Issuance> => {
    const prior = (
      await tx.query<{
        period_id: string;
        compute_policy_id: string;
        seconds_per_dollar: string;
        ends_at: Date;
      }>(
        "SELECT period_id,compute_policy_id,seconds_per_dollar,ends_at FROM managed_compute_pro_allowances WHERE user_id=$1 AND starts_at=$2",
        [userId, period.startsAt],
      )
    ).rows[0];
    if (prior) {
      if (
        prior.compute_policy_id !== price.policyId ||
        Number(prior.seconds_per_dollar) !== price.secondsPerDollar
      )
        return { state: "policy_conflict", endsAt: prior.ends_at };
      return {
        state: "ready",
        periodId: prior.period_id,
        endsAt: prior.ends_at,
        replayed: true,
      };
    }
    // An open-ended operator/paid entitlement is one audited activation, not
    // evidence of an infinite sequence of paid renewals. A bounded validity may
    // cover multiple service periods; staff benefits explicitly renew monthly.
    if (
      entitlement.source !== "staff" &&
      entitlement.valid_until === null &&
      (
        await tx.query(
          `SELECT 1 FROM managed_compute_pro_allowances
    WHERE user_id=$1 AND entitlement_source=$2 AND entitlement_revision=$3 AND entitlement_valid_from=$4 LIMIT 1`,
          [
            userId,
            entitlement.source,
            entitlement.revision,
            entitlement.valid_from,
          ],
        )
      ).rowCount
    )
      return { state: "renewal_unconfirmed", endsAt: period.endsAt };
    const overlap = await tx.query(
      `SELECT 1 FROM managed_compute_user_periods WHERE user_id=$1 AND starts_at<$3 AND ends_at>$2
    UNION ALL SELECT 1 FROM managed_compute_credit_periods WHERE user_id=$1 AND funding_mode<>'pro_user' AND starts_at<$3 AND ends_at>$2 LIMIT 1`,
      [userId, period.startsAt, period.endsAt],
    );
    if (overlap.rowCount)
      return { state: "legacy_conflict", endsAt: period.endsAt };
    const periodId = randomUUID(),
      receiptId = randomUUID();
    const sourceId = userId,
      lineItemId = period.startsAt.toISOString();
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          PRO_ALLOWANCE_POLICY,
          userId,
          lineItemId,
          period.endsAt.toISOString(),
          amount,
          price,
        ]),
      )
      .digest();
    await tx.query(
      `INSERT INTO managed_compute_user_periods(id,user_id,starts_at,ends_at,granted_micro_usd)
    VALUES($1,$2,$3,$4,$5)`,
      [periodId, userId, period.startsAt, period.endsAt, amount],
    );
    await tx.query(
      `INSERT INTO managed_compute_funding_receipts(id,period_id,user_id,source_kind,source_id,line_item_id,request_sha256,amount_micro_usd)
    VALUES($1,$2,$3,'pro_monthly_allowance',$4,$5,$6,$7)`,
      [receiptId, periodId, userId, sourceId, lineItemId, fingerprint, amount],
    );
    await tx.query(
      `INSERT INTO managed_compute_pro_allowances(user_id,starts_at,ends_at,period_id,receipt_id,allowance_policy,standard_seconds,
    compute_policy_id,seconds_per_dollar,entitlement_source,entitlement_revision,entitlement_valid_from,entitlement_valid_until)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        userId,
        period.startsAt,
        period.endsAt,
        periodId,
        receiptId,
        PRO_ALLOWANCE_POLICY,
        PRO_STANDARD_SECONDS,
        price.policyId,
        price.secondsPerDollar,
        entitlement.source,
        entitlement.revision,
        entitlement.valid_from,
        entitlement.valid_until,
      ],
    );
    return { state: "ready", periodId, endsAt: period.endsAt, replayed: false };
  };
  const current = await issuePeriod(period);
  // A finite lease may straddle a confirmed period boundary. Prefund only the
  // next period within that lease's bounded horizon, never an assumed renewal.
  const horizon =
    (price.maximumTtlSeconds ?? 0) + (price.requestMarginSeconds ?? 0);
  if (!Number.isSafeInteger(horizon) || horizon < 0 || horizon > 5400)
    throw new Error("Invalid allowance funding horizon");
  if (
    current.state === "ready" &&
    period.endsAt.getTime() <= now.getTime() + horizon * 1000 &&
    (entitlement.source === "staff" ||
      (entitlement.valid_until !== null &&
        entitlement.valid_until > period.endsAt))
  ) {
    await issuePeriod(proMonthlyPeriod(anchor.anchor_at, period.endsAt)!);
  }
  return finish(current);
}

export class DatabaseProMonthlyAllowance {
  constructor(
    private readonly pool: pg.Pool,
    private readonly price: Price,
  ) {
    validatePrice(price);
  }
  async ensure(userId: string): Promise<Issuance> {
    if (!z.string().uuid().safeParse(userId).success)
      throw new Error("Invalid allowance account");
    return withSystemTx(this.pool, async (tx) => {
      await lockComputeUserFunding(tx, userId);
      return ensureProMonthlyAllowance(tx, userId, this.price);
    });
  }
  async reconcile(limit = 50): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error("Invalid allowance batch");
    const users = await withSystemTx(
      this.pool,
      async (tx) =>
        (
          await tx.query<{ user_id: string }>(
            `SELECT user_id FROM managed_compute_pro_allowance_queue
      WHERE next_check_at<=clock_timestamp() ORDER BY next_check_at,user_id LIMIT $1`,
            [limit],
          )
        ).rows,
    );
    // Lock funding before the queue, matching admission repair. Duplicate
    // workers may inspect the same batch; receipt uniqueness prevents issuance twice.
    for (const user of users) await this.ensure(user.user_id);
    return users.length;
  }
  start(intervalMs = 60_000): () => Promise<void> {
    let stopped = false,
      running: Promise<void> | undefined;
    const tick = () => {
      if (stopped || running) return;
      running = this.reconcile()
        .then(() => undefined)
        .catch(() => {
          console.error("[cloud-allowance] reconciliation failed");
        })
        .finally(() => {
          running = undefined;
        });
    };
    const timer = setInterval(tick, intervalMs);
    timer.unref();
    tick();
    return async () => {
      stopped = true;
      clearInterval(timer);
      await running;
    };
  }
}

/** Read-only customer projection. Allocations between Organizations are
 * movements, never usage; cumulative debits and open holds are counted once. */
export async function readProComputeUsage(pool: pg.Pool, userId: string) {
  if (!z.string().uuid().safeParse(userId).success)
    throw new HttpError(
      404,
      "compute_usage_unavailable",
      "Compute usage is unavailable",
    );
  return withSystemTx(
    pool,
    async (tx) => {
      const row = (
        await tx.query<{
          now: Date;
          eligible: boolean;
          anchor_at: Date | null;
          period_id: string | null;
          ends_at: Date | null;
          granted: string | null;
          debited: string;
          reserved: string;
          last_state: string | null;
        }>(
          `WITH clock AS (SELECT clock_timestamp() AS now)
      SELECT clock.now,cloud_workspace_pro_user_live(account.id) AS eligible,anchor.anchor_at,allowance.period_id,allowance.ends_at,
        period.granted_micro_usd AS granted,coalesce(usage.debited,0)::text AS debited,coalesce(usage.reserved,0)::text AS reserved,queue.last_state
      FROM users account CROSS JOIN clock
      LEFT JOIN managed_compute_pro_accounts anchor ON anchor.user_id=account.id
      LEFT JOIN managed_compute_pro_allowances allowance ON allowance.user_id=account.id AND allowance.starts_at<=clock.now AND allowance.ends_at>clock.now
      LEFT JOIN managed_compute_user_periods period ON period.id=allowance.period_id
      LEFT JOIN managed_compute_pro_allowance_queue queue ON queue.user_id=account.id
      LEFT JOIN LATERAL(SELECT sum(debited_micro_usd) AS debited,sum(reserved_micro_usd) AS reserved
        FROM managed_compute_credit_periods WHERE funding_period_id=allowance.period_id) usage ON true
      WHERE account.id=$1 AND account.auth_status='active' AND account.deleted_at IS NULL`,
          [userId],
        )
      ).rows[0];
      if (!row)
        throw new HttpError(
          404,
          "compute_usage_unavailable",
          "Compute usage is unavailable",
        );
      const reset =
        row.ends_at ??
        (row.anchor_at
          ? proMonthlyPeriod(row.anchor_at, row.now)?.endsAt
          : null);
      const base = {
        resetsAt: reset?.toISOString() ?? null,
        asOf: row.now.toISOString(),
      };
      if (
        !row.eligible ||
        !row.period_id ||
        row.last_state === "policy_conflict"
      )
        return {
          ...base,
          state: !row.eligible
            ? "ineligible"
            : row.last_state && !["pending", "ready"].includes(row.last_state)
              ? "unavailable"
              : "pending",
          usedPercent: null,
          reservedPercent: null,
          availablePercent: null,
        };
      const grant = Number(row.granted),
        debited = Number(row.debited),
        reserved = Number(row.reserved);
      if (
        ![grant, debited, reserved].every(
          (value) => Number.isSafeInteger(value) && value >= 0,
        ) ||
        grant === 0 ||
        debited + reserved > grant
      )
        throw new HttpError(
          503,
          "compute_usage_unavailable",
          "Compute usage is temporarily unavailable",
        );
      const usedBasis = Math.min(10000, Math.round((debited / grant) * 10000));
      const reservedBasis = Math.min(
        10000 - usedBasis,
        Math.round((reserved / grant) * 10000),
      );
      return {
        ...base,
        state: debited + reserved >= grant ? "exhausted" : "ready",
        usedPercent: usedBasis / 100,
        reservedPercent: reservedBasis / 100,
        availablePercent: (10000 - usedBasis - reservedBasis) / 100,
      };
    },
    { consistentRead: true },
  );
}

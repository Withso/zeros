import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import { withSystemTx, type Tx } from "../db.js";
import { CloudProviderError } from "./provider.js";
import {
  computeMicroUsd,
  type CloudProviderComputeUsage,
} from "./provider-compute.js";
import { HttpError } from "../authz.js";
import { audit } from "../audit.js";
import {allocateComputeUserFunding,lockComputeUserFunding} from "./compute-funding.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POLICY = /^[A-Za-z0-9._:-]{1,128}$/;
const KEY = /^[A-Za-z0-9._:-]{8,128}$/;
const MAX_CREDIT = 1_000_000_000_000;
function deny(code: string): never {
  throw new CloudProviderError(
    code,
    "Managed compute credit requires reconciliation",
    false,
  );
}
function integer(
  value: string | number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0 || n > max)
    deny("compute_credit_invalid");
  return n;
}
function instant(value: Date | string): number {
  const n = new Date(value).getTime();
  if (!Number.isSafeInteger(n)) deny("compute_credit_invalid");
  return n;
}
function identity(...ids: string[]): void {
  if (ids.some((id) => !UUID.test(id))) deny("compute_credit_invalid");
}
type Account = { organizationId: string; userId: string };
type Period = {
  id: string;
  org_id: string;
  user_id: string;
  starts_at: Date;
  ends_at: Date;
  evaluated_at: Date;
  granted_micro_usd: string;
  debited_micro_usd: string;
  reserved_micro_usd: string;
  exposure_micro_usd: string;
  returned_micro_usd: string;
  funding_mode: "legacy_org"|"business"|"pro_user";
  funding_period_id: string|null;
};
type Reservation = {
  id: string;
  period_id: string;
  org_id: string;
  user_id: string;
  workspace_id: string;
  generation: number;
  billing_epoch: string;
  policy_id: string;
  seconds_per_dollar: string;
  meter_since: Date;
  meter_through: Date;
  covered_until: Date;
  billable_seconds: string;
  authorized_micro_usd: string;
  actual_micro_usd: string;
  debited_micro_usd: string;
  reserved_micro_usd: string;
  exposure_micro_usd: string;
  state: "open" | "final";
  final_reason: ComputeCreditFinalReason | null;
};
export type ComputeCreditFinalReason =
  | "allocation_stopped"
  | "allocation_deleted"
  | "allocation_lost"
  | "never_allocated"
  | "period_ended";
export type ComputeCreditReservation = {
  reservationId: string;
  periodId: string;
  state: "open" | "final";
  authorizedMicroUsd: number;
  actualMicroUsd: number;
  debitedMicroUsd: number;
  reservedMicroUsd: number;
  exposureMicroUsd: number;
  coveredUntil: string;
  meterThrough: string;
};
export type ComputeCreditAllocation = {
  periodId: string;
  meterSince: Date;
  coveredUntil: Date;
  authorizationMicroUsd: number;
};
function document(row: Reservation): ComputeCreditReservation {
  return {
    reservationId: row.id,
    periodId: row.period_id,
    state: row.state,
    authorizedMicroUsd: integer(row.authorized_micro_usd),
    actualMicroUsd: integer(row.actual_micro_usd),
    debitedMicroUsd: integer(row.debited_micro_usd),
    reservedMicroUsd: integer(row.reserved_micro_usd),
    exposureMicroUsd: integer(row.exposure_micro_usd),
    coveredUntil: row.covered_until.toISOString(),
    meterThrough: row.meter_through.toISOString(),
  };
}

/** Trusted billing boundary. No route may forward a caller-supplied grant,
 * price, provider meter or finalization proof into this service. Grant periods
 * are explicit; renewing an entitlement does not mint funds automatically. */
export class DatabaseManagedComputeCreditLedger {
  constructor(
    private readonly options: { pool: pg.Pool; workosEnabled: boolean },
  ) {}

  private async lockAccount(tx: Tx, account: Account): Promise<void> {
    await tx.query(
      `INSERT INTO managed_compute_credit_accounts(org_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [account.organizationId, account.userId],
    );
    await tx.query(
      `SELECT 1 FROM managed_compute_credit_accounts WHERE org_id=$1 AND user_id=$2 FOR UPDATE`,
      [account.organizationId, account.userId],
    );
  }
  private async event(
    tx: Tx,
    period: Period | Reservation,
    kind: "grant" | "reserve" | "debit" | "release" | "exposure",
    amount: number,
    reservationId: string | null = null,
  ): Promise<void> {
    if (amount === 0) return;
    await tx.query(
      `INSERT INTO managed_compute_credit_events(id,period_id,org_id,user_id,reservation_id,kind,amount_micro_usd)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        randomUUID(),
        "period_id" in period ? period.period_id : period.id,
        period.org_id,
        period.user_id,
        reservationId,
        kind,
        integer(amount),
      ],
    );
  }

  async grant(
    input: Account & {
      startsAt: Date;
      endsAt: Date;
      amountMicroUsd: number;
      policyId: string;
      idempotencyKey: string;
      operator?: {
        actorUserId: string;
        expectedOrganizationSlug: string;
        targetFingerprint: string;
        reason: string;
      };
    },
  ): Promise<{ periodId: string; replayed: boolean }> {
    identity(input.organizationId, input.userId);
    const start = instant(input.startsAt),
      end = instant(input.endsAt);
    if (
      end <= start ||
      end - start > 366 * 86400_000 ||
      !POLICY.test(input.policyId) ||
      !KEY.test(input.idempotencyKey) ||
      integer(input.amountMicroUsd, MAX_CREDIT) < 1
    )
      deny("compute_credit_invalid");
    if (input.operator) {
      identity(input.operator.actorUserId);
      if (
        !/^[a-f0-9]{64}$/.test(input.operator.targetFingerprint) ||
        input.operator.reason.length < 16 ||
        input.operator.reason.length > 512
      )
        deny("compute_credit_invalid");
    }
    const hash = createHash("sha256")
      .update(
        JSON.stringify([
          input.organizationId,
          input.userId,
          start,
          end,
          input.amountMicroUsd,
          input.policyId,
          input.operator ?? null,
        ]),
      )
      .digest();
    return withSystemTx(this.options.pool, async (tx) => {
      const org = (
        await tx.query(
          `SELECT is_personal,slug,deleted_at FROM organizations WHERE id=$1 FOR SHARE`,
          [input.organizationId],
        )
      ).rows[0];
      if (!org || org.is_personal) deny("compute_credit_scope_rejected");
      const plan=(await tx.query<{plan:string}>("SELECT plan FROM organization_entitlements WHERE org_id=$1",[input.organizationId])).rows[0]?.plan;
      if(plan!=="business"&&plan!=="enterprise")deny("compute_credit_user_funding_required");
      if (input.operator) {
        if (
          org.deleted_at ||
          org.slug !== input.operator.expectedOrganizationSlug ||
          !(
            await tx.query(
              `SELECT 1 FROM users
          WHERE id=$1 AND staff_role='platform_owner' AND auth_status='active' AND deleted_at IS NULL FOR SHARE`,
              [input.operator.actorUserId],
            )
          ).rowCount ||
          !(
            await tx.query(
              `SELECT 1 FROM users recipient JOIN organization_members membership ON membership.user_id=recipient.id
            WHERE recipient.id=$1 AND recipient.auth_status='active' AND recipient.deleted_at IS NULL AND membership.org_id=$2 FOR SHARE OF recipient,membership`,
              [input.userId, input.organizationId],
            )
          ).rowCount
        )
          deny("compute_credit_operator_rejected");
      }
      await this.lockAccount(tx, input);
      const prior = (
        await tx.query<{ period_id: string; request_sha256: Buffer }>(
          `SELECT period_id,request_sha256 FROM managed_compute_credit_grants
        WHERE org_id=$1 AND user_id=$2 AND idempotency_key=$3`,
          [input.organizationId, input.userId, input.idempotencyKey],
        )
      ).rows[0];
      if (prior) {
        if (!timingSafeEqual(prior.request_sha256, hash))
          deny("compute_credit_conflict");
        return { periodId: prior.period_id, replayed: true };
      }
      const overlapping = (
        await tx.query<Period>(
          `SELECT * FROM managed_compute_credit_periods
        WHERE org_id=$1 AND user_id=$2 AND starts_at < $4 AND ends_at > $3 FOR UPDATE`,
          [input.organizationId, input.userId, input.startsAt, input.endsAt],
        )
      ).rows;
      let period = overlapping[0];
      if (period?.funding_mode === "pro_user")
        deny("compute_credit_funding_mode_conflict");
      if (
        overlapping.length > 1 ||
        (period &&
          (instant(period.starts_at) !== start ||
            instant(period.ends_at) !== end))
      )
        deny("compute_credit_period_overlap");
      if (!period)
        period = (
          await tx.query<Period>(
            `INSERT INTO managed_compute_credit_periods(id,org_id,user_id,starts_at,ends_at,funding_mode)
        VALUES ($1,$2,$3,$4,$5,'business') RETURNING *`,
            [
              randomUUID(),
              input.organizationId,
              input.userId,
              input.startsAt,
              input.endsAt,
            ],
          )
        ).rows[0]!;
      if (integer(period.granted_micro_usd) + input.amountMicroUsd > MAX_CREDIT)
        deny("compute_credit_invalid");
      await tx.query(
        `INSERT INTO managed_compute_credit_grants(id,period_id,org_id,user_id,idempotency_key,request_sha256,amount_micro_usd,policy_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          randomUUID(),
          period.id,
          input.organizationId,
          input.userId,
          input.idempotencyKey,
          hash,
          input.amountMicroUsd,
          input.policyId,
        ],
      );
      await tx.query(
        `UPDATE managed_compute_credit_periods SET granted_micro_usd=granted_micro_usd+$2,updated_at=now() WHERE id=$1`,
        [period.id, input.amountMicroUsd],
      );
      await this.event(tx, period, "grant", input.amountMicroUsd);
      if (input.operator)
        await audit(
          tx,
          input.organizationId,
          input.operator.actorUserId,
          "cloud_compute.credit_granted",
          {
            periodId: period.id,
            userId: input.userId,
            amountMicroUsd: input.amountMicroUsd,
            policyId: input.policyId,
            idempotencyKey: input.idempotencyKey,
            targetFingerprint: input.operator.targetFingerprint,
            reason: input.operator.reason,
          },
        );
      return { periodId: period.id, replayed: false };
    });
  }

  /** All period segments are reserved in one transaction. An unfunded next
   * period cannot leave half of a provider lease authorized. Reservations never
   * expire just because a worker crashed or a provider reply was lost. */
  async reserve(input: {
    organizationId: string;
    workspaceId: string;
    generation: number;
    billingEpoch: number;
    reservationId: string;
    policyId: string;
    secondsPerDollar: number;
    allocations: ComputeCreditAllocation[];
    allocationLeaseClaim?: { owner: string };
  }): Promise<ComputeCreditReservation[]> {
    identity(input.organizationId, input.workspaceId, input.reservationId);
    if (
      input.allocationLeaseClaim &&
      !/^[A-Za-z0-9:_-]{1,128}$/.test(input.allocationLeaseClaim.owner)
    )
      deny("compute_credit_invalid");
    if (
      !POLICY.test(input.policyId) ||
      integer(input.generation) < 1 ||
      integer(input.billingEpoch) < 1 ||
      integer(input.secondsPerDollar, MAX_CREDIT) < 1 ||
      input.allocations.length < 1 ||
      input.allocations.length > 16 ||
      new Set(input.allocations.map((a) => a.periodId)).size !==
        input.allocations.length
    )
      deny("compute_credit_invalid");
    for (const a of input.allocations) {
      identity(a.periodId);
      if (
        instant(a.coveredUntil) <= instant(a.meterSince) ||
        integer(a.authorizationMicroUsd, MAX_CREDIT) < 1
      )
        deny("compute_credit_invalid");
    }
    return withSystemTx(this.options.pool, async (tx) => {
      const payer=(await tx.query<{user_id:string}>(`SELECT billing_owner_user_id AS user_id FROM workspace_billing_epochs
        WHERE workspace_id=$1 AND org_id=$2 AND billing_epoch=$3`,[input.workspaceId,input.organizationId,input.billingEpoch])).rows[0];
      if(!payer)deny("compute_credit_scope_rejected");
      await lockComputeUserFunding(tx,payer.user_id);
      await tx.query(`SELECT 1 FROM organizations WHERE id=$1 FOR UPDATE`, [
        input.organizationId,
      ]);
      await tx.query(
        `SELECT 1 FROM cloud_workspaces WHERE id=$1 AND org_id=$2 FOR UPDATE`,
        [input.workspaceId, input.organizationId],
      );
      const scope = (
        await tx.query<{
          user_id: string;
          live: boolean;
          credential_source: string;
          entitlement_plan: string;
        }>(
          `SELECT billing.billing_owner_user_id AS user_id,
          cloud_workspace_paid_authority_live(workspace.id,workspace.owner_user_id,$5) AS live, version.credential_source, billing.entitlement_plan
        FROM cloud_workspaces workspace JOIN workspace_billing_epochs billing
          ON billing.workspace_id=workspace.id AND billing.org_id=workspace.org_id AND billing.billing_epoch=workspace.current_billing_epoch
        JOIN cloud_workspace_generations generation ON generation.workspace_id=workspace.id AND generation.org_id=workspace.org_id AND generation.generation=workspace.current_generation
        JOIN provider_connection_versions version ON version.connection_id=generation.provider_connection_id AND version.org_id=generation.org_id AND version.version=generation.provider_connection_version
        JOIN organizations org ON org.id=workspace.org_id
        WHERE workspace.id=$1 AND workspace.org_id=$2 AND workspace.current_generation=$3 AND workspace.current_billing_epoch=$4
          AND workspace.desired_state='running' AND workspace.deleted_at IS NULL AND billing.ended_at IS NULL AND NOT org.is_personal`,
          [
            input.workspaceId,
            input.organizationId,
            input.generation,
            input.billingEpoch,
            this.options.workosEnabled,
          ],
        )
      ).rows[0];
      if (!scope?.live || scope.credential_source !== "hosted" || scope.user_id!==payer.user_id)
        deny("compute_credit_scope_rejected");
      if (
        input.allocationLeaseClaim &&
        !(
          await tx.query(
            `SELECT 1 FROM managed_compute_allocation_leases
        WHERE id=$1 AND workspace_id=$2 AND org_id=$3 AND generation=$4 AND billing_epoch=$5 AND user_id=$6
          AND state IN ('funding','authorized','active') AND lease_owner=$7 AND lease_expires_at>clock_timestamp()
        FOR UPDATE`,
            [
              input.reservationId,
              input.workspaceId,
              input.organizationId,
              input.generation,
              input.billingEpoch,
              scope.user_id,
              input.allocationLeaseClaim.owner,
            ],
          )
        ).rowCount
      )
        deny("compute_lease_superseded");
      await this.lockAccount(tx, {
        organizationId: input.organizationId,
        userId: scope.user_id,
      });
      await tx.query(
        `INSERT INTO managed_compute_reservation_scopes(id,org_id,user_id,workspace_id,generation,billing_epoch,policy_id,seconds_per_dollar)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
        [
          input.reservationId,
          input.organizationId,
          scope.user_id,
          input.workspaceId,
          input.generation,
          input.billingEpoch,
          input.policyId,
          input.secondsPerDollar,
        ],
      );
      const owner = (
        await tx.query<Reservation>(
          `SELECT * FROM managed_compute_reservation_scopes WHERE id=$1`,
          [input.reservationId],
        )
      ).rows[0]!;
      if (
        owner.workspace_id !== input.workspaceId ||
        owner.org_id !== input.organizationId ||
        owner.user_id !== scope.user_id ||
        owner.generation !== input.generation ||
        integer(owner.billing_epoch) !== input.billingEpoch ||
        owner.policy_id !== input.policyId ||
        integer(owner.seconds_per_dollar) !== input.secondsPerDollar
      )
        deny("compute_credit_conflict");
      const existing = (
        await tx.query<Reservation>(
          `SELECT * FROM managed_compute_credit_reservations WHERE id=$1 FOR UPDATE`,
          [input.reservationId],
        )
      ).rows;
      if (
        existing.some(
          (r) =>
            r.workspace_id !== input.workspaceId ||
            r.org_id !== input.organizationId ||
            r.user_id !== scope.user_id ||
            r.generation !== input.generation ||
            integer(r.billing_epoch) !== input.billingEpoch ||
            r.policy_id !== input.policyId ||
            integer(r.seconds_per_dollar) !== input.secondsPerDollar,
        )
      )
        deny("compute_credit_conflict");
      const result: ComputeCreditReservation[] = [];
      for (const a of [...input.allocations].sort((x, y) =>
        x.periodId.localeCompare(y.periodId),
      )) {
        let period = (
          await tx.query<Period>(
            `SELECT *,clock_timestamp() AS evaluated_at FROM managed_compute_credit_periods WHERE id=$1 AND org_id=$2 AND user_id=$3 FOR UPDATE`,
            [a.periodId, input.organizationId, scope.user_id],
          )
        ).rows[0];
        if (
          !period ||
          instant(a.meterSince) < instant(period.starts_at) ||
          instant(a.coveredUntil) > instant(period.ends_at) ||
          instant(period.ends_at) <= instant(period.evaluated_at)
        )
          deny("compute_credit_period_unavailable");
        const prior = existing.find((r) => r.period_id === a.periodId);
        if (
          prior &&
          (prior.state !== "open" ||
            instant(prior.meter_since) !== instant(a.meterSince) ||
            instant(prior.covered_until) > instant(a.coveredUntil) ||
            integer(prior.authorized_micro_usd) > a.authorizationMicroUsd)
        )
          deny("compute_credit_conflict");
        const added =
          a.authorizationMicroUsd - integer(prior?.authorized_micro_usd ?? 0);
        if(scope.entitlement_plan==='pro') {
          await allocateComputeUserFunding(tx,{periodId:a.periodId,userId:scope.user_id,requiredAvailableMicroUsd:added});
          period=(await tx.query<Period>("SELECT *,clock_timestamp() AS evaluated_at FROM managed_compute_credit_periods WHERE id=$1",[a.periodId])).rows[0]!;
        } else if(period.funding_mode==='pro_user') deny("compute_credit_scope_rejected");
        const available =
          integer(period.granted_micro_usd) -
          integer(period.debited_micro_usd) -
          integer(period.reserved_micro_usd) - integer(period.returned_micro_usd);
        if (added > available) deny("compute_credit_exhausted");
        const row = prior
          ? (
              await tx.query<Reservation>(
                `UPDATE managed_compute_credit_reservations SET authorized_micro_usd=$3,reserved_micro_usd=reserved_micro_usd+$4,covered_until=$5,updated_at=now() WHERE id=$1 AND period_id=$2 RETURNING *`,
                [
                  input.reservationId,
                  a.periodId,
                  a.authorizationMicroUsd,
                  added,
                  a.coveredUntil,
                ],
              )
            ).rows[0]!
          : (
              await tx.query<Reservation>(
                `INSERT INTO managed_compute_credit_reservations(id,period_id,org_id,user_id,workspace_id,generation,billing_epoch,policy_id,seconds_per_dollar,meter_since,meter_through,covered_until,authorized_micro_usd,reserved_micro_usd)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12,$12) RETURNING *`,
                [
                  input.reservationId,
                  a.periodId,
                  input.organizationId,
                  scope.user_id,
                  input.workspaceId,
                  input.generation,
                  input.billingEpoch,
                  input.policyId,
                  input.secondsPerDollar,
                  a.meterSince,
                  a.coveredUntil,
                  a.authorizationMicroUsd,
                ],
              )
            ).rows[0]!;
        if (added)
          await tx.query(
            `UPDATE managed_compute_credit_periods SET reserved_micro_usd=reserved_micro_usd+$2,updated_at=now() WHERE id=$1`,
            [a.periodId, added],
          );
        await this.event(tx, period, "reserve", added, input.reservationId);
        result.push(document(row));
      }
      return result;
    });
  }

  /** Only call after exact provider identity and stopped/deleted state have
   * been independently checked. A timeout or an expired authorization is not
   * finalization proof. Usage is cumulative within this exact period segment. */
  async meter(input: {
    reservationId: string;
    periodId: string;
    usage: CloudProviderComputeUsage;
    finalReason?: Exclude<ComputeCreditFinalReason, "never_allocated" | "allocation_lost">;
    allocationLeaseClaim?: { owner: string };
  }): Promise<ComputeCreditReservation> {
    identity(input.reservationId, input.periodId);
    return this.mutateMeter(
      input.reservationId,
      input.periodId,
      async (tx, row, period) => {
        const usage = input.usage;
        const binding = (
          await tx.query<{ provider_resource_id: string | null }>(
            `SELECT provider_resource_id FROM cloud_workspace_provider_bindings WHERE workspace_id=$1 AND generation=$2 AND org_id=$3`,
            [row.workspace_id, row.generation, row.org_id],
          )
        ).rows[0];
        if (
          !binding?.provider_resource_id ||
          binding.provider_resource_id !== usage.resourceId ||
          usage.secondsPerDollar !== integer(row.seconds_per_dollar) ||
          instant(usage.since) !== instant(row.meter_since) ||
          instant(usage.until) < instant(usage.since) ||
          instant(usage.until) > instant(period.ends_at) ||
          instant(usage.until) > instant(period.evaluated_at) + 5000 ||
          integer(usage.billableSeconds) !== usage.billableSeconds ||
          computeMicroUsd(usage.billableSeconds, usage.secondsPerDollar) !==
            usage.listPriceMicroUsd ||
          (input.finalReason &&
            input.finalReason !== "period_ended" &&
            usage.running) ||
          (input.finalReason === "period_ended" &&
            (instant(usage.until) !== instant(period.ends_at) ||
              instant(period.ends_at) > instant(period.evaluated_at)))
        )
          deny("compute_credit_meter_rejected");
        if (instant(usage.until) < instant(row.meter_through)) {
          if (input.finalReason) deny("compute_credit_meter_rejected");
          return document(row);
        }
        const actual = usage.listPriceMicroUsd;
        if (
          actual < integer(row.actual_micro_usd) ||
          usage.billableSeconds < integer(row.billable_seconds) ||
          (instant(usage.until) === instant(row.meter_through) &&
            actual !== integer(row.actual_micro_usd))
        )
          deny("compute_credit_meter_rejected");
        if (row.state === "final") {
          if (
            actual !== integer(row.actual_micro_usd) ||
            (input.finalReason && input.finalReason !== row.final_reason)
          )
            deny("compute_credit_conflict");
          return document(row);
        }
        return this.applyMeter(tx, row, {
          actual,
          billableSeconds: usage.billableSeconds,
          through: new Date(usage.until),
          finalReason: input.finalReason ?? null,
        });
      },
      input.allocationLeaseClaim,
    );
  }

  /** The lifecycle coordinator must first prove that a rejected/cancelled
   * create never allocated. Absence of a saved resource ID alone is insufficient. */
  async releaseUnallocated(input: {
    reservationId: string;
    periodId: string;
    allocationLeaseClaim?: { owner: string };
  }): Promise<ComputeCreditReservation> {
    identity(input.reservationId, input.periodId);
    return this.mutateMeter(
      input.reservationId,
      input.periodId,
      async (tx, row) => {
        const binding = (
          await tx.query(
            `SELECT provider_resource_id FROM cloud_workspace_provider_bindings WHERE workspace_id=$1 AND generation=$2 AND org_id=$3`,
            [row.workspace_id, row.generation, row.org_id],
          )
        ).rows[0];
        if (
          binding?.provider_resource_id ||
          integer(row.actual_micro_usd) ||
          integer(row.billable_seconds)
        )
          deny("compute_credit_conflict");
        if (row.state === "final") {
          if (row.final_reason !== "never_allocated")
            deny("compute_credit_conflict");
          return document(row);
        }
        return this.applyMeter(tx, row, {
          actual: 0,
          billableSeconds: 0,
          through: row.meter_through,
          finalReason: "never_allocated",
        });
      },
      input.allocationLeaseClaim,
    );
  }

  /** Release a future period only after the coordinator proves the allocation
   * stopped before that period began. No provider query may request a future
   * usage window and treat its truncated response as a final zero meter. */
  async releaseBeforeWindow(input: {
    reservationId: string;
    periodId: string;
    resourceId: string;
    reason: "allocation_stopped" | "allocation_deleted";
    allocationLeaseClaim?: { owner: string };
  }): Promise<ComputeCreditReservation> {
    identity(input.reservationId, input.periodId);
    return this.mutateMeter(
      input.reservationId,
      input.periodId,
      async (tx, row, period) => {
        const binding = (
          await tx.query<{ provider_resource_id: string | null }>(
            `SELECT provider_resource_id FROM cloud_workspace_provider_bindings
        WHERE workspace_id=$1 AND generation=$2 AND org_id=$3`,
            [row.workspace_id, row.generation, row.org_id],
          )
        ).rows[0];
        if (
          !binding?.provider_resource_id ||
          binding.provider_resource_id !== input.resourceId ||
          instant(period.evaluated_at) >= instant(row.meter_since) ||
          integer(row.actual_micro_usd) !== 0 ||
          integer(row.billable_seconds) !== 0
        )
          deny("compute_credit_conflict");
        if (row.state === "final") {
          if (row.final_reason !== input.reason)
            deny("compute_credit_conflict");
          return document(row);
        }
        return this.applyMeter(tx, row, {
          actual: 0,
          billableSeconds: 0,
          through: row.meter_through,
          finalReason: input.reason,
        });
      },
      input.allocationLeaseClaim,
    );
  }

  /** Finalize at the last provider meter after an operator attested that the
   * provider lost the exact bound allocation, and with it the usage meter.
   * Unmetered time is never billed: the remaining hold is released. */
  async finalizeLost(input: {
    reservationId: string;
    periodId: string;
    resourceId: string;
    allocationLeaseClaim?: { owner: string };
  }): Promise<ComputeCreditReservation> {
    identity(input.reservationId, input.periodId);
    return this.mutateMeter(
      input.reservationId,
      input.periodId,
      async (tx, row) => {
        const lost = await tx.query(
          `SELECT 1 FROM cloud_workspace_provider_bindings binding
           JOIN cloud_workspace_provider_operations operation ON operation.workspace_id=binding.workspace_id
             AND operation.generation=binding.generation AND operation.org_id=binding.org_id
             AND operation.resource_id=binding.provider_resource_id AND operation.lost_at IS NOT NULL
           WHERE binding.workspace_id=$1 AND binding.generation=$2 AND binding.org_id=$3 AND binding.provider_resource_id=$4`,
          [row.workspace_id, row.generation, row.org_id, input.resourceId],
        );
        if (!lost.rowCount) deny("compute_credit_conflict");
        if (row.state === "final") {
          if (row.final_reason !== "allocation_lost")
            deny("compute_credit_conflict");
          return document(row);
        }
        return this.applyMeter(tx, row, {
          actual: integer(row.actual_micro_usd),
          billableSeconds: integer(row.billable_seconds),
          through: row.meter_through,
          finalReason: "allocation_lost",
        });
      },
      input.allocationLeaseClaim,
    );
  }

  private async mutateMeter<T>(
    id: string,
    periodId: string,
    operation: (tx: Tx, row: Reservation, period: Period) => Promise<T>,
    allocationLeaseClaim?: { owner: string },
  ): Promise<T> {
    if (allocationLeaseClaim && !/^[A-Za-z0-9:_-]{1,128}$/.test(allocationLeaseClaim.owner))
      deny("compute_credit_invalid");
    return withSystemTx(this.options.pool, async (tx) => {
      const scope = (
        await tx.query<Reservation>(
          `SELECT * FROM managed_compute_credit_reservations WHERE id=$1 AND period_id=$2`,
          [id, periodId],
        )
      ).rows[0];
      if (!scope) deny("compute_credit_unavailable");
      if (allocationLeaseClaim) {
        // Match reserve's funding-user → organization → workspace → lease →
        // credit-account order. The live claim is locked with the final debit
        // or refund, so a late provider response cannot spend another claim.
        await lockComputeUserFunding(tx, scope.user_id);
        await tx.query("SELECT 1 FROM organizations WHERE id=$1 FOR UPDATE", [scope.org_id]);
        await tx.query("SELECT 1 FROM cloud_workspaces WHERE id=$1 AND org_id=$2 FOR UPDATE", [scope.workspace_id, scope.org_id]);
        if (!(await tx.query(
          `SELECT 1 FROM managed_compute_allocation_leases
           WHERE id=$1 AND workspace_id=$2 AND org_id=$3 AND generation=$4 AND billing_epoch=$5 AND user_id=$6
             AND state<>'settled' AND lease_owner=$7 AND lease_expires_at>clock_timestamp() FOR UPDATE`,
          [id, scope.workspace_id, scope.org_id, scope.generation, scope.billing_epoch, scope.user_id, allocationLeaseClaim.owner],
        )).rowCount) deny("compute_lease_superseded");
      }
      await this.lockAccount(tx, {
        organizationId: scope.org_id,
        userId: scope.user_id,
      });
      const row = (
        await tx.query<Reservation>(
          `SELECT * FROM managed_compute_credit_reservations WHERE id=$1 AND period_id=$2 FOR UPDATE`,
          [id, periodId],
        )
      ).rows[0]!;
      const period = (
        await tx.query<Period>(
          `SELECT *,clock_timestamp() AS evaluated_at FROM managed_compute_credit_periods WHERE id=$1 FOR UPDATE`,
          [periodId],
        )
      ).rows[0]!;
      return operation(tx, row, period);
    });
  }

  private async applyMeter(
    tx: Tx,
    row: Reservation,
    input: {
      actual: number;
      billableSeconds: number;
      through: Date;
      finalReason: ComputeCreditFinalReason | null;
    },
  ): Promise<ComputeCreditReservation> {
    const actualDelta = input.actual - integer(row.actual_micro_usd);
    const debited = Math.min(actualDelta, integer(row.reserved_micro_usd));
    const exposure = actualDelta - debited;
    const released = input.finalReason
      ? integer(row.reserved_micro_usd) - debited
      : 0;
    await tx.query(
      `UPDATE managed_compute_credit_periods SET debited_micro_usd=debited_micro_usd+$2,
      reserved_micro_usd=reserved_micro_usd-$2-$3,exposure_micro_usd=exposure_micro_usd+$4,updated_at=now() WHERE id=$1`,
      [row.period_id, debited, released, exposure],
    );
    const next = (
      await tx.query<Reservation>(
        `UPDATE managed_compute_credit_reservations SET actual_micro_usd=$3,billable_seconds=$4,meter_through=$5,
      debited_micro_usd=debited_micro_usd+$6,reserved_micro_usd=reserved_micro_usd-$6-$7,exposure_micro_usd=exposure_micro_usd+$8,
      state=CASE WHEN $9::text IS NULL THEN 'open' ELSE 'final' END,final_reason=$9,updated_at=now()
      WHERE id=$1 AND period_id=$2 RETURNING *`,
        [
          row.id,
          row.period_id,
          input.actual,
          input.billableSeconds,
          input.through,
          debited,
          released,
          exposure,
          input.finalReason,
        ],
      )
    ).rows[0]!;
    await this.event(tx, row, "debit", debited, row.id);
    await this.event(tx, row, "release", released, row.id);
    await this.event(tx, row, "exposure", exposure, row.id);
    return document(next);
  }

  async balanceSystem(
    account: Account,
  ): Promise<
    Array<{
      periodId: string;
      startsAt: string;
      endsAt: string;
      grantedMicroUsd: number;
      debitedMicroUsd: number;
      reservedMicroUsd: number;
      exposureMicroUsd: number;
      availableMicroUsd: number;
    }>
  > {
    identity(account.organizationId, account.userId);
    return withSystemTx(this.options.pool, async (tx) =>
      (
        await tx.query<Period>(
          `SELECT *,clock_timestamp() AS evaluated_at FROM managed_compute_credit_periods WHERE org_id=$1 AND user_id=$2 ORDER BY starts_at,id`,
          [account.organizationId, account.userId],
        )
      ).rows.map((r) => ({
        periodId: r.id,
        startsAt: r.starts_at.toISOString(),
        endsAt: r.ends_at.toISOString(),
        grantedMicroUsd: integer(r.granted_micro_usd),
        debitedMicroUsd: integer(r.debited_micro_usd),
        reservedMicroUsd: integer(r.reserved_micro_usd),
        exposureMicroUsd: integer(r.exposure_micro_usd),
        availableMicroUsd:
          instant(r.starts_at) <= instant(r.evaluated_at) &&
          instant(r.evaluated_at) < instant(r.ends_at)
            ? integer(r.granted_micro_usd) -
              integer(r.debited_micro_usd) -
              integer(r.reserved_micro_usd) - integer(r.returned_micro_usd)
            : 0,
      })),
    );
  }

  /** A user may inspect their own funds after a paid subscription ends. This
   * does not confer spending authority or reveal another member's balance. */
  async balanceForUser(account: Account) {
    identity(account.organizationId, account.userId);
    return withSystemTx(this.options.pool, async (tx) => {
      const allowed = await tx.query(
        `SELECT 1 FROM organizations org JOIN organization_members membership ON membership.org_id=org.id
        JOIN users actor ON actor.id=membership.user_id WHERE org.id=$1 AND actor.id=$2 AND NOT org.is_personal
          AND org.deleted_at IS NULL AND actor.deleted_at IS NULL AND actor.auth_status='active' FOR SHARE OF org,membership,actor`,
        [account.organizationId, account.userId],
      );
      if (!allowed.rowCount)
        throw new HttpError(
          404,
          "compute_credit_scope_not_found",
          "Compute credit scope not found",
        );
      const rows = (
        await tx.query<Period>(
          `SELECT *,clock_timestamp() AS evaluated_at FROM managed_compute_credit_periods
        WHERE org_id=$1 AND user_id=$2 ORDER BY ends_at DESC,id DESC LIMIT 100`,
          [account.organizationId, account.userId],
        )
      ).rows;
      return rows.map((r) => ({
        periodId: r.id,
        startsAt: r.starts_at.toISOString(),
        endsAt: r.ends_at.toISOString(),
        grantedMicroUsd: integer(r.granted_micro_usd),
        debitedMicroUsd: integer(r.debited_micro_usd),
        reservedMicroUsd: integer(r.reserved_micro_usd),
        availableMicroUsd:
          instant(r.starts_at) <= instant(r.evaluated_at) &&
          instant(r.evaluated_at) < instant(r.ends_at)
            ? integer(r.granted_micro_usd) -
              integer(r.debited_micro_usd) -
              integer(r.reserved_micro_usd) - integer(r.returned_micro_usd)
            : 0,
      }));
    });
  }
}

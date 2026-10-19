import { requireFinalSaveDispatch } from "./final-save-recovery.js";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { retryAbortedDatabaseTransaction, withRetryableSystemTx } from "../db-retry.js";
import { isDatabaseUnavailable } from "../db.js";
import { audit } from "../audit.js";
import { DatabaseManagedComputeCreditLedger, readManagedComputeAllocationLost } from "./compute-credits.js";
import {computeUserFundingAuthorityLive,lockComputeUserFunding,prepareComputeUserPeriods,readStaffComputeAllowance} from "./compute-funding.js";
import {ensureProMonthlyAllowance} from "./pro-allowance.js";
import {
  planManagedComputeCredit,
  type ComputeCreditPlanningPeriod,
  type ComputeCreditPlan,
} from "./compute-credit-plan.js";
import type { CloudProviderComputeUsage, CloudWorkspaceComputeProvider } from "./provider-compute.js";
import {
  CloudProviderError,
  assertProviderResourceIdentity,
  type CloudProviderCreateInput,
  type CloudProviderResource,
  type CloudWorkspaceProvider,
} from "./provider.js";
import type { CloudWorkspaceProviderResolver } from "./provider-resolver.js";
import { assertSingleProviderResource } from "./provider.js";
import { requestManagedComputeStop } from "./compute-credit-stop.js";
import { classifyCloudFailure, diagnosticCode, type CloudDiagnostic, type CloudDiagnosticPhase, type ComputeFailureSite } from "./cloud-diagnostics.js";
import { retainCloudDiagnostic, diagnosticStorageFailed, recoverCloudDiagnostic } from "./cloud-diagnostic-store.js";
import { prepareCloudWorkspaceStopSeal } from "./stop-seal.js";
import { computeLeaseDueAtSql } from "./compute-rechecks.js";
import { measureLifecyclePhase } from "./lifecycle-timing.js";

export type ManagedComputePolicy = {
  provider: string;
  policyId: string;
  secondsPerDollar: number;
  minimumTtlSeconds: number;
  maximumTtlSeconds: number;
  requestMarginSeconds: number;
};
export type ManagedComputeStart = CloudProviderCreateInput & {
  organizationId: string;
  intentId: string;
};
type Lease = {
  current_generation?: number;
  observed_at?: Date;
  /** next_check_at when this pass claimed the lease, exact to the microsecond. */
  claimed_next_check_at?: string;
  /** Only this request snapshot may be acknowledged after a successful pass. */
  claimed_recheck_sequence: string;
  id: string;
  workspace_id: string;
  org_id: string;
  generation: number;
  billing_epoch: string;
  user_id: string;
  lifecycle_intent_id: string;
  provider: string;
  provider_resource_id: string | null;
  policy_id: string;
  seconds_per_dollar: string;
  weight_numerator: number;
  weight_denominator: number;
  ttl_seconds: number;
  requested_at: Date;
  funded_until: Date | null;
  provider_expires_at: Date | null;
  state: "funding" | "authorized" | "active" | "draining" | "settled";
  stopped_observed_at: Date | null;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  last_error_code: string | null;
};
type Scope = {
  user_id: string;
  billing_epoch: string;
  requires_credit: boolean;
  entitlement_plan: string;
  live: boolean;
  desired_state: string;
  generation: number;
  setup_failure_code: string | null;
};
function failure(code: string, retryable = false): CloudProviderError {
  return new CloudProviderError(
    code,
    "Managed compute needs a funded finite lease",
    retryable,
  );
}
function compute(
  provider: CloudWorkspaceProvider,
): CloudWorkspaceProvider & CloudWorkspaceComputeProvider {
  for (const method of [
    "computeWeight",
    "createWithComputeLease",
    "startWithComputeLease",
    "readComputeUsage",
    "renewComputeLease",
  ] as const) {
    if (
      typeof (provider as unknown as Record<string, unknown>)[method] !==
      "function"
    )
      throw failure("compute_provider_unqualified");
  }
  return provider as CloudWorkspaceProvider & CloudWorkspaceComputeProvider;
}
const money = (value: number | string): number => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0)
    throw failure("compute_credit_invalid");
  return n;
};
// Includes recovery of an abandoned 30-minute allocation claim, but never
// follows a moving funded_until/updated_at deadline or the provider's much
// longer idempotency retention window.
const ALLOCATION_RETRY_WINDOW_MS = 45 * 60_000;
/** A final meter queries this far behind the provider clock, so it can cover
 * the first stopped observation only once this much time has passed. */
const FINAL_METER_LAG_MS = 5000;
/** A stopped allocation's lower final reading may be a passing provider fault.
 * It settles at the confirmed meter only this long after the stop was first
 * observed, on a retry after an earlier rejection. */
const REGRESSED_FINAL_METER_GRACE_MS = 15 * 60_000;
const MAX_CHECKPOINT_DEADLINE_MS = 300_000;
const STOP_MARGIN_MS = 15_000;
const FORCE_STOP_MARGIN_MS = 45_000;
// Used only while a drain lacks positive stopped proof. Read the current row
// and original checkpoint, not a captured pre-I/O deadline. A stopped lease
// can remain draining solely for metering and must keep settlement backoff.
const confirmedRunwayDeadlineSql = `least(coalesce(lease.provider_expires_at,clock_timestamp()),coalesce(lease.funded_until,clock_timestamp()))`;
const pendingStopDeadlineSql = `least(
  ${confirmedRunwayDeadlineSql} - (${FORCE_STOP_MARGIN_MS}::bigint*interval '1 millisecond'),
  (SELECT min(request.deadline_at) FROM workspace_checkpoint_requests request
   WHERE request.lifecycle_intent_id=lease.stop_intent_id AND request.workspace_id=lease.workspace_id AND request.org_id=lease.org_id
     AND request.generation=coalesce((SELECT current_generation FROM cloud_workspace_allocation_owners WHERE allocation_lease_id=lease.id),lease.generation)
     AND NOT cloud_final_save_proven(lease.stop_intent_id)))`;
// Reserve the full checkpoint deadline plus the existing stop margin. Retry
// backoff must never sleep past this boundary, even during a lasting outage.
const PROVIDER_RETRY_SAFETY_MARGIN_MS = MAX_CHECKPOINT_DEADLINE_MS + STOP_MARGIN_MS;
// The Boat client already caps a provider wait at five minutes. An active
// allocation's runway bound still applies on top of it.
const MAX_PROVIDER_RETRY_AFTER_MS = 300_000;
// A healthy running lease is next checked at its renewal point, but never
// later than this, so a change that no trigger reports is still observed.
const RUNNING_LEASE_CHECK_CEILING_MS = 10 * 60_000;
const REGULAR_RECHECK_MS = 15_000;
// A running allocation's open reservation already holds its whole authorized
// window, so its non-final meter can wait this long. A stop or period end is
// still metered at once.
const USAGE_METER_WINDOW_MS = 60 * 60_000;
// A metered increment differing from the weighted wall-clock time by more than
// the larger of these is recorded for the operator.
const USAGE_DISAGREEMENT_MIN_SECONDS = 60;
const USAGE_DISAGREEMENT_RATIO = 0.05;

/** Owns spending authority around provider calls. It never accepts an engine's
 * CPU meter as compute billing, and a failed request never releases a hold. */
export class CloudWorkspaceComputeLeaseCoordinator {
  private readonly ledger: DatabaseManagedComputeCreditLedger;
  private readonly workerId = `compute:${randomUUID()}`;
  private readonly usageMeterWindowMs: number;
  constructor(
    private readonly options: {
      pool: pg.Pool;
      providerResolver?: CloudWorkspaceProviderResolver;
      provider?: CloudWorkspaceProvider;
      workosEnabled: boolean;
      policy?: ManagedComputePolicy;
      usageMeterWindowMs?: number;
      logger?: Pick<Console, "error">;
    },
  ) {
    this.ledger = new DatabaseManagedComputeCreditLedger(options);
    const p = options.policy;
    if (
      p &&
      (!/^[a-z][a-z0-9_-]{0,63}$/.test(p.provider) ||
        !/^[A-Za-z0-9._:-]{1,128}$/.test(p.policyId) ||
        !Number.isSafeInteger(p.secondsPerDollar) ||
        p.secondsPerDollar < 1 ||
        p.secondsPerDollar > 1_000_000_000_000 ||
        !Number.isSafeInteger(p.minimumTtlSeconds) ||
        p.minimumTtlSeconds < 60 ||
        !Number.isSafeInteger(p.maximumTtlSeconds) ||
        p.maximumTtlSeconds < p.minimumTtlSeconds ||
        p.maximumTtlSeconds > 3600 ||
        !Number.isSafeInteger(p.requestMarginSeconds) ||
        p.requestMarginSeconds < 5 ||
        p.requestMarginSeconds > 1800)
    )
      throw new Error("Invalid managed compute lease policy");
    const window = options.usageMeterWindowMs ?? USAGE_METER_WINDOW_MS;
    if (!Number.isSafeInteger(window) || window < 0 || window > USAGE_METER_WINDOW_MS)
      throw new Error("Invalid compute usage meter window");
    this.usageMeterWindowMs = window;
  }
  private async scope(input: {
    workspaceId: string;
    organizationId: string;
    generation: number;
  }): Promise<Scope> {
    return withRetryableSystemTx(this.options.pool, async (tx) => {
      const row = (
        await tx.query<Scope>(
          `SELECT workspace.owner_user_id AS user_id,workspace.current_billing_epoch AS billing_epoch,
        workspace.desired_state,workspace.current_generation AS generation,billing.entitlement_plan,
        (
          SELECT CASE WHEN setup.state='failed' THEN setup.error_code ELSE NULL END
          FROM cloud_workspace_setup_runs setup WHERE setup.workspace_id=workspace.id AND setup.org_id=workspace.org_id
            AND setup.generation=workspace.current_generation ORDER BY setup.attempt DESC LIMIT 1
        ) AS setup_failure_code,
        version.credential_source='hosted' AND coalesce(requirement.require_credit,true) AS requires_credit,
        cloud_workspace_paid_authority_live(workspace.id,workspace.owner_user_id,$4)
          AND workspace.status<>'failed'
          AND (workspace.status NOT IN ('ready','busy') OR EXISTS (
            SELECT 1 FROM cloud_workspace_engine_instances engine WHERE engine.workspace_id=workspace.id
              AND engine.org_id=workspace.org_id AND engine.generation=workspace.current_generation
              AND engine.state='ready' AND engine.revoked_at IS NULL AND engine.lease_expires_at>clock_timestamp()
          )) AS live
        FROM cloud_workspaces workspace JOIN cloud_workspace_generations generation
          ON generation.workspace_id=workspace.id AND generation.org_id=workspace.org_id AND generation.generation=$3
        JOIN workspace_billing_epochs billing ON billing.workspace_id=workspace.id AND billing.org_id=workspace.org_id AND billing.billing_epoch=workspace.current_billing_epoch
        JOIN provider_connection_versions version ON version.connection_id=generation.provider_connection_id
          AND version.org_id=generation.org_id AND version.version=generation.provider_connection_version
        LEFT JOIN managed_compute_provider_requirements requirement ON requirement.provider=generation.provider
        WHERE workspace.id=$1 AND workspace.org_id=$2 AND workspace.deleted_at IS NULL`,
          [
            input.workspaceId,
            input.organizationId,
            input.generation,
            this.options.workosEnabled,
          ],
        )
      ).rows[0];
      if (!row) throw failure("compute_scope_unavailable");
      if(row.live&&row.requires_credit&&row.entitlement_plan==='pro')row.live=await computeUserFundingAuthorityLive(tx,row.user_id);
      return row;
    });
  }
  private async prepare(
    input: ManagedComputeStart,
    scope: Scope,
    provider: CloudWorkspaceProvider & CloudWorkspaceComputeProvider,
    owner: string,
  ): Promise<Lease> {
    const policy = this.options.policy;
    if (!policy || policy.provider !== provider.name)
      throw failure("compute_policy_unavailable");
    const weight = provider.computeWeight(input);
    return withRetryableSystemTx(this.options.pool, async (tx) => {
      await tx.query("SELECT 1 FROM organizations WHERE id=$1 FOR UPDATE", [
        input.organizationId,
      ]);
      await tx.query(
        "SELECT 1 FROM cloud_workspaces WHERE id=$1 AND org_id=$2 FOR UPDATE",
        [input.workspaceId, input.organizationId],
      );
      if (
        !(
          await tx.query(
            `SELECT 1 FROM cloud_workspace_lifecycle_intents WHERE id=$1 AND workspace_id=$2 AND org_id=$3
        AND generation=$4 AND operation IN ('create','wake') AND state IN ('queued','dispatching','observing')`,
            [
              input.intentId,
              input.workspaceId,
              input.organizationId,
              input.generation,
            ],
          )
        ).rowCount
      )
        throw failure("compute_lease_superseded");
      const existing = (
        await tx.query<Lease>(
          `SELECT * FROM managed_compute_allocation_leases WHERE workspace_id=$1 AND generation=$2 AND state<>'settled' FOR UPDATE`,
          [input.workspaceId, input.generation],
        )
      ).rows[0];
      if (existing) {
        if (existing.lifecycle_intent_id !== input.intentId)
          throw failure("compute_previous_lease_pending", true);
        if (
          existing.org_id !== input.organizationId ||
          existing.user_id !== scope.user_id ||
          money(existing.billing_epoch) !== money(scope.billing_epoch) ||
          existing.policy_id !== policy.policyId ||
          money(existing.seconds_per_dollar) !== policy.secondsPerDollar
        )
          throw failure("compute_credit_conflict");
      }
      const prior = !existing && (
        await tx.query(
          "SELECT 1 FROM managed_compute_allocation_leases WHERE id=$1",
          [input.intentId],
        )
      ).rowCount;
      if (prior) throw failure("compute_credit_conflict");
      if (!existing) await tx.query<Lease>(
          `INSERT INTO managed_compute_allocation_leases(id,workspace_id,org_id,generation,billing_epoch,user_id,
        lifecycle_intent_id,provider,policy_id,seconds_per_dollar,weight_numerator,weight_denominator,ttl_seconds,state)
        VALUES ($1,$2,$3,$4,$5,$6,$1,$7,$8,$9,$10,$11,$12,'funding') RETURNING *`,
          [
            input.intentId,
            input.workspaceId,
            input.organizationId,
            input.generation,
            scope.billing_epoch,
            scope.user_id,
            provider.name,
            policy.policyId,
            policy.secondsPerDollar,
            weight.numerator,
            weight.denominator,
            policy.maximumTtlSeconds,
          ],
        );
      // Creation and claiming are one transaction. A metering worker must
      // never observe a newly inserted, unclaimed funding lease and settle it
      // before the lifecycle worker has dispatched its first request.
      const claimed = (await tx.query<Lease>(
        `UPDATE managed_compute_allocation_leases
         SET lease_owner=$2,lease_expires_at=clock_timestamp()+interval '30 minutes'
         WHERE id=$1 AND state IN ('funding','authorized','active')
           AND (lease_owner IS NULL OR lease_expires_at<=clock_timestamp()) RETURNING *`,
        [existing?.id ?? input.intentId, owner],
      )).rows[0];
      if (!claimed) throw failure("compute_lease_busy", true);
      return claimed;
    }).catch(async (error: unknown) => {
      // The refused start waits for this lease to settle, which a long healthy cadence would otherwise delay.
      if (error instanceof CloudProviderError && error.code === "compute_previous_lease_pending")
        await withRetryableSystemTx(this.options.pool, (tx) => tx.query(
          `UPDATE managed_compute_allocation_leases SET next_check_at=clock_timestamp()
        WHERE workspace_id=$1 AND generation=$2 AND state<>'settled'
          AND lifecycle_intent_id IS DISTINCT FROM $3 AND (next_check_at>clock_timestamp() OR lease_owner IS NOT NULL)`,
          [input.workspaceId, input.generation, input.intentId],
        )).catch(() => undefined);
      throw error;
    });
  }

  private async plan(
    lease: Lease,
    fixedTtl = false,
  ): Promise<ComputeCreditPlan | null> {
    const policy = this.options.policy;
    if (
      !policy ||
      policy.policyId !== lease.policy_id ||
      policy.secondsPerDollar !== money(lease.seconds_per_dollar)
    )
      throw failure("compute_policy_changed");
    return withRetryableSystemTx(this.options.pool, async (tx) => {
      const billing=(await tx.query<{entitlement_plan:string}>(`SELECT entitlement_plan FROM workspace_billing_epochs
        WHERE workspace_id=$1 AND org_id=$2 AND billing_epoch=$3 AND billing_owner_user_id=$4`,
        [lease.workspace_id,lease.org_id,lease.billing_epoch,lease.user_id])).rows[0];
      let staffAllowance=false;
      if(billing?.entitlement_plan==='pro') {
        await lockComputeUserFunding(tx,lease.user_id);
        const allowance=await ensureProMonthlyAllowance(tx,lease.user_id,policy);
        if(allowance.state!=="ready")throw failure(`compute_allowance_${allowance.state}`);
        staffAllowance=Boolean(await readStaffComputeAllowance(tx,lease.user_id));
        await prepareComputeUserPeriods(tx,{userId:lease.user_id,organizationId:lease.org_id});
      }
      const now = (await tx.query<{now:Date}>("SELECT clock_timestamp() AS now")).rows[0]!.now.getTime();
      const rows = (
        await tx.query(
          `SELECT period.*,reservation.meter_since,reservation.meter_through,reservation.billable_seconds,
        EXISTS(SELECT 1 FROM managed_compute_pro_allowances WHERE period_id=period.funding_period_id) AS monthly_allowance,
        reservation.actual_micro_usd,reservation.debited_micro_usd AS reservation_debited,reservation.authorized_micro_usd,reservation.covered_until,
        CASE WHEN period.funding_mode='pro_user' THEN
          (SELECT greatest((CASE WHEN NOT $4::boolean AND base.id IS NOT NULL THEN base.amount_micro_usd ELSE root.granted_micro_usd END)-coalesce((SELECT sum(child.debited_micro_usd+child.reserved_micro_usd)
            FROM managed_compute_credit_periods child WHERE child.funding_period_id=root.id),0)
           ,0) FROM managed_compute_user_periods root LEFT JOIN managed_compute_pro_allowances allowance ON allowance.period_id=root.id
             LEFT JOIN managed_compute_funding_receipts base ON base.id=allowance.receipt_id WHERE root.id=period.funding_period_id)
          ELSE period.granted_micro_usd-period.debited_micro_usd-period.reserved_micro_usd-period.returned_micro_usd END AS available
        FROM managed_compute_credit_periods period LEFT JOIN managed_compute_credit_reservations reservation
          ON reservation.period_id=period.id AND reservation.id=$3 AND reservation.state='open'
        WHERE period.org_id=$1 AND period.user_id=$2 AND period.ends_at>clock_timestamp()
          AND period.starts_at<clock_timestamp()+interval '2 hours' ORDER BY period.starts_at,period.id LIMIT 17`,
          [lease.org_id, lease.user_id, lease.id,staffAllowance],
        )
      ).rows;
      const periods: ComputeCreditPlanningPeriod[] = rows.map((r) => ({
        id: r.id,
        startsAtMs: r.starts_at.getTime(),
        endsAtMs: r.ends_at.getTime(),
        availableMicroUsd: money(r.available),
        staffAllowance: staffAllowance&&r.monthly_allowance,
        ...(r.meter_since
          ? {
              reservation: {
                meterSinceMs: r.meter_since.getTime(),
                meterThroughMs: r.meter_through.getTime(),
                billableSeconds: money(r.billable_seconds),
                actualMicroUsd: money(r.actual_micro_usd),
                debitedMicroUsd: money(r.reservation_debited),
                authorizedMicroUsd: money(r.authorized_micro_usd),
                coveredUntilMs: r.covered_until.getTime(),
              },
            }
          : {}),
      }));
      return planManagedComputeCredit({
        nowMs: now,
        allocationStartedAtMs: lease.requested_at.getTime(),
        periods,
        secondsPerDollar: money(lease.seconds_per_dollar),
        weightNumerator: lease.weight_numerator,
        weightDenominator: lease.weight_denominator,
        minimumTtlSeconds: fixedTtl
          ? lease.ttl_seconds
          : policy.minimumTtlSeconds,
        maximumTtlSeconds: fixedTtl
          ? lease.ttl_seconds
          : policy.maximumTtlSeconds,
        requestMarginSeconds: policy.requestMarginSeconds,
      });
    });
  }

  private async fund(
    lease: Lease,
    plan: ComputeCreditPlan,
    owner: string,
  ): Promise<void> {
    await retryAbortedDatabaseTransaction(() => this.ledger.reserve({
      organizationId: lease.org_id,
      workspaceId: lease.workspace_id,
      generation: lease.generation,
      billingEpoch: money(lease.billing_epoch),
      reservationId: lease.id,
      policyId: lease.policy_id,
      secondsPerDollar: money(lease.seconds_per_dollar),
      allocations: plan.allocations,
      allocationLeaseClaim: { owner },
    }));
    await withRetryableSystemTx(this.options.pool, async (tx) => {
      const result = await tx.query(
        `UPDATE managed_compute_allocation_leases SET funded_until=greatest(funded_until,$2),
        ttl_seconds=CASE WHEN state='funding' THEN $3 ELSE ttl_seconds END,
        state=CASE WHEN state='funding' THEN 'authorized' ELSE state END,updated_at=now(),
        last_error_code=CASE WHEN state='active' THEN last_error_code ELSE NULL END,
        first_error_at=CASE WHEN state='active' THEN first_error_at ELSE NULL END
        WHERE id=$1 AND state IN ('funding','authorized','active') AND lease_owner=$4 AND lease_expires_at>clock_timestamp()
        RETURNING id`,
        [lease.id, plan.fundedUntil, plan.ttlSeconds, owner],
      );
      if (!result.rowCount) throw failure("compute_lease_superseded");
    });
  }

  /** Lifecycle callers must use this method for every new allocation/resume,
   * even when the requested default provider has no managed credit policy. The
   * saved connection version, not a client flag, selects the BYO bypass. */
  async allocate(
    input: ManagedComputeStart,
    provider: CloudWorkspaceProvider,
    current: CloudProviderResource | null,
  ): Promise<CloudProviderResource> {
    const scope = await measureLifecyclePhase("funding", () => this.scope(input));
    if (
      !scope.live ||
      scope.desired_state !== "running" ||
      scope.generation !== input.generation
    )
      throw failure("compute_scope_unavailable");
    if (!scope.requires_credit)
      return current
        ? provider.start(current.resourceId)
        : provider.create(input);
    const metered = compute(provider);
    // The lifecycle worker already serializes each intent. Claim this lease as
    // well so the metering worker cannot settle it during a provider request.
    const owner = `allocation:${randomUUID()}`;
    const lease = await measureLifecyclePhase("funding", () => this.prepare(input, scope, metered, owner));
    try {
      await measureLifecyclePhase("funding", () => this.assertAllocationRetryDeadline(lease));
      const plan = await measureLifecyclePhase("funding", () => this.plan(lease, lease.state !== "funding"));
      if (!plan) throw failure("compute_credit_exhausted");
      await measureLifecyclePhase("funding", () => this.fund(lease, plan, owner));
      // A lifecycle/ownership change during funding prevents dispatch, while
      // the reservation remains until independent absence/stop evidence.
      const currentScope = await measureLifecyclePhase("funding", () => this.scope(input));
      if (
        !currentScope.live ||
        currentScope.desired_state !== "running" ||
        currentScope.generation !== input.generation ||
        currentScope.user_id !== lease.user_id ||
        money(currentScope.billing_epoch) !== money(lease.billing_epoch)
      )
        throw failure("compute_lease_superseded");
      await measureLifecyclePhase("funding", () => this.assertAllocationRetryDeadline(lease));
      const resource = current
        ? await metered.startWithComputeLease(
            current.resourceId,
            plan.ttlSeconds,
          )
        : await metered.createWithComputeLease(input, plan.ttlSeconds);
      assertProviderResourceIdentity(resource, input);
      await measureLifecyclePhase("postDispatchObservation", () => this.observeRunning(input, provider, resource));
      return resource;
    } catch (error) {
      if (
        error instanceof CloudProviderError &&
        [
          "compute_credit_exhausted",
          "compute_policy_changed",
          "compute_credit_scope_rejected",
          "compute_allocation_retry_expired",
          // Not billed to the configured wallet: stop it rather than run to its TTL.
          "provider_billing_scope_mismatch",
          "provider_billing_scope_unconfirmed",
        ].includes(error.code)
      )
        await requestManagedComputeStop(this.options.pool, {
          leaseId: lease.id,
          reason: error.code,
          force: true,
          expectedLeaseOwner: owner,
        });
      throw error;
    } finally {
      await withRetryableSystemTx(this.options.pool, (tx) =>
        tx.query(
          `UPDATE managed_compute_allocation_leases
        SET lease_owner=NULL,lease_expires_at=NULL,next_check_at=now(),updated_at=now() WHERE id=$1 AND lease_owner=$2`,
          [lease.id, owner],
        ),
      );
    }
  }

  /** Reconcile a lost create/resume reply before declaring a running VM ready.
   * Provider liveness alone never establishes spending authority. Requests a
   * check of the lease unless the caller is that check (`requestCheck: false`),
   * which schedules the next one itself. */
  async observeRunning(
    input: { workspaceId: string; organizationId: string; generation: number },
    provider: CloudWorkspaceProvider,
    resource: CloudProviderResource,
    { requestCheck = true }: { requestCheck?: boolean } = {},
  ): Promise<void> {
    assertProviderResourceIdentity(resource, input);
    const scope = await this.scope(input);
    if (!scope.requires_credit) return;
    const expires =
      typeof resource.metadata.computeLeaseExpiresAt === "string"
        ? Date.parse(resource.metadata.computeLeaseExpiresAt)
        : NaN;
    await withRetryableSystemTx(this.options.pool, async (tx) => {
      const lease = (
        await tx.query<Lease>(
          `SELECT * FROM managed_compute_allocation_leases lease WHERE workspace_id=$1 AND org_id=$2 AND coalesce((SELECT current_generation FROM cloud_workspace_allocation_owners WHERE allocation_lease_id=lease.id),generation)=$3 AND state<>'settled' FOR UPDATE`,
          [input.workspaceId, input.organizationId, input.generation],
        )
      ).rows[0];
      const now = (
        await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now")
      ).rows[0]!.now.getTime();
      if (
        !lease ||
        lease.provider !== provider.name ||
        lease.state === "funding" ||
        lease.state === "draining" ||
        !lease.funded_until ||
        lease.funded_until.getTime() <= now ||
        lease.user_id !== scope.user_id ||
        money(lease.billing_epoch) !== money(scope.billing_epoch) ||
        !scope.live ||
        scope.desired_state !== "running" ||
        scope.generation !== input.generation ||
        (lease.provider_resource_id !== null &&
          lease.provider_resource_id !== resource.resourceId)
      )
        throw failure("compute_lease_unfunded");
      if (
        resource.state === "running" &&
        (!Number.isFinite(expires) ||
          expires <= now ||
          expires > lease.funded_until.getTime())
      )
        throw failure("compute_lease_unconfirmed", true);
      await tx.query(
        `UPDATE managed_compute_allocation_leases SET provider_resource_id=$2,
        provider_expires_at=greatest(provider_expires_at,$3::timestamptz),stopped_observed_at=NULL,
        state=CASE WHEN $4 THEN 'active' ELSE state END,updated_at=now(),next_check_at=CASE WHEN $5 THEN now() ELSE next_check_at END
        WHERE id=$1`,
        [
          lease.id,
          resource.resourceId,
          resource.state === "running" ? new Date(expires) : null,
          resource.state === "running",
          requestCheck,
        ],
      );
    });
  }

  private identity(lease: Lease) {
    return {
      workspaceId: lease.workspace_id,
      organizationId: lease.org_id,
      generation: lease.current_generation ?? lease.generation,
    };
  }
  private async stillClaimed(lease: Lease): Promise<void> {
    const live = await withRetryableSystemTx(
      this.options.pool,
      async (tx) =>
        (
          await tx.query(
            `SELECT 1 FROM managed_compute_allocation_leases
      WHERE id=$1 AND lease_owner=$2 AND lease_expires_at>clock_timestamp() AND state<>'settled'`,
            [lease.id, this.workerId],
          )
        ).rowCount,
    );
    if (!live) throw failure("compute_lease_superseded");
  }
  private async now(): Promise<number> {
    return withRetryableSystemTx(this.options.pool, async (tx) =>
      (
        await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now")
      ).rows[0]!.now.getTime(),
    );
  }
  private async assertAllocationRetryDeadline(lease: Lease): Promise<void> {
    if (lease.provider_expires_at === null &&
        (await this.now()) >= lease.requested_at.getTime() + ALLOCATION_RETRY_WINDOW_MS)
      throw failure("compute_allocation_retry_expired");
  }

  /** A retryable create/wake outcome is not a budget expiry. Keep the hold
   * until the same admitted start can retry, without making an absence claim
   * or granting execution authority to an unconfirmed allocation. */
  private async pendingAllocationRetry(lease: Lease): Promise<boolean> {
    return withRetryableSystemTx(this.options.pool, async (tx) => (await tx.query(
      `SELECT 1 FROM managed_compute_allocation_leases lease
       JOIN cloud_workspace_lifecycle_intents intent ON intent.id=lease.lifecycle_intent_id
         AND intent.workspace_id=lease.workspace_id AND intent.org_id=lease.org_id
         AND intent.generation=lease.generation AND intent.operation IN ('create','wake')
         AND intent.state IN ('queued','dispatching','observing')
       JOIN cloud_workspaces workspace ON workspace.id=lease.workspace_id AND workspace.org_id=lease.org_id
         AND workspace.current_generation=lease.generation AND workspace.current_billing_epoch=lease.billing_epoch
         AND workspace.owner_user_id=lease.user_id AND workspace.desired_state='running'
         AND workspace.status NOT IN ('failed','deleted') AND workspace.deleted_at IS NULL
       WHERE lease.id=$1 AND lease.lease_owner=$2 AND lease.lease_expires_at>clock_timestamp()
         AND lease.state IN ('funding','authorized') AND lease.provider_expires_at IS NULL
         AND lease.requested_at+($3::bigint*interval '1 millisecond')>clock_timestamp()
         AND (lease.state='funding' OR lease.funded_until>clock_timestamp()+interval '45 seconds')
         AND cloud_workspace_paid_authority_live(workspace.id,lease.user_id,$4)`,
      [lease.id, this.workerId, ALLOCATION_RETRY_WINDOW_MS, this.options.workosEnabled],
    )).rowCount === 1);
  }
  private runwayDeadline(lease: Lease): number {
    return Math.min(lease.provider_expires_at?.getTime() ?? 0, lease.funded_until?.getTime() ?? 0);
  }

  private async activeAllocationRetry(lease: Lease): Promise<boolean> {
    if (lease.state !== "active") return false;
    // A failed transaction may have overlapped Stop, claim recovery or a
    // shortened budget. The captured lease alone cannot authorize a retry.
    const current = await withRetryableSystemTx(this.options.pool, async tx => (await tx.query<{
      funded_until: Date; provider_expires_at: Date; reservation_valid: boolean;
    }>(`SELECT funded_until,provider_expires_at,
        EXISTS (SELECT 1 FROM managed_compute_credit_reservations reservation WHERE reservation.id=lease.id
          AND reservation.workspace_id=lease.workspace_id AND reservation.org_id=lease.org_id
          AND reservation.generation=lease.generation AND reservation.billing_epoch=lease.billing_epoch AND reservation.user_id=lease.user_id) AS reservation_valid
      FROM managed_compute_allocation_leases lease
      WHERE id=$1 AND lease_owner=$2 AND lease_expires_at>clock_timestamp() AND state='active'
        AND provider_resource_id=$3 AND user_id=$4 AND billing_epoch=$5 AND provider=$6
        AND workspace_id=$7 AND org_id=$8 AND generation=$9
        AND coalesce((SELECT current_generation FROM cloud_workspace_allocation_owners WHERE allocation_lease_id=lease.id),generation)=$10`,
    [lease.id,this.workerId,lease.provider_resource_id,lease.user_id,lease.billing_epoch,lease.provider,
      lease.workspace_id,lease.org_id,lease.generation,this.identity(lease).generation])).rows[0]);
    if (!current) throw failure("compute_lease_superseded");
    lease.funded_until = current.funded_until;
    lease.provider_expires_at = current.provider_expires_at;
    if (!current.reservation_valid) return false;
    const scope = await this.scope(this.identity(lease));
    if (!scope.live || scope.desired_state !== "running" || scope.generation !== this.identity(lease).generation ||
        scope.user_id !== lease.user_id || money(scope.billing_epoch) !== money(lease.billing_epoch)) return false;
    if ((await this.boundAllocation(lease))?.lost) return false;
    await this.stillClaimed(lease);
    return true;
  }

  private async stopAtBudget(lease: Lease, reason: string, incidentId?: string | null, stopReason?: "provider_outage" | "control_plane_unavailable"): Promise<void> {
    const now = await this.now();
    const remaining =
      Math.min(
        lease.provider_expires_at?.getTime() ?? now,
        lease.funded_until?.getTime() ?? now,
      ) - now;
    await requestManagedComputeStop(this.options.pool, {
      leaseId: lease.id,
      reason,
      ...(stopReason ? { stopReason } : {}),
      ...(incidentId ? { incidentId } : {}),
      force: remaining <= FORCE_STOP_MARGIN_MS,
      expectedLeaseOwner: this.workerId,
      expectedGeneration: this.identity(lease).generation,
      checkpointDeadlineMs: Math.max(
        30_000,
        Math.min(MAX_CHECKPOINT_DEADLINE_MS, remaining - STOP_MARGIN_MS),
      ),
    });
  }

  private async escalateDueStop(lease: Lease): Promise<void> {
    if (lease.state !== "draining") return;
    const due = await withRetryableSystemTx(this.options.pool, tx => tx.query(
      `SELECT 1 FROM managed_compute_allocation_leases lease
       WHERE id=$1 AND lease_owner=$2 AND lease_expires_at>clock_timestamp()
         AND state='draining' AND stopped_observed_at IS NULL
         AND coalesce((SELECT current_generation FROM cloud_workspace_allocation_owners WHERE allocation_lease_id=lease.id),generation)=$3
         AND ${pendingStopDeadlineSql}<=clock_timestamp()`,
      [lease.id, this.workerId, this.identity(lease).generation],
    ));
    if (due.rowCount) {
      const handledNextCheckAt = await requestManagedComputeStop(this.options.pool, {
        leaseId: lease.id, reason: lease.last_error_code ?? "compute_scope_unavailable", force: true,
        expectedLeaseOwner: this.workerId, expectedGeneration: this.identity(lease).generation,
        ...(lease.claimed_next_check_at !== undefined ? { expectedNextCheckAt: lease.claimed_next_check_at } : {}),
      });
      if (handledNextCheckAt !== undefined) lease.claimed_next_check_at = handledNextCheckAt;
    }
  }

  /** Stop and meter before permanently deleting the provider's usage API.
   * The normal lifecycle reconciler retries after settlement; timeouts retain
   * customer holds and never masquerade as a verified zero bill. */
  async beforeDelete(
    input: { workspaceId: string; organizationId: string; generation: number;
      dispatchClaim?: { intentId: string; workerId: string; attemptCount: number; authorityEpoch: string | number } },
    provider: CloudWorkspaceProvider,
    resource: CloudProviderResource,
  ): Promise<boolean> {
    const lease = await withRetryableSystemTx(
      this.options.pool,
      async (tx) =>
        (
          await tx.query<Lease>(
            `SELECT * FROM managed_compute_allocation_leases
      WHERE workspace_id=$1 AND org_id=$2 AND coalesce((SELECT current_generation FROM cloud_workspace_allocation_owners WHERE allocation_lease_id=managed_compute_allocation_leases.id),generation)=$3 AND state<>'settled'`,
            [input.workspaceId, input.organizationId, input.generation],
          )
        ).rows[0],
    );
    if (!lease) return true;
    assertProviderResourceIdentity(resource, input);
    const stopGate = await withRetryableSystemTx(this.options.pool, async tx => {
      await tx.query("SELECT id FROM organizations WHERE id=$1 FOR SHARE", [input.organizationId]);
      await tx.query("SELECT id FROM cloud_workspaces WHERE id=$1 AND org_id=$2 FOR UPDATE", [input.workspaceId, input.organizationId]);
      const intent = (await tx.query<{ id: string; operation: "stop" | "archive" | "delete"; requested_by: string | null }>(
        `SELECT id,operation,requested_by FROM cloud_workspace_lifecycle_intents
         WHERE workspace_id=$1 AND org_id=$2 AND generation=$3 AND operation IN ('stop','archive','delete')
           AND state IN ('queued','observing','dispatching') ORDER BY created_at DESC,id LIMIT 1`,
        [input.workspaceId, input.organizationId, input.generation],
      )).rows[0];
      return intent ? { ready: await prepareCloudWorkspaceStopSeal(tx, {
        ...input, intentId: intent.id, operation: intent.operation, requestedBy: intent.requested_by,
      }) } : null;
    });
    if (!stopGate) {
      // A direct settlement caller has no lifecycle claim proving a drain.
      // Admit a bounded stop first; its reconciler owns the provider dispatch.
      const now = await this.now();
      const remaining = Math.min(lease.provider_expires_at?.getTime() ?? now, lease.funded_until?.getTime() ?? now) - now;
      await requestManagedComputeStop(this.options.pool, {
        leaseId: lease.id, reason: "compute_delete_settlement", force: remaining < 45_000,
        checkpointDeadlineMs: Math.max(30_000, Math.min(MAX_CHECKPOINT_DEADLINE_MS, remaining - STOP_MARGIN_MS)),
      });
      return false;
    }
    // The lifecycle caller normally proved its final checkpoint before claim.
    // Settlement must not turn an overlapping user drain into a forced stop.
    if (!stopGate.ready) return false;
    await requestManagedComputeStop(this.options.pool, {
      leaseId: lease.id,
      reason: "compute_delete_settlement",
      force: true,
    });
    if (
      ![
        "stopped",
        "archived",
        "stopping",
        "archiving",
        "deleted",
        "deleting",
      ].includes(resource.state)
    ) {
      if (!input.dispatchClaim) return false;
      await requireFinalSaveDispatch(this.options.pool, { ...input, ...input.dispatchClaim, providerResourceId: resource.resourceId });
      const stopped = await provider.stop(resource.resourceId);
      assertProviderResourceIdentity(stopped, input);
    }
    await withRetryableSystemTx(this.options.pool, (tx) =>
      tx.query(
        `UPDATE managed_compute_allocation_leases SET next_check_at=now() WHERE id=$1`,
        [lease.id],
      ),
    );
    return false;
  }

  /** Reconcile one due lease, optionally only for one workspace. */
  async runOnce(workspaceId: string | null = null): Promise<boolean> {
    const claimStarted = performance.now();
    const lease = await withRetryableSystemTx(
      this.options.pool,
      async (tx) =>
        (
          await tx.query<Lease>(
            `WITH candidate AS (
      SELECT lease.id FROM managed_compute_allocation_leases lease WHERE lease.state<>'settled' AND (${computeLeaseDueAtSql})<=clock_timestamp()
        AND ($2::uuid IS NULL OR lease.workspace_id=$2)
        AND NOT EXISTS(SELECT 1 FROM cloud_workspace_runtime_transitions runtime
          WHERE runtime.workspace_id=lease.workspace_id
            AND ((runtime.phase IN ('activated','enrolling','checking') AND runtime.activation_deadline_at>clock_timestamp())
              OR (runtime.phase IN ('rolling_back','rollback_enrolling','rollback_checking') AND runtime.rollback_deadline_at>clock_timestamp())))
        AND (lease.lease_owner IS NULL OR lease.lease_expires_at<=clock_timestamp()) ORDER BY ${computeLeaseDueAtSql},lease.id FOR UPDATE OF lease SKIP LOCKED LIMIT 1)
      UPDATE managed_compute_allocation_leases lease SET lease_owner=$1,lease_expires_at=clock_timestamp()+interval '5 minutes'
      FROM candidate WHERE lease.id=candidate.id RETURNING lease.*,lease.next_check_at::text AS claimed_next_check_at,clock_timestamp() AS observed_at,
        coalesce((SELECT requested_sequence FROM cloud_workspace_compute_rechecks WHERE allocation_lease_id=lease.id),0)::text AS claimed_recheck_sequence,
        coalesce((SELECT current_generation FROM cloud_workspace_allocation_owners WHERE allocation_lease_id=lease.id),lease.generation) AS current_generation`,
            [this.workerId, workspaceId],
          )
        ).rows[0],
    );
    if (!lease) return false;
    let recheckAt: Date | null = null, failed = false, retryAfterMs: number | null = null;
    let phase: CloudDiagnosticPhase = "provider_inspect", phaseStarted = performance.now();
    let site: ComputeFailureSite | undefined;
    try {
      recheckAt = await this.reconcile(lease, (next, nextSite) => { phase = next; site = nextSite; phaseStarted = performance.now(); });
      phase = "ledger_commit"; site = "reconciliation_bookkeeping"; phaseStarted = performance.now();
      await withRetryableSystemTx(this.options.pool, (tx) =>
        tx.query(
          `UPDATE managed_compute_allocation_leases SET last_error_code=NULL,first_error_at=NULL
        WHERE id=$1 AND lease_owner=$2 AND state='active'`,
          [lease.id, this.workerId],
        ),
      );
      await recoverCloudDiagnostic(this.options.pool, {
        ...this.identity(lease), leaseId: lease.id, leaseOwner: this.workerId,
      }).catch(() => undefined);
    } catch (error) {
      failed = true;
      let diagnostic: CloudDiagnostic = { ...classifyCloudFailure(error, phase), ...(site ? { site } : {}) };
      const transientProvider = error instanceof CloudProviderError && error.retryable &&
        diagnostic.providerCode?.startsWith("provider_") === true && diagnostic.code !== "provider_resource_lost";
      if (error instanceof CloudProviderError && error.retryable && Number.isFinite(error.retryAfterMs))
        retryAfterMs = Math.min(MAX_PROVIDER_RETRY_AFTER_MS, Math.max(0, Math.floor(error.retryAfterMs!)));
      let transientDatabase = isDatabaseUnavailable(error);
      // Unavailable proof is not revocation. This grants no new authority or
      // funding: only the already confirmed finite provider deadline remains.
      let proofFailed = false;
      const proofStarted = performance.now();
      const currentActive = (transientProvider || transientDatabase) && await this.activeAllocationRetry(lease).catch(proofError => {
        proofFailed = true;
        phaseStarted = proofStarted;
        diagnostic = { ...classifyCloudFailure(proofError, "authority_check"), site: "retry_proof" };
        if (!isDatabaseUnavailable(proofError)) return false;
        transientDatabase = true;
        return null;
      });
      const now = await this.now().catch(clockError => {
        if (!isDatabaseUnavailable(clockError)) throw clockError;
        // Anchor to DB time sampled by the claim, charging the entire round
        // trip conservatively. Host wall-clock changes cannot extend runway.
        return lease.observed_at!.getTime() + Math.max(0, performance.now() - claimStarted);
      });
      const remaining = this.runwayDeadline(lease) - now;
      const activeRetry = lease.state === "active" && currentActive !== false &&
        Number.isFinite(remaining) && remaining > PROVIDER_RETRY_SAFETY_MARGIN_MS &&
        (lease.lease_expires_at?.getTime() ?? 0) > now;
      if (transientDatabase && lease.state === "active" && currentActive === false && !proofFailed)
        diagnostic = { phase: "authority_check", code: "compute_scope_unavailable", errorClass: "unknown", retryable: false, site: "retry_proof" };
      const code = diagnostic.code;
      const retry = code === "compute_lease_superseded" ||
        activeRetry || ((transientDatabase || (error instanceof CloudProviderError && error.retryable)) && await this.pendingAllocationRetry(lease).catch(() => false));
      const stopReason = currentActive !== false && lease.state === "active" && remaining <= PROVIDER_RETRY_SAFETY_MARGIN_MS
        ? transientDatabase ? "control_plane_unavailable" as const : transientProvider ? "provider_outage" as const : undefined
        : undefined;
      if (activeRetry) recheckAt = new Date(Math.min(this.runwayDeadline(lease) - PROVIDER_RETRY_SAFETY_MARGIN_MS,
        lease.lease_expires_at?.getTime() ?? Infinity));
      const bounded = (value: number) => Math.max(-86_400_000, Math.min(86_400_000, Math.floor(value)));
      let incidentId: string | null = null;
      // Active allocation retries retain the closed code and first-error clock
      // on the lease. Append an incident only if an actual stop is required;
      // a recovered outage must not fill history with safety failures.
      if (!activeRetry) try {
        incidentId = await retainCloudDiagnostic(this.options.pool, {
          ...this.identity(lease), operationKind: "compute", operationId: lease.id, leaseOwner: this.workerId,
        }, { ...diagnostic, elapsedMs: Math.max(0, bounded(performance.now() - phaseStarted)),
          fundedTtlMs: bounded((lease.funded_until?.getTime() ?? now) - now),
          providerTtlMs: bounded((lease.provider_expires_at?.getTime() ?? now) - now),
          ...(stopReason ? { stopReason } : {}),
          decision: retry ? "retry" : remaining <= FORCE_STOP_MARGIN_MS ? "direct_stop" : "checkpoint", claim: "current" });
      } catch { await diagnosticStorageFailed(this.options.pool); }
      await withRetryableSystemTx(this.options.pool, (tx) => tx.query(
        `UPDATE managed_compute_allocation_leases SET last_error_code=$3,first_error_at=coalesce(first_error_at,clock_timestamp()),updated_at=now()
        WHERE id=$1 AND lease_owner=$2 AND lease_expires_at>clock_timestamp()
          AND coalesce((SELECT current_generation FROM cloud_workspace_allocation_owners WHERE allocation_lease_id=managed_compute_allocation_leases.id),generation)=$4`,
        [lease.id, this.workerId, code, this.identity(lease).generation],
      )).catch(() => undefined);
      if (!retry) await this.stopAtBudget(lease, code, incidentId, stopReason);
      this.options.logger?.error(
        `[cloud-workspace] compute reconciliation failed (${code}${diagnostic.site ? `, ${diagnostic.site}` : ""}${diagnostic.sqlState ? `, SQLSTATE ${diagnostic.sqlState}` : ""})`,
      );
    } finally {
      await withRetryableSystemTx(this.options.pool, async (tx) => {
        // Lock lease -> marker -> job in that order. The accepted-observation
        // producer never locks a lease. Ack before the lease's job trigger, so
        // a workspace writer holding the marker cannot form a job/marker cycle.
        const owned = await tx.query(`SELECT id FROM managed_compute_allocation_leases lease
          WHERE id=$1 AND lease_owner=$2 AND lease_expires_at>clock_timestamp()
            AND coalesce((SELECT current_generation FROM cloud_workspace_allocation_owners WHERE allocation_lease_id=lease.id),generation)=$3
          FOR UPDATE`, [lease.id, this.workerId, this.identity(lease).generation]);
        if (!owned.rowCount) return;
        if (!failed) await tx.query(`UPDATE cloud_workspace_compute_rechecks
          SET handled_sequence=greatest(handled_sequence,$2::bigint)
          WHERE allocation_lease_id=$1 AND workspace_id=$3 AND org_id=$4 AND handled_sequence<$2::bigint`,
        [lease.id, lease.claimed_recheck_sequence, lease.workspace_id, lease.org_id]);
        await tx.query(
          // A just-stopped allocation settles once its final meter can cover
          // the stop; recheck then instead of after a full poll. Backoff cannot
          // defer an unproved stop past its next safety deadline. After a due
          // escalation attempt, use the normal cadence up to the finite TTL.
          // Past expiry, or with positive stopped proof, retain normal backoff
          // instead of making an expired deadline a permanent hot poll.
          // Keep a check requested while this pass ran, and honor provider
          // Retry-After only within the same runway and stop-deadline bounds.
          `UPDATE managed_compute_allocation_leases lease SET lease_owner=NULL,lease_expires_at=NULL,
        next_check_at=least(CASE WHEN NOT $4 AND $6::timestamptz IS NOT NULL AND next_check_at IS DISTINCT FROM $6::timestamptz THEN next_check_at END,CASE
          WHEN $4 THEN least(coalesce($3::timestamptz,'infinity'::timestamptz),greatest(clock_timestamp()+least(interval '5 minutes',
            greatest(interval '15 seconds',clock_timestamp()-coalesce(first_error_at,clock_timestamp()))),
            clock_timestamp()+coalesce($7::bigint,0)*interval '1 millisecond'))
          WHEN $3::timestamptz IS NULL THEN clock_timestamp()+interval '15 seconds'
          ELSE greatest($3::timestamptz,clock_timestamp()+interval '1 second') END,
          CASE WHEN state='draining' AND stopped_observed_at IS NULL THEN
            CASE WHEN ${pendingStopDeadlineSql}>clock_timestamp() THEN ${pendingStopDeadlineSql}
              WHEN ${confirmedRunwayDeadlineSql}>clock_timestamp() THEN least(${confirmedRunwayDeadlineSql},clock_timestamp()+interval '15 seconds')
              ELSE 'infinity'::timestamptz END
          ELSE 'infinity'::timestamptz END),updated_at=now()
        WHERE id=$1 AND lease_owner=$2 AND lease_expires_at>clock_timestamp()
          AND coalesce((SELECT current_generation FROM cloud_workspace_allocation_owners WHERE allocation_lease_id=lease.id),generation)=$5`,
          [lease.id, this.workerId, recheckAt, failed, this.identity(lease).generation, lease.claimed_next_check_at ?? null, retryAfterMs],
        );
      });
    }
    return true;
  }

  /** When a healthy running allocation whose provider deadline is `expiryMs`
   * is next checked: at its renewal point, early enough that a failed check
   * still leaves the checkpoint and stop margin, within the regular cadence
   * and the ceiling. */
  private runningRecheckAt(expiryMs: number, nowMs: number, renewWhenMs: number): Date {
    const due = expiryMs - Math.max(renewWhenMs, PROVIDER_RETRY_SAFETY_MARGIN_MS);
    return new Date(Math.max(nowMs + REGULAR_RECHECK_MS, Math.min(nowMs + RUNNING_LEASE_CHECK_CEILING_MS, due)));
  }

  /** Compares one metered provider increment with the allocation's weighted
   * wall-clock time over the same window. Billing still follows the provider;
   * a difference beyond the tolerance is recorded and audited for the operator.
   * Only a running allocation past its first window can be under-reported:
   * boot and stop make a partial window legitimately short. */
  private async compareUsage(
    lease: Lease,
    row: { period_id: string; meter_since: Date; meter_through: Date; billable_seconds: string },
    usage: CloudProviderComputeUsage,
    untilMs: number,
    stopped: boolean,
  ): Promise<void> {
    const windowMs = untilMs - row.meter_through.getTime();
    if (windowMs <= 0) return;
    const providerSeconds = usage.billableSeconds - money(row.billable_seconds);
    const expectedSeconds = Math.ceil((windowMs * lease.weight_numerator) / (lease.weight_denominator * 1000));
    const tolerance = Math.max(USAGE_DISAGREEMENT_MIN_SECONDS, Math.ceil(expectedSeconds * USAGE_DISAGREEMENT_RATIO));
    const direction = providerSeconds > expectedSeconds + tolerance ? "over"
      : !stopped && row.meter_through.getTime() > row.meter_since.getTime() && providerSeconds < expectedSeconds - tolerance
        ? "under" : null;
    if (!direction) return;
    const identity = this.identity(lease);
    try {
      await withRetryableSystemTx(this.options.pool, async (tx) => {
        const inserted = await tx.query(
          `INSERT INTO managed_compute_usage_disagreements(reservation_id,period_id,org_id,workspace_id,generation,
            window_since,window_until,provider_seconds,expected_seconds,direction)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (reservation_id,period_id,window_until) DO NOTHING RETURNING id`,
          [lease.id, row.period_id, identity.organizationId, identity.workspaceId, identity.generation,
            row.meter_through, new Date(untilMs), providerSeconds, expectedSeconds, direction],
        );
        if (inserted.rowCount) await audit(tx, identity.organizationId, null, "cloud_compute.usage_disagreement", {
          workspaceId: identity.workspaceId, generation: identity.generation, reservationId: lease.id, periodId: row.period_id,
          windowSince: row.meter_through.toISOString(), windowUntil: new Date(untilMs).toISOString(),
          providerSeconds, expectedSeconds, direction,
        });
      });
      this.options.logger?.error(`[cloud-workspace] compute usage disagrees with the provider meter (${direction})`);
    } catch {
      this.options.logger?.error("[cloud-workspace] compute usage disagreement was not recorded");
    }
  }

  /** Returns when a just-stopped allocation can next settle, or null to keep
   * the regular cadence. */
  private async reconcile(lease: Lease, phase: (phase: CloudDiagnosticPhase, site?: ComputeFailureSite) => void): Promise<Date | null> {
    const identity = this.identity(lease);
    // An unavailable/held provider cannot postpone the due safety decision.
    // The stop request rechecks claim and generation under its own row locks.
    phase("authority_check");
    await this.escalateDueStop(lease);
    phase("provider_inspect");
    const resolved = this.options.providerResolver
      ? (
          await this.options.providerResolver.resolve({
            ...identity,
            purpose: "cleanup",
          })
        ).provider
      : this.options.provider;
    if (!resolved) throw failure("compute_provider_unqualified");
    const provider = compute(resolved);
    if (provider.name !== lease.provider)
      throw failure("compute_provider_unqualified");
    const resource = lease.provider_resource_id
      ? await provider.inspect(lease.provider_resource_id)
      : assertSingleProviderResource(await provider.find(identity), identity);
    await this.stillClaimed(lease);
    if (!resource || resource.state === "deleted") {
      if (await this.pendingAllocationRetry(lease)) return null;
      // Missing list/inspect entries are not proof. The provider must attest
      // its journal has no outstanding allocation/deletion outcome.
      if (!provider.verifyAbsence || !(await provider.verifyAbsence(identity)))
        throw failure("compute_absence_unconfirmed", true);
      await this.stillClaimed(lease);
      const bound = await this.boundAllocation(lease);
      // A bound allocation settles without a final meter only after an
      // operator attested that the provider lost it; the ledger checks again.
      if (bound && !bound.lost)
        throw failure("compute_final_meter_unavailable", true);
      phase("final_settlement");
      const reservations = await withRetryableSystemTx(
        this.options.pool,
        async (tx) =>
          (
            await tx.query<{ period_id: string }>(
              "SELECT period_id FROM managed_compute_credit_reservations WHERE id=$1 AND state='open'",
              [lease.id],
            )
          ).rows,
      );
      for (const row of reservations) {
        const claim = { reservationId: lease.id, periodId: row.period_id, allocationLeaseClaim: { owner: this.workerId } };
        if (bound) await retryAbortedDatabaseTransaction(() => this.ledger.finalizeLost({ ...claim, resourceId: bound.resourceId }));
        else await retryAbortedDatabaseTransaction(() => this.ledger.releaseUnallocated(claim));
      }
      await this.settle(lease);
      return null;
    }
    assertProviderResourceIdentity(resource, identity);
    // An unchanged stopped VM may be a retryable wake. Its already-stopped
    // usage is not proof that this pending start reservation can be released.
    if ((resource.state === "stopped" || resource.state === "archived") &&
        await this.pendingAllocationRetry(lease)) return null;
    if (
      lease.provider_resource_id &&
      lease.provider_resource_id !== resource.resourceId
    )
      throw failure("provider_identity_mismatch");
    phase("ledger_commit", "allocation_binding");
    await withRetryableSystemTx(this.options.pool, async (tx) => {
      // Every pass re-observes the original allocation and reservation before
      // writing, including a lost COMMIT whose diagnostic could not be saved.
      const current=await tx.query<{reservation_valid:boolean}>(`SELECT id,state<>'active' OR EXISTS (
          SELECT 1 FROM managed_compute_credit_reservations reservation WHERE reservation.id=lease.id
            AND reservation.workspace_id=lease.workspace_id AND reservation.org_id=lease.org_id
            AND reservation.generation=lease.generation AND reservation.billing_epoch=lease.billing_epoch AND reservation.user_id=lease.user_id) AS reservation_valid
        FROM managed_compute_allocation_leases lease
        WHERE id=$1 AND lease_owner=$2 AND lease_expires_at>clock_timestamp()
          AND workspace_id=$3 AND org_id=$4 AND generation=$5 AND user_id=$6 AND billing_epoch=$7 AND provider=$8
          AND coalesce((SELECT current_generation FROM cloud_workspace_allocation_owners WHERE allocation_lease_id=lease.id),generation)=$9
          AND provider_resource_id IS NOT DISTINCT FROM $10
        FOR UPDATE`,[lease.id,this.workerId,lease.workspace_id,lease.org_id,lease.generation,lease.user_id,lease.billing_epoch,lease.provider,identity.generation,lease.provider_resource_id]);
      if (!current.rowCount) throw failure("compute_lease_superseded");
      if (!current.rows[0]!.reservation_valid) throw failure("compute_credit_conflict");
      const bound = await tx.query(
        `UPDATE cloud_workspace_provider_bindings SET provider_resource_id=$4
        WHERE workspace_id=$1 AND org_id=$2 AND generation=$3 AND (provider_resource_id IS NULL OR provider_resource_id=$4) RETURNING workspace_id`,
        [
          lease.workspace_id,
          lease.org_id,
          identity.generation,
          resource.resourceId,
        ],
      );
      if (!bound.rowCount) throw failure("provider_identity_mismatch");
      await tx.query(
        `UPDATE managed_compute_allocation_leases SET provider_resource_id=$3,updated_at=now()
        WHERE id=$1 AND lease_owner=$2 AND lease_expires_at>clock_timestamp()`,
        [lease.id, this.workerId, resource.resourceId],
      );
    });
    lease.provider_resource_id = resource.resourceId;
    const stopped = ["stopped", "archived"].includes(resource.state) || resource.computeStopped === true;
    phase("ledger_commit", "allocation_observation");
    const observed = await withRetryableSystemTx(
      this.options.pool,
      async (tx) =>
        (
          await tx.query<{ stopped_observed_at: Date | null; now: Date }>(
            `UPDATE managed_compute_allocation_leases
      SET stopped_observed_at=CASE WHEN $3 THEN coalesce(stopped_observed_at,clock_timestamp()) ELSE NULL END
      WHERE id=$1 AND lease_owner=$2 AND lease_expires_at>clock_timestamp() RETURNING stopped_observed_at,clock_timestamp() AS now`,
            [lease.id, this.workerId, stopped],
          )
        ).rows[0],
    );
    if (!observed) throw failure("compute_lease_superseded");
    // Query behind the provider clock. A final meter must also cover the first
    // independent stopped observation, not truncate the last seconds of use.
    const untilMs = observed.now.getTime() - FINAL_METER_LAG_MS;
    const finalStopped =
      stopped &&
      observed.stopped_observed_at !== null &&
      untilMs >= observed.stopped_observed_at.getTime();
    const reservations = await withRetryableSystemTx(
      this.options.pool,
      async (tx) =>
        (
          await tx.query<{
            period_id: string;
            meter_since: Date;
            meter_through: Date;
            billable_seconds: string;
            ends_at: Date;
          }>(
            `SELECT reservation.period_id,reservation.meter_since,reservation.meter_through,reservation.billable_seconds,period.ends_at FROM managed_compute_credit_reservations reservation
      JOIN managed_compute_credit_periods period ON period.id=reservation.period_id WHERE reservation.id=$1 AND reservation.state='open' ORDER BY period.starts_at`,
            [lease.id],
          )
        ).rows,
    );
    for (const row of reservations) {
      await this.stillClaimed(lease);
      if (finalStopped && row.meter_since.getTime() > observed.now.getTime()) {
        await retryAbortedDatabaseTransaction(() => this.ledger.releaseBeforeWindow({
          reservationId: lease.id,
          periodId: row.period_id,
          resourceId: resource.resourceId,
          reason: "allocation_stopped",
          allocationLeaseClaim: { owner: this.workerId },
        }));
        continue;
      }
      const until = Math.min(row.ends_at.getTime(), untilMs);
      if (
        until < row.meter_since.getTime() ||
        until < row.meter_through.getTime()
      )
        continue;
      if (!finalStopped && until !== row.ends_at.getTime() &&
          until - row.meter_through.getTime() < this.usageMeterWindowMs) continue;
      phase("meter_read");
      const usage = await provider.readComputeUsage(resource.resourceId, {
        since: row.meter_since,
        until: new Date(until),
      });
      await this.stillClaimed(lease);
      if (finalStopped && usage.running)
        throw failure("compute_stop_meter_unconfirmed", true);
      phase("ledger_commit", "meter_commit");
      const meter = { reservationId: lease.id, periodId: row.period_id, usage, allocationLeaseClaim: { owner: this.workerId } };
      let regressed = false;
      await retryAbortedDatabaseTransaction(() => this.ledger.meter({
        ...meter,
        ...(finalStopped
          ? { finalReason: "allocation_stopped" as const }
          : until === row.ends_at.getTime()
            ? { finalReason: "period_ended" as const }
            : {}),
      })).catch(async (error: unknown) => {
        // The provider can later report less for a window we already metered.
        // Once the stop is old enough, settle the stopped allocation at its
        // confirmed meter instead of holding it open forever. The ledger
        // accepts only a valid stopped reading that is lower than that meter.
        if (!finalStopped || !(error instanceof CloudProviderError) || error.code !== "compute_credit_meter_rejected" ||
            lease.last_error_code !== "compute_credit_meter_rejected" ||
            observed.now.getTime() - observed.stopped_observed_at!.getTime() < REGRESSED_FINAL_METER_GRACE_MS) throw error;
        await retryAbortedDatabaseTransaction(() => this.ledger.finalizeRegressed(meter));
        regressed = true;
        this.options.logger?.error("[cloud-workspace] settled a stopped allocation at its confirmed meter after the provider meter regressed");
      });
      if (!regressed) await this.compareUsage(lease, row, usage, until, stopped);
    }
    if (finalStopped) {
      phase("final_settlement");
      await this.settle(lease);
      return null;
    }
    if (stopped)
      return new Date(observed.stopped_observed_at!.getTime() + FINAL_METER_LAG_MS + 1000);
    phase("authority_check");
    const scope = await this.scope(identity);
    if (scope.generation === identity.generation && scope.desired_state !== "running") {
      // A user lifecycle request is a stop to observe, not a lost compute
      // scope. Adoption preserves its drain; only the finite budget may force it.
      const setupCode = diagnosticCode(scope.setup_failure_code);
      await this.stopAtBudget(lease, setupCode === scope.setup_failure_code ? setupCode : "workspace_stop_requested");
      return null;
    }
    if (
      lease.state === "draining" ||
      !scope.live ||
      scope.generation !== this.identity(lease).generation ||
      scope.user_id !== lease.user_id ||
      money(scope.billing_epoch) !== money(lease.billing_epoch)
    ) {
      const setupCode = diagnosticCode(scope.setup_failure_code);
      await this.stopAtBudget(lease, scope.generation === this.identity(lease).generation && setupCode === scope.setup_failure_code
        ? setupCode : "compute_scope_unavailable");
      return null;
    }
    if (resource.state !== "running") return null;
    // A check requested during this pass is kept, so this pass's own
    // observation must not request one: the lease would be due at once.
    await this.observeRunning(identity, provider, resource, { requestCheck: false });
    const expiry = Date.parse(String(resource.metadata.computeLeaseExpiresAt));
    // Leave ample time for checkpoint/stop and avoid a PATCH per meter poll.
    const renewWhenMs = Math.max(
      30_000,
      (this.options.policy?.maximumTtlSeconds ?? 900) * 500,
    );
    // A failed inspect/meter/renew skipped lease maintenance. Renew on the
    // first complete recovery pass instead of waiting for the half-TTL mark.
    if (expiry - observed.now.getTime() > renewWhenMs && !lease.last_error_code?.startsWith("provider_")) return this.runningRecheckAt(expiry, observed.now.getTime(), renewWhenMs);
    phase("ledger_commit", "renewal_plan");
    const plan = await this.plan(lease);
    if (!plan) {
      await this.stopAtBudget(lease, "compute_credit_exhausted");
      return null;
    }
    phase("ledger_commit", "renewal_reservation");
    await this.fund(lease, plan, this.workerId);
    await this.stillClaimed(lease);
    phase("authority_check");
    const current = await this.scope(identity);
    if (
      !current.live ||
      current.desired_state !== "running" ||
      current.generation !== identity.generation ||
      current.user_id !== lease.user_id ||
      money(current.billing_epoch) !== money(lease.billing_epoch)
    )
      throw failure("compute_lease_superseded");
    // The request cannot shorten an already confirmed funded lease.
    if (observed.now.getTime() + plan.ttlSeconds * 1000 <= expiry) return this.runningRecheckAt(expiry, observed.now.getTime(), renewWhenMs);
    phase("provider_renew");
    const renewed = await provider.renewComputeLease(
      resource.resourceId,
      plan.ttlSeconds,
    );
    const deadline = Date.parse(renewed.expiresAt),
      now = await this.now();
    if (
      !Number.isFinite(deadline) ||
      deadline <= now ||
      deadline > plan.fundedUntil.getTime()
    )
      throw failure("compute_lease_unconfirmed", true);
    phase("ledger_commit", "renewal_commit");
    await withRetryableSystemTx(this.options.pool, (tx) =>
      tx.query(
        `UPDATE managed_compute_allocation_leases SET provider_expires_at=greatest(provider_expires_at,$3),
      state='active',updated_at=now() WHERE id=$1 AND lease_owner=$2 AND lease_expires_at>clock_timestamp() AND state IN ('authorized','active')`,
        [lease.id, this.workerId, new Date(deadline)],
      ),
    );
    return this.runningRecheckAt(deadline, now, renewWhenMs);
  }

  /** The generation's bound allocation, which the lease may not have recorded
   * yet, and whether an operator attested that the provider lost it. */
  private async boundAllocation(lease: Lease): Promise<{ resourceId: string; lost: boolean } | null> {
    return withRetryableSystemTx(this.options.pool, async (tx) => {
      const resourceId = lease.provider_resource_id ?? (await tx.query<{ provider_resource_id: string | null }>(
        "SELECT provider_resource_id FROM cloud_workspace_provider_bindings WHERE workspace_id=$1 AND generation=$2 AND org_id=$3",
        [lease.workspace_id, lease.generation, lease.org_id],
      )).rows[0]?.provider_resource_id ?? null;
      if (!resourceId) return null;
      const lost = await readManagedComputeAllocationLost(tx,{leaseId:lease.id,workspaceId:lease.workspace_id,
        generation:lease.generation,organizationId:lease.org_id,resourceId});
      return { resourceId, lost };
    });
  }

  private async settle(lease: Lease): Promise<void> {
    await withRetryableSystemTx(this.options.pool, async (tx) => {
      const result = await tx.query(
        `UPDATE managed_compute_allocation_leases SET state='settled',settled_at=clock_timestamp(),last_error_code=NULL,first_error_at=NULL,updated_at=now()
        WHERE id=$1 AND lease_owner=$2 AND lease_expires_at>clock_timestamp()
          AND NOT EXISTS (SELECT 1 FROM managed_compute_credit_reservations WHERE id=$1 AND state='open') RETURNING id`,
        [lease.id, this.workerId],
      );
      if (!result.rowCount)
        throw failure("compute_settlement_incomplete", true);
      // A start refused because this allocation was unsettled is otherwise
      // asleep in exponential backoff; let it retry now. Other backoff (for
      // example provider rate limits) is left alone.
      await tx.query(
        `UPDATE cloud_workspace_lifecycle_intents SET next_attempt_at=clock_timestamp(),updated_at=now()
        WHERE workspace_id=$1 AND org_id=$2 AND generation=$3 AND operation IN ('create','wake')
          AND state='observing' AND error_code='compute_previous_lease_pending' AND next_attempt_at>clock_timestamp()`,
        [lease.workspace_id, lease.org_id, lease.generation],
      );
    });
  }
}

import { randomUUID } from "node:crypto";
import type pg from "pg";
import { withSystemTx } from "../db.js";
import { DatabaseManagedComputeCreditLedger } from "./compute-credits.js";
import {lockComputeUserFunding,prepareComputeUserPeriods} from "./compute-funding.js";
import {
  planManagedComputeCredit,
  type ComputeCreditPlanningPeriod,
  type ComputeCreditPlan,
} from "./compute-credit-plan.js";
import type { CloudWorkspaceComputeProvider } from "./provider-compute.js";
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
};
type Scope = {
  user_id: string;
  billing_epoch: string;
  requires_credit: boolean;
  live: boolean;
  desired_state: string;
  generation: number;
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

/** Owns spending authority around provider calls. It never accepts an engine's
 * CPU meter as compute billing, and a failed request never releases a hold. */
export class CloudWorkspaceComputeLeaseCoordinator {
  private readonly ledger: DatabaseManagedComputeCreditLedger;
  private readonly workerId = `compute:${randomUUID()}`;
  constructor(
    private readonly options: {
      pool: pg.Pool;
      providerResolver?: CloudWorkspaceProviderResolver;
      provider?: CloudWorkspaceProvider;
      workosEnabled: boolean;
      policy?: ManagedComputePolicy;
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
  }
  private async scope(input: {
    workspaceId: string;
    organizationId: string;
    generation: number;
  }): Promise<Scope> {
    return withSystemTx(this.options.pool, async (tx) => {
      const row = (
        await tx.query<Scope>(
          `SELECT workspace.owner_user_id AS user_id,workspace.current_billing_epoch AS billing_epoch,
        workspace.desired_state,workspace.current_generation AS generation,
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
    return withSystemTx(this.options.pool, async (tx) => {
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
    return withSystemTx(this.options.pool, async (tx) => {
      const now = (
        await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now")
      ).rows[0]!.now.getTime();
      const billing=(await tx.query<{entitlement_plan:string}>(`SELECT entitlement_plan FROM workspace_billing_epochs
        WHERE workspace_id=$1 AND org_id=$2 AND billing_epoch=$3 AND billing_owner_user_id=$4`,
        [lease.workspace_id,lease.org_id,lease.billing_epoch,lease.user_id])).rows[0];
      if(billing?.entitlement_plan==='pro') {
        await lockComputeUserFunding(tx,lease.user_id);
        await prepareComputeUserPeriods(tx,{userId:lease.user_id,organizationId:lease.org_id});
      }
      const rows = (
        await tx.query(
          `SELECT period.*,reservation.meter_since,reservation.meter_through,reservation.billable_seconds,
        reservation.actual_micro_usd,reservation.debited_micro_usd AS reservation_debited,reservation.authorized_micro_usd,reservation.covered_until,
        CASE WHEN period.funding_mode='pro_user' THEN
          (SELECT root.granted_micro_usd-coalesce((SELECT sum(child.debited_micro_usd+child.reserved_micro_usd)
            FROM managed_compute_credit_periods child WHERE child.funding_period_id=root.id),0)
           FROM managed_compute_user_periods root WHERE root.id=period.funding_period_id)
          ELSE period.granted_micro_usd-period.debited_micro_usd-period.reserved_micro_usd-period.returned_micro_usd END AS available
        FROM managed_compute_credit_periods period LEFT JOIN managed_compute_credit_reservations reservation
          ON reservation.period_id=period.id AND reservation.id=$3 AND reservation.state='open'
        WHERE period.org_id=$1 AND period.user_id=$2 AND period.ends_at>clock_timestamp()
          AND period.starts_at<clock_timestamp()+interval '2 hours' ORDER BY period.starts_at,period.id LIMIT 17`,
          [lease.org_id, lease.user_id, lease.id],
        )
      ).rows;
      const periods: ComputeCreditPlanningPeriod[] = rows.map((r) => ({
        id: r.id,
        startsAtMs: r.starts_at.getTime(),
        endsAtMs: r.ends_at.getTime(),
        availableMicroUsd: money(r.available),
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
    await this.ledger.reserve({
      organizationId: lease.org_id,
      workspaceId: lease.workspace_id,
      generation: lease.generation,
      billingEpoch: money(lease.billing_epoch),
      reservationId: lease.id,
      policyId: lease.policy_id,
      secondsPerDollar: money(lease.seconds_per_dollar),
      allocations: plan.allocations,
      allocationLeaseClaim: { owner },
    });
    await withSystemTx(this.options.pool, async (tx) => {
      const result = await tx.query(
        `UPDATE managed_compute_allocation_leases SET funded_until=greatest(funded_until,$2),
        ttl_seconds=CASE WHEN state='funding' THEN $3 ELSE ttl_seconds END,
        state=CASE WHEN state='funding' THEN 'authorized' ELSE state END,updated_at=now(),last_error_code=NULL,first_error_at=NULL
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
    const scope = await this.scope(input);
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
    const lease = await this.prepare(input, scope, metered, owner);
    try {
      await this.assertAllocationRetryDeadline(lease);
      const plan = await this.plan(lease, lease.state !== "funding");
      if (!plan) throw failure("compute_credit_exhausted");
      await this.fund(lease, plan, owner);
      // A lifecycle/ownership change during funding prevents dispatch, while
      // the reservation remains until independent absence/stop evidence.
      const currentScope = await this.scope(input);
      if (
        !currentScope.live ||
        currentScope.desired_state !== "running" ||
        currentScope.generation !== input.generation ||
        currentScope.user_id !== lease.user_id ||
        money(currentScope.billing_epoch) !== money(lease.billing_epoch)
      )
        throw failure("compute_lease_superseded");
      await this.assertAllocationRetryDeadline(lease);
      const resource = current
        ? await metered.startWithComputeLease(
            current.resourceId,
            plan.ttlSeconds,
          )
        : await metered.createWithComputeLease(input, plan.ttlSeconds);
      assertProviderResourceIdentity(resource, input);
      await this.observeRunning(input, provider, resource);
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
      await withSystemTx(this.options.pool, (tx) =>
        tx.query(
          `UPDATE managed_compute_allocation_leases
        SET lease_owner=NULL,lease_expires_at=NULL,next_check_at=now(),updated_at=now() WHERE id=$1 AND lease_owner=$2`,
          [lease.id, owner],
        ),
      );
    }
  }

  /** Reconcile a lost create/resume reply before declaring a running VM ready.
   * Provider liveness alone never establishes spending authority. */
  async observeRunning(
    input: { workspaceId: string; organizationId: string; generation: number },
    provider: CloudWorkspaceProvider,
    resource: CloudProviderResource,
  ): Promise<void> {
    assertProviderResourceIdentity(resource, input);
    const scope = await this.scope(input);
    if (!scope.requires_credit) return;
    const expires =
      typeof resource.metadata.computeLeaseExpiresAt === "string"
        ? Date.parse(resource.metadata.computeLeaseExpiresAt)
        : NaN;
    await withSystemTx(this.options.pool, async (tx) => {
      const lease = (
        await tx.query<Lease>(
          `SELECT * FROM managed_compute_allocation_leases WHERE workspace_id=$1 AND org_id=$2 AND generation=$3 AND state<>'settled' FOR UPDATE`,
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
        state=CASE WHEN $4 THEN 'active' ELSE state END,updated_at=now(),next_check_at=now()
        WHERE id=$1`,
        [
          lease.id,
          resource.resourceId,
          resource.state === "running" ? new Date(expires) : null,
          resource.state === "running",
        ],
      );
    });
  }

  private identity(lease: Lease) {
    return {
      workspaceId: lease.workspace_id,
      organizationId: lease.org_id,
      generation: lease.generation,
    };
  }
  private async stillClaimed(lease: Lease): Promise<void> {
    const live = await withSystemTx(
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
    return withSystemTx(this.options.pool, async (tx) =>
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
    return withSystemTx(this.options.pool, async (tx) => (await tx.query(
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
  private async stopAtBudget(lease: Lease, reason: string): Promise<void> {
    const now = await this.now();
    const remaining =
      Math.min(
        lease.provider_expires_at?.getTime() ?? now,
        lease.funded_until?.getTime() ?? now,
      ) - now;
    await requestManagedComputeStop(this.options.pool, {
      leaseId: lease.id,
      reason,
      force: remaining < 45_000,
      expectedLeaseOwner: this.workerId,
      checkpointDeadlineMs: Math.max(
        30_000,
        Math.min(300_000, remaining - 15_000),
      ),
    });
  }

  /** Stop and meter before permanently deleting the provider's usage API.
   * The normal lifecycle reconciler retries after settlement; timeouts retain
   * customer holds and never masquerade as a verified zero bill. */
  async beforeDelete(
    input: { workspaceId: string; organizationId: string; generation: number },
    provider: CloudWorkspaceProvider,
    resource: CloudProviderResource,
  ): Promise<boolean> {
    const lease = await withSystemTx(
      this.options.pool,
      async (tx) =>
        (
          await tx.query<Lease>(
            `SELECT * FROM managed_compute_allocation_leases
      WHERE workspace_id=$1 AND org_id=$2 AND generation=$3 AND state<>'settled'`,
            [input.workspaceId, input.organizationId, input.generation],
          )
        ).rows[0],
    );
    if (!lease) return true;
    assertProviderResourceIdentity(resource, input);
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
      const stopped = await provider.stop(resource.resourceId);
      assertProviderResourceIdentity(stopped, input);
    }
    await withSystemTx(this.options.pool, (tx) =>
      tx.query(
        `UPDATE managed_compute_allocation_leases SET next_check_at=now() WHERE id=$1`,
        [lease.id],
      ),
    );
    return false;
  }

  async runOnce(): Promise<boolean> {
    const lease = await withSystemTx(
      this.options.pool,
      async (tx) =>
        (
          await tx.query<Lease>(
            `WITH candidate AS (
      SELECT id FROM managed_compute_allocation_leases WHERE state<>'settled' AND next_check_at<=clock_timestamp()
        AND (lease_owner IS NULL OR lease_expires_at<=clock_timestamp()) ORDER BY next_check_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE managed_compute_allocation_leases lease SET lease_owner=$1,lease_expires_at=clock_timestamp()+interval '5 minutes'
      FROM candidate WHERE lease.id=candidate.id RETURNING lease.*`,
            [this.workerId],
          )
        ).rows[0],
    );
    if (!lease) return false;
    let recheckAt: Date | null = null, failed = false;
    try {
      recheckAt = await this.reconcile(lease);
      await withSystemTx(this.options.pool, (tx) =>
        tx.query(
          `UPDATE managed_compute_allocation_leases SET last_error_code=NULL,first_error_at=NULL
        WHERE id=$1 AND lease_owner=$2 AND state='active'`,
          [lease.id, this.workerId],
        ),
      );
    } catch (error) {
      failed = true;
      const code =
        error instanceof CloudProviderError &&
        /^[a-z][a-z0-9_]{0,127}$/.test(error.code)
          ? error.code
          : "compute_reconciliation_failed";
      await withSystemTx(this.options.pool, (tx) =>
        tx.query(
          `UPDATE managed_compute_allocation_leases SET last_error_code=$3,first_error_at=coalesce(first_error_at,clock_timestamp()),updated_at=now()
        WHERE id=$1 AND lease_owner=$2`,
          [lease.id, this.workerId, code],
        ),
      );
      if (code !== "compute_lease_superseded" &&
          !(error instanceof CloudProviderError && error.retryable && await this.pendingAllocationRetry(lease)))
        await this.stopAtBudget(lease, code);
      this.options.logger?.error(
        `[cloud-workspace] compute reconciliation failed (${code})`,
      );
    } finally {
      await withSystemTx(this.options.pool, (tx) =>
        tx.query(
          // A just-stopped allocation settles once its final meter can cover
          // the stop; recheck then instead of after a full poll. A persistent
          // failure (for example an unattested provider loss) backs off to
          // five minutes rather than requesting another stop every poll.
          `UPDATE managed_compute_allocation_leases SET lease_owner=NULL,lease_expires_at=NULL,
        next_check_at=CASE
          WHEN $4 THEN clock_timestamp()+least(interval '5 minutes',
            greatest(interval '15 seconds',clock_timestamp()-coalesce(first_error_at,clock_timestamp())))
          WHEN $3::timestamptz IS NULL THEN clock_timestamp()+interval '15 seconds'
          ELSE greatest($3::timestamptz,clock_timestamp()+interval '1 second') END,updated_at=now()
        WHERE id=$1 AND lease_owner=$2`,
          [lease.id, this.workerId, recheckAt, failed],
        ),
      );
    }
    return true;
  }

  /** Returns when a just-stopped allocation can next settle, or null to keep
   * the regular cadence. */
  private async reconcile(lease: Lease): Promise<Date | null> {
    const identity = this.identity(lease);
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
      const reservations = await withSystemTx(
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
        if (bound) await this.ledger.finalizeLost({ ...claim, resourceId: bound.resourceId });
        else await this.ledger.releaseUnallocated(claim);
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
    await withSystemTx(this.options.pool, async (tx) => {
      const bound = await tx.query(
        `UPDATE cloud_workspace_provider_bindings SET provider_resource_id=$4
        WHERE workspace_id=$1 AND org_id=$2 AND generation=$3 AND (provider_resource_id IS NULL OR provider_resource_id=$4) RETURNING workspace_id`,
        [
          lease.workspace_id,
          lease.org_id,
          lease.generation,
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
    const observed = await withSystemTx(
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
    const reservations = await withSystemTx(
      this.options.pool,
      async (tx) =>
        (
          await tx.query<{
            period_id: string;
            meter_since: Date;
            meter_through: Date;
            ends_at: Date;
          }>(
            `SELECT reservation.period_id,reservation.meter_since,reservation.meter_through,period.ends_at FROM managed_compute_credit_reservations reservation
      JOIN managed_compute_credit_periods period ON period.id=reservation.period_id WHERE reservation.id=$1 AND reservation.state='open' ORDER BY period.starts_at`,
            [lease.id],
          )
        ).rows,
    );
    for (const row of reservations) {
      await this.stillClaimed(lease);
      if (finalStopped && row.meter_since.getTime() > observed.now.getTime()) {
        await this.ledger.releaseBeforeWindow({
          reservationId: lease.id,
          periodId: row.period_id,
          resourceId: resource.resourceId,
          reason: "allocation_stopped",
          allocationLeaseClaim: { owner: this.workerId },
        });
        continue;
      }
      const until = Math.min(row.ends_at.getTime(), untilMs);
      if (
        until < row.meter_since.getTime() ||
        until < row.meter_through.getTime()
      )
        continue;
      const usage = await provider.readComputeUsage(resource.resourceId, {
        since: row.meter_since,
        until: new Date(until),
      });
      await this.stillClaimed(lease);
      if (finalStopped && usage.running)
        throw failure("compute_stop_meter_unconfirmed", true);
      await this.ledger.meter({
        reservationId: lease.id,
        periodId: row.period_id,
        usage,
        allocationLeaseClaim: { owner: this.workerId },
        ...(finalStopped
          ? { finalReason: "allocation_stopped" as const }
          : until === row.ends_at.getTime()
            ? { finalReason: "period_ended" as const }
            : {}),
      });
    }
    if (finalStopped) {
      await this.settle(lease);
      return null;
    }
    if (stopped)
      return new Date(observed.stopped_observed_at!.getTime() + FINAL_METER_LAG_MS + 1000);
    const scope = await this.scope(identity);
    if (
      lease.state === "draining" ||
      !scope.live ||
      scope.desired_state !== "running" ||
      scope.generation !== lease.generation ||
      scope.user_id !== lease.user_id ||
      money(scope.billing_epoch) !== money(lease.billing_epoch)
    ) {
      await this.stopAtBudget(lease, "compute_scope_unavailable");
      return null;
    }
    if (resource.state !== "running") return null;
    await this.observeRunning(identity, provider, resource);
    const expiry = Date.parse(String(resource.metadata.computeLeaseExpiresAt));
    // Leave ample time for checkpoint/stop and avoid a PATCH per meter poll.
    const renewWhenMs = Math.max(
      30_000,
      (this.options.policy?.maximumTtlSeconds ?? 900) * 500,
    );
    if (expiry - observed.now.getTime() > renewWhenMs) return null;
    const plan = await this.plan(lease);
    if (!plan) {
      await this.stopAtBudget(lease, "compute_credit_exhausted");
      return null;
    }
    await this.fund(lease, plan, this.workerId);
    await this.stillClaimed(lease);
    const current = await this.scope(identity);
    if (
      !current.live ||
      current.desired_state !== "running" ||
      current.generation !== lease.generation ||
      current.user_id !== lease.user_id ||
      money(current.billing_epoch) !== money(lease.billing_epoch)
    )
      throw failure("compute_lease_superseded");
    // The request cannot shorten an already confirmed funded lease.
    if (observed.now.getTime() + plan.ttlSeconds * 1000 <= expiry) return null;
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
    await withSystemTx(this.options.pool, (tx) =>
      tx.query(
        `UPDATE managed_compute_allocation_leases SET provider_expires_at=greatest(provider_expires_at,$3),
      state='active',updated_at=now() WHERE id=$1 AND lease_owner=$2 AND lease_expires_at>clock_timestamp() AND state IN ('authorized','active')`,
        [lease.id, this.workerId, new Date(deadline)],
      ),
    );
    return null;
  }

  /** The generation's bound allocation, which the lease may not have recorded
   * yet, and whether an operator attested that the provider lost it. */
  private async boundAllocation(lease: Lease): Promise<{ resourceId: string; lost: boolean } | null> {
    return withSystemTx(this.options.pool, async (tx) => {
      const resourceId = lease.provider_resource_id ?? (await tx.query<{ provider_resource_id: string | null }>(
        "SELECT provider_resource_id FROM cloud_workspace_provider_bindings WHERE workspace_id=$1 AND generation=$2 AND org_id=$3",
        [lease.workspace_id, lease.generation, lease.org_id],
      )).rows[0]?.provider_resource_id ?? null;
      if (!resourceId) return null;
      const lost = (await tx.query<{ lost: boolean }>(
        "SELECT cloud_provider_allocation_lost($1,$2,$3,$4) AS lost",
        [lease.workspace_id, lease.generation, lease.org_id, resourceId],
      )).rows[0]!.lost;
      return { resourceId, lost };
    });
  }

  private async settle(lease: Lease): Promise<void> {
    await withSystemTx(this.options.pool, async (tx) => {
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

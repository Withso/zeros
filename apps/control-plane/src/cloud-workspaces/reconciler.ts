import { createHash, randomUUID } from "node:crypto";
import { stopUnavailableCloudEngine } from "./engine-health.js";
import type pg from "pg";

import { audit } from "../audit.js";
import { HttpError } from "../authz.js";
import { CLOUD_WORKSPACE_V2_REQUIRED, requireSupportedCloudWorkspaceGeneration } from "./supported-generation.js";
import { withSystemTx } from "../db.js";
import { deferCloudRecoveryResourceBlock, enqueueCloudMissingSnapshotRecovery } from "./automatic-recovery.js";
import { requireGenerationRuntime } from "./generation-pins.js";
import { CloudRuntimeError } from "./runtime-selection.js";
import type { CloudWorkspaceBackendConfig } from "../config.js";
import { upgradeCloudRuntimeOnWake } from "./runtime-wake-upgrade.js";
import {
  assertProviderResourceIdentity,
  assertProviderAbsence,
  assertSingleProviderResource,
  CloudProviderError,
  type CloudProviderInventoryItem,
  type CloudProviderResource,
  type CloudWorkspaceProvider,
} from "./provider.js";
import type {
  CloudWorkspaceProviderCleanupScope,
  CloudWorkspaceProviderResolver,
} from "./provider-resolver.js";
import { isValidCloudWorkspaceWorkerId } from "./worker-identity.js";
import { CloudWorkerScheduler } from "./worker-scheduler.js";
import { JobRunner } from "../job-runner.js";
import { isValidJobOwner, purgeFailedJobs, type ClaimedJob } from "../job-queue.js";
import {
  auditLifecycleJobs,
  DEFAULT_STOPPED_DRIFT_INTERVAL_MS,
  LIFECYCLE_JOB_KINDS,
  lifecycleWorkForJob,
  rescheduleLifecycleJob,
  type LifecycleWork,
} from "./lifecycle-jobs.js";
import { prepareCloudWorkspaceStopSeal } from "./stop-seal.js";
import { runCloudDiagnosticCleanup } from "./cloud-diagnostic-store.js";
import {
  advanceCloudWorkspaceGenerationTransitionAfterDrain,
  failCloudWorkspaceGenerationRollback,
  rollbackCloudWorkspaceGenerationTransition,
  rollbackCloudWorkspaceGenerationTransitionAfterDrainFailure,
} from "./generation-transitions.js";
import {
  confirmCloudWorkspaceClientAccessRevoked,
  queueCloudWorkspaceSetupVerification,
  retireCloudWorkspaceRuntimeAccess,
} from "./runtime-access.js";
import { DatabaseCloudWorkspacePaidAuthorityReconciler } from "./paid-authority.js";
import { CloudWorkspaceComputeLeaseCoordinator, type ManagedComputePolicy } from "./compute-leases.js";
import {retireCloudAgentBootSources} from "./agent-boot-credentials.js";

type LifecycleOperation = "create" | "stop" | "wake" | "archive" | "delete";
type DesiredState = "running" | "stopped" | "archived" | "deleted";

type ClaimedIntent = {
  id: string;
  workspaceId: string;
  orgId: string;
  operation: LifecycleOperation;
  desiredState: DesiredState;
  generation: number;
  provider: string;
  imageRef: string;
  architecture: "linux/amd64" | "linux/arm64";
  cpuMillicores: number;
  memoryMiB: number;
  storageMiB: number;
  providerResourceId: string | null;
  attemptCount: number;
  affectsWorkspace: boolean;
  generationWasCurrent: boolean;
  generationTransitionId: string | null;
  authorityEpoch: string;
};

type DriftCandidate = {
  workspaceId: string;
  orgId: string;
  desiredState: DesiredState;
  status: string;
  version: string | number;
  generation: number;
  provider: string;
  providerResourceId: string | null;
  driftLeaseUntil: Date;
  /** This candidate's observation cadence, by its settled state. */
  intervalMs: number;
};

type ReconcileLogger = Pick<Console, "info" | "warn" | "error">;

/** The sweep needs only inventory and lifecycle operations, not access. */
type SweepScope = Omit<CloudWorkspaceProviderCleanupScope, "provider"> & { provider: CloudWorkspaceProvider };

export type CloudWorkspaceReconcilerOptions = {
  pool: pg.Pool;
  provider: CloudWorkspaceProvider;
  providerResolver?: CloudWorkspaceProviderResolver;
  computePolicy?: ManagedComputePolicy;
  computeUsageMeterWindowMs?: number;
  intervalMs?: number;
  leaseMs?: number;
  orphanGraceMs?: number;
  maxManagedResourcesPerSweep?: number;
  workosEnabled?: boolean;
  runtimeUpgradeConfig?: CloudWorkspaceBackendConfig;
  paidAuthorityRecheckIntervalMs?: number;
  workerId?: string;
  logger?: ReconcileLogger;
  /** Drift cadence for workspaces settled stopped or archived (default 6 h).
   * Running and transitional workspaces keep intervalMs. */
  stoppedDriftIntervalMs?: number;
  /** How far an inventory-confirmed binding's next drift check is pushed
   * (default 6 h). A dead sweep lets per-workspace inspects resume then. */
  inventoryFallbackMs?: number;
  /** Concurrent lifecycle jobs per process. The default, 1, keeps the
   * former tick's serial provider calls. */
  jobConcurrency?: number;
  /** Safety audit for lost job enqueues (default hourly). */
  jobAuditIntervalMs?: number;
};

// Bounded work per job run, as in the former per-tick loops; a job that hits
// it reschedules itself immediately.
const MAX_CLAIMS_PER_JOB = 20;
const ORPHAN_SWEEP_INTERVAL_MS = 60_000;
const SWEEP_LOCK_TIMEOUT_MS = 2_000;

function requestDigest(value: unknown): Buffer {
  return createHash("sha256").update(JSON.stringify(value)).digest();
}

function desiredForOperation(operation: LifecycleOperation): DesiredState {
  switch (operation) {
    case "create":
    case "wake":
      return "running";
    case "stop":
      return "stopped";
    case "archive":
      return "archived";
    case "delete":
      return "deleted";
  }
}

function correctiveOperation(
  desired: DesiredState,
): Exclude<LifecycleOperation, "create"> {
  switch (desired) {
    case "running":
      return "wake";
    case "stopped":
      return "stop";
    case "archived":
      return "archive";
    case "deleted":
      return "delete";
  }
}

function operationSatisfied(
  operation: LifecycleOperation,
  resource: CloudProviderResource | null,
): boolean {
  switch (operation) {
    case "create":
    case "wake":
      return resource?.state === "running";
    case "stop":
      return (
        resource === null ||
        resource.computeStopped === true ||
        resource.state === "stopped" ||
        resource.state === "archived" ||
        resource.state === "deleted"
      );
    case "archive":
      return (
        resource === null ||
        (resource.state === "stopped" && resource.storageOffloaded === true) ||
        resource.state === "archived" ||
        resource.state === "deleted"
      );
    case "delete":
      return resource === null || resource.state === "deleted";
  }
}

function isTransitional(resource: CloudProviderResource | null): boolean {
  return (
    resource !== null &&
    ["provisioning", "stopping", "archiving", "deleting", "unknown"].includes(
      resource.state,
    )
  );
}

function statusForObserved(
  desired: DesiredState,
  resource: CloudProviderResource | null,
): string {
  if (desired === "deleted") {
    return resource === null || resource.state === "deleted"
      ? "deleted"
      : "deleting";
  }
  if (desired === "archived") {
    return operationSatisfied("archive", resource)
      ? "archived"
      : "archiving";
  }
  if (desired === "stopped") {
    return resource === null ||
      ["stopped", "archived", "deleted"].includes(resource.state)
      ? "stopped"
      : "stopping";
  }
  if (resource?.state === "running") return "setting_up";
  if (resource?.state === "provisioning") return "provisioning";
  if (resource?.state === "failed") return "failed";
  return "waking";
}

function statusForReconciledObservation(
  desired: DesiredState,
  resource: CloudProviderResource | null,
  currentStatus: string,
): string {
  if (
    desired === "running" &&
    resource?.state === "running" &&
    ["setting_up", "ready", "busy", "failed"].includes(currentStatus)
  ) {
    // Provider health cannot prove setup/readiness, current activity, or
    // recovery from an application failure. Those states belong to their own
    // controllers and must not be downgraded by a lifecycle observation.
    return currentStatus;
  }
  return statusForObserved(desired, resource);
}

function boundedMetadata(
  metadata: Readonly<Record<string, string | number | boolean | null>>,
): string {
  const serialized = JSON.stringify(metadata);
  // jsonb's normalized textual form may add insignificant spaces; leave room
  // beneath the database's hard 64 KiB ceiling.
  if (Buffer.byteLength(serialized, "utf8") <= 60 * 1024) return serialized;
  return JSON.stringify({ truncated: true });
}

/** Settled resting workspaces drift-check on the slow cadence; running and
 * transitional ones keep the fast one. */
function driftCadenceMs(desiredState: DesiredState, status: string, intervalMs: number, stoppedIntervalMs: number): number {
  return (desiredState === "stopped" && status === "stopped") || (desiredState === "archived" && status === "archived")
    ? stoppedIntervalMs : intervalMs;
}

function retryDelayMs(attempt: number, providerDelayMs?: number): number {
  const exponential = Math.min(
    5 * 60_000,
    1_000 * 2 ** Math.min(Math.max(attempt - 1, 0), 8),
  );
  const requested =
    typeof providerDelayMs === "number" && Number.isFinite(providerDelayMs)
      ? Math.min(5 * 60_000, Math.max(0, Math.ceil(providerDelayMs)))
      : 0;
  return Math.max(exponential, requested);
}

function observationDelayMs(attempt: number, elapsedMs: number): number {
  if (elapsedMs < 30_000) {
    return Math.min(2_000, 500 * 2 ** Math.min(Math.max(attempt - 1, 0), 2));
  }
  // Resume the original exponential schedule by dispatch age. Extra healthy
  // polls must not turn a thirty-second transition into a four-minute wait;
  // slow provider replies must also retain their shorter existing delay.
  const elapsedAttempt = 1 + Math.floor(Math.log2(1 + elapsedMs / 1_000));
  return retryDelayMs(Math.min(attempt, elapsedAttempt));
}

function safeFailure(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
  retryAfterMs?: number | undefined;
} {
  if (error instanceof HttpError && error.code === CLOUD_WORKSPACE_V2_REQUIRED) return { code: error.code, message: error.message, retryable: false };
  if (error instanceof CloudRuntimeError) return { code: error.code, message: error.message, retryable: false };
  if (error instanceof CloudProviderError) {
    return {
      code: error.code.slice(0, 128),
      message: error.retryable
        ? "Cloud provider operation is temporarily unavailable"
        : "Cloud provider rejected the lifecycle operation",
      retryable: error.retryable,
      retryAfterMs: error.retryAfterMs,
    };
  }
  return {
    code: "provider_unknown_failure",
    message: "Cloud provider operation did not complete",
    retryable: true,
  };
}

export class CloudWorkspaceReconciler {
  private readonly pool: pg.Pool;
  private readonly provider: CloudWorkspaceProvider;
  private readonly providerResolver: CloudWorkspaceProviderResolver | null;
  private readonly intervalMs: number;
  private readonly leaseMs: number;
  private readonly orphanGraceMs: number;
  private readonly maxManagedResourcesPerSweep: number;
  private readonly stoppedDriftIntervalMs: number;
  private readonly inventoryFallbackMs: number;
  private cleanupScopeOffset = 0;
  private readonly workerId: string;
  private readonly logger: ReconcileLogger;
  private readonly paidAuthority: DatabaseCloudWorkspacePaidAuthorityReconciler;
  private readonly computeLeases: CloudWorkspaceComputeLeaseCoordinator;
  private readonly runtimeUpgradeConfig: CloudWorkspaceBackendConfig | null;
  private readonly workosEnabled: boolean;
  private readonly scheduler: CloudWorkerScheduler;
  private readonly jobs: JobRunner;
  private readonly jobAuditIntervalMs: number;
  private stopped = false;
  private ticking = false;
  private orphanSweepAt = Date.now() + ORPHAN_SWEEP_INTERVAL_MS;
  private auditAt: number;

  constructor(options: CloudWorkspaceReconcilerOptions) {
    this.pool = options.pool;
    this.provider = options.provider;
    this.providerResolver = options.providerResolver ?? null;
    this.runtimeUpgradeConfig = options.runtimeUpgradeConfig ?? null;
    this.workosEnabled = options.workosEnabled === true;
    this.computeLeases = new CloudWorkspaceComputeLeaseCoordinator({pool:options.pool,provider:options.provider,
      ...(options.providerResolver?{providerResolver:options.providerResolver}:{}),workosEnabled:options.workosEnabled===true,
      ...(options.computePolicy?{policy:options.computePolicy}:{}),
      ...(options.computeUsageMeterWindowMs !== undefined ? { usageMeterWindowMs: options.computeUsageMeterWindowMs } : {}),
      logger:options.logger??console});
    this.intervalMs = options.intervalMs ?? 60_000;
    this.stoppedDriftIntervalMs = options.stoppedDriftIntervalMs ?? DEFAULT_STOPPED_DRIFT_INTERVAL_MS;
    this.inventoryFallbackMs = options.inventoryFallbackMs ?? DEFAULT_STOPPED_DRIFT_INTERVAL_MS;
    this.leaseMs = options.leaseMs ?? 10 * 60_000;
    this.orphanGraceMs = options.orphanGraceMs ?? 60 * 60_000;
    this.maxManagedResourcesPerSweep =
      options.maxManagedResourcesPerSweep ?? 10_000;
    this.workerId = options.workerId ?? `control-plane:${randomUUID()}`;
    this.paidAuthority = new DatabaseCloudWorkspacePaidAuthorityReconciler(
      this.pool,
      {
        workosEnabled: options.workosEnabled === true,
        ...(options.paidAuthorityRecheckIntervalMs === undefined
          ? {}
          : {
              recheckIntervalMs: options.paidAuthorityRecheckIntervalMs,
            }),
      },
    );
    if (
      !Number.isSafeInteger(this.intervalMs) ||
      this.intervalMs < 100 ||
      this.intervalMs > 300_000 ||
      !Number.isSafeInteger(this.leaseMs) ||
      this.leaseMs < 1_000 ||
      this.leaseMs > 3_600_000 ||
      !Number.isSafeInteger(this.orphanGraceMs) ||
      this.orphanGraceMs < 1_000 ||
      this.orphanGraceMs > 30 * 24 * 60 * 60_000 ||
      !Number.isSafeInteger(this.maxManagedResourcesPerSweep) ||
      this.maxManagedResourcesPerSweep < 1 ||
      this.maxManagedResourcesPerSweep > 100_000
    ) {
      throw new Error("Cloud workspace reconciler timing is invalid");
    }
    if (!isValidCloudWorkspaceWorkerId(this.workerId)) {
      throw new Error("Cloud workspace reconciler worker identity is invalid");
    }
    this.logger = options.logger ?? console;
    this.jobAuditIntervalMs = options.jobAuditIntervalMs ?? 60 * 60_000;
    if (!Number.isSafeInteger(this.jobAuditIntervalMs) || this.jobAuditIntervalMs < 1_000 ||
      this.jobAuditIntervalMs > 24 * 60 * 60_000 ||
      !Number.isSafeInteger(this.stoppedDriftIntervalMs) ||
      this.stoppedDriftIntervalMs < Math.max(60_000, this.intervalMs) ||
      this.stoppedDriftIntervalMs > 7 * 24 * 60 * 60_000 ||
      !Number.isSafeInteger(this.inventoryFallbackMs) ||
      this.inventoryFallbackMs < Math.max(60_000, this.intervalMs) ||
      this.inventoryFallbackMs > 7 * 24 * 60 * 60_000) {
      throw new Error("Cloud workspace reconciler timing is invalid");
    }
    // Replicas start together after a deploy; spread their audits.
    this.auditAt = Date.now() + Math.round(this.jobAuditIntervalMs * (0.5 + Math.random() * 0.5));
    // Due work arrives as jobs. This loop only runs the inventory sweep and
    // the lost-enqueue audit, and reads nothing until one of them is due.
    this.scheduler = new CloudWorkerScheduler(this.intervalMs, () => this.tick(), () => {
      this.logger.error("[cloud-workspace] reconcile maintenance failed; will retry");
    }, async () => Math.min(this.orphanSweepAt, this.auditAt) - Date.now(), { readBeforeRun: true });
    const leaseMs = Math.max(60_000, Math.min(3_600_000, this.leaseMs));
    this.jobs = new JobRunner({
      pool: this.pool,
      concurrency: options.jobConcurrency ?? 1,
      pollIntervalMs: Math.min(300_000, Math.max(1_000, this.intervalMs)),
      ownerId: isValidJobOwner(this.workerId) ? this.workerId : `control-plane:${randomUUID()}`,
      logger: this.logger,
      handlers: (Object.keys(LIFECYCLE_JOB_KINDS) as LifecycleWork[]).map(work => ({
        kind: LIFECYCLE_JOB_KINDS[work],
        leaseMs: 60_000,
        // A lifecycle dispatch holds its own intent lease for up to leaseMs.
        timeoutMs: leaseMs,
        backoff: { baseMs: 1_000, maxMs: 5 * 60_000 },
        handle: (job, { signal }) => this.runJob(job, signal),
      })),
    });
  }

  start(): () => Promise<void> {
    this.jobs.start();
    this.scheduler.start();
    return () => this.stop();
  }

  /** A hint that lifecycle work may be due: claim due jobs now. */
  notify(): void { this.jobs.notify(); }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all([this.scheduler.stop(), this.jobs.stop()]);
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      if (Date.now() >= this.orphanSweepAt) {
        try { await this.reconcileOrphansOnce(); }
        finally { this.orphanSweepAt = Date.now() + ORPHAN_SWEEP_INTERVAL_MS; }
      }
      if (!this.stopped && Date.now() >= this.auditAt) {
        try { await this.auditJobs(); }
        finally { this.auditAt = Date.now() + this.jobAuditIntervalMs; }
      }
    } finally {
      this.ticking = false;
    }
  }

  private dueScope() {
    return { provider: this.providerResolver ? null : this.provider.name, driftIntervalMs: this.intervalMs,
      stoppedDriftIntervalMs: this.stoppedDriftIntervalMs };
  }

  /** Hourly maintenance: repair missing or late jobs and purge terminally
   * failed rows, which nothing else ever deletes. */
  async auditJobs(): Promise<Partial<Record<LifecycleWork, number>>> {
    const repaired = await auditLifecycleJobs(this.pool, this.dueScope());
    const total = Object.values(repaired).reduce((sum, count) => sum + count, 0);
    if (total) this.logger.warn(`[cloud-workspace] lifecycle job audit repaired ${total} missing or late job(s)`);
    const purged = await purgeFailedJobs(this.pool, { olderThanMs: 7 * 24 * 60 * 60_000, limit: 1_000 });
    if (purged) this.logger.info(`[jobs] purged ${purged} terminally failed job(s)`);
    return repaired;
  }

  /** Run one lifecycle job: claim that workspace's due work of the job's kind
   * through the existing fenced claim, then reschedule at the next due time. */
  async runJob(job: Pick<ClaimedJob, "kind" | "workspaceId" | "orgId" | "payload">, signal?: AbortSignal): Promise<void> {
    const work = lifecycleWorkForJob(job.kind);
    if (!work) return;
    const scope = work === "diagnostics" ? null : job.workspaceId;
    // A workspace job without a workspace cannot be scoped; never widen it.
    if (work !== "diagnostics" && !scope) return;
    const provider = this.dueScope().provider;
    let processed = 0;
    // The runner aborts on timeout and lease loss and then frees the slot, so
    // a run that kept claiming would overlap the next one in this process.
    const live = () => !this.stopped && !signal?.aborted;
    const drain = async (claim: () => Promise<boolean>) => {
      while (live() && processed < MAX_CLAIMS_PER_JOB && await claim()) processed += 1;
    };
    switch (work) {
      case "paidAuthority": await drain(async () => (await this.paidAuthority.runOnce(scope)) !== null); break;
      case "engineHealth": await drain(() => stopUnavailableCloudEngine(this.pool, provider, scope)); break;
      case "compute": await drain(() => this.computeLeases.runOnce(scope)); break;
      case "lifecycle": await drain(() => this.runOnce(scope)); break;
      case "drift": if (live() && await this.reconcileDriftOnce(scope)) processed = 1; break;
      // Work still due after a pass is contested (SKIP LOCKED): back off.
      // A productive pass means a publication backlog may remain (256 per
      // pass): reschedule at once instead of backing off.
      case "diagnostics": if (live()) processed = await runCloudDiagnosticCleanup(this.pool) > 0 ? 1 : 0; break;
    }
    // An aborted run's job already belongs to the runner (failure backoff) or
    // to whoever reclaimed its lease; moving it earlier would undo either.
    if (signal?.aborted) return;
    // Completion deletes the job, so it is rescheduled even during shutdown;
    // work a shutdown interrupted is due again now, for another replica.
    await rescheduleLifecycleJob(this.pool, work, job, { ...this.dueScope(), processed: processed > 0 || this.stopped });
    // Maintenance can enqueue a stop. Claim it now rather than wait for the
    // commit hint, which a runner without a listener never receives.
    if (processed > 0 && work !== "lifecycle") this.jobs.notify();
  }

  private async claimIntent(workspaceId: string | null = null): Promise<ClaimedIntent | null> {
    return withSystemTx(this.pool, async (tx) => {
      const result = await tx.query<{
        id: string;
        workspace_id: string;
        org_id: string;
        operation: LifecycleOperation;
        desired_state: DesiredState;
        current_generation: number;
        generation: number;
        provider: string;
        image_ref: string;
        architecture: "linux/amd64" | "linux/arm64";
        cpu_millicores: number;
        memory_mib: number;
        storage_mib: number;
        provider_resource_id: string | null;
        attempt_count: number;
        affects_workspace: boolean;
        generation_transition_id: string | null;
        checkpoint_request_id: string | null;
        checkpoint_request_state: string | null;
        authority_epoch: string;
      }>(
        `SELECT i.id, i.workspace_id, i.org_id, i.operation,
                cw.desired_state, cw.current_generation, cw.authority_epoch, i.generation,
                i.affects_workspace, i.generation_transition_id, g.provider,
                g.image_ref, g.architecture, g.cpu_millicores,
                g.memory_mib, g.storage_mib, pb.provider_resource_id,
                i.attempt_count, checkpoint_request.id AS checkpoint_request_id,
                checkpoint_request.state AS checkpoint_request_state
         FROM cloud_workspace_lifecycle_intents i
         JOIN cloud_workspaces cw ON cw.id = i.workspace_id
         JOIN cloud_workspace_generations g
           ON g.workspace_id = i.workspace_id AND g.generation = i.generation
          AND g.org_id = i.org_id
         JOIN cloud_workspace_provider_bindings pb
           ON pb.workspace_id = g.workspace_id AND pb.generation = g.generation
         LEFT JOIN workspace_checkpoint_requests checkpoint_request
           ON checkpoint_request.lifecycle_intent_id = i.id
         WHERE i.next_attempt_at <= now()
           AND ($1::uuid IS NULL OR i.workspace_id = $1)
           AND (i.resume_after_intent_id IS NULL OR EXISTS (
             SELECT 1 FROM cloud_workspace_lifecycle_intents prerequisite
             WHERE prerequisite.id=i.resume_after_intent_id AND prerequisite.state='succeeded'
           ))
           AND (
             i.state IN ('queued', 'observing')
             OR (i.state = 'dispatching' AND i.lease_expires_at <= now())
           )
           AND NOT EXISTS (
             SELECT 1 FROM cloud_workspace_lifecycle_intents active
             WHERE active.workspace_id = i.workspace_id
               AND active.id <> i.id
               AND active.state = 'dispatching'
               AND active.lease_expires_at > now()
           )
           AND (
             checkpoint_request.id IS NULL
             OR checkpoint_request.state = 'succeeded'
             OR (checkpoint_request.state = 'cancelled' AND checkpoint_request.error_code = 'stop_unsealed')
           )
           AND (
             i.operation <> 'create'
             OR NOT EXISTS (
               SELECT 1 FROM workspace_fork_intents fork
               WHERE fork.target_cloud_workspace_id = i.workspace_id
                 AND fork.org_id = i.org_id
                 AND fork.operation = 'local_to_cloud'
                 AND fork.state <> 'succeeded'
             )
           )
         ORDER BY i.created_at, i.id
         FOR UPDATE OF i, cw SKIP LOCKED
         LIMIT 1`,
        [workspaceId],
      );
      const row = result.rows[0];
      if (!row) return null;

      if ((row.operation === "stop" || row.operation === "archive" || row.operation === "delete") &&
          !await prepareCloudWorkspaceStopSeal(tx, {
            workspaceId: row.workspace_id, organizationId: row.org_id, generation: row.generation,
            intentId: row.id, operation: row.operation,
          })) return null;

      let desiredState = row.desired_state;
      let authorityEpoch = row.authority_epoch;
      if (
        row.affects_workspace &&
        row.checkpoint_request_id !== null &&
        ["succeeded", "cancelled"].includes(row.checkpoint_request_state ?? "") &&
        row.current_generation === row.generation &&
        row.desired_state === "running" &&
        ["stop", "archive", "delete"].includes(row.operation)
      ) {
        desiredState = desiredForOperation(row.operation);
        const status =
          row.operation === "stop"
            ? "stopping"
            : row.operation === "archive"
              ? "archiving"
              : "deleting";
        const advanced = await tx.query<{ authority_epoch: string }>(
          `UPDATE cloud_workspaces
           SET desired_state = $2, status = $3::cloud_workspace_status,
               authority_epoch = authority_epoch + 1,
               version = version + 1, updated_at = now(),
               last_error_code = NULL, last_error_message = NULL
           WHERE id = $1 AND current_generation = $4
           RETURNING authority_epoch`,
          [row.workspace_id, desiredState, status, row.generation],
        );
        authorityEpoch = advanced.rows[0]!.authority_epoch;
        await retireCloudWorkspaceRuntimeAccess(tx, {
          workspaceId: row.workspace_id,
          organizationId: row.org_id,
          generation: row.generation,
          reason:
            row.operation === "stop"
              ? "workspace_stop_requested"
              : row.operation === "archive"
                ? "workspace_archive_requested"
                : "workspace_delete_requested",
        });
      }
      await tx.query(
        `UPDATE cloud_workspace_lifecycle_intents
         SET state = 'dispatching', attempt_count = attempt_count + 1,
             lease_owner = $2,
             lease_expires_at = now() + ($3::bigint * interval '1 millisecond'),
             dispatched_at = coalesce(dispatched_at, now()), updated_at = now(),
             error_code = NULL, error_message = NULL
         WHERE id = $1`,
        [row.id, this.workerId, this.leaseMs],
      );
      return {
        id: row.id,
        workspaceId: row.workspace_id,
        orgId: row.org_id,
        operation: row.operation,
        desiredState,
        generation: row.generation,
        provider: row.provider,
        imageRef: row.image_ref,
        architecture: row.architecture,
        cpuMillicores: row.cpu_millicores,
        memoryMiB: row.memory_mib,
        storageMiB: row.storage_mib,
        providerResourceId: row.provider_resource_id,
        attemptCount: row.attempt_count + 1,
        affectsWorkspace: row.affects_workspace,
        generationWasCurrent: row.generation === row.current_generation,
        generationTransitionId: row.generation_transition_id,
        authorityEpoch,
      };
    });
  }

  async runOnce(workspaceId: string | null = null): Promise<boolean> {
    const intent = await this.claimIntent(workspaceId);
    if (!intent) return false;
    const mayUpgradeOnWake = !!this.runtimeUpgradeConfig && intent.affectsWorkspace &&
      !intent.generationTransitionId && ["create", "wake"].includes(intent.operation);
    let provider: CloudWorkspaceProvider;
    try {
      if (intent.operation === "create" || intent.operation === "wake") {
        await withSystemTx(this.pool, async tx => {
          await tx.query("SELECT id FROM organizations WHERE id=$1 FOR SHARE", [intent.orgId]);
          await tx.query("SELECT id FROM cloud_workspaces WHERE id=$1 AND org_id=$2 FOR SHARE", [intent.workspaceId, intent.orgId]);
          await requireSupportedCloudWorkspaceGeneration(tx, {
            workspaceId: intent.workspaceId, organizationId: intent.orgId, generation: intent.generation,
          });
        });
      }
      if (!mayUpgradeOnWake && (intent.operation === "create" || intent.operation === "wake")) {
        await withSystemTx(this.pool, tx => requireGenerationRuntime(tx, {
          workspaceId: intent.workspaceId, organizationId: intent.orgId, generation: intent.generation,
        }, this.runtimeUpgradeConfig?.runtime?.qualificationMode));
      }
      provider = this.providerResolver
        ? (
            await this.providerResolver.resolve({
              workspaceId: intent.workspaceId,
              organizationId: intent.orgId,
              generation: intent.generation,
              purpose: ["create", "wake"].includes(intent.operation)
                ? "lifecycle"
                : "cleanup",
            })
          ).provider
        : this.provider;
    } catch (error) {
      await this.recordFailure(intent, error);
      return true;
    }
    if (intent.provider !== provider.name) {
      await this.recordFailure(
        intent,
        new CloudProviderError(
          "provider_not_available",
          "No reconciler is registered for this workspace provider",
          false,
        ),
      );
      return true;
    }

    let current: CloudProviderResource | null = null;
    try {
      current = await this.observe(provider, intent);
      let providerAccessRevocationProven =
        current === null || current.state === "deleted";

      // The request changed while an earlier provider call was in flight. Find
      // and bind any unknown result, but never dispatch an obsolete action.
      if (
        intent.affectsWorkspace &&
        (!intent.generationWasCurrent ||
          intent.desiredState !== desiredForOperation(intent.operation))
      ) {
        await this.recordResult(intent, current, "superseded");
        return true;
      }

      if (intent.operation === "wake" && intent.affectsWorkspace && !intent.generationTransitionId &&
          provider.name === "boat" && current?.state === "failed" && current.computeStopped === true &&
          current.metadata.snapshotMissing === true)
        throw new CloudProviderError("provider_snapshot_missing", "The stopped snapshot is no longer available", false);
      if (mayUpgradeOnWake && current && ["stopped", "archived"].includes(current.state) &&
          await upgradeCloudRuntimeOnWake(this.pool, this.runtimeUpgradeConfig!, {
            workspaceId: intent.workspaceId, organizationId: intent.orgId, generation: intent.generation,
            intentId: intent.id, workerId: this.workerId,
          }, this.workosEnabled)) return true;
      // A replacement may repair a revoked stopped pin. Any ordinary resume
      // still validates that saved pin before provider or compute-lease writes.
      if (mayUpgradeOnWake) await withSystemTx(this.pool, tx => requireGenerationRuntime(tx, {
        workspaceId:intent.workspaceId,organizationId:intent.orgId,generation:intent.generation,
      },this.runtimeUpgradeConfig?.runtime?.qualificationMode));
      if(current?.state==='running'&&['create','wake'].includes(intent.operation))
        await this.computeLeases.observeRunning({workspaceId:intent.workspaceId,organizationId:intent.orgId,generation:intent.generation},provider,current);

      // The provider adapter's destructive lifecycle contract includes
      // provider-wide access revocation. Even when provider state already
      // satisfies stop/archive, dispatch once so a stale SSH bearer cannot be
      // declared revoked in PostgreSQL without provider proof.
      const forceProviderAccessDrain =
        current !== null &&
        current.state !== "deleted" &&
        ["stop", "archive"].includes(intent.operation);
      if (
        (!operationSatisfied(intent.operation, current) ||
          forceProviderAccessDrain) &&
        (!isTransitional(current) || current?.computeStopped === true)
      ) {
        current = await this.dispatch(provider, intent, current);
        if (["stop", "archive", "delete"].includes(intent.operation)) {
          providerAccessRevocationProven = true;
        }
      }
      if (operationSatisfied(intent.operation, current)) {
        await this.recordResult(
          intent,
          current,
          "succeeded",
          providerAccessRevocationProven,
        );
      } else if (current?.state === "failed") {
        await this.recordFailure(
          intent,
          new CloudProviderError(
            current.computeStopped === true ? "provider_snapshot_failed" : "provider_resource_failed",
            current.computeStopped === true ? "Compute stopped but its provider snapshot failed; recover the durable checkpoint into a new generation" : "Provider resource entered a failed state",
            false,
          ),
        );
      } else {
        await this.recordResult(intent, current, "observing");
      }
    } catch (error) {
      await this.recordFailure(intent, error, current);
    }
    return true;
  }

  private async observe(
    provider: CloudWorkspaceProvider,
    intent: ClaimedIntent,
  ): Promise<CloudProviderResource | null> {
    if (intent.providerResourceId) {
      const resource = await provider.inspect(intent.providerResourceId);
      if (resource) assertProviderResourceIdentity(resource, intent);
      else await assertProviderAbsence(provider, intent);
      return resource;
    }
    const found = assertSingleProviderResource(
      await provider.find({
        workspaceId: intent.workspaceId,
        generation: intent.generation,
      }),
      { workspaceId: intent.workspaceId, generation: intent.generation },
    );
    if (found) assertProviderResourceIdentity(found, intent);
    // Candidate cleanup is generation-scoped; the restored current workspace
    // may still desire running. Its state cannot prove this allocation absent.
    else if (intent.desiredState !== "running" ||
             !["create", "wake"].includes(intent.operation))
      await assertProviderAbsence(provider, intent);
    return found;
  }

  private async dispatch(
    provider: CloudWorkspaceProvider,
    intent: ClaimedIntent,
    current: CloudProviderResource | null,
  ): Promise<CloudProviderResource | null> {
    switch (intent.operation) {
      case "create":
      case "wake": {
        await withSystemTx(this.pool, async tx => {
          await tx.query("SELECT id FROM organizations WHERE id=$1 FOR SHARE", [intent.orgId]);
          await tx.query("SELECT id FROM cloud_workspaces WHERE id=$1 AND org_id=$2 FOR SHARE", [intent.workspaceId, intent.orgId]);
          await requireSupportedCloudWorkspaceGeneration(tx, {
            workspaceId: intent.workspaceId, organizationId: intent.orgId, generation: intent.generation,
          });
          await requireGenerationRuntime(tx, {
            workspaceId: intent.workspaceId, organizationId: intent.orgId, generation: intent.generation,
          }, this.runtimeUpgradeConfig?.runtime?.qualificationMode);
        });
        if (!current && intent.providerResourceId) {
          // An admitted generation already had an allocation. Reusing its
          // identity would hide allocation loss and native-history recovery
          // from clients. The owner can select its durable checkpoint through
          // the fenced recovery-generation API.
          throw new CloudProviderError("provider_resource_lost", "The allocation is unavailable; recover the durable checkpoint into a new generation", false);
        }
        const next = await this.computeLeases.allocate({
              workspaceId: intent.workspaceId,
              organizationId:intent.orgId,
              intentId:intent.id,
              generation: intent.generation,
              imageRef: intent.imageRef,
              architecture: intent.architecture,
              cpuMillicores: intent.cpuMillicores,
              memoryMiB: intent.memoryMiB,
              storageMiB: intent.storageMiB,
              idempotencyKey: intent.id,
            },provider,current);
        assertProviderResourceIdentity(next, intent);
        return next;
      }
      case "stop": {
        if (!current) return null;
        const next = await provider.stop(current.resourceId);
        assertProviderResourceIdentity(next, intent);
        return next;
      }
      case "archive": {
        if (!current) return null;
        const next = await provider.archive(current.resourceId);
        assertProviderResourceIdentity(next, intent);
        return next;
      }
      case "delete": {
        if (!current) return null;
        if(!await this.computeLeases.beforeDelete({workspaceId:intent.workspaceId,organizationId:intent.orgId,generation:intent.generation},provider,current))
          return (await provider.inspect(current.resourceId))??current;
        await provider.delete(current.resourceId);
        // A successful dispatch proves only that the provider accepted the
        // request. Inspect independently before publishing durable deletion;
        // providers may apply deletion asynchronously.
        const remaining = await provider.inspect(current.resourceId);
        if (remaining) assertProviderResourceIdentity(remaining, intent);
        else await assertProviderAbsence(provider, intent);
        return remaining;
      }
    }
  }

  private async recordResult(
    intent: ClaimedIntent,
    resource: CloudProviderResource | null,
    intentState: "succeeded" | "superseded" | "observing",
    providerAccessRevocationProven = false,
  ): Promise<void> {
    await withSystemTx(this.pool, async (tx) => {
      // Lifecycle routes lock workspace before touching intents. Keep the same
      // order here so a provider response racing stop/delete cannot deadlock.
      const workspace = await tx.query<{
        desired_state: DesiredState;
        current_generation: number;
      }>(
        `SELECT desired_state, current_generation
         FROM cloud_workspaces WHERE id = $1 FOR UPDATE`,
        [intent.workspaceId],
      );
      const current = workspace.rows[0];
      if (!current) return;

      const owned = await tx.query<{
        state: string;
        affects_workspace: boolean;
        lease_owner: string | null;
        dispatched_age_ms: string;
      }>(
        `SELECT state, affects_workspace, lease_owner,
                extract(epoch FROM (now() - dispatched_at)) * 1000 AS dispatched_age_ms
         FROM cloud_workspace_lifecycle_intents
         WHERE id = $1 FOR UPDATE`,
        [intent.id],
      );
      const row = owned.rows[0];
      if (!row || row.state === "succeeded" || row.state === "superseded")
        return;
      if (row.lease_owner !== this.workerId) return;

      const desired = current.desired_state;
      const generationIsCurrent =
        current.current_generation === intent.generation;
      const intentIsCurrent =
        row.affects_workspace &&
        generationIsCurrent &&
        desired === desiredForOperation(intent.operation);
      const resultState = row.affects_workspace
        ? intentIsCurrent
          ? intentState
          : "superseded"
        : intentState;
      const observedState =
        resource?.state ??
        (intent.operation === "delete" ? "deleted" : "absent");
      // A later stop or archive that finds a deleted generation absent must
      // not clear its deletion verification; only a live resource can.
      await tx.query(
        `UPDATE cloud_workspace_provider_bindings
         SET provider_resource_id = coalesce($3, provider_resource_id),
             provider_target = coalesce($4, provider_target),
             observed_state = CASE
               WHEN $3::text IS NULL AND deletion_verified_at IS NOT NULL THEN 'deleted' ELSE $5
             END,
             observed_metadata = $6::jsonb,
             last_observed_at = now(), updated_at = now(),
             deletion_verified_at = CASE
               WHEN $5 = 'deleted' THEN now()
               WHEN $3::text IS NULL THEN deletion_verified_at
               ELSE NULL
             END
         WHERE workspace_id = $1 AND generation = $2`,
        [
          intent.workspaceId,
          intent.generation,
          resource?.resourceId ?? null,
          resource?.target ?? null,
          observedState,
          boundedMetadata(resource?.metadata ?? {}),
        ],
      );

      if (
        row.affects_workspace &&
        generationIsCurrent &&
        resultState !== "superseded" &&
        intent.operation === "create" &&
        resource?.state === "running"
      ) {
        await tx.query(
          `UPDATE cloud_workspace_generation_transitions
           SET state = 'setting_up', updated_at = now()
           WHERE workspace_id = $1 AND org_id = $2
             AND candidate_generation = $3 AND state = 'provisioning'`,
          [intent.workspaceId, intent.orgId, intent.generation],
        );
      }
      if (
        !row.affects_workspace &&
        intent.operation === "delete" &&
        resultState === "succeeded"
      ) {
        await tx.query(
          `UPDATE cloud_workspace_generations
           SET retired_at = coalesce(retired_at, now())
           WHERE workspace_id = $1 AND generation = $2 AND org_id = $3`,
          [intent.workspaceId, intent.generation, intent.orgId],
        );
      }
      if (
        resultState === "succeeded" &&
        providerAccessRevocationProven &&
        ["stop", "archive", "delete"].includes(intent.operation)
      ) {
        await confirmCloudWorkspaceClientAccessRevoked(tx, {
          workspaceId: intent.workspaceId,
          organizationId: intent.orgId,
          generation: intent.generation,
        });
        await tx.query("UPDATE cloud_workspace_restore_incidents SET next_attempt_at=now() WHERE drain_intent_id=$1 AND state='queued'",[intent.id]);
      }
      if (
        resultState === "succeeded" &&
        !row.affects_workspace &&
        intent.operation === "stop" &&
        intent.generationTransitionId
      ) {
        await advanceCloudWorkspaceGenerationTransitionAfterDrain(tx, {
          workspaceId: intent.workspaceId,
          organizationId: intent.orgId,
          sourceGeneration: intent.generation,
          transitionId: intent.generationTransitionId,
        });
      }

      if (
        !generationIsCurrent ||
        desired !== "running" ||
        resource?.state !== "running"
      ) {
        await retireCloudWorkspaceRuntimeAccess(tx, {
          workspaceId: intent.workspaceId,
          organizationId: intent.orgId,
          generation: intent.generation,
          reason: !generationIsCurrent
            ? "generation_superseded"
            : desired !== "running"
              ? "lifecycle_superseded"
              : "provider_not_running",
        });
      }

      if (row.affects_workspace && generationIsCurrent) {
        const status = statusForObserved(desired, resource);
        await tx.query(
          `UPDATE cloud_workspaces
           SET status = $2::cloud_workspace_status,
               last_observed_at = now(), updated_at = now(),
               version = version + 1,
               deleted_at = CASE WHEN $2 = 'deleted' THEN coalesce(deleted_at, now())
                                 ELSE NULL END,
               last_error_code = NULL, last_error_message = NULL
           WHERE id = $1 AND current_generation = $3`,
          [intent.workspaceId, status, intent.generation],
        );

        if (
          resultState !== "superseded" &&
          desired === "running" &&
          resource?.state === "running"
        ) {
          await queueCloudWorkspaceSetupVerification(tx, {
            workspaceId: intent.workspaceId,
            generation: intent.generation,
            organizationId: intent.orgId,
          });
        }
      }

      if (resultState === "observing") {
        await tx.query(
          `UPDATE cloud_workspace_lifecycle_intents
           SET state = 'observing', lease_owner = NULL, lease_expires_at = NULL,
               next_attempt_at = now() + ($2::bigint * interval '1 millisecond'),
               error_code = NULL, error_message = NULL, updated_at = now()
           WHERE id = $1`,
          [intent.id, observationDelayMs(intent.attemptCount, Number(row.dispatched_age_ms))],
        );
      } else {
        await tx.query(
          `UPDATE cloud_workspace_lifecycle_intents
           SET state = $2::cloud_workspace_intent_state,
               completed_at = now(), lease_owner = NULL,
               lease_expires_at = NULL, error_code = NULL,
               error_message = NULL, updated_at = now()
           WHERE id = $1`,
          [intent.id, resultState],
        );
      }
      if(resultState==="succeeded"&&providerAccessRevocationProven&&["stop","archive","delete"].includes(intent.operation))
        await retireCloudAgentBootSources(tx,{workspaceId:intent.workspaceId,organizationId:intent.orgId,generation:intent.generation},
          {kind:"provider-lifecycle",intentId:intent.id});
      await audit(
        tx,
        intent.orgId,
        null,
        `cloud_workspace.${intent.operation}_${resultState}`,
        {
          workspaceId: intent.workspaceId,
          intentId: intent.id,
          generation: intent.generation,
          providerState: observedState,
          staleGeneration: !generationIsCurrent,
          desiredStateChanged: !intentIsCurrent && generationIsCurrent,
        },
      );
    });
  }

  private async recordFailure(
    intent: ClaimedIntent,
    error: unknown,
    observed: CloudProviderResource | null = null,
  ): Promise<void> {
    const failure = safeFailure(error);
    await withSystemTx(this.pool, async (tx) => {
      const current = await tx.query<{
        desired_state: DesiredState;
        current_generation: number;
        authority_epoch: string;
      }>(
        `SELECT desired_state, current_generation, authority_epoch
         FROM cloud_workspaces WHERE id = $1 FOR UPDATE`,
        [intent.workspaceId],
      );
      const workspace = current.rows[0];

      const owned = await tx.query<{
        state: string;
        affects_workspace: boolean;
        lease_owner: string | null;
        lease_current: boolean;
      }>(
        `SELECT state, affects_workspace, lease_owner, lease_expires_at>clock_timestamp() AS lease_current
         FROM cloud_workspace_lifecycle_intents
         WHERE id = $1 FOR UPDATE`,
        [intent.id],
      );
      const row = owned.rows[0];
      if (!row || row.lease_owner !== this.workerId) return;
      if (failure.code === "provider_snapshot_missing" && (!row.lease_current || row.state !== "dispatching")) return;

      const newerCaptureAuthority = failure.code === "provider_snapshot_missing" &&
        workspace?.current_generation === intent.generation && workspace.authority_epoch !== intent.authorityEpoch;
      const superseded =
        !workspace ||
        (row.affects_workspace &&
          (workspace.current_generation !== intent.generation ||
            workspace.desired_state !== desiredForOperation(intent.operation) ||
            newerCaptureAuthority));
      if (superseded) {
        // A later wake can admit new setup/access in the same generation.
        // This old provider observation cannot retire the newer authority.
        if (!newerCaptureAuthority) await retireCloudWorkspaceRuntimeAccess(tx, {
          workspaceId: intent.workspaceId,
          organizationId: intent.orgId,
          generation: intent.generation,
          reason:
            workspace?.current_generation !== intent.generation
              ? "generation_superseded"
              : "lifecycle_superseded",
        });
        await tx.query(
          `UPDATE cloud_workspace_lifecycle_intents
           SET state = 'superseded', completed_at = now(), lease_owner = NULL,
               lease_expires_at = NULL, error_code = NULL,
               error_message = NULL, updated_at = now()
           WHERE id = $1`,
          [intent.id],
        );
        await audit(
          tx,
          intent.orgId,
          null,
          `cloud_workspace.${intent.operation}_superseded`,
          {
            workspaceId: intent.workspaceId,
            intentId: intent.id,
            generation: intent.generation,
            code: failure.code,
            staleGeneration:
              workspace?.current_generation !== intent.generation,
          },
        );
        return;
      }

      // Compute can stop between delete polls while its snapshot still uploads.
      // If DELETE then reports a storage hold, retain that positive observation
      // so retirement can obtain fresh receipt proof. A partial/failed snapshot
      // becomes `deleting`, never a resumable archive. Leaving the old `archiving`
      // binding would veto retirement throughout the storage hold.
      // This is neither physical deletion nor a release of reserved storage.
      if (intent.operation === "delete" && row.affects_workspace && row.state === "dispatching" && row.lease_current &&
          workspace?.authority_epoch === intent.authorityEpoch && failure.retryable &&
          ["provider_deletion_blocked", "provider_deletion_pending"].includes(failure.code) &&
          observed && (["stopped", "archived"].includes(observed.state) || observed.computeStopped === true)) {
        assertProviderResourceIdentity(observed, intent);
        const observedState = ["stopped", "archived"].includes(observed.state) ? observed.state : "deleting";
        await tx.query(`UPDATE cloud_workspace_provider_bindings
          SET observed_state=$4, observed_metadata=$7::jsonb, last_observed_at=now(), updated_at=now()
          WHERE workspace_id=$1 AND org_id=$2 AND generation=$3 AND provider=$5
            AND provider_resource_id=$6 AND deletion_verified_at IS NULL`,
        [intent.workspaceId, intent.orgId, intent.generation, observedState, intent.provider, observed.resourceId,
          boundedMetadata(observed.metadata)]);
      }

      if (await deferCloudRecoveryResourceBlock(tx, {workspaceId:intent.workspaceId,transitionId:intent.generationTransitionId,intentId:intent.id,code:failure.code})) return;
      if (failure.retryable) {
        await tx.query(
          `UPDATE cloud_workspace_lifecycle_intents
           SET state = 'observing', lease_owner = NULL, lease_expires_at = NULL,
               next_attempt_at = now() + ($2::bigint * interval '1 millisecond'),
               error_code = $3, error_message = $4, updated_at = now()
           WHERE id = $1`,
          [
            intent.id,
            retryDelayMs(intent.attemptCount, failure.retryAfterMs),
            failure.code,
            failure.message,
          ],
        );
      } else {
        await tx.query(
          `UPDATE cloud_workspace_lifecycle_intents
           SET state = 'failed', completed_at = now(), lease_owner = NULL,
               lease_expires_at = NULL, error_code = $2,
               error_message = $3, updated_at = now()
           WHERE id = $1`,
          [intent.id, failure.code, failure.message],
        );
        const blockedWake = await tx.query(`UPDATE cloud_workspace_lifecycle_intents
          SET state='failed',completed_at=now(),updated_at=now(),error_code='workspace_drain_failed',
            error_message='The previous engine could not be stopped. Retry starting the workspace.'
          WHERE resume_after_intent_id=$1 AND affects_workspace AND state IN ('queued','observing') RETURNING id`, [intent.id]);
        if (blockedWake.rowCount && workspace?.current_generation === intent.generation && workspace.desired_state === "running") {
          await tx.query(`UPDATE cloud_workspaces SET status='failed',last_error_code='workspace_drain_failed',
            last_error_message='The previous engine could not be stopped. Retry starting the workspace.',
            version=version+1,updated_at=now() WHERE id=$1`, [intent.workspaceId]);
        }
        const rolledBackFromDrain =
          !row.affects_workspace &&
          intent.operation === "stop" &&
          intent.generationTransitionId
            ? await rollbackCloudWorkspaceGenerationTransitionAfterDrainFailure(
                tx,
                {
                  workspaceId: intent.workspaceId,
                  organizationId: intent.orgId,
                  sourceGeneration: intent.generation,
                  transitionId: intent.generationTransitionId,
                  errorCode: failure.code,
                  errorMessage: failure.message,
                },
              )
            : false;
        const rolledBack =
          rolledBackFromDrain ||
          (row.affects_workspace && intent.operation === "create"
            ? await rollbackCloudWorkspaceGenerationTransition(tx, {
                workspaceId: intent.workspaceId,
                organizationId: intent.orgId,
                candidateGeneration: intent.generation,
                errorCode: failure.code,
                errorMessage: failure.message,
              })
            : false);
        if (row.affects_workspace && !rolledBack) {
          await tx.query(
            `UPDATE cloud_workspaces
             SET status = 'failed', last_error_code = $2,
                 last_error_message = $3, updated_at = now(),
                 version = version + 1
             WHERE id = $1 AND current_generation = $4`,
            [
              intent.workspaceId,
              failure.code,
              failure.message,
              intent.generation,
            ],
          );
          await failCloudWorkspaceGenerationRollback(tx, {
            workspaceId: intent.workspaceId,
            organizationId: intent.orgId,
            sourceGeneration: intent.generation,
            errorCode: failure.code,
            errorMessage: failure.message,
          });
        }
        await retireCloudWorkspaceRuntimeAccess(tx, {
          workspaceId: intent.workspaceId,
          organizationId: intent.orgId,
          generation: intent.generation,
          reason: "provider_operation_failed",
        });
        if (failure.code === "provider_snapshot_missing" && intent.provider === "boat" && intent.operation === "wake" &&
            row.affects_workspace && row.lease_current && row.state === "dispatching" && this.runtimeUpgradeConfig &&
            !intent.generationTransitionId && intent.providerResourceId)
          await enqueueCloudMissingSnapshotRecovery(tx, { workspaceId: intent.workspaceId, organizationId: intent.orgId,
            generation: intent.generation, wakeIntentId: intent.id, providerResourceId: intent.providerResourceId,
            authorityEpoch: intent.authorityEpoch });
      }
      await audit(
        tx,
        intent.orgId,
        null,
        `cloud_workspace.${intent.operation}_${failure.retryable ? "retry_scheduled" : "failed"}`,
        {
          workspaceId: intent.workspaceId,
          intentId: intent.id,
          generation: intent.generation,
          code: failure.code,
          attempt: intent.attemptCount,
        },
      );
    });
  }

  private async driftCandidate(workspaceId: string | null): Promise<DriftCandidate | null> {
    return withSystemTx(this.pool, async (tx) => {
      const result = await tx.query<{
        workspace_id: string;
        org_id: string;
        desired_state: DesiredState;
        status: string;
        version: string | number;
        current_generation: number;
        provider: string;
        provider_resource_id: string | null;
      }>(
        `SELECT cw.id AS workspace_id, cw.org_id, cw.desired_state,
                cw.status, cw.version, cw.current_generation, pb.provider,
                pb.provider_resource_id
         FROM cloud_workspaces cw
         JOIN cloud_workspace_provider_bindings pb
           ON pb.workspace_id = cw.id
          AND pb.generation = cw.current_generation
         WHERE cw.status <> 'deleted'
           AND NOT EXISTS (SELECT 1 FROM cloud_workspace_restore_incidents incident WHERE incident.workspace_id=cw.id
             AND incident.source_generation=cw.current_generation AND incident.state IN ('queued','waiting_for_capacity','waiting_for_funding','restoring','recovery_needed'))
           AND ($1::text IS NULL OR pb.provider = $1)
           AND ($3::uuid IS NULL OR cw.id = $3)
           AND pb.next_drift_check_at <= clock_timestamp()
           AND (pb.drift_paced_until IS NULL OR pb.drift_paced_until <= clock_timestamp())
           AND (pb.last_observed_at IS NULL OR
                pb.last_observed_at < now() - (CASE WHEN (cw.desired_state='stopped' AND cw.status='stopped')
                  OR (cw.desired_state='archived' AND cw.status='archived')
                  THEN $4::bigint ELSE $2::bigint END * interval '1 millisecond'))
           AND NOT EXISTS (
             SELECT 1 FROM cloud_workspace_lifecycle_intents i
             WHERE i.workspace_id = cw.id
               AND (i.generation = cw.current_generation OR i.affects_workspace)
               AND i.state IN ('queued', 'dispatching', 'observing')
           )
         ORDER BY pb.next_drift_check_at, pb.last_observed_at NULLS FIRST, cw.updated_at, cw.id
         FOR UPDATE OF cw, pb SKIP LOCKED
         LIMIT 1`,
        [this.providerResolver ? null : this.provider.name, this.intervalMs, workspaceId, this.stoppedDriftIntervalMs],
      );
      const row = result.rows[0];
      if (!row) return null;
      const claim = await tx.query<{ next_drift_check_at: Date }>(
        `UPDATE cloud_workspace_provider_bindings
         SET next_drift_check_at = date_trunc('milliseconds', clock_timestamp()) + ($3::bigint * interval '1 millisecond')
         WHERE workspace_id=$1 AND generation=$2 RETURNING next_drift_check_at`,
        [row.workspace_id, row.current_generation, this.leaseMs],
      );
      return {
            workspaceId: row.workspace_id,
            orgId: row.org_id,
            desiredState: row.desired_state,
            status: row.status,
            version: row.version,
            generation: row.current_generation,
            provider: row.provider,
            providerResourceId: row.provider_resource_id,
            driftLeaseUntil: claim.rows[0]!.next_drift_check_at,
            intervalMs: driftCadenceMs(row.desired_state, row.status, this.intervalMs, this.stoppedDriftIntervalMs),
          };
    });
  }

  async reconcileDriftOnce(workspaceId: string | null = null): Promise<boolean> {
    const candidate = await this.driftCandidate(workspaceId);
    if (!candidate) return false;
    try {
      return await this.observeDriftCandidate(candidate);
    } finally {
      // Release only our exact claim. A failed attempt may already have
      // installed a longer provider backoff; a stale worker cannot shorten it.
      await withSystemTx(this.pool, tx => tx.query(
        `UPDATE cloud_workspace_provider_bindings
         SET next_drift_check_at=clock_timestamp()+($4::bigint * interval '1 millisecond')
         WHERE workspace_id=$1 AND generation=$2 AND next_drift_check_at=$3`,
        [candidate.workspaceId,candidate.generation,candidate.driftLeaseUntil,candidate.intervalMs],
      ));
    }
  }

  private async observeDriftCandidate(candidate: DriftCandidate): Promise<boolean> {
    let resource: CloudProviderResource | null;
    try {
      const provider = this.providerResolver
        ? (
            await this.providerResolver.resolve({
              workspaceId: candidate.workspaceId,
              organizationId: candidate.orgId,
              generation: candidate.generation,
              purpose:
                candidate.desiredState === "running" ? "lifecycle" : "cleanup",
            })
          ).provider
        : this.provider;
      resource = candidate.providerResourceId
        ? await provider.inspect(candidate.providerResourceId)
        : assertSingleProviderResource(
            await provider.find({
              workspaceId: candidate.workspaceId,
              generation: candidate.generation,
            }),
            {
              workspaceId: candidate.workspaceId,
              generation: candidate.generation,
            },
          );
      if (resource) assertProviderResourceIdentity(resource, candidate);
      else if (candidate.providerResourceId || candidate.desiredState !== "running")
        await assertProviderAbsence(provider, candidate);
      if(resource?.state==='running'&&candidate.desiredState==='running')
        await this.computeLeases.observeRunning({workspaceId:candidate.workspaceId,organizationId:candidate.orgId,generation:candidate.generation},provider,resource);
    } catch (error) {
      const failure = safeFailure(error);
      await withSystemTx(this.pool, tx => tx.query(
        `UPDATE cloud_workspace_provider_bindings
         SET next_drift_check_at=clock_timestamp()+($4::bigint * interval '1 millisecond')
         WHERE workspace_id=$1 AND generation=$2 AND next_drift_check_at=$3`,
        [candidate.workspaceId,candidate.generation,candidate.driftLeaseUntil,
          Math.max(candidate.intervalMs,30_000,retryDelayMs(1,failure.retryAfterMs))],
      ));
      this.logger.warn(
        `[cloud-workspace] drift observation failed (${failure.code})`,
      );
      return true;
    }

    await withSystemTx(this.pool, async (tx) => {
      const current = await tx.query<{
        desired_state: DesiredState;
        status: string;
        last_error_code: string | null;
        version: string | number;
        current_generation: number;
      }>(
        `SELECT desired_state, status, last_error_code, version, current_generation
         FROM cloud_workspaces
         WHERE id = $1 FOR UPDATE`,
        [candidate.workspaceId],
      );
      const workspace = current.rows[0];
      if (
        !workspace ||
        String(workspace.version) !== String(candidate.version) ||
        workspace.current_generation !== candidate.generation
      ) {
        return;
      }
      if (!(await tx.query(
        `SELECT 1 FROM cloud_workspace_provider_bindings WHERE workspace_id=$1 AND generation=$2
         AND next_drift_check_at=$3 FOR UPDATE`,
        [candidate.workspaceId,candidate.generation,candidate.driftLeaseUntil],
      )).rowCount) return;
      const observedState =
        resource?.state ??
        (workspace.desired_state === "deleted" ? "deleted" : "absent");
      await tx.query(
        `UPDATE cloud_workspace_provider_bindings
         SET provider_resource_id = coalesce($3, provider_resource_id),
             provider_target = coalesce($4, provider_target),
             observed_state = $5, observed_metadata = $6::jsonb,
             last_observed_at = now(), updated_at = now(),
             drift_inspect_requested = false, drift_paced_until = NULL,
             deletion_verified_at = CASE
               WHEN $5 = 'deleted' THEN now() ELSE NULL
             END
         WHERE workspace_id = $1 AND generation = $2`,
        [
          candidate.workspaceId,
          candidate.generation,
          resource?.resourceId ?? null,
          resource?.target ?? null,
          observedState,
          boundedMetadata(resource?.metadata ?? {}),
        ],
      );

      if (
        workspace.desired_state !== "running" ||
        resource?.state !== "running"
      ) {
        await retireCloudWorkspaceRuntimeAccess(tx, {
          workspaceId: candidate.workspaceId,
          organizationId: candidate.orgId,
          generation: candidate.generation,
          reason: "provider_not_running",
        });
      }

      if (workspace.desired_state === "running" && !resource && candidate.providerResourceId) {
        if (workspace.status === "failed" && workspace.last_error_code === "provider_resource_lost") return;
        await tx.query(`UPDATE cloud_workspaces SET status = 'failed',
          last_error_code = 'provider_resource_lost',
          last_error_message = 'The allocation is unavailable; recover the durable checkpoint into a new generation',
          last_observed_at = now(), updated_at = now(), version = version + 1
          WHERE id = $1`, [candidate.workspaceId]);
        await audit(tx, candidate.orgId, null, "cloud_workspace.allocation_lost", {
          workspaceId: candidate.workspaceId, generation: candidate.generation,
        });
        return;
      }

      const operation = correctiveOperation(workspace.desired_state);
      if (workspace.desired_state === "running" && resource?.state === "paused") {
        if (workspace.status === "failed" && workspace.last_error_code === "provider_paused_requires_stop") return;
        await tx.query(`UPDATE cloud_workspaces SET status='failed',last_error_code='provider_paused_requires_stop',
          last_error_message='Cold-stop the paused VM before starting a fresh runtime',
          last_observed_at=now(),updated_at=now(),version=version+1 WHERE id=$1`,[candidate.workspaceId]);
        await audit(tx,candidate.orgId,null,'cloud_workspace.provider_paused',{workspaceId:candidate.workspaceId,generation:candidate.generation});
        return;
      }
      if(resource?.state==='failed'&&resource.computeStopped===true&&workspace.desired_state!=='deleted'){
        if(workspace.status==='failed'&&workspace.last_error_code==='provider_snapshot_failed')return;
        await tx.query(`UPDATE cloud_workspaces SET status='failed',last_error_code='provider_snapshot_failed',
          last_error_message='Compute stopped but its provider snapshot failed; recover the durable checkpoint into a new generation',
          last_observed_at=now(),updated_at=now(),version=version+1 WHERE id=$1`,[candidate.workspaceId]);
        await audit(tx,candidate.orgId,null,'cloud_workspace.snapshot_failed',{workspaceId:candidate.workspaceId,generation:candidate.generation});
        return;
      }
      if (operationSatisfied(operation, resource)) {
        const status = statusForReconciledObservation(
          workspace.desired_state,
          resource,
          workspace.status,
        );
        await tx.query(
          `UPDATE cloud_workspaces
           SET status = $2::cloud_workspace_status,
               last_observed_at = now(), updated_at = now(), version = version + 1,
               deleted_at = CASE WHEN $2 = 'deleted' THEN coalesce(deleted_at, now())
                                 ELSE NULL END
           WHERE id = $1`,
          [candidate.workspaceId, status],
        );
        if (status === "setting_up") {
          await queueCloudWorkspaceSetupVerification(tx, {
            workspaceId: candidate.workspaceId,
            generation: candidate.generation,
            organizationId: candidate.orgId,
          });
        }
        return;
      }
      if (isTransitional(resource)) return;

      const intentId = randomUUID();
      const key = `system:drift:${randomUUID()}`;
      await tx.query(
        `INSERT INTO cloud_workspace_lifecycle_intents (
           id, workspace_id, generation, org_id, requested_by, operation,
           idempotency_key, request_sha256
         ) VALUES ($1, $2, $3, $4, NULL, $5, $6, $7)`,
        [
          intentId,
          candidate.workspaceId,
          candidate.generation,
          candidate.orgId,
          operation,
          key,
          requestDigest({
            operation,
            workspaceId: candidate.workspaceId,
            desiredState: workspace.desired_state,
            reason: "provider_drift",
          }),
        ],
      );
      await tx.query(
        `UPDATE cloud_workspaces
         SET status = $2::cloud_workspace_status,
             last_observed_at = now(), updated_at = now(), version = version + 1
         WHERE id = $1`,
        [
          candidate.workspaceId,
          statusForObserved(workspace.desired_state, resource),
        ],
      );
      await audit(tx, candidate.orgId, null, "cloud_workspace.drift_detected", {
        workspaceId: candidate.workspaceId,
        intentId,
        desiredState: workspace.desired_state,
        providerState: observedState,
      });
    });
    return true;
  }

  async reconcileOrphansOnce(): Promise<number> {
    const resolved = this.providerResolver?.cleanupScopes
      ? await this.providerResolver.cleanupScopes()
      : {
          scopes: [
            {
              provider: this.provider,
              organizationId: null,
              connectionId: null,
              connectionVersion: null,
              credentialSource: "hosted" as const,
            },
          ],
          unavailable: 0,
        };
    if (resolved.unavailable > 0) {
      this.logger.warn(
        `[cloud-workspace] ${resolved.unavailable} delegated cleanup scope(s) unavailable`,
      );
    }
    let observed = 0;
    // A large account or a permanently revoked historic key must not starve
    // later accounts on every run. Failed inventories are never absence proof.
    const offset = this.cleanupScopeOffset % Math.max(1, resolved.scopes.length);
    this.cleanupScopeOffset = (offset + 1) % Math.max(1, resolved.scopes.length);
    const scopes = [...resolved.scopes.slice(offset), ...resolved.scopes.slice(0, offset)];
    for (const scope of scopes) {
      try {
      // Providers with a paged list give one inventory per sweep instead of
      // one inspect per resource; a partial listing is neither absence nor
      // mismatch evidence.
      if (scope.provider.listInventory) {
        const inventory = new Map<string, CloudProviderInventoryItem>();
        let capped = false;
        for await (const item of scope.provider.listInventory()) {
          // The sweep skips sandboxes the journal cannot place (runtime
          // images, staging, templates), so they must not use up the ceiling.
          if (item.workspaceId !== null) {
            if (observed >= this.maxManagedResourcesPerSweep) { capped = true; break; }
            observed += 1;
          }
          inventory.set(item.resourceId, item);
        }
        if (capped) {
          this.logger.warn(
            "[cloud-workspace] managed-resource sweep hit its safety ceiling",
          );
          return observed;
        }
        await this.sweepScopeInventory(scope, inventory);
        continue;
      }
      for await (const resource of scope.provider.listManaged()) {
        if (observed >= this.maxManagedResourcesPerSweep) {
          this.logger.warn(
            "[cloud-workspace] managed-resource sweep hit its safety ceiling",
          );
          return observed;
        }
        observed += 1;
        await this.reconcileSweepResource(scope, {
          resourceId: resource.resourceId,
          state: resource.state,
          computeStopped: resource.computeStopped === true,
          workspaceId: resource.workspaceId,
          generation: resource.generation,
        }, resource);
      }
      } catch (error) {
        this.logger.warn(`[cloud-workspace] inventory scope failed (${safeFailure(error).code})`);
      }
    }
    return observed;
  }

  /** Inventory paces drift. A binding whose resource the provider's list
   * confirms unchanged and in its desired state is paced one fallback
   * horizon out (drift_paced_until), so per-workspace inspects resume only if
   * sweeps stop. Any other binding loses its pacing and returns to the
   * per-interval drift schedule; a listing that contradicts the last
   * observation also invalidates it, so the next due drift job inspects. */
  private async sweepScopeInventory(
    scope: SweepScope,
    inventory: Map<string, CloudProviderInventoryItem>,
  ): Promise<void> {
    const ids = [...inventory.keys()];
    // A settled stopped or archived workspace whose sandbox an inspect
    // already confirmed gone can never appear in the listing; its absence
    // matches, or every sweep would force an inspect and defeat the slow
    // settled cadence.
    // Matching the last observation is not enough: drift's inspect is also
    // what corrects a VM that diverges from desired_state (a failed stop
    // leaves it running and observed running). Only a settled workspace whose
    // listing already satisfies its desired state, as operationSatisfied
    // would judge it, may be paced; everything else stays on the inspect path.
    const matched = `(scoped.steady AND ((scoped.seen_id IS NOT NULL
        AND scoped.seen_state IS NOT DISTINCT FROM binding.observed_state)
      OR (scoped.seen_id IS NULL AND scoped.settled
        AND binding.observed_state IN ('absent','deleted'))))`;
    // A listing that contradicts the last observation invalidates it, so the
    // claim's last-observed gate (the slow settled cadence included) cannot
    // hold the inspect back. One that agrees leaves the per-interval schedule.
    const contradicted = `NOT ((scoped.seen_id IS NOT NULL
        AND scoped.seen_state IS NOT DISTINCT FROM binding.observed_state)
      OR (scoped.seen_id IS NULL AND binding.observed_state IN ('absent','deleted')))`;
    await withSystemTx(this.pool, async (tx) => {
      // The statement row-locks every scoped binding. One stalled holder must
      // not block the sweep (and the audit queued behind it): fail this scope
      // and retry at the next minute instead.
      await tx.query(`SET LOCAL lock_timeout = '${SWEEP_LOCK_TIMEOUT_MS}ms'`);
      await tx.query(
      `WITH inventory(resource_id, state, compute_stopped) AS (
         SELECT * FROM unnest($2::text[], $3::text[], $9::boolean[])
       ), scoped AS (
         SELECT binding.workspace_id, binding.generation, binding.provider_resource_id,
                inventory.resource_id AS seen_id, inventory.state AS seen_state,
                ((workspace.desired_state = 'stopped' AND workspace.status = 'stopped')
                  OR (workspace.desired_state = 'archived' AND workspace.status = 'archived')) AS settled,
                CASE workspace.desired_state
                  WHEN 'running' THEN workspace.status IN ('ready','busy')
                    AND inventory.state = 'running'
                  WHEN 'stopped' THEN workspace.status = 'stopped'
                    AND (inventory.resource_id IS NULL
                      OR inventory.state IN ('stopped','archived','deleted')
                      OR (inventory.compute_stopped AND inventory.state <> 'failed'))
                  -- A listed stopped sandbox may or may not have offloaded
                  -- storage; only an inspect can tell, so it is not paced.
                  WHEN 'archived' THEN workspace.status = 'archived'
                    AND (inventory.resource_id IS NULL OR inventory.state IN ('archived','deleted'))
                  ELSE false
                END AS steady
         FROM cloud_workspace_provider_bindings binding
         JOIN provider_connections connection
           ON connection.id = binding.provider_connection_id
          AND connection.org_id = binding.org_id
         JOIN cloud_workspaces workspace ON workspace.id = binding.workspace_id
         LEFT JOIN inventory ON inventory.resource_id = binding.provider_resource_id
         WHERE binding.provider = $1 AND binding.provider_resource_id IS NOT NULL
           -- Only the current generation can be claimed; an old generation's
           -- row must neither be paced nor move the workspace's drift job.
           AND binding.generation = workspace.current_generation
           AND workspace.status <> 'deleted'
           -- An active restore incident excludes its workspace from drift
           -- checks; the sweep must not pace it either. Every incident state
           -- change requests an inspect (0158), so the first post-incident
           -- inspect (target and metadata refresh) never waits out a pacing
           -- horizon set before the incident.
           AND NOT EXISTS (SELECT 1 FROM cloud_workspace_restore_incidents incident
             WHERE incident.workspace_id = workspace.id
               AND incident.source_generation = workspace.current_generation
               AND incident.state IN ('queued','waiting_for_capacity','waiting_for_funding','restoring','recovery_needed'))
           AND (($5 = 'hosted' AND connection.credential_source = 'hosted')
             OR ($5 = 'delegated' AND binding.org_id = $6::uuid
                 AND binding.provider_connection_id = $7::uuid
                 AND binding.provider_connection_version = $8::bigint))
       )
       -- Pacing never pushes next_drift_check_at: it remains the per-interval
       -- schedule, the drift claim's lease and any provider backoff, so a
       -- sweep cannot void an in-flight claim, and a binary that predates
       -- pacing still finds every binding due on its own cadence.
       , paced AS (
         UPDATE cloud_workspace_provider_bindings binding
         SET drift_paced_until = clock_timestamp() + ($4::bigint * interval '1 millisecond')
         FROM scoped
         WHERE binding.workspace_id = scoped.workspace_id
           AND binding.generation = scoped.generation
           AND binding.provider = $1
           AND binding.provider_resource_id = scoped.provider_resource_id
           AND ${matched}
           -- Re-read under the row lock: an event that committed after this
           -- statement's snapshot keeps its requested inspect.
           AND NOT binding.drift_inspect_requested
           AND (binding.drift_paced_until IS NULL OR binding.drift_paced_until < clock_timestamp()
                 + (($4::bigint - $4::bigint / 12) * interval '1 millisecond'))
         RETURNING binding.workspace_id, binding.drift_paced_until
       ), forced AS (
         UPDATE cloud_workspace_provider_bindings binding
         SET drift_paced_until = NULL,
             last_observed_at = CASE WHEN ${contradicted} THEN NULL ELSE binding.last_observed_at END,
             -- The settled cadence is hours long, so a contradicted listing
             -- pulls that schedule in. A value within one claim lease is a
             -- live claim or a provider backoff: kept, so the claim's fence
             -- holds and the backoff is honoured. Listing the column also
             -- fires the binding trigger, which enqueues the drift job at it.
             next_drift_check_at = CASE WHEN ${contradicted}
                 AND binding.next_drift_check_at > clock_timestamp() + ($10::bigint * interval '1 millisecond')
               THEN clock_timestamp() ELSE binding.next_drift_check_at END
         FROM scoped
         WHERE binding.workspace_id = scoped.workspace_id
           AND binding.generation = scoped.generation
           AND binding.provider = $1
           AND binding.provider_resource_id = scoped.provider_resource_id
           AND NOT ${matched}
           AND (binding.drift_paced_until IS NOT NULL
             OR (${contradicted} AND binding.last_observed_at IS NOT NULL))
       )
       -- Enqueues only ever move a queued job earlier, so without this the
       -- workspace's drift job would empty-run every keep-alive margin. A job
       -- already due was made due by an event and must run.
       UPDATE control_plane_jobs job
       SET run_at = paced.drift_paced_until, updated_at = clock_timestamp()
       FROM paced
       WHERE job.kind = 'cloud_workspace_drift'
         AND job.state = 'queued'
         AND job.dedupe_key = 'workspace:' || paced.workspace_id::text
         AND job.run_at > clock_timestamp()
         AND job.run_at < paced.drift_paced_until`,
      [
        scope.provider.name,
        ids,
        ids.map((id) => inventory.get(id)!.state),
        this.inventoryFallbackMs,
        scope.credentialSource,
        scope.organizationId,
        scope.connectionId,
        scope.connectionVersion,
        ids.map((id) => inventory.get(id)!.computeStopped === true),
        this.leaseMs,
      ],
      );
    });
    // Orphan rows clear once a binding claims the resource again; orphan
    // bookkeeping and cleanup cover only inventory no binding claims.
    const bound = await withSystemTx(this.pool, async (tx) => {
      const claimed = await tx.query<{ provider_resource_id: string }>(
        `SELECT provider_resource_id FROM cloud_workspace_provider_bindings
         WHERE provider = $1 AND provider_resource_id = ANY($2::text[])`,
        [scope.provider.name, ids],
      );
      const boundIds = new Set(claimed.rows.map((row) => row.provider_resource_id));
      await tx.query(
        `DELETE FROM cloud_workspace_provider_orphans
         WHERE provider = $1 AND provider_resource_id = ANY($2::text[])
           AND org_id IS NOT DISTINCT FROM $3::uuid
           AND provider_connection_id IS NOT DISTINCT FROM $4::uuid
           AND provider_connection_version IS NOT DISTINCT FROM $5::bigint`,
        [scope.provider.name, [...boundIds], scope.organizationId, scope.connectionId, scope.connectionVersion],
      );
      return boundIds;
    });
    for (const id of ids) {
      if (bound.has(id)) continue;
      const item = inventory.get(id)!;
      // Inventory outside the journal (runtime images, staging,
      // qualification, computer templates, builder VMs, retirement) is not
      // ours to track. Quarantining it would stall provider_orphans health
      // permanently: nothing may delete a stray, and nothing clears its row.
      if (item.workspaceId === null || item.generation === null) continue;
      await this.reconcileSweepResource(scope, item, null);
    }
  }

  private async reconcileSweepResource(
    scope: SweepScope,
    item: CloudProviderInventoryItem,
    resource: CloudProviderResource | null,
  ): Promise<void> {
    const identity = item.workspaceId !== null && item.generation !== null
      ? { workspaceId: item.workspaceId, generation: item.generation } : null;
    const durableOwnership = identity !== null &&
      await scope.provider.verifyManagedResourceOwnership?.({
        resourceId: item.resourceId,
        workspaceId: identity.workspaceId,
        generation: identity.generation,
        state: item.state,
        target: resource?.target ?? null,
        computeStopped: item.computeStopped,
        metadata: resource?.metadata ?? {},
      }) === true;
    const decision = await withSystemTx(this.pool, async (tx) => {
      const binding = await tx.query(
        `SELECT 1
             FROM cloud_workspace_provider_bindings binding
             WHERE binding.provider = $1 AND binding.provider_resource_id = $2`,
        [
          scope.provider.name,
          item.resourceId,
        ],
      );
      if ((binding.rowCount ?? 0) > 0) {
        await tx.query(
          `DELETE FROM cloud_workspace_provider_orphans
             WHERE provider = $1 AND provider_resource_id = $2
               AND org_id IS NOT DISTINCT FROM $3::uuid
               AND provider_connection_id IS NOT DISTINCT FROM $4::uuid
               AND provider_connection_version IS NOT DISTINCT FROM $5::bigint`,
          [
            scope.provider.name,
            item.resourceId,
            scope.organizationId,
            scope.connectionId,
            scope.connectionVersion,
          ],
        );
        return false;
      }

      // A create response can be lost after the provider committed but before
      // its binding transaction. Only a durable allocation receipt can
      // recover that identity: provider labels are editable and copyable.
      const generation = durableOwnership && identity ? await tx.query<{
        provider_resource_id: string | null;
      }>(
        `SELECT pb.provider_resource_id
           FROM cloud_workspace_generations g
           JOIN cloud_workspace_provider_bindings pb
             ON pb.workspace_id = g.workspace_id
            AND pb.generation = g.generation
            AND pb.org_id = g.org_id
           JOIN provider_connections connection
             ON connection.id = pb.provider_connection_id
            AND connection.org_id = pb.org_id
           WHERE g.workspace_id = $1 AND g.generation = $2
             AND g.provider = $3
             AND (
               ($4 = 'hosted' AND connection.credential_source = 'hosted')
               OR
               ($4 = 'delegated'
                 AND pb.org_id = $5::uuid
                 AND pb.provider_connection_id = $6::uuid
                 AND pb.provider_connection_version = $7::bigint)
             )
           FOR UPDATE OF pb`,
        [
          identity.workspaceId,
          identity.generation,
          scope.provider.name,
          scope.credentialSource,
          scope.organizationId,
          scope.connectionId,
          scope.connectionVersion,
        ],
      ) : { rows: [] };
      const recoverable = generation.rows[0];
      if (recoverable && identity) {
        if (recoverable.provider_resource_id === null) {
          if (resource) {
            await tx.query(
              `UPDATE cloud_workspace_provider_bindings
               SET provider_resource_id = $3, provider_target = $4,
                   observed_state = $5, observed_metadata = $6::jsonb,
                   last_observed_at = now(), updated_at = now(),
                   drift_paced_until = NULL
               WHERE workspace_id = $1 AND generation = $2`,
              [
                identity.workspaceId,
                identity.generation,
                item.resourceId,
                resource.target,
                item.state,
                boundedMetadata(resource.metadata),
              ],
            );
          } else {
            // Inventory identity comes without an inspect's metadata, so the
            // recovered binding is forced due: the drift check refreshes it.
            await tx.query(
              `UPDATE cloud_workspace_provider_bindings
               SET provider_resource_id = $3, provider_target = NULL,
                   observed_state = $4, observed_metadata = '{}'::jsonb,
                   last_observed_at = now(), updated_at = now(),
                   next_drift_check_at = now(), drift_inspect_requested = true,
                   drift_paced_until = NULL
               WHERE workspace_id = $1 AND generation = $2`,
              [
                identity.workspaceId,
                identity.generation,
                item.resourceId,
                item.state,
              ],
            );
          }
          await tx.query(
            `DELETE FROM cloud_workspace_provider_orphans
               WHERE provider = $1 AND provider_resource_id = $2
                 AND org_id IS NOT DISTINCT FROM $3::uuid
                 AND provider_connection_id IS NOT DISTINCT FROM $4::uuid
                 AND provider_connection_version IS NOT DISTINCT FROM $5::bigint`,
            [
              scope.provider.name,
              item.resourceId,
              scope.organizationId,
              scope.connectionId,
              scope.connectionVersion,
            ],
          );
        } else {
          // If another resource is already bound, retain the duplicate for
          // operator review. Automatic deletion is intentionally limited to
          // a label identity that no durable generation recognizes.
          await tx.query(
            `INSERT INTO cloud_workspace_provider_orphans (
                 provider, provider_resource_id, workspace_id_hint,
                 generation_hint, org_id, provider_connection_id,
                 provider_connection_version
               ) VALUES ($1, $2, $3, $4, $5, $6, $7)
               ON CONFLICT (provider, provider_resource_id, org_id,
                            provider_connection_id, provider_connection_version)
                 DO UPDATE
                 SET last_seen_at = now(),
                     observation_count = cloud_workspace_provider_orphans.observation_count + 1`,
            [
              scope.provider.name,
              item.resourceId,
              item.workspaceId,
              item.generation,
              scope.organizationId,
              scope.connectionId,
              scope.connectionVersion,
            ],
          );
        }
        return false;
      }

      const result = await tx.query<{
        first_seen_at: Date;
        observation_count: number;
        deletion_verified_at: Date | null;
        eligible: boolean;
      }>(
        `INSERT INTO cloud_workspace_provider_orphans (
             provider, provider_resource_id, workspace_id_hint,
             generation_hint, org_id, provider_connection_id,
             provider_connection_version
           ) VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (provider, provider_resource_id, org_id,
                        provider_connection_id, provider_connection_version)
             DO UPDATE
             SET last_seen_at = now(),
                 observation_count = cloud_workspace_provider_orphans.observation_count + 1
           RETURNING first_seen_at, observation_count, deletion_verified_at,
                     first_seen_at <= now() -
                       ($8::bigint * interval '1 millisecond') AS eligible`,
        [
          scope.provider.name,
          item.resourceId,
          item.workspaceId,
          item.generation,
          scope.organizationId,
          scope.connectionId,
          scope.connectionVersion,
          this.orphanGraceMs,
        ],
      );
      const orphan = result.rows[0]!;
      return (
        durableOwnership && !orphan.deletion_verified_at &&
        orphan.observation_count >= 2 &&
        orphan.eligible
      );
    });
    if (!decision || !identity) return;

    try {
      await scope.provider.delete(item.resourceId);
      const remaining = await scope.provider.inspect(item.resourceId);
      if (remaining) assertProviderResourceIdentity(remaining, identity);
      else await assertProviderAbsence(scope.provider, identity);
      const deletionVerified =
        remaining === null || remaining.state === "deleted";
      await withSystemTx(this.pool, (tx) =>
        tx.query(
          `UPDATE cloud_workspace_provider_orphans
             SET delete_attempted_at = now(),
                 deletion_verified_at = CASE WHEN $3 THEN now() ELSE NULL END,
                 last_seen_at = now()
             WHERE provider = $1 AND provider_resource_id = $2
               AND org_id IS NOT DISTINCT FROM $4::uuid
               AND provider_connection_id IS NOT DISTINCT FROM $5::uuid
               AND provider_connection_version IS NOT DISTINCT FROM $6::bigint`,
          [
            scope.provider.name,
            item.resourceId,
            deletionVerified,
            scope.organizationId,
            scope.connectionId,
            scope.connectionVersion,
          ],
        ),
      );
    } catch (error) {
      const failure = safeFailure(error);
      this.logger.warn(
        `[cloud-workspace] orphan cleanup failed (${failure.code})`,
      );
      await withSystemTx(this.pool, (tx) =>
        tx.query(
          `UPDATE cloud_workspace_provider_orphans
             SET delete_attempted_at = now()
             WHERE provider = $1 AND provider_resource_id = $2
               AND org_id IS NOT DISTINCT FROM $3::uuid
               AND provider_connection_id IS NOT DISTINCT FROM $4::uuid
               AND provider_connection_version IS NOT DISTINCT FROM $5::bigint`,
          [
            scope.provider.name,
            item.resourceId,
            scope.organizationId,
            scope.connectionId,
            scope.connectionVersion,
          ],
        ),
      );
    }
  }
}

export function startCloudWorkspaceReconciler(
  options: CloudWorkspaceReconcilerOptions,
): { reconciler: CloudWorkspaceReconciler; stop: () => Promise<void> } {
  const reconciler = new CloudWorkspaceReconciler(options);
  return { reconciler, stop: reconciler.start() };
}

import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";

import { audit } from "../audit.js";
import { withSystemTx, type Tx } from "../db.js";
import {
  assertSingleProviderResource,
  CloudProviderError,
  type CloudProviderResource,
  type CloudWorkspaceProvider,
} from "./provider.js";

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
};

type ReconcileLogger = Pick<Console, "info" | "warn" | "error">;

export type CloudWorkspaceReconcilerOptions = {
  pool: pg.Pool;
  provider: CloudWorkspaceProvider;
  intervalMs: number;
  leaseMs?: number;
  orphanGraceMs?: number;
  maxManagedResourcesPerSweep?: number;
  workerId?: string;
  logger?: ReconcileLogger;
};

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

function correctiveOperation(desired: DesiredState): Exclude<LifecycleOperation, "create"> {
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
        resource.state === "stopped" ||
        resource.state === "archived" ||
        resource.state === "deleted"
      );
    case "archive":
      return resource === null || resource.state === "archived" || resource.state === "deleted";
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
    return resource === null || resource.state === "deleted" ? "deleted" : "deleting";
  }
  if (desired === "archived") {
    return resource === null || resource.state === "archived" ? "archived" : "archiving";
  }
  if (desired === "stopped") {
    return resource === null || ["stopped", "archived", "deleted"].includes(resource.state)
      ? "stopped"
      : "stopping";
  }
  if (resource?.state === "running") return "setting_up";
  if (resource?.state === "provisioning") return "provisioning";
  if (resource?.state === "failed") return "failed";
  return "waking";
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

function retryDelayMs(attempt: number): number {
  return Math.min(5 * 60_000, 1_000 * 2 ** Math.min(Math.max(attempt - 1, 0), 8));
}

function safeFailure(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
} {
  if (error instanceof CloudProviderError) {
    return {
      code: error.code.slice(0, 128),
      message: error.retryable
        ? "Cloud provider operation is temporarily unavailable"
        : "Cloud provider rejected the lifecycle operation",
      retryable: error.retryable,
    };
  }
  return {
    code: "provider_unknown_failure",
    message: "Cloud provider operation did not complete",
    retryable: true,
  };
}

function assertResourceIdentity(
  resource: CloudProviderResource,
  intent: Pick<ClaimedIntent, "workspaceId" | "generation" | "provider">,
): void {
  if (
    resource.workspaceId !== intent.workspaceId ||
    resource.generation !== intent.generation
  ) {
    throw new CloudProviderError(
      "provider_identity_mismatch",
      "Provider resource identity does not match the claimed workspace generation",
      false,
    );
  }
}

export class CloudWorkspaceReconciler {
  private readonly pool: pg.Pool;
  private readonly provider: CloudWorkspaceProvider;
  private readonly intervalMs: number;
  private readonly leaseMs: number;
  private readonly orphanGraceMs: number;
  private readonly maxManagedResourcesPerSweep: number;
  private readonly workerId: string;
  private readonly logger: ReconcileLogger;
  private timer: NodeJS.Timeout | null = null;
  private activeTick: Promise<void> | null = null;
  private started = false;
  private stopped = false;
  private ticking = false;
  private tickCount = 0;

  constructor(options: CloudWorkspaceReconcilerOptions) {
    this.pool = options.pool;
    this.provider = options.provider;
    this.intervalMs = options.intervalMs;
    this.leaseMs = options.leaseMs ?? 10 * 60_000;
    this.orphanGraceMs = options.orphanGraceMs ?? 60 * 60_000;
    this.maxManagedResourcesPerSweep =
      options.maxManagedResourcesPerSweep ?? 10_000;
    if (
      !Number.isSafeInteger(this.maxManagedResourcesPerSweep) ||
      this.maxManagedResourcesPerSweep < 1 ||
      this.maxManagedResourcesPerSweep > 100_000
    ) {
      throw new Error("maxManagedResourcesPerSweep must be between 1 and 100000");
    }
    this.workerId = options.workerId ?? `control-plane:${randomUUID()}`;
    this.logger = options.logger ?? console;
  }

  start(): () => Promise<void> {
    if (this.started || this.stopped) return () => this.stop();
    this.started = true;
    const run = () => {
      if (this.stopped) return;
      const task = this.tick().catch((error) => {
        this.logger.error(
          `[cloud-workspace] reconcile tick failed: ${
            error instanceof Error ? error.name : "unknown"
          }`,
        );
      });
      this.activeTick = task;
      void task.finally(() => {
        if (this.activeTick === task) this.activeTick = null;
        if (this.stopped) return;
        this.timer = setTimeout(run, this.intervalMs);
        this.timer.unref();
      });
    };
    run();
    return () => this.stop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.activeTick;
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      let processed = 0;
      while (!this.stopped && processed < 20 && (await this.runOnce())) {
        processed += 1;
      }
      if (!this.stopped && processed === 0) await this.reconcileDriftOnce();
      this.tickCount += 1;
      if (!this.stopped && this.tickCount % 12 === 0) {
        await this.reconcileOrphansOnce();
      }
    } finally {
      this.ticking = false;
    }
  }

  private async claimIntent(): Promise<ClaimedIntent | null> {
    return withSystemTx(this.pool, async (tx) => {
      const result = await tx.query<{
        id: string;
        workspace_id: string;
        org_id: string;
        operation: LifecycleOperation;
        desired_state: DesiredState;
        current_generation: number;
        provider: string;
        image_ref: string;
        architecture: "linux/amd64" | "linux/arm64";
        cpu_millicores: number;
        memory_mib: number;
        storage_mib: number;
        provider_resource_id: string | null;
        attempt_count: number;
      }>(
        `SELECT i.id, i.workspace_id, i.org_id, i.operation,
                cw.desired_state, cw.current_generation, g.provider,
                g.image_ref, g.architecture, g.cpu_millicores,
                g.memory_mib, g.storage_mib, pb.provider_resource_id,
                i.attempt_count
         FROM cloud_workspace_lifecycle_intents i
         JOIN cloud_workspaces cw ON cw.id = i.workspace_id
         JOIN cloud_workspace_generations g
           ON g.workspace_id = cw.id AND g.generation = cw.current_generation
         JOIN cloud_workspace_provider_bindings pb
           ON pb.workspace_id = g.workspace_id AND pb.generation = g.generation
         WHERE i.next_attempt_at <= now()
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
         ORDER BY i.created_at, i.id
         FOR UPDATE OF i, cw SKIP LOCKED
         LIMIT 1`,
      );
      const row = result.rows[0];
      if (!row) return null;
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
        desiredState: row.desired_state,
        generation: row.current_generation,
        provider: row.provider,
        imageRef: row.image_ref,
        architecture: row.architecture,
        cpuMillicores: row.cpu_millicores,
        memoryMiB: row.memory_mib,
        storageMiB: row.storage_mib,
        providerResourceId: row.provider_resource_id,
        attemptCount: row.attempt_count + 1,
      };
    });
  }

  async runOnce(): Promise<boolean> {
    const intent = await this.claimIntent();
    if (!intent) return false;
    if (intent.provider !== this.provider.name) {
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

    try {
      let current = await this.observe(intent);

      // The request changed while an earlier provider call was in flight. Find
      // and bind any unknown result, but never dispatch an obsolete action.
      if (intent.desiredState !== desiredForOperation(intent.operation)) {
        await this.recordResult(intent, current, "superseded");
        return true;
      }

      if (!operationSatisfied(intent.operation, current) && !isTransitional(current)) {
        current = await this.dispatch(intent, current);
      }
      if (operationSatisfied(intent.operation, current)) {
        await this.recordResult(intent, current, "succeeded");
      } else if (current?.state === "failed") {
        await this.recordFailure(
          intent,
          new CloudProviderError(
            "provider_resource_failed",
            "Provider resource entered a failed state",
            false,
          ),
        );
      } else {
        await this.recordResult(intent, current, "observing");
      }
    } catch (error) {
      await this.recordFailure(intent, error);
    }
    return true;
  }

  private async observe(intent: ClaimedIntent): Promise<CloudProviderResource | null> {
    if (intent.providerResourceId) {
      const resource = await this.provider.inspect(intent.providerResourceId);
      if (resource) assertResourceIdentity(resource, intent);
      return resource;
    }
    const found = assertSingleProviderResource(
      await this.provider.find({
        workspaceId: intent.workspaceId,
        generation: intent.generation,
      }),
      { workspaceId: intent.workspaceId, generation: intent.generation },
    );
    if (found) assertResourceIdentity(found, intent);
    return found;
  }

  private async dispatch(
    intent: ClaimedIntent,
    current: CloudProviderResource | null,
  ): Promise<CloudProviderResource | null> {
    switch (intent.operation) {
      case "create":
      case "wake": {
        const next = current
          ? await this.provider.start(current.resourceId)
          : await this.provider.create({
              workspaceId: intent.workspaceId,
              generation: intent.generation,
              imageRef: intent.imageRef,
              architecture: intent.architecture,
              cpuMillicores: intent.cpuMillicores,
              memoryMiB: intent.memoryMiB,
              storageMiB: intent.storageMiB,
              idempotencyKey: intent.id,
            });
        assertResourceIdentity(next, intent);
        return next;
      }
      case "stop": {
        if (!current) return null;
        const next = await this.provider.stop(current.resourceId);
        assertResourceIdentity(next, intent);
        return next;
      }
      case "archive": {
        if (!current) return null;
        const next = await this.provider.archive(current.resourceId);
        assertResourceIdentity(next, intent);
        return next;
      }
      case "delete": {
        if (!current) return null;
        await this.provider.delete(current.resourceId);
        return null;
      }
    }
  }

  private async recordResult(
    intent: ClaimedIntent,
    resource: CloudProviderResource | null,
    intentState: "succeeded" | "superseded" | "observing",
  ): Promise<void> {
    await withSystemTx(this.pool, async (tx) => {
      const owned = await tx.query<{ state: string; lease_owner: string | null }>(
        `SELECT state, lease_owner
         FROM cloud_workspace_lifecycle_intents
         WHERE id = $1 FOR UPDATE`,
        [intent.id],
      );
      const row = owned.rows[0];
      if (!row || row.state === "succeeded" || row.state === "superseded") return;
      if (row.lease_owner !== this.workerId) return;

      const workspace = await tx.query<{ desired_state: DesiredState }>(
        `SELECT desired_state FROM cloud_workspaces WHERE id = $1 FOR UPDATE`,
        [intent.workspaceId],
      );
      const desired = workspace.rows[0]?.desired_state;
      if (!desired) return;
      const observedState =
        resource?.state ?? (desired === "deleted" ? "deleted" : "absent");
      await tx.query(
        `UPDATE cloud_workspace_provider_bindings
         SET provider_resource_id = coalesce($3, provider_resource_id),
             provider_target = coalesce($4, provider_target),
             observed_state = $5, observed_metadata = $6::jsonb,
             last_observed_at = now(), updated_at = now(),
             deletion_verified_at = CASE
               WHEN $5 = 'deleted' THEN now() ELSE NULL
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

      const status = statusForObserved(desired, resource);
      await tx.query(
        `UPDATE cloud_workspaces
         SET status = $2::cloud_workspace_status,
             last_observed_at = now(), updated_at = now(),
             version = version + 1,
             deleted_at = CASE WHEN $2 = 'deleted' THEN coalesce(deleted_at, now())
                               ELSE NULL END,
             last_error_code = NULL, last_error_message = NULL
         WHERE id = $1`,
        [intent.workspaceId, status],
      );

      if (desired === "running" && resource?.state === "running") {
        await tx.query(
          `INSERT INTO cloud_workspace_setup_runs (
             workspace_id, generation, org_id, attempt
           ) VALUES ($1, $2, $3, 1)
           ON CONFLICT (workspace_id, generation, attempt) DO NOTHING`,
          [intent.workspaceId, intent.generation, intent.orgId],
        );
      }

      if (intentState === "observing") {
        await tx.query(
          `UPDATE cloud_workspace_lifecycle_intents
           SET state = 'observing', lease_owner = NULL, lease_expires_at = NULL,
               next_attempt_at = now() + ($2::bigint * interval '1 millisecond'),
               updated_at = now()
           WHERE id = $1`,
          [intent.id, retryDelayMs(intent.attemptCount)],
        );
      } else {
        await tx.query(
          `UPDATE cloud_workspace_lifecycle_intents
           SET state = $2::cloud_workspace_intent_state,
               completed_at = now(), lease_owner = NULL,
               lease_expires_at = NULL, updated_at = now()
           WHERE id = $1`,
          [intent.id, intentState],
        );
      }
      await audit(
        tx,
        intent.orgId,
        null,
        `cloud_workspace.${intent.operation}_${intentState}`,
        {
          workspaceId: intent.workspaceId,
          intentId: intent.id,
          generation: intent.generation,
          providerState: observedState,
        },
      );
    });
  }

  private async recordFailure(intent: ClaimedIntent, error: unknown): Promise<void> {
    const failure = safeFailure(error);
    await withSystemTx(this.pool, async (tx) => {
      const owned = await tx.query<{ state: string; lease_owner: string | null }>(
        `SELECT state, lease_owner
         FROM cloud_workspace_lifecycle_intents
         WHERE id = $1 FOR UPDATE`,
        [intent.id],
      );
      const row = owned.rows[0];
      if (!row || row.lease_owner !== this.workerId) return;
      if (failure.retryable) {
        await tx.query(
          `UPDATE cloud_workspace_lifecycle_intents
           SET state = 'observing', lease_owner = NULL, lease_expires_at = NULL,
               next_attempt_at = now() + ($2::bigint * interval '1 millisecond'),
               error_code = $3, error_message = $4, updated_at = now()
           WHERE id = $1`,
          [intent.id, retryDelayMs(intent.attemptCount), failure.code, failure.message],
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
        const current = await tx.query<{ desired_state: DesiredState }>(
          `SELECT desired_state FROM cloud_workspaces WHERE id = $1 FOR UPDATE`,
          [intent.workspaceId],
        );
        if (current.rows[0]?.desired_state === desiredForOperation(intent.operation)) {
          await tx.query(
            `UPDATE cloud_workspaces
             SET status = 'failed', last_error_code = $2,
                 last_error_message = $3, updated_at = now(), version = version + 1
             WHERE id = $1`,
            [intent.workspaceId, failure.code, failure.message],
          );
        }
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

  private async driftCandidate(): Promise<DriftCandidate | null> {
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
           AND pb.provider = $1
           AND (pb.last_observed_at IS NULL OR
                pb.last_observed_at < now() - ($2::bigint * interval '1 millisecond'))
           AND NOT EXISTS (
             SELECT 1 FROM cloud_workspace_lifecycle_intents i
             WHERE i.workspace_id = cw.id
               AND i.state IN ('queued', 'dispatching', 'observing')
           )
         ORDER BY pb.last_observed_at NULLS FIRST, cw.updated_at, cw.id
         FOR UPDATE OF cw SKIP LOCKED
         LIMIT 1`,
        [this.provider.name, this.intervalMs],
      );
      const row = result.rows[0];
      return row
        ? {
            workspaceId: row.workspace_id,
            orgId: row.org_id,
            desiredState: row.desired_state,
            status: row.status,
            version: row.version,
            generation: row.current_generation,
            provider: row.provider,
            providerResourceId: row.provider_resource_id,
          }
        : null;
    });
  }

  async reconcileDriftOnce(): Promise<boolean> {
    const candidate = await this.driftCandidate();
    if (!candidate) return false;
    let resource: CloudProviderResource | null;
    try {
      resource = candidate.providerResourceId
        ? await this.provider.inspect(candidate.providerResourceId)
        : assertSingleProviderResource(
            await this.provider.find({
              workspaceId: candidate.workspaceId,
              generation: candidate.generation,
            }),
            {
              workspaceId: candidate.workspaceId,
              generation: candidate.generation,
            },
          );
      if (resource) assertResourceIdentity(resource, candidate);
    } catch (error) {
      const failure = safeFailure(error);
      this.logger.warn(
        `[cloud-workspace] drift observation failed (${failure.code})`,
      );
      return true;
    }

    await withSystemTx(this.pool, async (tx) => {
      const current = await tx.query<{
        desired_state: DesiredState;
        version: string | number;
      }>(
        `SELECT desired_state, version FROM cloud_workspaces
         WHERE id = $1 FOR UPDATE`,
        [candidate.workspaceId],
      );
      const workspace = current.rows[0];
      if (!workspace || String(workspace.version) !== String(candidate.version)) return;
      const observedState =
        resource?.state ??
        (workspace.desired_state === "deleted" ? "deleted" : "absent");
      await tx.query(
        `UPDATE cloud_workspace_provider_bindings
         SET provider_resource_id = coalesce($3, provider_resource_id),
             provider_target = coalesce($4, provider_target),
             observed_state = $5, observed_metadata = $6::jsonb,
             last_observed_at = now(), updated_at = now(),
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

      const operation = correctiveOperation(workspace.desired_state);
      if (operationSatisfied(operation, resource)) {
        const status = statusForObserved(workspace.desired_state, resource);
        await tx.query(
          `UPDATE cloud_workspaces
           SET status = $2::cloud_workspace_status,
               last_observed_at = now(), updated_at = now(), version = version + 1,
               deleted_at = CASE WHEN $2 = 'deleted' THEN coalesce(deleted_at, now())
                                 ELSE NULL END
           WHERE id = $1`,
          [candidate.workspaceId, status],
        );
        return;
      }
      if (isTransitional(resource)) return;

      const intentId = randomUUID();
      const key = `system:drift:${randomUUID()}`;
      await tx.query(
        `INSERT INTO cloud_workspace_lifecycle_intents (
           id, workspace_id, org_id, requested_by, operation,
           idempotency_key, request_sha256
         ) VALUES ($1, $2, $3, NULL, $4, $5, $6)`,
        [
          intentId,
          candidate.workspaceId,
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
        [candidate.workspaceId, statusForObserved(workspace.desired_state, resource)],
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
    let observed = 0;
    for await (const resource of this.provider.listManaged()) {
      if (observed >= this.maxManagedResourcesPerSweep) {
        this.logger.warn(
          "[cloud-workspace] managed-resource sweep hit its safety ceiling",
        );
        break;
      }
      observed += 1;
      const decision = await withSystemTx(this.pool, async (tx) => {
        const binding = await tx.query(
          `SELECT 1 FROM cloud_workspace_provider_bindings
           WHERE provider = $1 AND provider_resource_id = $2`,
          [this.provider.name, resource.resourceId],
        );
        if ((binding.rowCount ?? 0) > 0) {
          await tx.query(
            `DELETE FROM cloud_workspace_provider_orphans
             WHERE provider = $1 AND provider_resource_id = $2`,
            [this.provider.name, resource.resourceId],
          );
          return false;
        }

        // A create response can be lost after the provider committed but before
        // its binding transaction. The immutable labels still point at a real
        // database generation, so recover that binding instead of classifying
        // the resource as an orphan. Record-before-dispatch guarantees a valid
        // provider create always has this row first.
        const generation = await tx.query<{ provider_resource_id: string | null }>(
          `SELECT pb.provider_resource_id
           FROM cloud_workspace_generations g
           JOIN cloud_workspace_provider_bindings pb
             ON pb.workspace_id = g.workspace_id
            AND pb.generation = g.generation
           WHERE g.workspace_id = $1 AND g.generation = $2
             AND g.provider = $3
           FOR UPDATE OF pb`,
          [resource.workspaceId, resource.generation, this.provider.name],
        );
        const recoverable = generation.rows[0];
        if (recoverable) {
          if (recoverable.provider_resource_id === null) {
            await tx.query(
              `UPDATE cloud_workspace_provider_bindings
               SET provider_resource_id = $3, provider_target = $4,
                   observed_state = $5, observed_metadata = $6::jsonb,
                   last_observed_at = now(), updated_at = now()
               WHERE workspace_id = $1 AND generation = $2`,
              [
                resource.workspaceId,
                resource.generation,
                resource.resourceId,
                resource.target,
                resource.state,
                boundedMetadata(resource.metadata),
              ],
            );
            await tx.query(
              `DELETE FROM cloud_workspace_provider_orphans
               WHERE provider = $1 AND provider_resource_id = $2`,
              [this.provider.name, resource.resourceId],
            );
          } else {
            // If another resource is already bound, retain the duplicate for
            // operator review. Automatic deletion is intentionally limited to
            // a label identity that no durable generation recognizes.
            await tx.query(
              `INSERT INTO cloud_workspace_provider_orphans (
                 provider, provider_resource_id, workspace_id_hint,
                 generation_hint
               ) VALUES ($1, $2, $3, $4)
               ON CONFLICT (provider, provider_resource_id) DO UPDATE
                 SET last_seen_at = now(),
                     observation_count = cloud_workspace_provider_orphans.observation_count + 1`,
              [
                this.provider.name,
                resource.resourceId,
                resource.workspaceId,
                resource.generation,
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
             generation_hint
           ) VALUES ($1, $2, $3, $4)
           ON CONFLICT (provider, provider_resource_id) DO UPDATE
             SET last_seen_at = now(),
                 observation_count = cloud_workspace_provider_orphans.observation_count + 1
           RETURNING first_seen_at, observation_count, deletion_verified_at,
                     first_seen_at <= now() -
                       ($5::bigint * interval '1 millisecond') AS eligible`,
          [
            this.provider.name,
            resource.resourceId,
            resource.workspaceId,
            resource.generation,
            this.orphanGraceMs,
          ],
        );
        const orphan = result.rows[0]!;
        return (
          !orphan.deletion_verified_at &&
          orphan.observation_count >= 2 &&
          orphan.eligible
        );
      });
      if (!decision) continue;

      try {
        await this.provider.delete(resource.resourceId);
        await withSystemTx(this.pool, (tx) =>
          tx.query(
            `UPDATE cloud_workspace_provider_orphans
             SET delete_attempted_at = now(), deletion_verified_at = now(),
                 last_seen_at = now()
             WHERE provider = $1 AND provider_resource_id = $2`,
            [this.provider.name, resource.resourceId],
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
             WHERE provider = $1 AND provider_resource_id = $2`,
            [this.provider.name, resource.resourceId],
          ),
        );
      }
    }
    return observed;
  }
}

export function startCloudWorkspaceReconciler(
  options: CloudWorkspaceReconcilerOptions,
): { reconciler: CloudWorkspaceReconciler; stop: () => Promise<void> } {
  const reconciler = new CloudWorkspaceReconciler(options);
  return { reconciler, stop: reconciler.start() };
}

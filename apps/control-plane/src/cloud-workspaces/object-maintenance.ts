import { randomUUID } from "node:crypto";

export interface CloudWorkspaceObjectMaintenance {
  scheduleKeyRotation(): Promise<number>;
  rotateKeyOnce(input: {
    workerId: string;
    leaseMs?: number;
    maxAttempts?: number;
  }): Promise<boolean>;
  reconcileReferenceCounts(): Promise<number>;
  collectGarbageOnce(graceMs?: number): Promise<boolean>;
}

export type CloudWorkspaceObjectMaintenanceResult = {
  scheduledRotations: number;
  processedRotations: number;
  repairedReferenceCounts: number;
  collectedObjects: number;
};

/**
 * Bounded coordinator for the independently crash-safe object primitives.
 * Multiple control-plane replicas may run this worker: scheduling is unique,
 * rotation/GC claims use SKIP LOCKED, and reference counts are derived state.
 */
export class CloudWorkspaceObjectMaintenanceWorker {
  private readonly workerId: string;
  private readonly intervalMs: number;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private readonly rotationBatchSize: number;
  private readonly garbageBatchSize: number;
  private readonly garbageGraceMs: number;
  private timer: NodeJS.Timeout | null = null;
  private active: Promise<void> | null = null;
  private started = false;
  private stopped = false;

  constructor(
    private readonly maintenance: CloudWorkspaceObjectMaintenance,
    private readonly options: {
      workerId?: string;
      intervalMs?: number;
      leaseMs?: number;
      maxAttempts?: number;
      rotationBatchSize?: number;
      garbageBatchSize?: number;
      garbageGraceMs?: number;
      logger?: Pick<Console, "error">;
    } = {},
  ) {
    this.workerId =
      options.workerId ?? `cloud-object-maintenance:${randomUUID()}`;
    this.intervalMs = options.intervalMs ?? 60_000;
    this.leaseMs = options.leaseMs ?? 60_000;
    this.maxAttempts = options.maxAttempts ?? 10;
    this.rotationBatchSize = options.rotationBatchSize ?? 100;
    this.garbageBatchSize = options.garbageBatchSize ?? 100;
    this.garbageGraceMs = options.garbageGraceMs ?? 24 * 60 * 60_000;
    if (
      this.workerId.length < 1 ||
      this.workerId.length > 255 ||
      /[\u0000-\u001f\u007f]/u.test(this.workerId) ||
      !Number.isSafeInteger(this.intervalMs) ||
      this.intervalMs < 100 ||
      this.intervalMs > 300_000 ||
      !Number.isSafeInteger(this.leaseMs) ||
      this.leaseMs < 1_000 ||
      this.leaseMs > 3_600_000 ||
      !Number.isSafeInteger(this.maxAttempts) ||
      this.maxAttempts < 1 ||
      this.maxAttempts > 100 ||
      !Number.isSafeInteger(this.rotationBatchSize) ||
      this.rotationBatchSize < 1 ||
      this.rotationBatchSize > 1_000 ||
      !Number.isSafeInteger(this.garbageBatchSize) ||
      this.garbageBatchSize < 1 ||
      this.garbageBatchSize > 1_000 ||
      !Number.isSafeInteger(this.garbageGraceMs) ||
      this.garbageGraceMs < 60_000 ||
      this.garbageGraceMs > 30 * 24 * 60 * 60_000
    ) {
      throw new Error(
        "cloud workspace object maintenance configuration is invalid",
      );
    }
  }

  start(): () => Promise<void> {
    if (this.started || this.stopped) {
      throw new Error("cloud workspace object maintenance lifecycle is invalid");
    }
    this.started = true;
    const tick = () => {
      if (this.stopped) return;
      const task = this.runOnce()
        .then(() => undefined)
        .catch((error) => {
          (this.options.logger ?? console).error(
            `[cloud-workspace] object maintenance tick failed: ${
              error instanceof Error ? error.name : "unknown"
            }`,
          );
        });
      this.active = task;
      void task.finally(() => {
        if (this.active === task) this.active = null;
        if (this.stopped) return;
        this.timer = setTimeout(tick, this.intervalMs);
        this.timer.unref();
      });
    };
    tick();
    return () => this.stop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.active;
  }

  async runOnce(): Promise<CloudWorkspaceObjectMaintenanceResult> {
    const scheduledRotations = await this.maintenance.scheduleKeyRotation();
    let processedRotations = 0;
    for (; processedRotations < this.rotationBatchSize; processedRotations += 1) {
      if (
        !(await this.maintenance.rotateKeyOnce({
          workerId: this.workerId,
          leaseMs: this.leaseMs,
          maxAttempts: this.maxAttempts,
        }))
      ) {
        break;
      }
    }

    // Blob-reference rows are authoritative. Repair the cached count before
    // every deletion sweep so a crashed writer cannot make GC unsafe.
    const repairedReferenceCounts =
      await this.maintenance.reconcileReferenceCounts();
    let collectedObjects = 0;
    for (; collectedObjects < this.garbageBatchSize; collectedObjects += 1) {
      if (
        !(await this.maintenance.collectGarbageOnce(this.garbageGraceMs))
      ) {
        break;
      }
    }
    return {
      scheduledRotations,
      processedRotations,
      repairedReferenceCounts,
      collectedObjects,
    };
  }
}

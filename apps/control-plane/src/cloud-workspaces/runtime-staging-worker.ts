import { randomUUID } from "node:crypto";
import type { RuntimeArtifactStore } from "./runtime-artifact-store.js";
import { RuntimeInstallInputSchema } from "./runtime-contract.js";
import type { DatabaseCloudRuntimeTransitionService, CloudRuntimeTransitionClaim } from "./runtime-transfer.js";
import type { RuntimeUpdateInput, RuntimeUpdateResult } from "./runtime-update-runner.js";
import type { RuntimeStagePlan, RuntimeStagingStore } from "./runtime-staging-store.js";
import { CloudWorkerScheduler } from "./worker-scheduler.js";
export type { RuntimeStagingStore } from "./runtime-staging-store.js";

// HU owns these fences and all writes to the transition journal. In particular,
// cancellation must succeed only before activation; release cannot renew a lease.
export type RuntimeStagingTransitions = Pick<DatabaseCloudRuntimeTransitionService,
  "offer" | "claim" | "renew" | "reconcile" | "staged" | "release" | "cancelStaging">;
type StageInput = Extract<RuntimeUpdateInput, { operation: "stage" }>;
type Scope = Pick<CloudRuntimeTransitionClaim, "workspaceId" | "organizationId" | "transitionId">;
const samePlan = (a: RuntimeStagePlan, b: RuntimeStagePlan | null) => b !== null && JSON.stringify(a) === JSON.stringify(b);
const PAGE_SIZE = 16;

/** Notification-driven discovery, durable recovery, bounded downloads. This
 * worker has no activation handler, preparation command or provider stop API. */
export class CloudRuntimeStagingWorker {
  private readonly scheduler: CloudWorkerScheduler;
  private readonly workerId: string;
  private readonly concurrency: number;
  private readonly flights = new Map<string, { promise: Promise<void>; abort: AbortController }>();
  private readonly retries = new Map<string, { attempts: number; after: number; expires: number }>();
  private discoveryCursor: string | null = null;
  private pendingCursor: string | null = null;
  private rescan = false;
  private stopped = false;

  constructor(private readonly options: {
    store: RuntimeStagingStore; transitions: RuntimeStagingTransitions;
    artifacts: Pick<RuntimeArtifactStore, "presignGet">;
    run(resourceId: string, input: StageInput, signal: AbortSignal): Promise<RuntimeUpdateResult>;
    workerId?: string; intervalMs?: number; concurrency?: number;
    logger?: Pick<Console, "warn">;
  }) {
    this.workerId = options.workerId ?? `runtime-stage:${randomUUID()}`;
    this.concurrency = Math.max(1, Math.min(4, Math.floor(options.concurrency ?? 2)));
    this.scheduler = new CloudWorkerScheduler(options.intervalMs ?? 15_000, () => this.tick(), () => this.warn());
  }

  start(): () => Promise<void> { this.scheduler.start(); return () => this.stop(); }
  notify(): void { this.scheduler.notify(); }
  private warn(): void { (this.options.logger ?? console).warn("[cloud-runtime] staging_deferred"); }

  private async stop(): Promise<void> {
    this.stopped = true;
    for (const flight of this.flights.values()) flight.abort.abort();
    await this.scheduler.stop();
    await Promise.allSettled([...this.flights.values()].map(flight => flight.promise));
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    for (const [id, retry] of this.retries) if (retry.expires <= Date.now()) this.retries.delete(id);
    if (this.flights.size >= this.concurrency) { this.rescan = true; return; }
    const pending = await this.options.store.pending(this.pendingCursor, PAGE_SIZE);
    this.pendingCursor = pending.cursor;
    for (const scope of pending.items) this.launch(scope);
    if (this.stopped) return;
    if (this.flights.size >= this.concurrency) { this.rescan = true; return; }
    const page = await this.options.store.discover(this.discoveryCursor, PAGE_SIZE);
    this.discoveryCursor = page.cursor;
    for (const input of page.items) {
      if (this.stopped) break;
      const transition = await this.options.transitions.offer(input);
      if (transition?.executionMode === "retain_allocation" && ["offered", "staged"].includes(transition.phase))
        this.launch({ workspaceId: input.workspaceId, organizationId: input.organizationId, transitionId: transition.transitionId });
    }
    // Pages are bounded even when a release affects many workspaces. Pending
    // rows recover entries offered after this replica's download slots filled.
    if (page.cursor || pending.cursor) this.scheduler.notify();
  }

  private launch(scope: Scope): void {
    if (this.stopped || this.flights.has(scope.transitionId)) return;
    if (this.flights.size >= this.concurrency) { this.rescan = true; return; }
    if ((this.retries.get(scope.transitionId)?.after ?? 0) > Date.now()) return;
    const abort = new AbortController();
    const promise = this.stage(scope, abort).catch(() => this.warn()).finally(() => {
      this.flights.delete(scope.transitionId);
      if (this.rescan && !this.stopped) { this.rescan = false; this.scheduler.notify(); }
    });
    this.flights.set(scope.transitionId, { promise, abort });
  }

  private async stage(scope: Scope, abort: AbortController): Promise<void> {
    const { transitions, store } = this.options;
    const claim = await transitions.claim(scope, this.workerId);
    if (!claim) return;
    let leaseLost = false;
    let monitor: Promise<void> | null = null;
    let plan: RuntimeStagePlan | null = null;
    let invalid = false;
    const renewal = setInterval(() => {
      if (monitor || abort.signal.aborted) return;
      monitor = (async () => {
        if (!await transitions.renew(claim)) { leaseLost = true; abort.abort(); return; }
        if (plan && !samePlan(plan, await store.read(claim))) { invalid = true; abort.abort(); }
      })().catch(() => { leaseLost = true; abort.abort(); }).finally(() => { monitor = null; });
    }, 25_000);
    renewal.unref();
    const timeout = setTimeout(() => abort.abort(), 900_000);
    timeout.unref();
    try {
      if (this.stopped || abort.signal.aborted) return;
      const next = await transitions.reconcile(claim);
      if (next !== "stage" && next !== "activate") return;
      plan = await store.read(claim);
      if (!plan) { await transitions.cancelStaging(claim); return; }
      if (plan.phase === "staged") return;
      if (plan.deadline - Date.now() < 30_000) { await transitions.cancelStaging(claim); return; }
      const retry = this.retries.get(scope.transitionId) ?? { attempts: 0, after: 0, expires: plan.deadline };
      // Bounded memory and attempts. The durable 15-minute HU deadline also
      // bounds retries across process crashes; operation identity survives them.
      if (this.retries.size >= 512 && !this.retries.has(scope.transitionId)) return;
      if (retry.attempts >= 3) { await transitions.cancelStaging(claim); return; }
      retry.attempts++; this.retries.set(scope.transitionId, retry);
      const ttl = Math.min(900, Math.floor((plan.deadline - Date.now()) / 1000));
      const artifact = await this.options.artifacts.presignGet(plan.objectKey, ttl);
      const install = RuntimeInstallInputSchema.parse({ schema: "zeros.runtime-install/v1", purpose: "qualification", runtime: plan.target, artifact });
      const expiresAt = Math.min(plan.deadline, Date.parse(artifact.expiresAt));
      if (expiresAt <= Date.now() || expiresAt > Date.now() + 900_000) throw new Error("Staging capability unavailable");
      if (abort.signal.aborted || this.stopped) return;
      if (!samePlan(plan, await store.read(claim))) { invalid = true; return; }
      if (abort.signal.aborted || this.stopped) return;
      const input: StageInput = { ...plan.input, expiresAt: new Date(expiresAt).toISOString(),
        install: Buffer.from(JSON.stringify(install)).toString("base64url") };
      const result = await this.options.run(plan.resourceId, input, abort.signal);
      if (abort.signal.aborted || this.stopped) return;
      if (!samePlan(plan, await store.read(claim))) { invalid = true; return; }
      if (abort.signal.aborted || this.stopped) return;
      if (result.outcome !== "staged" || result.operation !== "stage" || result.transitionId !== claim.transitionId ||
        result.fence !== claim.executionFence || Object.entries(input.scope).some(([key, value]) => result.scope[key as keyof typeof result.scope] !== value))
        throw new Error("Staging receipt unavailable");
      if (!await transitions.staged(claim)) return;
      this.retries.delete(scope.transitionId);
    } catch {
      if (!leaseLost && !abort.signal.aborted) {
        const retry = this.retries.get(scope.transitionId);
        if (retry) {
          retry.after = Date.now() + [5_000, 30_000, 120_000][retry.attempts - 1]!;
          if (retry.attempts >= 3) {
            retry.after = retry.expires;
            await transitions.cancelStaging(claim);
          }
        }
        this.warn();
      }
    } finally {
      clearInterval(renewal); clearTimeout(timeout);
      await monitor;
      if (invalid && !leaseLost) await transitions.cancelStaging(claim);
      await transitions.release(claim);
    }
  }
}

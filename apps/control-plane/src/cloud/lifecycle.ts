// Drives cloud v2 workspaces through their transitional states on Boat, and
// stops idle ones. Every step is idempotent, so a crash or a lost reply only
// repeats it: creation uses the workspace id as Boat's idempotency key, and
// the worker credential is delivered by command after boot, never in the
// sandbox definition, so it can be rotated on any retry.
import { CLOUD_V2_LEASE_SECONDS, type CloudV2Compute, type CloudV2CommandResult } from "./boat.js";
import { BoatSnapshotExpiredError } from "./boat-client.js";
import { CloudProviderError } from "./provider-error.js";
import { installRuntimeCommand, type CloudV2Runtime } from "./runtime.js";
import type { CloudV2Store, CloudV2Workspace, CloudV2LifecycleWorkspace } from "./store.js";
import { CLOUD_V2_WORKER_PORT, type CloudV2WorkerTiming } from "./contract.js";

const CONCURRENCY = 4;
const LEASE_MS = 2 * 60_000;
/** The worker's hello moves the workspace to running at once; this poll only
 * re-delivers a credential to a worker that has not connected. */
const HELLO_POLL_MS = 30_000;
const BOOT_DEADLINE_MS = 10 * 60_000;
const MAX_ATTEMPTS = 8;
const LEASE_RENEW_MS = 12 * 60 * 60_000;
const MAINTENANCE_SCAN_MS = 60_000;
const RETENTION_AGE_MS = 12 * 24 * 60 * 60_000;
export const CLOUD_V2_IDLE_STOP_MS = 10 * 60_000;
/** Boat's stock image runs commands as its one user, `user`. The worker and
 * agents run as that user too, so its credential lives in its config dir. */
export const CLOUD_V2_WORKER_TOKEN_PATH = "/home/user/.config/zeros/worker-token";
/** Non-secret boot settings for the worker's systemd unit (EnvironmentFile). */
export const CLOUD_V2_WORKER_ENV_PATH = "/home/user/.config/zeros/worker.env";

type LifecyclePhase = "boat_create" | "boat_resume" | "runtime_install" | "protected_route" | "token_delivery" | "total";
export type CloudV2TimingRecord = {
  workspaceId: string;
  phase: LifecyclePhase | CloudV2WorkerTiming["phase"] | "worker_hello" | "relay_ready";
  durationMs: number;
  state?: CloudV2Workspace["state"];
  runtimeChanged?: boolean;
};
export function emitCloudV2Timing(observer: ((record: CloudV2TimingRecord) => void) | undefined, record: CloudV2TimingRecord): void {
  try { observer?.(record); } catch { /* Optional diagnostics cannot change lifecycle authority. */ }
}

export type CloudV2LifecycleDeps = {
  store: Pick<CloudV2Store, "claimPending" | "defer" | "transition" | "rotateWorkerToken" | "computerSnapshot" | "revoke" | "idleSince" | "setWorkerRoute" | "leasesDue" | "markLeaseRenewed"
    | "retentionDue" | "beginRetention" | "finishRetention" | "deferRetention" | "retentionCleanupDue" | "beginRetentionCleanup" | "finishRetentionCleanup" | "beginRestore" | "finishRestore">;
  /** Optional for older compositions; the shipped store always provides it. */
  prompts?: CloudV2Store["prompts"];
  stopIdle?: (id: string, before: Date) => Promise<void>;
  compute: CloudV2Compute;
  /** The worker runtime every VM must run; installed on create and on wake. */
  runtime: CloudV2Runtime;
  publicKeys: readonly string[];
  sealPortToken(token: string, workspaceId: string): unknown;
  stopWorker(workspace: CloudV2Workspace): Promise<boolean>;
  /** Non-secret boot settings, e.g. the relay URL and workspace id. */
  bootEnv(workspace: CloudV2Workspace): Record<string, string>;
  sandboxName(workspace: CloudV2Workspace): string;
  retentionName(workspace: CloudV2LifecycleWorkspace): string;
  /** Cloud Computer builds share this loop; one runs at a time. */
  builds?: { tick(): Promise<void>; cleanup?(): Promise<void> };
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  logger?: Pick<Console, "warn">;
  timing?: (record: CloudV2TimingRecord) => void;
};

/** Boat no longer has the VM, or deleted the disk of one stopped 14 days. */
function sandboxLost(error: unknown): boolean {
  return error instanceof BoatSnapshotExpiredError || (error instanceof CloudProviderError && error.code === "provider_not_found");
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[a-z0-9_]{1,64}$/.test(code) ? code : "provider_request_failed";
}

/** Writes the worker credential and its boot settings owner-only, then starts
 * the worker if it is not running. Values are single-quoted base64 literals the
 * shell never expands. Boat's sandbox environment does not reach systemd, so
 * the boot settings travel with the credential. */
export function deliverWorkerTokenCommand(token: string, bootEnv: Readonly<Record<string, string>> = {}): string {
  if (!/^zw2w_[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Invalid worker token");
  for (const [name, value] of Object.entries(bootEnv))
    if (!["CLOUD_V2_API_URL", "CLOUD_V2_RUNTIME_SHA256", "ZEROS_WORKSPACE_ID"].includes(name) || !/^[\x21-\x7e]{1,2048}$/.test(value)) throw new Error("Invalid worker boot setting");
  const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64");
  const dir = CLOUD_V2_WORKER_TOKEN_PATH.slice(0, CLOUD_V2_WORKER_TOKEN_PATH.lastIndexOf("/"));
  const envFile = Object.entries(bootEnv).map(([name, value]) => `${name}=${value}\n`).join("");
  return `umask 077 && mkdir -p ${dir} && chmod 700 ${dir} && ` +
    `printf %s '${b64(envFile)}' | base64 -d > ${CLOUD_V2_WORKER_ENV_PATH}.tmp && mv -f ${CLOUD_V2_WORKER_ENV_PATH}.tmp ${CLOUD_V2_WORKER_ENV_PATH} && ` +
    `printf %s '${b64(token)}' | base64 -d > ${CLOUD_V2_WORKER_TOKEN_PATH}.tmp && mv -f ${CLOUD_V2_WORKER_TOKEN_PATH}.tmp ${CLOUD_V2_WORKER_TOKEN_PATH} && ` +
    `(sudo -n systemctl restart zeros-worker.service || true)`;
}

export class CloudV2Lifecycle {
  private timer: NodeJS.Timeout | null = null;
  /** Only admission is serialized; provider calls run in separate slots. */
  private running: Promise<void> | null = null;
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(private readonly deps: CloudV2LifecycleDeps, private readonly intervalMs = 2_000) {}

  start(): () => Promise<void> {
    this.timer = setInterval(() => {
      void this.poll().catch(error => this.deps.logger?.warn(`[cloud-v2] lifecycle poll failed (${errorCode(error)})`));
    }, this.intervalMs);
    this.timer.unref();
    return async () => {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      await this.running;
      await Promise.all(this.inFlight.values());
      await this.renewing;
      await this.retaining;
      await this.building;
      await this.cleaning;
    };
  }

  private building: Promise<void> | null = null;
  private cleaning: Promise<void> | null = null;
  private lastPromptPrune = 0;
  private renewing: Promise<void> | null = null;
  private lastLeaseScan = -Infinity;
  private retaining: Promise<void> | null = null;
  private lastRetentionScan = -Infinity;

  async tick(): Promise<void> {
    await this.poll();
    await Promise.all(this.inFlight.values());
  }

  private poll(): Promise<void> {
    return this.running ??= this.admit().finally(() => { this.running = null; });
  }

  private async admit(): Promise<void> {
    const now = this.deps.now?.() ?? Date.now();
    await this.deps.prompts?.wakePending();
    if (now - this.lastPromptPrune > 10 * 60_000) {
      await this.deps.prompts?.prune(); this.lastPromptPrune = now;
    }
    if (this.building && this.deps.builds?.cleanup && !this.cleaning)
      this.cleaning = this.deps.builds.cleanup().catch(() => {}).finally(() => { this.cleaning = null; });
    // A build can take many minutes; it never blocks workspace lifecycle steps.
    if (this.deps.builds && !this.building)
      this.building = this.deps.builds.tick().catch(() => {}).finally(() => { this.building = null; });
    for (const idle of await this.deps.store.idleSince(new Date(now - CLOUD_V2_IDLE_STOP_MS))) {
      if (this.deps.stopIdle) await this.deps.stopIdle(idle.id, new Date(now - CLOUD_V2_IDLE_STOP_MS));
      else await this.deps.store.transition(idle.id, ["running"], "stopping");
    }
    if (!this.renewing && now - this.lastLeaseScan >= MAINTENANCE_SCAN_MS) {
      this.lastLeaseScan = now;
      this.renewing = this.renewLeases(now)
        .catch(error => this.deps.logger?.warn(`[cloud-v2] lease scan failed (${errorCode(error)})`))
        .finally(() => { this.renewing = null; });
    }
    if (!this.retaining && now - this.lastRetentionScan >= MAINTENANCE_SCAN_MS) {
      this.lastRetentionScan = now;
      this.retaining = this.maintainRetention(now)
        .catch(error => this.deps.logger?.warn(`[cloud-v2] retention scan failed (${errorCode(error)})`))
        .finally(() => { this.retaining = null; });
    }
    const slots = CONCURRENCY - this.inFlight.size;
    if (slots <= 0) return;
    for (const workspace of await this.deps.store.claimPending(slots, LEASE_MS, [...this.inFlight.keys()])) {
      if (this.inFlight.has(workspace.id) || this.inFlight.size >= CONCURRENCY) continue;
      const step = this.runStep(workspace, now)
        // A failed retry write must not escape an unobserved background promise.
        .catch(error => this.deps.logger?.warn(`[cloud-v2] lifecycle retry failed (${errorCode(error)})`))
        .finally(() => { this.inFlight.delete(workspace.id); });
      this.inFlight.set(workspace.id, step);
    }
  }

  private async renewLeases(now: number): Promise<void> {
    const { store, compute } = this.deps;
    const workspaces = await store.leasesDue(new Date(now - LEASE_RENEW_MS), CONCURRENCY);
    await Promise.all(workspaces.map(async workspace => {
      if (!workspace.boatSandboxId) return;
      const renewedAt = new Date(this.deps.now?.() ?? Date.now());
      try {
        await compute.extendLease(workspace.boatSandboxId, CLOUD_V2_LEASE_SECONDS);
        await store.markLeaseRenewed(workspace.id, workspace.boatSandboxId, renewedAt);
      } catch (error) { this.deps.logger?.warn(`[cloud-v2] lease renewal failed (${errorCode(error)})`); }
    }));
  }

  private async maintainRetention(now: number): Promise<void> {
    const { store, compute } = this.deps;
    // Running means an authenticated hello has registered the new worker. A
    // later stop also retires the previous stop's now-stale backup.
    for (const workspace of await store.retentionCleanupDue(CONCURRENCY)) {
      const name = workspace.retentionSnapshot;
      if (!name || !await store.beginRetentionCleanup(workspace.id, name)) continue;
      try {
        await compute.deleteSnapshot(name);
        await store.finishRetentionCleanup(workspace.id, name);
      } catch (error) {
        await store.deferRetention(workspace.id, name);
        this.deps.logger?.warn(`[cloud-v2] retention cleanup failed (${errorCode(error)})`);
      }
    }
    const workspace = (await store.retentionDue(new Date(now - RETENTION_AGE_MS), 1))[0];
    if (!workspace?.boatSandboxId || !workspace.stoppedAt) return;
    const name = workspace.retentionSnapshot ?? this.deps.retentionName(workspace);
    if (!await store.beginRetention(workspace, name)) return;
    try {
      await compute.saveSnapshot(workspace.boatSandboxId, name, { resume: true });
      await store.finishRetention(workspace.id, workspace.boatSandboxId, name);
    } catch (error) {
      await store.deferRetention(workspace.id, name);
      this.deps.logger?.warn(`[cloud-v2] retention save failed (${errorCode(error)})`);
    }
  }

  private async runStep(workspace: CloudV2LifecycleWorkspace & { attempts: number }, now: number): Promise<void> {
    try {
      if (workspace.state === "creating" || workspace.state === "starting")
        await this.measure(workspace, "total", () => this.step(workspace, now));
      else await this.step(workspace, now);
    } catch (error) {
      const code = errorCode(error);
      this.deps.logger?.warn(`[cloud-v2] ${workspace.state} step failed (${code})`);
      // Retrying cannot wake or stop a VM that is gone; say so at once.
      if ((workspace.state === "starting" || workspace.state === "stopping") && workspace.boatSandboxId && sandboxLost(error)) {
        await this.deps.store.revoke(workspace.id, false);
        await this.deps.store.transition(workspace.id, [workspace.state], "failed", { errorCode: "sandbox_missing" });
      } else if (workspace.attempts >= MAX_ATTEMPTS) await this.deps.store.transition(workspace.id, [workspace.state], "failed", { errorCode: code });
      else await this.deps.store.defer(workspace.id, workspace.state, Math.min(5_000 * 2 ** workspace.attempts, 5 * 60_000), { failure: true });
    }
  }

  private async step(workspace: CloudV2LifecycleWorkspace & { attempts: number }, now: number): Promise<void> {
    const { store, compute } = this.deps;
    switch (workspace.state) {
      case "creating": {
        if (now - Date.parse(workspace.createdAt) > BOOT_DEADLINE_MS) {
          await store.transition(workspace.id, ["creating"], "failed", { errorCode: "worker_boot_timeout" });
          return;
        }
        let sandboxId = workspace.boatSandboxId;
        if (!sandboxId) {
          const from = await store.computerSnapshot(workspace.organizationId, workspace.computerBuildId);
          if (!from) {
            await store.transition(workspace.id, ["creating"], "failed", { errorCode: "cloud_computer_build_required" });
            return;
          }
          const renewedAt = new Date(this.deps.now?.() ?? Date.now());
          ({ sandboxId } = await this.measure(workspace, "boat_create", () => compute.create({
            key: workspace.id, from, name: this.deps.sandboxName(workspace), env: this.deps.bootEnv(workspace),
          })));
          await store.defer(workspace.id, "creating", 0, { boatSandboxId: sandboxId });
          await store.markLeaseRenewed(workspace.id, sandboxId, renewedAt);
        }
        await this.measure(workspace, "runtime_install", () => this.ensureRuntime(sandboxId), runtimeChanged => ({ runtimeChanged }));
        if (!await this.measure(workspace, "protected_route", () => this.host(workspace, sandboxId))) return;
        await this.measure(workspace, "token_delivery", () => this.deliverToken(workspace, sandboxId));
        await store.defer(workspace.id, "creating", HELLO_POLL_MS);
        return;
      }
      case "starting": {
        let sandboxId = workspace.boatSandboxId;
        if (!sandboxId && !workspace.retentionSavedAt) {
          await store.transition(workspace.id, ["starting"], "failed", { errorCode: "sandbox_missing" });
          return;
        }
        // A wake requested during a save waits for that operation. Its boot
        // budget starts once the dependency permits it to touch the VM.
        const waking = now - Math.max(Date.parse(workspace.updatedAt), Date.parse(workspace.retentionOperationUntil ?? "") || 0);
        if (waking > BOOT_DEADLINE_MS) {
          await store.transition(workspace.id, ["starting"], "failed", { errorCode: "worker_boot_timeout" });
          return;
        }
        // Resume and protected hosting are idempotent. Rotate the HTTP token
        // and restart every wake to register a new process boot identity.
        if (workspace.restorePending || !sandboxId) {
          const restored = await this.restore(workspace);
          if (!restored || restored.state !== "starting") return;
          sandboxId = restored.sandboxId;
        } else {
          const renewedAt = new Date(this.deps.now?.() ?? Date.now());
          try {
            await this.measure(workspace, "boat_resume", () => compute.resume(sandboxId!));
            await store.markLeaseRenewed(workspace.id, sandboxId, renewedAt);
          } catch (error) {
            if (!sandboxLost(error) || !workspace.retentionSnapshot) throw error;
            let retained = workspace;
            if (!workspace.retentionSavedAt) {
              // The save may have committed before its HTTP/DB acknowledgement
              // was lost. saveSnapshot observes the named result first; a lost
              // source cannot start another real save alongside the background job.
              if (!await store.beginRetention(workspace, workspace.retentionSnapshot)) return;
              await compute.saveSnapshot(sandboxId, workspace.retentionSnapshot, { resume: true });
              await store.finishRetention(workspace.id, sandboxId, workspace.retentionSnapshot);
              retained = { ...workspace, retentionSavedAt: new Date(this.deps.now?.() ?? Date.now()).toISOString() };
            }
            const restored = await this.restore(retained);
            if (!restored || restored.state !== "starting") return;
            sandboxId = restored.sandboxId;
          }
        }
        // A runtime shipped while the VM slept is installed now.
        await this.measure(workspace, "runtime_install", () => this.ensureRuntime(sandboxId), runtimeChanged => ({ runtimeChanged }));
        if (!await this.measure(workspace, "protected_route", () => this.host(workspace, sandboxId))) return;
        await this.measure(workspace, "token_delivery", () => this.deliverToken(workspace, sandboxId));
        await store.defer(workspace.id, "starting", HELLO_POLL_MS);
        return;
      }
      case "stopping": {
        let sandboxId = workspace.boatSandboxId;
        if (workspace.restorePending) {
          const restored = await this.restore(workspace);
          if (!restored) return;
          sandboxId = restored.sandboxId;
        }
        if (sandboxId) {
          await this.deps.stopWorker({ ...workspace, boatSandboxId: sandboxId });
          await compute.stop(sandboxId);
        }
        await store.revoke(workspace.id, false);
        await store.transition(workspace.id, ["stopping"], "stopped");
        return;
      }
      case "deleting": {
        let sandboxId = workspace.boatSandboxId;
        if (workspace.restorePending) {
          const restored = await this.restore(workspace);
          if (!restored) return;
          sandboxId = restored.sandboxId;
        }
        if (sandboxId) await compute.delete(sandboxId);
        if (workspace.retentionSnapshot) {
          await compute.deleteSnapshot(workspace.retentionSnapshot);
          await store.finishRetentionCleanup(workspace.id, workspace.retentionSnapshot);
        }
        await store.revoke(workspace.id, true);
        await store.transition(workspace.id, ["deleting"], "deleted");
        return;
      }
      default:
        return;
    }
  }

  private async restore(workspace: CloudV2LifecycleWorkspace): Promise<{ sandboxId: string; state: CloudV2Workspace["state"] } | null> {
    const { store, compute } = this.deps;
    const name = workspace.retentionSnapshot;
    if (!name || !workspace.retentionSavedAt || !await store.beginRestore(workspace.id, workspace.boatSandboxId, name)) return null;
    const renewedAt = new Date(this.deps.now?.() ?? Date.now());
    const create = () => compute.create({ key: `restore:${workspace.id}:${name}`, from: name,
      name: this.deps.sandboxName(workspace), env: this.deps.bootEnv(workspace) });
    const { sandboxId } = workspace.state === "starting" ? await this.measure(workspace, "boat_create", create) : await create();
    // The expired sandbox may still have a Boat record. Keep its id until
    // deletion succeeds; a lost reply replays the same new allocation key.
    if (workspace.boatSandboxId && workspace.boatSandboxId !== sandboxId) await compute.delete(workspace.boatSandboxId);
    const state = await store.finishRestore(workspace.id, workspace.boatSandboxId, name, sandboxId, renewedAt);
    return state ? { sandboxId, state } : null;
  }

  private async deliverToken(workspace: CloudV2Workspace, sandboxId: string): Promise<void> {
    const token = await this.deps.store.rotateWorkerToken(workspace.id);
    const result = await this.execWhenReady(sandboxId, deliverWorkerTokenCommand(token, this.deps.bootEnv(workspace)), 30);
    if (result.exitCode !== 0 || result.timedOut) throw Object.assign(new Error("token delivery failed"), { code: "worker_token_delivery_failed" });
  }

  private async host(workspace: CloudV2Workspace, sandboxId: string): Promise<boolean> {
    const route = await this.deps.compute.hostPort(sandboxId, { port: CLOUD_V2_WORKER_PORT, localhost: true, title: "Zeros worker" });
    return this.deps.store.setWorkerRoute(workspace.id, sandboxId, route.url, this.deps.sealPortToken(route.token, workspace.id));
  }

  /** Quick when the VM already has the runtime; otherwise downloads it. */
  private async ensureRuntime(sandboxId: string): Promise<boolean> {
    const { runtime } = this.deps;
    const result = await this.execWhenReady(sandboxId, installRuntimeCommand({ sha256: runtime.sha256, url: await runtime.url(), publicKeys: this.deps.publicKeys }), 300);
    if (result.exitCode !== 0 || result.timedOut) throw Object.assign(new Error("runtime install failed"), { code: "worker_runtime_install_failed" });
    return result.stdout.split(/\r?\n/).includes("runtime-changed");
  }

  private async measure<T>(workspace: CloudV2Workspace, phase: LifecyclePhase, run: () => Promise<T>, detail?: (value: T) => { runtimeChanged: boolean }): Promise<T> {
    const start = this.deps.now?.() ?? Date.now();
    const value = await run();
    emitCloudV2Timing(this.deps.timing, { workspaceId: workspace.id.slice(0, 8), state: workspace.state, phase,
      durationMs: Math.max(0, Math.round((this.deps.now?.() ?? Date.now()) - start)), ...detail?.(value) });
    return value;
  }

  /** A VM that has just started or resumed can refuse commands for a few seconds. */
  private async execWhenReady(sandboxId: string, command: string, timeoutSeconds: number): Promise<CloudV2CommandResult> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.deps.compute.exec(sandboxId, command, timeoutSeconds);
      } catch (error) {
        if (attempt >= 6) throw error;
        await (this.deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(2_000);
      }
    }
  }
}

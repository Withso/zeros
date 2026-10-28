// Drives cloud v2 workspaces through their transitional states on Boat, and
// stops idle ones. Every step is idempotent, so a crash or a lost reply only
// repeats it: creation uses the workspace id as Boat's idempotency key, and
// the worker credential is delivered by command after boot, never in the
// sandbox definition, so it can be rotated on any retry.
import { randomBytes, randomUUID } from "node:crypto";
import { CLOUD_V2_LEASE_SECONDS, type CloudV2Compute, type CloudV2CommandResult } from "./boat.js";
import { BoatCreateRejectedError, BoatForkRefusedError, BoatSnapshotExpiredError } from "./boat-client.js";
import { CloudProviderError } from "./provider-error.js";
import { installRuntimeCommand, type CloudV2Runtime } from "./runtime.js";
import type { CloudV2CheckpointFork, CloudV2CheckpointReuse, CloudV2CheckpointRetry, CloudV2CheckpointScope, CloudV2Store, CloudV2Workspace,
  CloudV2LifecycleWorkspace } from "./store.js";
import { CLOUD_V2_WORKER_PORT, type CloudV2WorkerTiming } from "./contract.js";
import { CLOUD_V2_CHECKPOINT_ERRORS, CLOUD_V2_CHECKPOINT_SECONDS, checkpointCommand, cloudV2CheckpointObject, parseCheckpointResult, parseRestoreResult,
  restoreCommand, type CloudV2CheckpointError, type CloudV2CheckpointStorage } from "./checkpoint.js";

const CONCURRENCY = 4;
/** A stop can spend minutes saving its checkpoint; creates and wakes, which
 * someone is waiting for, always keep the remaining slots. */
const STOPPING_SLOTS = 2;
const LEASE_MS = 2 * 60_000;
/** The worker's hello moves the workspace to running at once; this poll only
 * re-delivers a credential to a worker that has not connected. */
const HELLO_POLL_MS = 30_000;
const BOOT_DEADLINE_MS = 10 * 60_000;
/** A restore also creates a VM and applies a checkpoint of up to 4 GiB. */
const RESTORE_DEADLINE_MS = 25 * 60_000;
/** Holds the step's claim while the VM runs a checkpoint command. */
const CHECKPOINT_LEASE_MS = (CLOUD_V2_CHECKPOINT_SECONDS + 120) * 1000;
/** GitHub answers while Boat boots the VM; never longer than this. */
const BASE_COMMIT_MS = 3_000;
/** An upload whose command reply was lost can still land until its URL has
 * expired (15 minutes) and curl's own limit (7 minutes) has passed. */
const UPLOAD_HORIZON_MS = 25 * 60_000;
/** Boat keeps an idempotency key for 24 hours. */
const CREATE_KEY_MS = 23 * 60 * 60_000;
const MAX_ATTEMPTS = 8;
const LEASE_RENEW_MS = 12 * 60 * 60_000;
const MAINTENANCE_SCAN_MS = 60_000;
export const CLOUD_V2_IDLE_STOP_MS = 10 * 60_000;
/** A failed stop checkpoint is retried on a fork of the stopped VM: first
 * after whatever failed has had time to pass, then less often. */
const RETRY_FIRST_MS = 10 * 60_000;
const RETRY_BACKOFF_MS = [10, 30, 60, 120, 240, 480, 960, 1440].map(minutes => minutes * 60_000);
/** Boat deletes a stopped VM's disk after 14 days; retries end two days before. */
export const CLOUD_V2_CHECKPOINT_RETRY_WINDOW_MS = 12 * 24 * 60 * 60_000;
/** Holds a retry's claim while its fork boots and runs the checkpoint. */
const RETRY_LEASE_MS = (CLOUD_V2_CHECKPOINT_SECONDS + 600) * 1000;
/** A backstop only: every fork is deleted as soon as its attempt ends. */
const FORK_TTL_SECONDS = 60 * 60;
/** A new VM can take longer than a resumed one to accept commands. */
const FORK_READY_ATTEMPTS = 36;
/** Boat archives a stopped VM for a few seconds; a fork waits for that. */
const ARCHIVING_RECHECK_MS = 60_000;
/** Boat's stock image home; repositories live at <home>/<owner>/<name>. */
export const CLOUD_V2_HOME = "/home/user";
/** Boat's stock image runs commands as its one user, `user`. The worker and
 * agents run as that user too, so its credential lives in its config dir. */
export const CLOUD_V2_WORKER_TOKEN_PATH = "/home/user/.config/zeros/worker-token";
/** Non-secret boot settings for the worker's systemd unit (EnvironmentFile). */
export const CLOUD_V2_WORKER_ENV_PATH = "/home/user/.config/zeros/worker.env";

type LifecyclePhase = "boat_create" | "boat_resume" | "runtime_install" | "protected_route" | "token_delivery" | "checkpoint" | "checkpoint_restore" | "total";
export type CloudV2TimingRecord = {
  workspaceId: string;
  phase: LifecyclePhase | CloudV2WorkerTiming["phase"] | "worker_hello" | "relay_ready";
  durationMs: number;
  state?: CloudV2Workspace["state"];
  runtimeChanged?: boolean;
  /** Whether a checkpoint command uploaded a new object or kept the last one. */
  checkpoint?: "saved" | "unchanged";
};
type TimingDetail = Pick<CloudV2TimingRecord, "runtimeChanged" | "checkpoint">;
export function emitCloudV2Timing(observer: ((record: CloudV2TimingRecord) => void) | undefined, record: CloudV2TimingRecord): void {
  try { observer?.(record); } catch { /* Optional diagnostics cannot change lifecycle authority. */ }
}

export type CloudV2LifecycleDeps = {
  store: Pick<CloudV2Store, "claimPending" | "defer" | "transition" | "rotateWorkerToken" | "computerSnapshot" | "revoke" | "idleSince" | "setWorkerRoute" | "leasesDue" | "markLeaseRenewed"
    | "setBaseCommit" | "saveCheckpoint" | "checkpointFailed" | "checkpointUpload" | "checkpointUploadDone" | "checkpointUploadHorizon" | "stopCurrent"
    | "beginRestore" | "replaceSandbox" | "finishRestore" | "checkpointUnchanged" | "claimCheckpointRetry" | "beginCheckpointFork"
    | "checkpointForkCreated" | "checkpointForkGone" | "checkpointRetryNext">;
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
  /** Checkpoints in object storage. Without them a stopped workspace has only
   * Boat's disk, which Boat deletes after 14 days. */
  checkpoints?: {
    storage: CloudV2CheckpointStorage;
    seal(key: Buffer, workspaceId: string, object: string): unknown;
    open(sealed: unknown, workspaceId: string, object: string): Buffer;
  };
  /** The base branch's GitHub head, recorded at creation; null when unknown. */
  remoteHead?(workspace: CloudV2Workspace): Promise<string | null>;
  /** A repository token, for a restore that must fetch or clone from GitHub. */
  githubToken?(workspace: CloudV2Workspace): Promise<{ token: string }>;
  authorizeSource?(workspace: CloudV2Workspace): Promise<void>;
  prepareRepository?(workspace: CloudV2Workspace, sandboxId: string): Promise<void>;
  /** Cloud Computer builds share this loop; one runs at a time. */
  builds?: { tick(): Promise<void>; cleanup?(): Promise<void> };
  /** Retries a stop's failed checkpoint on a fork of the stopped VM. */
  checkpointRetry?: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** `error` carries the alert that a stop is left without a checkpoint. */
  logger?: Pick<Console, "warn"> & Partial<Pick<Console, "error">>;
  timing?: (record: CloudV2TimingRecord) => void;
};

/** Boat no longer has the VM, or deleted the disk of one stopped 14 days. */
function sandboxLost(error: unknown): boolean {
  return error instanceof BoatSnapshotExpiredError || (error instanceof CloudProviderError && error.code === "provider_not_found");
}

const checkpointError = (code: CloudV2CheckpointError) => Object.assign(new Error("checkpoint failed"), { code });
const checkpointCode = (error: unknown): CloudV2CheckpointError =>
  (CLOUD_V2_CHECKPOINT_ERRORS as readonly string[]).includes(errorCode(error)) ? errorCode(error) as CloudV2CheckpointError : "checkpoint_failed";
/** Boat refused before creating anything: its source is gone, the request was
 * invalid or not permitted, or Boat certified the refusal. */
const neverCreated = (error: unknown) => sandboxLost(error) || error instanceof BoatCreateRejectedError || error instanceof BoatForkRefusedError ||
  (error instanceof CloudProviderError && [400, 401, 402, 403, 422].includes(error.httpStatus ?? 0));
/** One key per attempt: a replay returns that attempt's fork, never a second one. */
const forkKey = (workspaceId: string, attempt: string) => `checkpoint:${workspaceId}:${attempt}`;

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
  private readonly stopping = new Set<string>();

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
      await this.retrying;
      await this.building;
      await this.cleaning;
    };
  }

  private building: Promise<void> | null = null;
  private cleaning: Promise<void> | null = null;
  private lastPromptPrune = 0;
  private renewing: Promise<void> | null = null;
  private lastLeaseScan = -Infinity;
  private retrying: Promise<void> | null = null;
  private nextRetryScan = -Infinity;

  async tick(): Promise<void> {
    await this.poll();
    await Promise.all(this.inFlight.values());
    await this.retrying;
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
    const slots = CONCURRENCY - this.inFlight.size;
    if (slots <= 0) return;
    // Creates, wakes and deletions first; stops then take at most their own slots.
    this.admitClaimed(await this.deps.store.claimPending(slots, LEASE_MS, [...this.inFlight.keys()], ["creating", "starting", "deleting"]), now);
    const stopSlots = Math.min(CONCURRENCY - this.inFlight.size, STOPPING_SLOTS - this.stopping.size);
    if (stopSlots > 0) this.admitClaimed(await this.deps.store.claimPending(stopSlots, LEASE_MS, [...this.inFlight.keys()], ["stopping"]), now);
    // One retry at a time, only with a slot to spare, and never in a slot: a
    // fork runs for minutes and nobody is waiting for it.
    if (this.deps.checkpointRetry && this.deps.checkpoints && !this.retrying && now >= this.nextRetryScan && this.inFlight.size < CONCURRENCY) {
      this.nextRetryScan = now + MAINTENANCE_SCAN_MS;
      this.retrying = this.retryCheckpoint()
        // Another one may be due at once; otherwise wait for the next scan.
        .then(claimed => { if (claimed) this.nextRetryScan = -Infinity; })
        .catch(error => this.deps.logger?.warn(`[cloud-v2] checkpoint retry step failed (${errorCode(error)})`))
        .finally(() => { this.retrying = null; });
    }
  }

  private admitClaimed(claimed: (CloudV2LifecycleWorkspace & { attempts: number })[], now: number): void {
    for (const workspace of claimed) {
      if (this.inFlight.has(workspace.id) || this.inFlight.size >= CONCURRENCY) continue;
      if (workspace.state === "stopping") {
        if (this.stopping.size >= STOPPING_SLOTS) continue;
        this.stopping.add(workspace.id);
      }
      const step = this.runStep(workspace, now)
        // A failed retry write must not escape an unobserved background promise.
        .catch(error => this.deps.logger?.warn(`[cloud-v2] lifecycle retry failed (${errorCode(error)})`))
        .finally(() => { this.inFlight.delete(workspace.id); this.stopping.delete(workspace.id); });
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

  private async runStep(workspace: CloudV2LifecycleWorkspace & { attempts: number }, now: number): Promise<void> {
    try {
      if (workspace.state === "creating" || workspace.state === "starting")
        await this.measure(workspace, "total", () => this.step(workspace, now));
      else await this.step(workspace, now);
    } catch (error) {
      const code = errorCode(error);
      this.deps.logger?.warn(`[cloud-v2] ${workspace.state} step failed (${code})`);
      // A stop's outcome belongs to that stop alone, never to a newer one.
      const fence = workspace.state === "stopping" ? { stopGeneration: workspace.stopGeneration } : {};
      // Retrying cannot wake or stop a VM that is gone; say so at once. With a
      // checkpoint the next attempt restores instead.
      if ((workspace.state === "starting" || workspace.state === "stopping") && workspace.boatSandboxId && sandboxLost(error) && !workspace.checkpoint) {
        await this.deps.store.transition(workspace.id, [workspace.state], "failed", { errorCode: "sandbox_missing", revoke: true, ...fence });
      } else if (workspace.attempts >= MAX_ATTEMPTS) {
        // A restore that gives up keeps its checkpoint; Start tries again.
        const restore = workspace.state === "starting" && workspace.restorePending && !(CLOUD_V2_CHECKPOINT_ERRORS as readonly string[]).includes(code);
        await this.deps.store.transition(workspace.id, [workspace.state], "failed", { errorCode: restore ? "checkpoint_restore_failed" : code, ...fence });
      }
      else await this.deps.store.defer(workspace.id, workspace.state, Math.min(5_000 * 2 ** workspace.attempts, 5 * 60_000), { failure: true, ...fence });
    }
  }

  private async step(workspace: CloudV2LifecycleWorkspace & { attempts: number }, now: number): Promise<void> {
    const { store, compute } = this.deps;
    if (workspace.state === "creating" || workspace.state === "starting") await this.deps.authorizeSource?.(workspace);
    switch (workspace.state) {
      case "creating": {
        if (now - Date.parse(workspace.createdAt) > BOOT_DEADLINE_MS) {
          await store.transition(workspace.id, ["creating"], "failed", { errorCode: "worker_boot_timeout" });
          return;
        }
        const baseCommit = workspace.baseCommit || !this.deps.remoteHead ? null : this.lookupBaseCommit(workspace);
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
        if (this.deps.prepareRepository) {
          await store.defer(workspace.id, "creating", 17 * 60_000);
          await this.deps.prepareRepository(workspace, sandboxId);
        }
        if (!await this.measure(workspace, "protected_route", () => this.host(workspace, sandboxId))) return;
        // The worker reads it with its configuration, after the token arrives.
        const commit = await baseCommit;
        if (commit) await store.setBaseCommit(workspace.id, commit);
        await this.measure(workspace, "token_delivery", () => this.deliverToken(workspace, sandboxId));
        await store.defer(workspace.id, "creating", HELLO_POLL_MS);
        return;
      }
      case "starting": {
        let sandboxId = workspace.boatSandboxId, restoring = workspace.restorePending;
        const deadline = restoring || (!sandboxId && workspace.checkpoint) ? RESTORE_DEADLINE_MS : BOOT_DEADLINE_MS;
        if (now - Date.parse(workspace.updatedAt) > deadline) {
          await store.transition(workspace.id, ["starting"], "failed",
            { errorCode: deadline === RESTORE_DEADLINE_MS ? "checkpoint_restore_failed" : "worker_boot_timeout" });
          return;
        }
        if (!sandboxId) {
          if (!restoring && !workspace.checkpoint) {
            await store.transition(workspace.id, ["starting"], "failed", { errorCode: "sandbox_missing" });
            return;
          }
          sandboxId = await this.replacement(workspace, restoring ? undefined : null);
          if (!sandboxId) return;
          restoring = true;
        } else {
          // Resume and protected hosting are idempotent. Rotate the HTTP token
          // and restart every wake to register a new process boot identity.
          const renewedAt = new Date(this.deps.now?.() ?? Date.now());
          try {
            await this.measure(workspace, "boat_resume", () => compute.resume(sandboxId!));
            await store.markLeaseRenewed(workspace.id, sandboxId, renewedAt);
          } catch (error) {
            // Boat deleted the disk of a VM stopped for 14 days: a new VM
            // from the Cloud Computer gets the last checkpoint.
            if (!sandboxLost(error) || !workspace.checkpoint) throw error;
            sandboxId = await this.replacement(workspace, sandboxId);
            if (!sandboxId) return;
            restoring = true;
          }
        }
        // A runtime shipped while the VM slept is installed now.
        await this.measure(workspace, "runtime_install", () => this.ensureRuntime(sandboxId), runtimeChanged => ({ runtimeChanged }));
        if (restoring) {
          await this.measure(workspace, "checkpoint_restore", () => this.applyCheckpoint(workspace, sandboxId));
          if (!await store.finishRestore(workspace.id, sandboxId)) return;
        }
        if (!await this.measure(workspace, "protected_route", () => this.host(workspace, sandboxId))) return;
        await this.measure(workspace, "token_delivery", () => this.deliverToken(workspace, sandboxId));
        await store.defer(workspace.id, "starting", HELLO_POLL_MS);
        return;
      }
      case "stopping": {
        let sandboxId = workspace.boatSandboxId;
        if (workspace.restorePending && !sandboxId) sandboxId = await this.replacement(workspace, undefined, { find: true });
        if (sandboxId) {
          await this.deps.stopWorker({ ...workspace, boatSandboxId: sandboxId });
          // A replacement without its checkpoint holds nothing of the user's yet.
          if (!workspace.restorePending) await this.checkpoint(workspace, sandboxId);
          // A stop that a later one has replaced leaves the VM to that one,
          // whose checkpoint may still be running on it.
          if (!await store.stopCurrent(workspace.id, workspace.stopGeneration)) return;
          try { await compute.stop(sandboxId); }
          catch (error) {
            // Nothing is left to stop; the next wake restores the checkpoint.
            if (!sandboxLost(error) || !workspace.checkpoint) throw error;
          }
        }
        // Credentials go only with this stop's own completion.
        await store.transition(workspace.id, ["stopping"], "stopped", { stopGeneration: workspace.stopGeneration, revoke: true });
        return;
      }
      case "deleting": {
        let sandboxId = workspace.boatSandboxId;
        if (workspace.restorePending && !sandboxId) sandboxId = await this.replacement(workspace, undefined, { find: true });
        // A retry's fork first: finding one whose reply was lost needs its source.
        if (workspace.checkpointRetryFork) await this.removeFork(workspace, workspace.checkpointRetryFork);
        if (sandboxId) await compute.delete(sandboxId);
        // Every checkpoint object, including any a crashed upload left behind.
        await this.deps.checkpoints?.storage.prune(workspace.id);
        // An upload whose outcome is unknown may still land; prune again once it
        // no longer can. Read live: no upload is admitted once deletion began.
        const uploadUntil = Date.parse(this.deps.checkpoints ? await store.checkpointUploadHorizon(workspace.id) ?? "" : "");
        if (this.deps.checkpoints && uploadUntil > now) {
          await store.defer(workspace.id, "deleting", uploadUntil - now + 1_000);
          return;
        }
        await store.revoke(workspace.id, true);
        await store.transition(workspace.id, ["deleting"], "deleted");
        return;
      }
      default:
        return;
    }
  }

  /** The VM a restore applies the checkpoint to. `lost` starts a restore
   * (null when the workspace has no VM); undefined continues one. A restore
   * records its attempt and exact request first, so a lost reply replays the
   * same request and finds the same VM, even after a runtime release or once
   * its build is retiring. Each attempt names its VM uniquely, so once Boat
   * has forgotten the key the VM is found by name instead of made again. With
   * `find`, a stop or deletion only looks for it. */
  private async replacement(workspace: CloudV2LifecycleWorkspace, lost: string | null | undefined, options: { find?: boolean } = {}): Promise<string | null> {
    const { store, compute } = this.deps;
    if (!workspace.checkpoint) return null;
    let attempt = workspace.restoreAttempt, request = workspace.restoreCreate;
    if (lost !== undefined) {
      const next = randomUUID();
      const begun = await store.beginRestore(workspace.id, lost,
        { attempt: next, name: `${this.deps.sandboxName(workspace)}-r${next.slice(0, 8)}`, env: this.deps.bootEnv(workspace) });
      if (begun === "no_computer") {
        await store.transition(workspace.id, ["starting"], "failed", { errorCode: "cloud_computer_build_required" });
        return null;
      }
      if (!begun) return null;
      ({ attempt, create: request } = begun);
      // Boat may keep a record of the expired VM.
      if (lost) await compute.delete(lost).catch(() => {});
    }
    if (!attempt || !request) return null;
    const { requestedAt, ...body } = request;
    let sandboxId: string | null;
    if ((this.deps.now?.() ?? Date.now()) - Date.parse(requestedAt) < CREATE_KEY_MS) {
      const create = () => compute.create({ key: `restore:${workspace.id}:${attempt}`, ...body });
      ({ sandboxId } = workspace.state === "starting" ? await this.measure(workspace, "boat_create", create) : await create());
    } else {
      sandboxId = await compute.findSandbox(body.name, new Date(Date.parse(requestedAt) - 10 * 60_000));
      // Nothing was made under this attempt: a wake starts a new one; a stop
      // or deletion has nothing to clean.
      if (!sandboxId) return options.find || workspace.state !== "starting" ? null : this.replacement(workspace, null);
    }
    // A stop or deletion that won the race finds this VM in the row.
    const state = await store.replaceSandbox(workspace.id, attempt, sandboxId, new Date(this.deps.now?.() ?? Date.now()));
    return state && (options.find || state === "starting") ? sandboxId : null;
  }

  /** Saves the stopped worker's checkpoint. Never blocks the stop: a failure
   * keeps the previous checkpoint and records why. */
  private async checkpoint(workspace: CloudV2LifecycleWorkspace, sandboxId: string): Promise<void> {
    if (!this.deps.checkpoints) return;
    // A retried stop already saved this one.
    if (workspace.checkpoint?.stopGeneration === workspace.stopGeneration) return;
    await this.capture(workspace, sandboxId, sandboxId, "stop", async () => {
      await this.deps.store.defer(workspace.id, "stopping", CHECKPOINT_LEASE_MS, { failure: true, stopGeneration: workspace.stopGeneration });
    }).catch(() => {});
  }

  /** Runs the checkpoint command on `vm` and records the result for the stop
   * of `owner`, the workspace's VM: `vm` itself, or a fork of it for a retry.
   * Resolves whether it saved a new checkpoint, kept the last one, or was
   * fenced out; rejects, after recording why, when it saved nothing. */
  private async capture(workspace: CloudV2LifecycleWorkspace, vm: string, owner: string, scope: CloudV2CheckpointScope,
    before: () => Promise<void> = async () => {}): Promise<"saved" | "unchanged" | "fenced"> {
    const checkpoints = this.deps.checkpoints!, store = this.deps.store, generation = workspace.stopGeneration;
    const object = cloudV2CheckpointObject(workspace.id, randomUUID()), key = randomBytes(32);
    const uploadUntil = new Date((this.deps.now?.() ?? Date.now()) + UPLOAD_HORIZON_MS);
    // A stop's own calls keep their original shape; a retry names its scope.
    const scoped = scope === "stop" ? [] as const : [scope] as const;
    // Whether this upload is known to be over, whatever its outcome.
    let settled = false;
    try {
      await before();
      // Recorded before the URL exists. A stop that no longer owns the VM, for
      // instance once deletion began, issues no upload at all.
      if (!await store.checkpointUpload(workspace.id, owner, generation, object, uploadUntil, ...scoped)) return "fenced";
      const reuse = await this.reusable(workspace);
      const command = checkpointCommand({ checkoutPath: `${CLOUD_V2_HOME}/${workspace.repository}`, home: CLOUD_V2_HOME,
        baseBranch: workspace.baseBranch, key, uploadUrl: await checkpoints.storage.uploadUrl(workspace.id, object), ...(reuse ? { reuse } : {}) });
      const { result, saved } = await this.measure(workspace, "checkpoint", async () => {
        const result = await this.deps.compute.exec(vm, command, CLOUD_V2_CHECKPOINT_SECONDS);
        return { result, saved: parseCheckpointResult(result.stdout) };
      }, ({ result, saved }): TimingDetail => saved.ok && result.exitCode === 0 && !result.timedOut ? { checkpoint: saved.unchanged ? "unchanged" : "saved" } : {});
      // A failure before the upload step never started one. A failed upload,
      // a timeout or a lost reply may still land, so its intent stays.
      if (!saved.ok) { settled = !result.timedOut && saved.step !== "upload" && saved.step !== "unknown"; throw checkpointError(saved.code); }
      if (result.exitCode !== 0 || result.timedOut) throw checkpointError("checkpoint_failed");
      // curl reported the upload complete, or there was nothing to upload, so nothing is in flight.
      settled = true;
      if (saved.unchanged) {
        // Only an answer about the checkpoint it was asked to compare with counts.
        if (!reuse || !workspace.checkpoint || saved.fingerprint !== reuse.fingerprint) throw checkpointError("checkpoint_failed");
        // Nothing was uploaded under the new name; remove anything that was.
        await checkpoints.storage.delete(workspace.id, object).catch(() => {});
        return await store.checkpointUnchanged(workspace.id, owner, generation, workspace.checkpoint.object, ...scoped) ? "unchanged" : "fenced";
      }
      if (await checkpoints.storage.size(workspace.id, object) !== saved.bytes) throw checkpointError("checkpoint_upload_failed");
      // Only this stop, or a retry of it, records it: a late save from an earlier stop is refused.
      const recorded = await store.saveCheckpoint(workspace.id, owner, generation,
        { object, key: checkpoints.seal(key, workspace.id, object), sha256: saved.sha256, bytes: saved.bytes, ...(saved.reuse ? { reuse: saved.reuse } : {}) },
        ...scoped);
      // Only the checkpoint this one replaced is retired, never anything newer;
      // anything a crashed upload left goes with the workspace.
      if (recorded && recorded.replaced) await checkpoints.storage.delete(workspace.id, recorded.replaced)
        .catch(error => this.deps.logger?.warn(`[cloud-v2] checkpoint retire failed (${errorCode(error)})`));
      if (!recorded) await checkpoints.storage.delete(workspace.id, object).catch(() => {});
      return recorded ? "saved" : "fenced";
    } catch (error) {
      const code = checkpointCode(error);
      this.deps.logger?.warn(`[cloud-v2] checkpoint failed (${code})`);
      await store.checkpointFailed(workspace.id, owner, generation, code, ...scoped).catch(() => {});
      await checkpoints.storage.delete(workspace.id, object).catch(() => {});
      throw checkpointError(code);
    } finally {
      key.fill(0);
      if (settled) await store.checkpointUploadDone(workspace.id, object).catch(() => {});
    }
  }

  /** What the last checkpoint can be compared by, when it was recorded for
   * that object and the object is still stored in full. */
  private async reusable(workspace: CloudV2LifecycleWorkspace): Promise<CloudV2CheckpointReuse | null> {
    const checkpoint = workspace.checkpoint;
    if (!checkpoint?.reuse || !this.deps.checkpoints) return null;
    const size = await this.deps.checkpoints.storage.size(workspace.id, checkpoint.object).catch(() => null);
    return size === checkpoint.bytes ? checkpoint.reuse : null;
  }

  /** One retry of a stop that has no checkpoint, on a fork of its stopped VM,
   * so the VM itself is never woken and a user can open it meanwhile.
   * Resolves whether a workspace was claimed. */
  private async retryCheckpoint(): Promise<boolean> {
    const { store } = this.deps;
    const row = await store.claimCheckpointRetry({ leaseMs: RETRY_LEASE_MS, firstDelayMs: RETRY_FIRST_MS,
      windowMs: CLOUD_V2_CHECKPOINT_RETRY_WINDOW_MS, excludeIds: [...this.inFlight.keys()] });
    if (!row) return false;
    const { retry } = row;
    // A fork an earlier attempt may have left goes first, whatever comes next.
    if (row.checkpointRetryFork) await this.removeFork(row, row.checkpointRetryFork);
    const source = row.boatSandboxId;
    if (row.state !== "stopped" || !source || row.restorePending || row.checkpoint?.stopGeneration === row.stopGeneration) {
      await store.checkpointRetryNext(row.id, retry.generation, { done: true });
      return true;
    }
    const now = this.deps.now?.() ?? Date.now(), until = Date.parse(retry.stoppedAt) + CLOUD_V2_CHECKPOINT_RETRY_WINDOW_MS;
    if (now >= until) { await this.retriesExhausted(row, retry, "checkpoint_failed"); return true; }
    // Boat forks only a VM whose stop has finished archiving.
    let inspected: { name: string | null; state: string };
    try { inspected = await this.deps.compute.inspect(source); }
    catch (error) { if (!sandboxLost(error)) throw error; await this.retriesExhausted(row, retry, "checkpoint_failed"); return true; }
    if (inspected.state !== "archived") {
      const next = now + (inspected.state === "archiving" ? ARCHIVING_RECHECK_MS : RETRY_BACKOFF_MS[Math.min(retry.attempts, RETRY_BACKOFF_MS.length - 1)]!);
      if (next >= until) await this.retriesExhausted(row, retry, "checkpoint_failed");
      else await store.checkpointRetryNext(row.id, retry.generation, { at: new Date(next) });
      return true;
    }
    const attempt = randomUUID();
    // Boat names every fork after its source. Recording that name, and asking
    // for it, keeps a fork findable whichever name Boat applies.
    const fork = await store.beginCheckpointFork(row.id, retry.generation, { attempt, name: inspected.name ? `${inspected.name} fork` : "", source });
    // The workspace was woken, stopped again or deleted meanwhile.
    if (!fork) { await store.checkpointRetryNext(row.id, retry.generation, { done: true }); return true; }
    let outcome: "saved" | "unchanged" | "fenced" | null = null, code: CloudV2CheckpointError = "checkpoint_failed", final = false, absent = false;
    let forking = true;
    try {
      let sandboxId: string;
      try { ({ sandboxId } = await this.deps.compute.fork(source, { key: forkKey(row.id, attempt), ...(fork.name ? { name: fork.name } : {}), ttlSeconds: FORK_TTL_SECONDS })); }
      catch (error) { absent = neverCreated(error); throw error; }
      forking = false;
      fork.sandboxId = sandboxId;
      await store.checkpointForkCreated(row.id, attempt, sandboxId);
      await this.untilReady(sandboxId);
      outcome = await this.capture(row, sandboxId, source, "retry");
    } catch (error) {
      code = checkpointCode(error);
      // Nothing is left to fork from, and a stopped disk never shrinks.
      final = (forking && sandboxLost(error)) || code === "checkpoint_too_large";
      if (!(CLOUD_V2_CHECKPOINT_ERRORS as readonly string[]).includes(errorCode(error)))
        this.deps.logger?.warn(`[cloud-v2] checkpoint retry failed (${errorCode(error)})`);
    } finally {
      if (absent) await store.checkpointForkGone(row.id, attempt).catch(() => {});
      // Kept recorded when Boat cannot confirm; the next claim removes it.
      else await this.removeFork(row, fork).catch(error => this.deps.logger?.warn(`[cloud-v2] checkpoint fork cleanup failed (${errorCode(error)})`));
    }
    if (outcome) { await store.checkpointRetryNext(row.id, retry.generation, { done: true }); return true; }
    const next = (this.deps.now?.() ?? Date.now()) + RETRY_BACKOFF_MS[Math.min(retry.attempts, RETRY_BACKOFF_MS.length - 1)]!;
    if (final || next >= until) await this.retriesExhausted(row, retry, code);
    else await store.checkpointRetryNext(row.id, retry.generation, { at: new Date(next) });
    return true;
  }

  /** The alert: this stop has no checkpoint, and none will be retried. A
   * restore after Boat deletes the VM uses the previous checkpoint, if any. */
  private async retriesExhausted(workspace: CloudV2LifecycleWorkspace, retry: CloudV2CheckpointRetry, code: string): Promise<void> {
    await this.deps.store.checkpointRetryNext(workspace.id, retry.generation, { exhausted: true });
    const line = `[cloud-v2] checkpoint retries exhausted (${code}) workspace=${workspace.id.slice(0, 8)} previous=${workspace.checkpoint ? "kept" : "none"}`;
    (this.deps.logger?.error ?? this.deps.logger?.warn)?.call(this.deps.logger, line);
  }

  /** Deletes a retry's fork, finding it by its request first when the reply
   * never arrived. Throws, keeping the record, while Boat cannot confirm. */
  private async removeFork(workspace: CloudV2LifecycleWorkspace, fork: CloudV2CheckpointFork): Promise<void> {
    const { compute, store } = this.deps;
    let sandboxId = fork.sandboxId;
    if (!sandboxId) {
      if ((this.deps.now?.() ?? Date.now()) - Date.parse(fork.requestedAt) < CREATE_KEY_MS) {
        // The same key returns the fork it made, if it made one.
        try { ({ sandboxId } = await compute.fork(fork.source, { key: forkKey(workspace.id, fork.attempt), ...(fork.name ? { name: fork.name } : {}), ttlSeconds: FORK_TTL_SECONDS })); }
        catch (error) { if (!neverCreated(error)) throw error; }
      } else if (fork.name) sandboxId = await compute.findSandbox(fork.name, new Date(Date.parse(fork.requestedAt) - 10 * 60_000));
      // Without a name nothing can find it; its lease stops it within the hour.
      else this.deps.logger?.warn("[cloud-v2] checkpoint fork unrecoverable (provider_not_found)");
    }
    if (sandboxId) await compute.delete(sandboxId);
    await store.checkpointForkGone(workspace.id, fork.attempt);
  }

  /** A fork boots like a new VM; a slow boot is not a failed checkpoint. */
  private async untilReady(sandboxId: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        const ready = await this.deps.compute.exec(sandboxId, "true", 30);
        if (ready.exitCode === 0 && !ready.timedOut) return;
      } catch (error) { if (sandboxLost(error) || attempt >= FORK_READY_ATTEMPTS) throw error; }
      if (attempt >= FORK_READY_ATTEMPTS) throw Object.assign(new Error("fork never became ready"), { code: "provider_request_failed" });
      await (this.deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(5_000);
    }
  }

  /** Applies the last checkpoint before the worker starts. Idempotent, so a
   * failed attempt is simply retried. */
  private async applyCheckpoint(workspace: CloudV2LifecycleWorkspace, sandboxId: string): Promise<void> {
    const checkpoints = this.deps.checkpoints, checkpoint = workspace.checkpoint;
    if (!checkpoints || !checkpoint) throw checkpointError("checkpoint_restore_failed");
    await this.deps.authorizeSource?.(workspace);
    const github = await this.deps.githubToken?.(workspace) ?? null;
    const key = checkpoints.open(checkpoint.key, workspace.id, checkpoint.object);
    try {
      const command = restoreCommand({ checkoutPath: `${CLOUD_V2_HOME}/${workspace.repository}`, home: CLOUD_V2_HOME, key,
        sha256: checkpoint.sha256, downloadUrl: await checkpoints.storage.downloadUrl(workspace.id, checkpoint.object),
        repositoryUrl: `https://github.com/${workspace.repository}.git`, ...(github ? { githubToken: github.token } : {}) });
      await this.deps.store.defer(workspace.id, "starting", CHECKPOINT_LEASE_MS, { failure: true });
      const result = await this.deps.compute.exec(sandboxId, command, CLOUD_V2_CHECKPOINT_SECONDS);
      const restored = parseRestoreResult(result.stdout);
      if (!restored.ok) throw checkpointError(restored.code);
      if (result.exitCode !== 0 || result.timedOut) throw checkpointError("checkpoint_restore_failed");
    } finally { key.fill(0); }
  }

  private async lookupBaseCommit(workspace: CloudV2Workspace): Promise<string | null> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const head = await Promise.race([this.deps.remoteHead!(workspace),
        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), BASE_COMMIT_MS); timer.unref(); })]);
      return head && /^[0-9a-f]{40}$/.test(head) ? head : null;
    } catch { return null; } finally { clearTimeout(timer); }
  }

  private async deliverToken(workspace: CloudV2Workspace, sandboxId: string): Promise<void> {
    await this.deps.authorizeSource?.(workspace);
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

  private async measure<T>(workspace: CloudV2Workspace, phase: LifecyclePhase, run: () => Promise<T>, detail?: (value: T) => TimingDetail): Promise<T> {
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

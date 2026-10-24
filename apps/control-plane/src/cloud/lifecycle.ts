// Drives cloud v2 workspaces through their transitional states on Boat, and
// stops idle ones. Every step is idempotent, so a crash or a lost reply only
// repeats it: creation uses the workspace id as Boat's idempotency key, and
// the worker credential is delivered by command after boot, never in the
// sandbox definition, so it can be rotated on any retry.
import { randomBytes, randomUUID } from "node:crypto";
import { CLOUD_V2_LEASE_SECONDS, type CloudV2Compute, type CloudV2CommandResult } from "./boat.js";
import { BoatSnapshotExpiredError } from "./boat-client.js";
import { CloudProviderError } from "./provider-error.js";
import { installRuntimeCommand, type CloudV2Runtime } from "./runtime.js";
import type { CloudV2Store, CloudV2Workspace, CloudV2LifecycleWorkspace } from "./store.js";
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
};
export function emitCloudV2Timing(observer: ((record: CloudV2TimingRecord) => void) | undefined, record: CloudV2TimingRecord): void {
  try { observer?.(record); } catch { /* Optional diagnostics cannot change lifecycle authority. */ }
}

export type CloudV2LifecycleDeps = {
  store: Pick<CloudV2Store, "claimPending" | "defer" | "transition" | "rotateWorkerToken" | "computerSnapshot" | "revoke" | "idleSince" | "setWorkerRoute" | "leasesDue" | "markLeaseRenewed"
    | "setBaseCommit" | "saveCheckpoint" | "checkpointFailed" | "checkpointUpload" | "checkpointUploadDone" | "checkpointUploadHorizon" | "stopCurrent"
    | "beginRestore" | "replaceSandbox" | "finishRestore">;
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

const checkpointError = (code: CloudV2CheckpointError) => Object.assign(new Error("checkpoint failed"), { code });

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
      await this.building;
      await this.cleaning;
    };
  }

  private building: Promise<void> | null = null;
  private cleaning: Promise<void> | null = null;
  private lastPromptPrune = 0;
  private renewing: Promise<void> | null = null;
  private lastLeaseScan = -Infinity;

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
    const slots = CONCURRENCY - this.inFlight.size;
    if (slots <= 0) return;
    // Creates, wakes and deletions first; stops then take at most their own slots.
    this.admitClaimed(await this.deps.store.claimPending(slots, LEASE_MS, [...this.inFlight.keys()], ["creating", "starting", "deleting"]), now);
    const stopSlots = Math.min(CONCURRENCY - this.inFlight.size, STOPPING_SLOTS - this.stopping.size);
    if (stopSlots > 0) this.admitClaimed(await this.deps.store.claimPending(stopSlots, LEASE_MS, [...this.inFlight.keys()], ["stopping"]), now);
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
    const checkpoints = this.deps.checkpoints;
    if (!checkpoints) return;
    // A retried stop already saved this one.
    if (workspace.checkpoint?.stopGeneration === workspace.stopGeneration) return;
    const object = cloudV2CheckpointObject(workspace.id, randomUUID()), key = randomBytes(32);
    const uploadUntil = new Date((this.deps.now?.() ?? Date.now()) + UPLOAD_HORIZON_MS);
    // Whether this upload is known to be over, whatever its outcome.
    let settled = false;
    try {
      await this.deps.store.defer(workspace.id, "stopping", CHECKPOINT_LEASE_MS, { failure: true, stopGeneration: workspace.stopGeneration });
      // Recorded before the URL exists. A stop that no longer owns the VM, for
      // instance once deletion began, issues no upload at all.
      if (!await this.deps.store.checkpointUpload(workspace.id, sandboxId, workspace.stopGeneration, object, uploadUntil)) return;
      const command = checkpointCommand({ checkoutPath: `${CLOUD_V2_HOME}/${workspace.repository}`, home: CLOUD_V2_HOME,
        baseBranch: workspace.baseBranch, key, uploadUrl: await checkpoints.storage.uploadUrl(workspace.id, object) });
      const result = await this.measure(workspace, "checkpoint", () => this.deps.compute.exec(sandboxId, command, CLOUD_V2_CHECKPOINT_SECONDS));
      const saved = parseCheckpointResult(result.stdout);
      // A failure before the upload step never started one. A failed upload,
      // a timeout or a lost reply may still land, so its intent stays.
      if (!saved.ok) { settled = !result.timedOut && saved.step !== "upload" && saved.step !== "unknown"; throw checkpointError(saved.code); }
      if (result.exitCode !== 0 || result.timedOut) throw checkpointError("checkpoint_failed");
      // curl reported the upload complete, so nothing is in flight.
      settled = true;
      if (await checkpoints.storage.size(workspace.id, object) !== saved.bytes) throw checkpointError("checkpoint_upload_failed");
      // Only this stop records it: a late save from an earlier stop is refused.
      const recorded = await this.deps.store.saveCheckpoint(workspace.id, sandboxId, workspace.stopGeneration,
        { object, key: checkpoints.seal(key, workspace.id, object), sha256: saved.sha256, bytes: saved.bytes });
      // Only the checkpoint this one replaced is retired, never anything newer;
      // anything a crashed upload left goes with the workspace.
      if (recorded && recorded.replaced) await checkpoints.storage.delete(workspace.id, recorded.replaced)
        .catch(error => this.deps.logger?.warn(`[cloud-v2] checkpoint retire failed (${errorCode(error)})`));
      if (!recorded) await checkpoints.storage.delete(workspace.id, object).catch(() => {});
    } catch (error) {
      const code = (CLOUD_V2_CHECKPOINT_ERRORS as readonly string[]).includes(errorCode(error)) ? errorCode(error) : "checkpoint_failed";
      this.deps.logger?.warn(`[cloud-v2] checkpoint failed (${code})`);
      await this.deps.store.checkpointFailed(workspace.id, sandboxId, workspace.stopGeneration, code).catch(() => {});
      await checkpoints.storage.delete(workspace.id, object).catch(() => {});
    } finally {
      key.fill(0);
      if (settled) await this.deps.store.checkpointUploadDone(workspace.id, object).catch(() => {});
    }
  }

  /** Applies the last checkpoint before the worker starts. Idempotent, so a
   * failed attempt is simply retried. */
  private async applyCheckpoint(workspace: CloudV2LifecycleWorkspace, sandboxId: string): Promise<void> {
    const checkpoints = this.deps.checkpoints, checkpoint = workspace.checkpoint;
    if (!checkpoints || !checkpoint) throw checkpointError("checkpoint_restore_failed");
    const github = await this.deps.githubToken?.(workspace).catch(() => null) ?? null;
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

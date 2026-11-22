// Drives cloud v2 workspaces through their transitional states on Boat, and
// stops idle ones. Every step is idempotent, so a crash or a lost reply only
// repeats it: creation uses the workspace id as Boat's idempotency key, and
// the worker credential is delivered by command after boot, never in the
// sandbox definition, so it can be rotated on any retry.
import { workspaceCheckoutPath } from "./workspace-layout.js";
import { randomBytes, randomUUID } from "node:crypto";
import { CLOUD_V2_LEASE_SECONDS, type CloudV2Compute, type CloudV2CommandResult } from "./boat.js";
import { BoatBootPendingError, BoatCreateRejectedError, BoatForkRefusedError, BoatSnapshotExpiredError } from "./boat-client.js";
import { CloudProviderError } from "./provider-error.js";
import { installRuntimeCommand, prepareRuntimeCommand, type CloudV2Runtime } from "./runtime.js";
import { GIT_LFS_INSTALL_COMMAND } from "./computer.js";
import { pruneCloudRepositories } from "./source-authority.js";
import type { PendingSourceOutcome } from "./pending-create.js";
import type { CloudV2ReadyCopyForks } from "./ready-copies.js";
import type { CloudV2CheckpointFork, CloudV2CheckpointReuse, CloudV2CheckpointRetry, CloudV2CheckpointScope, CloudV2Store, CloudV2Workspace,
  CloudV2LifecycleWorkspace, CloudV2RestoreCreate } from "./store.js";
import { CLOUD_V2_WORKER_PORT, type CloudV2WorkerTiming, type CloudV2WorkerBootTiming } from "./contract.js";
import { CLOUD_V2_BACKUP_PROBE_SECONDS, CLOUD_V2_CHECKPOINT_ERRORS, CLOUD_V2_CHECKPOINT_SECONDS, WORKER_OFF_COMMAND, WORKER_UNIT_CHECK, backupProbeCommand, checkpointCommand,
  cloudV2CheckpointObject, parseBackupProbe, parseCheckpointResult, parseRestoreResult, restoreCommand, workerUnitOff, type BackupProbe,
  type CloudV2CheckpointError, type CloudV2CheckpointStorage } from "./checkpoint.js";

const CONCURRENCY = 4;
/** A stop can spend minutes saving its checkpoint; creates and wakes, which
 * someone is waiting for, always keep the remaining slots. */
const STOPPING_SLOTS = 2;
const LEASE_MS = 2 * 60_000;
/** Configured hello publishes readiness; a poll only re-delivers the credential
 * while no worker boot has bound it. */
const HELLO_POLL_MS = 30_000;
/** Set by a refused worker hello while starting; the next step installs the pin. */
export const CLOUD_V2_RUNTIME_REFUSED = "worker_runtime_mismatch";
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
const STAGE_ATTEMPTS = 3, STAGE_RETRY_MS = 20_000;
const MAINTENANCE_SCAN_MS = 60_000;
/** An idle control plane sweeps this often; lifecycle notifications and due
 * deferrals wake it sooner. */
const IDLE_SWEEP_MS = 60_000;
export const CLOUD_V2_LIFECYCLE_CHANNEL = "zeros_cloud_v2_lifecycle";
/** Each sweep starts Computer build and maintenance checks in the background;
 * one that settles this quickly found nothing long-running to do. */
const BACKGROUND_SETTLE_MS = 1_000;
export const CLOUD_V2_IDLE_STOP_MS = 20 * 60_000;
/** A failed stop checkpoint is retried on a fork of the stopped VM: first
 * after whatever failed has had time to pass, then less often. */
const RETRY_FIRST_MS = 10 * 60_000;
const RETRY_BACKOFF_MS = [10, 30, 60, 120, 240, 480, 960, 1440].map(minutes => minutes * 60_000);
/** Boat deletes a stopped VM's disk after 14 days; retries end two days before. */
export const CLOUD_V2_CHECKPOINT_RETRY_WINDOW_MS = 12 * 24 * 60 * 60_000;
/** Retention: a stop uploads nothing; its backup is taken about an hour later, on a fork of the stopped VM. */
export const CLOUD_V2_BACKUP_DELAY_MS = 60 * 60_000;
/** Retention: backup forks begun per hour, across the deployment. Boat counts forks as creation
 * requests (its 12-a-minute and 200-a-day limits); creates and wakes keep the rest. */
export const CLOUD_V2_BACKUP_FORKS_PER_HOUR = 20;
/** Retention S2: the shared budget of maintenance machine starts (wakes and backup forks). Boat counts
 * creates, forks and resumes against 12 a minute and 200 a day (Alpha), so creates and user wakes keep
 * at least 80 of the day's 200. */
export const CLOUD_V2_MAINTENANCE_PER_HOUR = 20;
export const CLOUD_V2_MAINTENANCE_PER_DAY = 120;
/** A maintenance wake's own lease: if our stop fails, Boat archives the machine after this. */
export const CLOUD_V2_MAINTENANCE_LEASE_SECONDS = 300;
/** A maintenance mark older than this belongs to a step that died; a user wake or the next claim takes over. */
export const CLOUD_V2_MAINTENANCE_STALE_MS = 10 * 60_000;
/** A user wake that finds a maintenance stop under way waits this long between checks. */
const MAINTENANCE_WAIT_MS = 5_000;
/** A start that took a wake over waits this long between looks: the wake lets go within its call in flight. */
const MAINTENANCE_ADOPT_WAIT_MS = 1_000;
/** A takeover whose wake never let go (its step died) expires after this. Every call a wake makes is
 * bounded well under it (an exec by its 15–30 s timeout), so a live wake has always let go by then. */
export const CLOUD_V2_MAINTENANCE_ADOPT_STALE_MS = 2 * 60_000;

/** Thrown inside a maintenance wake the moment a person's start has taken it over. */
class MaintenanceReleased extends Error {}
/** Retention: before rebuilding a workspace whose unbacked work only its machine held, the
 * machine must read as gone twice this far apart, after the resume that failed. */
export const CLOUD_V2_LOSS_CONFIRM_MS = 30_000;
/** Deferred unconfirmed losses alert from this attempt on. */
export const CLOUD_V2_LOSS_UNCONFIRMED_ALERT = 3;
/** Holds a retry's claim while its fork boots and runs the checkpoint. */
const RETRY_LEASE_MS = (CLOUD_V2_CHECKPOINT_SECONDS + 600) * 1000;
/** A backstop only: every fork is deleted as soon as its attempt ends. */
const FORK_TTL_SECONDS = 60 * 60;
/** A new VM can take longer than a resumed one to accept commands. */
const FORK_READY_ATTEMPTS = 36;
/** Boat archives a stopped VM for a few seconds; a fork waits for that. */
const ARCHIVING_RECHECK_MS = 60_000;
/** A stop waits this long for Boat to finish archiving before trying again. */
const ARCHIVE_CONFIRM_READS = 12, ARCHIVE_CONFIRM_MS = 5_000;
/** Boat's stock image home; repositories live at <home>/<owner>/<name>. */
export const CLOUD_V2_HOME = "/home/user";
/** Boat's stock image runs commands as its one user, `user`. The worker and
 * agents run as that user too, so its credential lives in its config dir. */
export const CLOUD_V2_WORKER_TOKEN_PATH = "/home/user/.config/zeros/worker-token";
/** Non-secret boot settings for the worker's systemd unit (EnvironmentFile). */
export const CLOUD_V2_WORKER_ENV_PATH = "/home/user/.config/zeros/worker.env";

type LifecyclePhase = "boat_create" | "boat_resume" | "source_resolve" | "source_authorize" | "runtime_install" | "image_prepare" | "repository_prepare" | "protected_route" | "token_delivery" | "checkpoint" | "checkpoint_restore" | "maintenance_wake" | "maintenance_backlog" | "total";
export type CloudV2TimingRecord = {
  workspaceId: string;
  state?: CloudV2Workspace["state"];
  runtimeChanged?: boolean;
  /** runtime_install: the VM kept the release's previous runtime and stages the pin afterwards. */
  runtimeKept?: boolean;
  /** Whether a checkpoint command uploaded a new object or kept the last one; for
   * checkpoint_restore, "earlier" when the latest stop had no backup of its own yet
   * and an earlier backup or checkpoint was restored, "none" when there was nothing to restore. */
  checkpoint?: "saved" | "unchanged" | "earlier" | "none";
  /** relay_ready: the worker socket dial, and the time from it to readiness.
   * worker_hello: configMs is the control plane's configuration inside hello. */
  dialMs?: number; configMs?: number;
  readyWaitMs?: number; routeReads?: number; gatewayFailures?: number; gatewayWaitMs?: number;
  /** relay_ready: route reads until the worker was ready, including the successful one. */
  attempts?: number;
  /** maintenance_backlog: sleeping workspaces due a wake, past due by 2 days, found expired by Boat,
   * and those the budget cannot reach before Boat's expected deletion. */
  due?: number; overdue?: number; expired?: number; unreachable?: number;
  /** maintenance_wake: how it ended. */
  outcome?: "stopped" | "adopted" | "gone" | "failed";
} & ({
  phase: LifecyclePhase | CloudV2WorkerTiming["phase"] | "worker_hello" | "relay_ready";
  durationMs: number;
} | CloudV2WorkerBootTiming);
type TimingDetail = Pick<CloudV2TimingRecord, "runtimeChanged" | "runtimeKept" | "checkpoint">;
export function emitCloudV2Timing(observer: ((record: CloudV2TimingRecord) => void) | undefined, record: CloudV2TimingRecord): void {
  try { observer?.(record); } catch { /* Optional diagnostics cannot change lifecycle authority. */ }
}

export type CloudV2LifecycleDeps = {
  /** Database-only scan, once a minute, for running workspaces whose messages do not move (cloud/provider-stop.ts). */
  providerStop?: { scan(): Promise<void> };
  store: Pick<CloudV2Store, "claimPending" | "nextLifecycleDue" | "defer" | "transition" | "rotateWorkerToken" | "workspaceImage" | "revoke" | "idleSince" | "setWorkerRoute" | "leasesDue" | "markLeaseRenewed" | "recordInitialSandbox"
    | "setBaseCommit" | "saveCheckpoint" | "checkpointFailed" | "checkpointUpload" | "checkpointUploadDone" | "checkpointUploadHorizon" | "stopCurrent"
    | "beginRestore" | "replaceSandbox" | "finishRestore" | "checkpointUnchanged" | "claimCheckpointRetry" | "beginCheckpointFork"
    | "checkpointForkCreated" | "checkpointForkGone" | "checkpointRetryNext"
    // Retention (`retention`); absent from older compositions, which never enable it.
    | "recordStopProbe" | "restoreForkRefused" | "replaceLostSandbox" | "workspaceBranches" | "recordLostWork"
    | "claimMaintenanceWake" | "beginMaintenanceStop" | "adoptMaintenance" | "maintenanceHeld" | "finishMaintenance" | "clearStaleMaintenance" | "maintenanceBacklog" | "keepLostMachine">;
  /** Optional for older compositions; the shipped store always provides it. */
  prompts?: CloudV2Store["prompts"];
  pruneEnvironments?: () => Promise<void>;
  stopIdle?: (id: string, before: Date) => Promise<void>;
  compute: CloudV2Compute;
  /** The channel runtime; an admitted canary resolves its own pin. */
  runtime: CloudV2Runtime;
  /** The pin the channel's current release replaced. A wake may start it from
   * disk instead of installing the channel pin inside the wake. */
  previousRuntimeSha256?: string;
  runtimeForWorkspace?(workspace: CloudV2Workspace): Promise<CloudV2Runtime>;
  publicKeys: readonly string[];
  sealPortToken(token: string, workspaceId: string): unknown;
  stopWorker(workspace: CloudV2Workspace): Promise<boolean>;
  /** Non-secret boot settings, e.g. the relay URL and workspace id. */
  bootEnv(workspace: CloudV2Workspace, runtime?: CloudV2Runtime): Record<string, string> | Promise<Record<string, string>>;
  sandboxName(workspace: CloudV2Workspace): string;
  /** Checkpoints in object storage. Without them a stopped workspace has only
   * Boat's disk, which Boat deletes after 14 days. */
  checkpoints?: {
    storage: CloudV2CheckpointStorage;
    seal(key: Buffer, workspaceId: string, object: string): unknown;
    open(sealed: unknown, workspaceId: string, object: string): Buffer;
  };
  /** The base branch's GitHub head, recorded at creation; null when unknown. */
  remoteHead?(workspace: CloudV2LifecycleWorkspace): Promise<string | null>;
  /** A repository token, for a restore that must fetch or clone from GitHub. */
  /** `repository`: one of a workspace of several's repositories; the first without one. */
  githubToken?(workspace: CloudV2LifecycleWorkspace, repository?: string): Promise<{ token: string }>;
  authorizeWorkspace?(workspace: CloudV2LifecycleWorkspace): Promise<void>;
  assertExecution?(workspace: CloudV2LifecycleWorkspace): Promise<void>;
  claimExecutionRestore?(workspace: CloudV2LifecycleWorkspace, sandboxId: string): Promise<boolean>;
  /** A pending create's GitHub checks and its one-time source scope. */
  resolvePendingSource?(workspace: CloudV2Workspace): Promise<PendingSourceOutcome>;
  prepareRepository?(workspace: CloudV2LifecycleWorkspace, sandboxId: string): Promise<void>;
  /** A workspace of several repositories: every one after the first, for its checkpoint and restore. */
  repositories?(workspace: CloudV2LifecycleWorkspace): Promise<{ repository: string; checkoutFolder: string; baseBranch: string }[]>;
  /** Cloud Computer builds share this loop; one runs at a time. */
  builds?: { tick(): Promise<void>; cleanup?(): Promise<void>; close?(): void };
  /** Ready copies (CloudV2Config.readyCopies): creates fork a repository's
   * stopped, set-up machine; their builds run beside Cloud Computer builds. */
  readyCopies?: Pick<CloudV2ReadyCopyForks<CloudV2LifecycleWorkspace>, "prepare" | "fetchBase">;
  readyCopyBuilds?: { tick(): Promise<void>; close?(): void };
  runtimeUpdates?: { tick(): Promise<void>; close(): void };
  recovery?: { start(): () => Promise<void> };
  executionActivations?: { tick(): Promise<void> };
  /** Retries a stop's failed checkpoint on a fork of the stopped VM. */
  checkpointRetry?: boolean;
  /** CLOUD_V2_RETENTION_ENABLED, with checkpoints configured: a stop probes instead of
   * uploading, and a smaller backup is taken later on a fork. Off, nothing here changes. */
  retention?: boolean;
  /** Retention's cap on backup forks per hour; CLOUD_V2_BACKUP_FORKS_PER_HOUR by default. */
  backupForksPerHour?: number;
  /** Retention S2's shared maintenance budget; CLOUD_V2_MAINTENANCE_PER_HOUR / _PER_DAY by default. */
  maintenancePerHour?: number;
  maintenancePerDay?: number;
  /** Retention: the stopped machine of the workspace's project's ready copy a restore may fork,
   * when it is laid out as this workspace is; null to create from the Cloud Computer. */
  restoreSource?(workspace: CloudV2LifecycleWorkspace): Promise<string | null>;
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

/** The checkpoint script's own step names; anything else the VM prints is not logged. */
const CHECKPOINT_STEPS: ReadonlySet<string> = new Set(["attachments", "bundle", "decrypt", "download", "encrypt", "environment", "files", "fingerprint", "gitdir", "ignored", "marker", "node", "objects", "pack", "refs", "remotes", "repository", "sessions", "start", "stash", "turns", "upload", "upstream", "worktree"]);
const checkpointError = (code: CloudV2CheckpointError) => Object.assign(new Error("checkpoint failed"), { code });
const checkpointCode = (error: unknown): CloudV2CheckpointError =>
  (CLOUD_V2_CHECKPOINT_ERRORS as readonly string[]).includes(errorCode(error)) ? errorCode(error) as CloudV2CheckpointError : "checkpoint_failed";
/** Boat refused before creating anything: its source is gone, the request was
 * invalid or not permitted, or Boat certified the refusal. */
const neverCreated = (error: unknown) => sandboxLost(error) || error instanceof BoatCreateRejectedError || error instanceof BoatForkRefusedError ||
  (error instanceof CloudProviderError && [400, 401, 402, 403, 422].includes(error.httpStatus ?? 0));
/** One key per attempt: a replay returns that attempt's fork, never a second one. */
const forkKey = (workspaceId: string, attempt: string) => `checkpoint:${workspaceId}:${attempt}`;
const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

/** The workspace branch from GitHub's, read with the authorization header on stdin.
 * Exit 2 from ls-remote is GitHub's "no such branch": the worker creates it from the base. */
export function restoreBranchCommand(checkoutPath: string, branch: string): string {
  const q = shellQuote, ref = `refs/heads/${branch}`;
  return `bash -c ${q([
    "set -eu", "IFS= read -r ZEROS_GITHUB_AUTH_HEADER", "export ZEROS_GITHUB_AUTH_HEADER GIT_TERMINAL_PROMPT=0",
    `cd -- ${q(checkoutPath)}`,
    `if git show-ref --verify --quiet ${q(ref)}; then exit 0; fi`,
    `status=0; git --config-env=http.extraHeader=ZEROS_GITHUB_AUTH_HEADER ls-remote --exit-code origin ${q(ref)} >/dev/null 2>&1 || status=$?`,
    "if [ \"$status\" -eq 2 ]; then exit 0; fi",
    "[ \"$status\" -eq 0 ]",
    `git --config-env=http.extraHeader=ZEROS_GITHUB_AUTH_HEADER fetch --quiet origin ${q(`+${ref}:refs/remotes/origin/${branch}`)}`,
    `git branch --no-track -- ${q(branch)} ${q(`refs/remotes/origin/${branch}`)}`,
  ].join("\n"))}`;
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[a-z0-9_]{1,64}$/.test(code) ? code : "provider_request_failed";
}

/** `/home/user/<owner>/<name>`, with no `.` or `..` segment. */
const CHECKOUT_PATH = /^\/home\/user(?:\/(?!\.\.?(?:\/|$))[A-Za-z0-9._-]{1,100}){2}$/;
const READ_ONLY_GIT = "GIT_OPTIONAL_LOCKS=0 timeout 60 git -c core.fsmonitor=false -c core.hooksPath=/dev/null";
/** A create's VM restores its disk lazily from the Cloud Computer snapshot, and
 * the restore gives every file a new inode. On fresh VMs with Withso/zeros,
 * the first pack read took ~3 s and `git switch` 3.3–3.7 s cold, versus 0.55 s
 * once the trees and every file's stat were read. Started detached when the VM
 * is ready, as the VM user, so it overlaps the rest of the create and the
 * worker's boot. Read-only: no index lock, submodule, fsmonitor or hook, so it
 * cannot collide with the worker's own checkout. Null for an unusual path. */
export function checkoutWarmupCommand(checkoutPath: string): string | null {
  if (!CHECKOUT_PATH.test(checkoutPath)) return null;
  return `cd -- '${checkoutPath}' && { setsid nohup sh -c '${CHECKOUT_WARMUP_SCRIPT}' >/dev/null 2>&1 </dev/null & } ; echo started`;
}
/** Run in the checkout. Compared by mtime and size alone, restored files stay
 * clean, so `diff-files --quiet` visits every file instead of the first; on
 * Zeros Dev only this variant brought the switch down to ~0.6 s. A racily
 * clean entry gets a content comparison, which for LFS starts git-lfs's clean
 * filter. That writes nothing persistent (checkout-warmup.test.ts). */
export const CHECKOUT_WARMUP_SCRIPT = `${READ_ONLY_GIT} ls-tree -r -z HEAD >/dev/null 2>&1 & ` +
  `${READ_ONLY_GIT} -c core.checkStat=minimal -c core.trustctime=false diff-files --quiet --ignore-submodules >/dev/null 2>&1; wait`;

/** Writes the worker credential and its boot settings owner-only, re-enables
 * the unit a stop disabled so a reboot keeps it, then restarts the worker.
 * Values are single-quoted base64 literals the shell never expands. Boat's
 * sandbox environment does not reach systemd, so the boot settings travel with
 * the credential. */
export function deliverWorkerTokenCommand(token: string, bootEnv: Readonly<Record<string, string>> = {}): string {
  if (!/^zw2w_[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Invalid worker token");
  for (const [name, value] of Object.entries(bootEnv))
    if (!["CLOUD_V2_API_URL", "CLOUD_V2_RUNTIME_SHA256", "ZEROS_WORKSPACE_ID"].includes(name) || !/^[\x21-\x7e]{1,2048}$/.test(value)) throw new Error("Invalid worker boot setting");
  const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64");
  const dir = CLOUD_V2_WORKER_TOKEN_PATH.slice(0, CLOUD_V2_WORKER_TOKEN_PATH.lastIndexOf("/"));
  const envFile = Object.entries(bootEnv).map(([name, value]) => `${name}=${value}\n`).join("");
  return `(exec 9</opt/zeros/runtime/.install.lock && flock -x 9 && umask 077 && mkdir -p ${dir} && chmod 700 ${dir} && ` +
    `sudo -n rm -f /opt/zeros/worker-runtime.env && ` +
    `printf %s '${b64(envFile)}' | base64 -d > ${CLOUD_V2_WORKER_ENV_PATH}.tmp && mv -f ${CLOUD_V2_WORKER_ENV_PATH}.tmp ${CLOUD_V2_WORKER_ENV_PATH} && ` +
    `printf %s '${b64(token)}' | base64 -d > ${CLOUD_V2_WORKER_TOKEN_PATH}.tmp && mv -f ${CLOUD_V2_WORKER_TOKEN_PATH}.tmp ${CLOUD_V2_WORKER_TOKEN_PATH} && ` +
    `(systemctl is-enabled --quiet zeros-worker.service || sudo -n systemctl enable zeros-worker.service >/dev/null 2>&1 || true) && ` +
    `(sudo -n systemctl restart zeros-worker.service || true))`;
}

export class CloudV2Lifecycle {
  private timer: NodeJS.Timeout | null = null;
  /** Only admission is serialized; provider calls run in separate slots. */
  private running: Promise<void> | null = null;
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly stopping = new Set<string>();
  /** A restore begun in this step, until the same step applies its checkpoint. */
  private readonly recordedRestores = new Map<string, CloudV2RestoreCreate>();

  constructor(private readonly deps: CloudV2LifecycleDeps, private readonly intervalMs = 2_000) {}

  start(): () => Promise<void> {
    this.started = true; this.stopped = false;
    const stopRecovery = this.deps.recovery?.start();
    this.schedule(this.intervalMs);
    return async () => {
      this.stopped = true;
      const recoveryStopped = stopRecovery?.();
      this.deps.runtimeUpdates?.close();
      this.deps.builds?.close?.();
      this.deps.readyCopyBuilds?.close?.();
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      await this.running;
      await Promise.all(this.inFlight.values());
      await this.renewing;
      await this.retrying;
      await this.maintaining;
      await this.building;
      await this.copying;
      await this.cleaning;
      await recoveryStopped;
    };
  }

  private get retention(): boolean { return this.deps.retention === true && !!this.deps.checkpoints; }

  private started = false;
  private stopped = false;
  private sweeping = false;
  private woken = false;

  /** A lifecycle row changed: sweep now rather than at the next deadline. */
  wake(): void {
    if (!this.started || this.stopped) return;
    if (this.sweeping) this.woken = true;
    else this.schedule(0);
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.sweep(); }, ms);
    this.timer.unref();
  }

  private async sweep(): Promise<void> {
    this.sweeping = true;
    let next = this.intervalMs;
    try {
      const running = new Set([this.building, this.copying, this.cleaning, this.retrying, this.renewing, this.maintaining]);
      await this.poll();
      next = await this.nextSweep(running);
    } catch (error) {
      this.deps.logger?.warn(`[cloud-v2] lifecycle poll failed (${errorCode(error)})`);
    } finally { this.sweeping = false; }
    if (this.woken) { this.woken = false; next = 0; }
    this.schedule(next);
  }

  /** Work in progress keeps the fast cadence; otherwise the next due deferral,
   * bounded by the idle sweep, decides. */
  private async nextSweep(running: ReadonlySet<Promise<void> | null>): Promise<number> {
    const background = [this.building, this.copying, this.cleaning, this.retrying, this.renewing, this.maintaining].filter(task => task !== null && !running.has(task));
    if (background.length) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([Promise.allSettled(background), new Promise(resolve => { timer = setTimeout(resolve, BACKGROUND_SETTLE_MS); })]);
      clearTimeout(timer);
    }
    if (this.inFlight.size || this.building || this.copying || this.cleaning || this.retrying || this.renewing || this.maintaining) return this.intervalMs;
    const due = await this.deps.store.nextLifecycleDue();
    return due === null ? IDLE_SWEEP_MS : Math.min(IDLE_SWEEP_MS, Math.max(this.intervalMs, due));
  }

  private building: Promise<void> | null = null;
  private copying: Promise<void> | null = null;
  private cleaning: Promise<void> | null = null;
  private lastPromptPrune = 0;
  private renewing: Promise<void> | null = null;
  private lastLeaseScan = -Infinity;
  private retrying: Promise<void> | null = null;
  private maintaining: Promise<void> | null = null;
  private nextMaintenanceScan = -Infinity;
  private nextBacklogReport = -Infinity;
  private nextRetryScan = -Infinity;
  private lastProviderStopScan = -Infinity;
  private providerStopScan: Promise<void> | null = null;

  async tick(): Promise<void> {
    await this.poll();
    await Promise.all(this.inFlight.values());
    await this.retrying;
    await this.maintaining;
  }

  private poll(): Promise<void> {
    return this.running ??= this.admit().finally(() => { this.running = null; });
  }

  private async admit(): Promise<void> {
    const now = this.deps.now?.() ?? Date.now();
    await this.deps.executionActivations?.tick();
    await this.deps.runtimeUpdates?.tick();
    await this.deps.prompts?.wakePending();
    if (now - this.lastPromptPrune > 10 * 60_000) {
      await this.deps.prompts?.prune();
      await this.deps.pruneEnvironments?.();
      this.lastPromptPrune = now;
    }
    if (this.building && this.deps.builds?.cleanup && !this.cleaning)
      this.cleaning = this.deps.builds.cleanup().catch(() => {}).finally(() => { this.cleaning = null; });
    // A build can take many minutes; it never blocks workspace lifecycle steps.
    if (this.deps.builds && !this.building)
      this.building = this.deps.builds.tick().catch(() => {}).finally(() => { this.building = null; });
    // A ready copy clones and sets up a whole repository; it never waits for, or holds up, a Cloud Computer build.
    if (this.deps.readyCopyBuilds && !this.copying)
      this.copying = this.deps.readyCopyBuilds.tick().catch(() => {}).finally(() => { this.copying = null; });
    // Idle stop skips a workspace with pending messages; this finds the ones whose VM Boat stopped underneath them.
    if (this.deps.providerStop && !this.providerStopScan && now - this.lastProviderStopScan >= 60_000) {
      this.lastProviderStopScan = now;
      this.providerStopScan = this.deps.providerStop.scan().catch(() => {}).finally(() => { this.providerStopScan = null; });
    }
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
    let retryStarted: Promise<void> | null = null;
    if ((this.deps.checkpointRetry || this.retention) && this.deps.checkpoints && !this.retrying && !this.maintaining && now >= this.nextRetryScan && this.inFlight.size < CONCURRENCY) {
      this.nextRetryScan = now + MAINTENANCE_SCAN_MS;
      this.retrying = this.retryCheckpoint()
        // Another one may be due at once; otherwise wait for the next scan.
        .then(claimed => { if (claimed) this.nextRetryScan = -Infinity; })
        .catch(error => this.deps.logger?.warn(`[cloud-v2] checkpoint retry step failed (${errorCode(error)})`))
        .finally(() => { this.retrying = null; });
      retryStarted = this.retrying;
    }
    // Retention S2: one maintenance wake at a time, only with two slots to spare, so creates and
    // user wakes always go first. A claimed wake looks for the next at once.
    // Never beside a backup retry: one would resume the machine the other is forking or inspecting. A
    // retry started in this same pass runs first and the wake follows it, so neither lane starves.
    if (this.retention && !this.maintaining && (!this.retrying || this.retrying === retryStarted) && now >= this.nextMaintenanceScan && this.inFlight.size <= CONCURRENCY - 2) {
      this.nextMaintenanceScan = now + MAINTENANCE_SCAN_MS;
      const after = retryStarted ?? Promise.resolve();
      this.maintaining = after.then(() => this.maintenanceWake())
        .then(claimed => { if (claimed) this.nextMaintenanceScan = -Infinity; })
        .then(() => this.reportBacklog(now))
        .catch(error => this.deps.logger?.warn(`[cloud-v2] maintenance wake step failed (${errorCode(error)})`))
        .finally(() => { this.maintaining = null; });
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
      // A late step cannot finalize a newer stop or a newly recorded VM.
      const fence = workspace.state === "stopping" ? { stopGeneration: workspace.stopGeneration }
        : workspace.state === "deleting" ? { expectedSandboxId: workspace.boatSandboxId } : {};
      // Retrying cannot wake or stop a VM that is gone; say so at once. With a
      // checkpoint the next attempt restores instead.
      if ((workspace.state === "starting" || workspace.state === "stopping") && workspace.boatSandboxId && sandboxLost(error) && !workspace.checkpoint
        && !(this.retention && workspace.executionIntent === undefined)) {
        await this.deps.store.transition(workspace.id, [workspace.state], "failed", { errorCode: "sandbox_missing", revoke: true, ...fence });
      } else if ((code === "cloud_source_checkout_failed" || code === "github_access_required") && (workspace.state === "creating" || workspace.state === "starting")) {
        await this.deps.store.transition(workspace.id, [workspace.state], "failed", { errorCode: code });
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
    if (workspace.state === "creating" && workspace.sourcePending) {
      // A create that returned before its GitHub checks: they run here, before
      // any VM exists. The database refuses a sandbox while it is pending.
      if (now - Date.parse(workspace.createdAt) > BOOT_DEADLINE_MS) {
        await store.transition(workspace.id, ["creating"], "failed", { errorCode: "worker_boot_timeout" });
        return;
      }
      const outcome = this.deps.resolvePendingSource
        ? await this.measure(workspace, "source_resolve", () => this.deps.resolvePendingSource!(workspace))
        : { errorCode: "cloud_source_pending_unsupported" };
      if ("skipped" in outcome) return;
      if ("errorCode" in outcome) {
        await store.transition(workspace.id, ["creating"], "failed", { errorCode: outcome.errorCode });
        return;
      }
      const { sourcePending: _resolved, ...rest } = workspace;
      workspace = { ...rest, baseCommit: workspace.baseCommit ?? outcome.baseCommit };
    }
    if ((workspace.state === "creating" || workspace.state === "starting") && this.deps.authorizeWorkspace)
      await this.measure(workspace, "source_authorize", () => this.deps.authorizeWorkspace!(workspace));
    switch (workspace.state) {
      case "creating": {
        if (now - Date.parse(workspace.createdAt) > BOOT_DEADLINE_MS) {
          await store.transition(workspace.id, ["creating"], "failed", { errorCode: "worker_boot_timeout" });
          return;
        }
        const boot = await this.boot(workspace);
        const baseCommit = workspace.baseCommit || !this.deps.remoteHead ? null : this.lookupBaseCommit(workspace);
        let sandboxId = workspace.boatSandboxId;
        let image = await store.workspaceImage(workspace.id);
        if (!image) {
          await store.transition(workspace.id, ["creating"], "failed", { errorCode: "cloud_computer_build_required" });
          return;
        }
        // A fork of the repository's ready copy already holds the base, the
        // checkout and its setup. Without one the create clones directly.
        const forked = this.deps.readyCopies ? await this.deps.readyCopies.prepare(workspace) : null;
        if (forked && "waitMs" in forked) { await store.defer(workspace.id, "creating", forked.waitMs); return; }
        if (forked) {
          image = { from: image.from, prune: [], checkout: true };
          if (!sandboxId) {
            const recorded = await store.recordInitialSandbox(workspace.id, workspace.stopGeneration, forked.sandboxId, new Date(this.deps.now?.() ?? Date.now()));
            if (!recorded || recorded.state !== "creating") {
              if (recorded?.state === "deleting") await this.runStep(recorded, now);
              return;
            }
            sandboxId = forked.sandboxId;
          }
        }
        if (!sandboxId) {
          const renewedAt = new Date(this.deps.now?.() ?? Date.now());
          ({ sandboxId } = await this.measure(workspace, "boat_create", () => compute.create({
            key: workspace.id, ...(image.from ? { from: image.from } : {}), name: this.deps.sandboxName(workspace), env: boot.env,
          })));
          const recorded = await store.recordInitialSandbox(workspace.id, workspace.stopGeneration, sandboxId, renewedAt);
          if (!recorded || recorded.state !== "creating") {
            if (recorded?.state === "deleting") await this.runStep(recorded, now);
            return;
          }
        }
        // Nothing listens on the route until the worker starts, and only token
        // delivery below starts it, after the image is prepared. Creating the
        // route while the VM boots overlaps the two.
        const routed = this.measure(workspace, "protected_route", () => this.host(workspace, sandboxId));
        routed.catch(() => {});
        await this.measure(workspace, "runtime_install", () => this.ensureRuntime(sandboxId, boot.runtime), installed => ({ runtimeChanged: installed.changed }));
        // Boat exec waited ~6 s for a 6 s child with trailing "&"; braces + echo returned in ~120 ms.
        // Still unawaited so a slow or failed launch cannot hold up worker startup.
        const warmup = image.checkout ? checkoutWarmupCommand(workspaceCheckoutPath(workspace)) : null;
        if (warmup) void this.deps.compute.exec(sandboxId, warmup, 30).catch(() => undefined);
        if (!forked && (image.prune.length || !image.from)) await this.measure(workspace, "image_prepare", () => this.prepareImage(sandboxId, image));
        if (forked) await this.measure(workspace, "repository_prepare", () => this.deps.readyCopies!.fetchBase(workspace, sandboxId));
        // An active create obtains the initiator's repository material through
        // its bootstrap lease, after the worker has proved boot cleanup.
        if (this.deps.prepareRepository && !image.checkout && !workspace.executionIntent) {
          await store.defer(workspace.id, "creating", 17 * 60_000);
          await this.measure(workspace, "repository_prepare", () => this.deps.prepareRepository!(workspace, sandboxId));
        }
        if (!await routed) return;
        // The worker reads it with its configuration, after the token arrives.
        const commit = await baseCommit;
        if (commit) await store.setBaseCommit(workspace.id, commit);
        await this.measure(workspace, "token_delivery", () => this.deliverToken(workspace, sandboxId, boot.env));
        await store.defer(workspace.id, "creating", HELLO_POLL_MS);
        return;
      }
      case "starting": {
        // A maintenance wake has the machine. While it is waking, take it over in one statement and
        // wait for it to let go (within its call in flight); once it has marked its stop, let that
        // finish (stopped, then resumed here). Never touch the machine before the mark is gone; a
        // mark whose step died is taken over.
        const mark = workspace.maintenance;
        if (mark) {
          const staleMs = mark.phase === "adopting" ? CLOUD_V2_MAINTENANCE_ADOPT_STALE_MS : CLOUD_V2_MAINTENANCE_STALE_MS;
          if (now - Date.parse(mark.startedAt) < staleMs) {
            // Lost to a stop mark set meanwhile, the next look finds 'stopping' and waits for that.
            if (mark.phase === "waking") await store.adoptMaintenance(workspace.id, mark.attempt);
            await store.defer(workspace.id, "starting", mark.phase === "stopping" ? MAINTENANCE_WAIT_MS : MAINTENANCE_ADOPT_WAIT_MS);
            return;
          }
          await store.clearStaleMaintenance(workspace.id, staleMs);
        }
        let sandboxId = workspace.boatSandboxId, restoring = workspace.restorePending;
        const deadline = restoring || (!sandboxId && workspace.checkpoint) ? RESTORE_DEADLINE_MS : BOOT_DEADLINE_MS;
        if (now - Date.parse(workspace.updatedAt) > deadline) {
          await store.transition(workspace.id, ["starting"], "failed",
            { errorCode: deadline === RESTORE_DEADLINE_MS ? "checkpoint_restore_failed" : "worker_boot_timeout" });
          return;
        }
        const boot = await this.boot(workspace);
        if (restoring && workspace.executionIntent && workspace.executionRestoreClaimed) {
          await this.deps.assertExecution?.(workspace);
          if (sandboxId) await compute.delete(sandboxId);
          await this.deps.assertExecution?.(workspace);
          sandboxId = await this.replacement(workspace, sandboxId, { bootEnv: boot.env });
          if (!sandboxId) return;
        } else if (!sandboxId && !restoring && this.cleanRestore(workspace)) {
          sandboxId = await this.cleanReplacement(workspace, null, boot.env);
          if (!sandboxId) return;
        } else if (!sandboxId) {
          if (!restoring && !workspace.checkpoint) {
            await store.transition(workspace.id, ["starting"], "failed", { errorCode: "sandbox_missing" });
            return;
          }
          sandboxId = await this.replacement(workspace, restoring ? undefined : null, { bootEnv: boot.env });
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
            if (!sandboxLost(error) || !(workspace.checkpoint || this.cleanRestore(workspace))) throw error;
            // One 404 is not proof: the machine may hold the only copy of the latest stop's work, with
            // no backup or only an earlier one.
            if (this.onlyOnMachine(workspace) && !await this.confirmedGone(sandboxId)) {
              // Deferred, never rebuilt; past a few attempts someone should look. The generic attempt
              // bound then fails the start visibly with this code, leaving the machine untouched.
              // The claim has already counted this attempt.
              if (workspace.attempts >= CLOUD_V2_LOSS_UNCONFIRMED_ALERT) (this.deps.logger?.error ?? this.deps.logger?.warn)?.call(this.deps.logger,
                `[cloud-v2] resume keeps failing but Boat still has the machine; not rebuilding workspace=${workspace.id.slice(0, 8)} attempts=${workspace.attempts}`);
              throw Object.assign(new Error("Boat has not confirmed the machine gone"), { code: "provider_loss_unconfirmed" });
            }
            if (this.cleanRestore(workspace)) {
              sandboxId = await this.cleanReplacement(workspace, sandboxId, boot.env);
              if (!sandboxId) return;
            } else {
              sandboxId = await this.replacement(workspace, sandboxId, { bootEnv: boot.env });
              if (!sandboxId) return;
              restoring = true;
            }
          }
        }
        // As on create, the route is inert until token delivery starts the worker.
        // A rare restore keeps it after the checkpoint is applied.
        const route = () => this.measure(workspace, "protected_route", () => this.host(workspace, sandboxId!));
        const routed = restoring ? undefined : route();
        routed?.catch(() => {});
        // A runtime shipped while the VM slept is installed now, unless the VM
        // already holds the release it replaced: that starts at once and the
        // pin is staged after the worker starts, for the next wake.
        const keep = restoring ? undefined : this.keepableRuntime(workspace, boot.runtime);
        const installed = await this.measure(workspace, "runtime_install", () => this.ensureRuntime(sandboxId, boot.runtime, keep),
          result => ({ runtimeChanged: result.changed, ...(result.kept ? { runtimeKept: true } : {}) }));
        const bootEnv = installed.kept && keep
          ? await this.deps.bootEnv(workspace, { sha256: keep, url: async (target = keep) => boot.runtime.url(target) }) : boot.env;
        if (restoring) {
          // Replayed as recorded: no lookup of a build that deletion may be retiring.
          const recorded = this.recordedRestores.get(workspace.id) ?? workspace.restoreCreate;
          this.recordedRestores.delete(workspace.id);
          const image = { from: recorded?.from ?? null, prune: recorded?.prune ?? [] };
          // A ready copy fork already holds every checkout, set up, with Git LFS.
          if (!recorded?.fork && (image.prune.length || !image.from)) await this.measure(workspace, "image_prepare", () => this.prepareImage(sandboxId, image));
          // Retention: in the hour before a stop's backup, a lost VM restores the last earlier one.
          const earlier = this.retention && workspace.checkpoint?.stopGeneration !== workspace.stopGeneration;
          await this.measure(workspace, "checkpoint_restore", () => this.applyCheckpoint(workspace, sandboxId!), () => earlier ? { checkpoint: "earlier" } : {});
          if (earlier) {
            this.deps.logger?.warn(`[cloud-v2] restored an earlier backup or checkpoint: the latest stop had none yet workspace=${workspace.id.slice(0, 8)}`);
            await store.recordLostWork(workspace.id, "earlier");
          }
          if (!await store.finishRestore(workspace.id, sandboxId)) return;
        }
        if (!await (routed ?? route())) return;
        const delivered = await this.measure(workspace, "token_delivery", () => this.deliverToken(workspace, sandboxId, bootEnv));
        if (installed.kept && delivered) this.stageRuntime(sandboxId, boot.runtime);
        await store.defer(workspace.id, "starting", HELLO_POLL_MS);
        return;
      }
      case "stopping": {
        let sandboxId = workspace.boatSandboxId, stoppedAt: Date | null = null;
        if (workspace.restorePending && !sandboxId) sandboxId = await this.replacement(workspace, undefined, { find: true });
        if (sandboxId) {
          await this.deps.stopWorker({ ...workspace, boatSandboxId: sandboxId });
          // A replacement without its checkpoint holds nothing of the user's yet.
          // Retention uploads nothing here: the probe switches the worker off and
          // records whether a backup is needed later.
          const saved = !workspace.restorePending && (this.retention ? await this.probeStop(workspace, sandboxId) : await this.checkpoint(workspace, sandboxId));
          // A stop that a later one has replaced leaves the VM to that one,
          // whose checkpoint may still be running on it.
          if (!await store.stopCurrent(workspace.id, workspace.stopGeneration)) return;
          try { await compute.stop(sandboxId); stoppedAt = await this.untilArchived(sandboxId); }
          catch (error) {
            // Nothing is left to stop; the next wake restores the checkpoint, or under retention rebuilds without one.
            if (!sandboxLost(error) || !(workspace.checkpoint || saved || (this.retention && workspace.executionIntent === undefined))) throw error;
          }
        }
        // Credentials go only with this stop's own completion. Retention keeps
        // Boat's stoppedAt, the time its 14-day deletion counts from.
        await store.transition(workspace.id, ["stopping"], "stopped", { stopGeneration: workspace.stopGeneration, revoke: true,
          ...(this.retention && stoppedAt ? { stoppedAt } : {}) });
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
        await store.transition(workspace.id, ["deleting"], "deleted", { expectedSandboxId: sandboxId });
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
  private async replacement(workspace: CloudV2LifecycleWorkspace, lost: string | null | undefined,
    options: { find?: boolean; bootEnv?: Record<string, string> } = {}): Promise<string | null> {
    const { store, compute } = this.deps;
    if (!workspace.checkpoint) return null;
    let attempt = workspace.restoreAttempt, request = workspace.restoreCreate;
    if (lost !== undefined) {
      const next = randomUUID();
      const fork = this.retention && this.deps.restoreSource ? await this.deps.restoreSource(workspace).catch(() => null) : null;
      const begun = await store.beginRestore(workspace.id, lost,
        { attempt: next, name: `${this.deps.sandboxName(workspace)}-r${next.slice(0, 8)}`, env: options.bootEnv ?? (await this.boot(workspace)).env,
          ...(fork ? { fork } : {}) });
      if (begun === "no_computer") {
        await store.transition(workspace.id, ["starting"], "failed", { errorCode: "cloud_computer_build_required" });
        return null;
      }
      if (!begun) return null;
      ({ attempt, create: request } = begun);
      // Boat may keep a record of the expired VM. One that may hold the latest stop's work, which the
      // earlier backup does not, is kept instead (its loss was already confirmed twice).
      if (lost && !this.onlyOnMachine(workspace)) await compute.delete(lost).catch(() => {});
      else if (lost) {
        await store.keepLostMachine(workspace.id, lost);
        (this.deps.logger?.error ?? this.deps.logger?.warn)?.call(this.deps.logger,
          `[cloud-v2] restored an earlier backup; the machine that may hold later work was kept workspace=${workspace.id.slice(0, 8)}`);
      }
    }
    if (!attempt || !request) return null;
    // This step's apply reads it; a later step reads the claimed row instead.
    this.recordedRestores.set(workspace.id, request);
    if (this.recordedRestores.size > 256) this.recordedRestores.delete(this.recordedRestores.keys().next().value!);
    const { requestedAt, ...body } = request;
    let sandboxId: string | null;
    if ((this.deps.now?.() ?? Date.now()) - Date.parse(requestedAt) < CREATE_KEY_MS) {
      const create = async () => {
        if (body.fork) {
          try { return await compute.fork(body.fork, { key: `restore-fork:${workspace.id}:${attempt}`, ttlSeconds: CLOUD_V2_LEASE_SECONDS }); }
          catch (error) {
            // Refused before making anything: this attempt creates from the Cloud Computer instead, for good.
            if (!neverCreated(error)) throw error;
            await store.restoreForkRefused(workspace.id, attempt!);
            this.deps.logger?.warn(`[cloud-v2] ready copy fork refused for a restore; creating from the Cloud Computer (${errorCode(error)})`);
          }
        }
        return compute.create({ key: `restore:${workspace.id}:${attempt}`, name: body.name, env: body.env, ...(body.from ? { from: body.from } : {}) });
      };
      ({ sandboxId } = workspace.state === "starting" ? await this.measure(workspace, "boat_create", create) : await create());
    } else if (body.fork) {
      // Many machines share a ready copy's fork name, so only the key can find this one, and it
      // has expired. A fork it made is stopped by its lease but stays (a lease is not a delete).
      (this.deps.logger?.error ?? this.deps.logger?.warn)?.call(this.deps.logger,
        `[cloud-v2] restore fork unrecoverable past its key window; any fork it made leaked workspace=${workspace.id.slice(0, 8)}`);
      return options.find || workspace.state !== "starting" ? null : this.replacement(workspace, null, options);
    } else {
      sandboxId = await compute.findSandbox(body.name, new Date(Date.parse(requestedAt) - 10 * 60_000));
      // Nothing was made under this attempt: a wake starts a new one; a stop
      // or deletion has nothing to clean.
      if (!sandboxId) return options.find || workspace.state !== "starting" ? null : this.replacement(workspace, null, options);
    }
    // A stop or deletion that won the race finds this VM in the row.
    const state = await store.replaceSandbox(workspace.id, attempt, sandboxId, new Date(this.deps.now?.() ?? Date.now()));
    return state && (options.find || state === "starting") ? sandboxId : null;
  }

  /** Retention S2's invisible wake: resumes a sleeping machine on a short lease so Boat's deletion of a
   * stopped disk never reaches it, switches the worker off (verified), and stops it again. It never
   * changes the workspace's state, tokens, updated_at or active_at, so no client sees it. A user who
   * opens the workspace meanwhile adopts the running machine; the stop is marked first in the same
   * statement that checks the workspace is still stopped, and a user wake waits for that mark.
   * Resolves whether a wake was claimed. */
  private async maintenanceWake(): Promise<boolean> {
    const { store, compute } = this.deps, attempt = randomUUID();
    const row = await store.claimMaintenanceWake({ attempt, perHour: this.deps.maintenancePerHour ?? CLOUD_V2_MAINTENANCE_PER_HOUR,
      perDay: this.deps.maintenancePerDay ?? CLOUD_V2_MAINTENANCE_PER_DAY, staleMs: CLOUD_V2_MAINTENANCE_STALE_MS, excludeIds: [...this.inFlight.keys()] });
    if (!row) return false;
    const vm = row.boatSandboxId!, start = this.deps.now?.() ?? Date.now();
    let outcome: "stopped" | "adopted" | "gone" | "failed" = "failed", workerFoundRunning = false, workerOff: boolean | undefined;
    let machineStoppedAt: Date | null = null, snapshotAvailable: boolean | undefined, dataExpiredAt: Date | null = null;
    // After every call to the machine: a person's start that took the wake over (or opened the
    // workspace) gets it at once, and nothing of the wake's runs after their worker starts.
    const held = async () => { if (!await store.maintenanceHeld(row.id, attempt)) throw new MaintenanceReleased(); };
    try {
      try { await compute.resume(vm, CLOUD_V2_MAINTENANCE_LEASE_SECONDS); }
      catch (error) {
        if (!sandboxLost(error)) throw error;
        // One 404 is not proof, and "gone" stops further wakes for this stop: Boat must say so twice.
        // Boat's own fields are recorded either way; a later user wake decides what a lost machine means.
        const gone = await this.confirmedGone(vm, inspected => { snapshotAvailable = inspected.snapshotAvailable; dataExpiredAt = inspected.dataExpiredAt ?? null; });
        if (!gone) throw error;
        outcome = "gone";
        return true;
      }
      await held();
      // Anything the user left running outside the worker's service also runs for this minute.
      const unit = await compute.exec(vm, WORKER_UNIT_CHECK, 30).catch(() => null);
      await held();
      const running = !!unit && /\bactive=active\b/.test(unit.stdout);
      if (running) (this.deps.logger?.error ?? this.deps.logger?.warn)?.call(this.deps.logger,
        `[cloud-v2] worker found running during a maintenance wake; switching it off workspace=${row.id.slice(0, 8)}`);
      workerFoundRunning = running;
      const off = await this.switchWorkerOff(vm, held);
      workerOff = off;
      if (!off) (this.deps.logger?.error ?? this.deps.logger?.warn)?.call(this.deps.logger,
        `[cloud-v2] maintenance wake could not verify the worker off; stopping at once workspace=${row.id.slice(0, 8)}`);
      // Opened meanwhile: the person's start has the running machine. Only a wake still waking on a
      // stopped workspace marks its stop, in one statement.
      if (!await store.beginMaintenanceStop(row.id, attempt)) { outcome = "adopted"; return true; }
      await compute.stop(vm);
      machineStoppedAt = await this.untilArchived(vm);
      outcome = "stopped";
      return true;
    } catch (error) {
      // Taken over: no further call to the machine, and nothing about its worker is recorded (the
      // person's start owns it now).
      if (error instanceof MaintenanceReleased) { outcome = "adopted"; workerOff = undefined; return true; }
      // The short lease archives the machine if our stop did not.
      this.deps.logger?.warn(`[cloud-v2] maintenance wake failed (${errorCode(error)}) workspace=${row.id.slice(0, 8)}`);
      return true;
    } finally {
      await store.finishMaintenance(row.id, attempt, { outcome, machineStoppedAt, workerFoundRunning, ...(workerOff !== undefined ? { workerOff } : {}),
        ...(snapshotAvailable !== undefined ? { snapshotAvailable } : {}), dataExpiredAt })
        .catch(error => this.deps.logger?.warn(`[cloud-v2] maintenance wake not recorded (${errorCode(error)})`));
      emitCloudV2Timing(this.deps.timing, { workspaceId: row.id.slice(0, 8), state: row.state, phase: "maintenance_wake", outcome,
        durationMs: Math.max(0, Math.round((this.deps.now?.() ?? Date.now()) - start)) });
    }
  }

  /** Once an hour: how far the maintenance budget is from what is due. A workspace the budget cannot
   * reach before Boat's expected deletion falls back to its last backup or checkpoint, as today; that
   * is one summary line, not an alert each. */
  private async reportBacklog(now: number): Promise<void> {
    if (now < this.nextBacklogReport) return;
    this.nextBacklogReport = now + 60 * 60_000;
    const backlog = await this.deps.store.maintenanceBacklog();
    const perHour = this.deps.maintenancePerHour ?? CLOUD_V2_MAINTENANCE_PER_HOUR, perDay = this.deps.maintenancePerDay ?? CLOUD_V2_MAINTENANCE_PER_DAY;
    // Deadline-first, after what the last day already spent: the i-th due workspace waits for the
    // day's budget to roll over once per perDay ahead of it, then takes its place in the hourly rate.
    const reachedAfter = (index: number) => {
      const slot = index + backlog.usedToday;
      return (Math.floor(slot / perDay) * 24 + (slot % perDay) / perHour) * 60 * 60_000;
    };
    const unreachable = backlog.deadlines.filter((deadline, index) => now + reachedAfter(index) > deadline.getTime()).length;
    emitCloudV2Timing(this.deps.timing, { workspaceId: "-", phase: "maintenance_backlog", durationMs: 0,
      due: backlog.due, overdue: backlog.overdue, expired: backlog.expired, unreachable });
    if (unreachable || backlog.overdue) this.deps.logger?.warn(`[cloud-v2] maintenance backlog: ${backlog.due} due, ${backlog.overdue} past due by 2 days, `
      + `${unreachable} beyond the budget before Boat's expected deletion (they restore from their last backup or checkpoint)`);
  }

  /** Retention's stop: switches the worker service off and verifies it, then
   * records whether any repository holds work that is not on GitHub. Bounded by
   * its commands' timeouts and never fails the stop: an unverified worker is
   * recorded for the next wake, no probe answer records unknown, which backs up.
   * Resolves false: the stop has no checkpoint of its own. */
  private async probeStop(workspace: CloudV2LifecycleWorkspace, sandboxId: string): Promise<false> {
    const workerOff = await this.switchWorkerOff(sandboxId);
    if (!workerOff) (this.deps.logger?.error ?? this.deps.logger?.warn)?.call(this.deps.logger,
      `[cloud-v2] stop could not verify the worker off; recorded for the next wake workspace=${workspace.id.slice(0, 8)}`);
    let probe: BackupProbe = "unknown";
    try {
      const others = await this.deps.repositories?.(workspace) ?? [];
      const result = await this.deps.compute.exec(sandboxId,
        backupProbeCommand([workspaceCheckoutPath(workspace), ...others.map(entry => `${CLOUD_V2_HOME}/${entry.checkoutFolder}`)]), CLOUD_V2_BACKUP_PROBE_SECONDS);
      if (result.exitCode === 0 && !result.timedOut) probe = parseBackupProbe(result.stdout);
    } catch (error) {
      this.deps.logger?.warn(`[cloud-v2] stop probe failed (${errorCode(error)}) workspace=${workspace.id.slice(0, 8)}`);
    }
    await this.deps.store.recordStopProbe(workspace.id, workspace.stopGeneration, probe, workerOff)
      .catch(error => this.deps.logger?.warn(`[cloud-v2] stop probe not recorded (${errorCode(error)})`));
    return false;
  }

  /** Stops and disables the worker service, then checks both took (boat-fake.ts, "worker unit stays
   * disabled": an explicit stop freezes a running worker and resume restores it; a fork or a cold
   * resume starts an enabled one). Two attempts, each bounded by its commands' timeouts. */
  private async switchWorkerOff(sandboxId: string, between?: () => Promise<void>): Promise<boolean> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await this.deps.compute.exec(sandboxId, WORKER_OFF_COMMAND, CLOUD_V2_BACKUP_PROBE_SECONDS);
        await between?.();
        const unit = await this.deps.compute.exec(sandboxId, WORKER_UNIT_CHECK, CLOUD_V2_BACKUP_PROBE_SECONDS);
        await between?.();
        if (unit.exitCode === 0 && !unit.timedOut && workerUnitOff(unit.stdout)) return true;
      } catch (error) {
        // A maintenance wake taken over stops here; anything else is retried once, then recorded as unverified.
        if (error instanceof MaintenanceReleased) throw error;
      }
    }
    return false;
  }

  /** Saves the stopped worker's checkpoint. Never blocks the stop: a failure
   * keeps the previous checkpoint and records why. */
  /** Resolves whether this stop now has a checkpoint of its own. */
  private async checkpoint(workspace: CloudV2LifecycleWorkspace, sandboxId: string): Promise<boolean> {
    if (!this.deps.checkpoints) return false;
    // A retried stop already saved this one.
    if (workspace.checkpoint?.stopGeneration === workspace.stopGeneration) return true;
    return await this.capture(workspace, sandboxId, sandboxId, "stop", async () => {
      await this.deps.store.defer(workspace.id, "stopping", CHECKPOINT_LEASE_MS, { failure: true, stopGeneration: workspace.stopGeneration });
    }).then(outcome => outcome !== "fenced", () => false);
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
    // Why it failed, as closed values only: never Boat's or the VM's own text.
    let cause = "";
    try {
      await before();
      // Recorded before the URL exists. A stop that no longer owns the VM, for
      // instance once deletion began, issues no upload at all.
      if (!await store.checkpointUpload(workspace.id, owner, generation, object, uploadUntil, ...scoped)) return "fenced";
      const reuse = await this.reusable(workspace);
      // Every repository of a workspace of several, each in its own part of the archive.
      const others = await this.deps.repositories?.(workspace) ?? [];
      const command = checkpointCommand({ checkoutPath: workspaceCheckoutPath(workspace), home: CLOUD_V2_HOME,
        baseBranch: workspace.baseBranch, key, uploadUrl: await checkpoints.storage.uploadUrl(workspace.id, object), ...(reuse ? { reuse } : {}),
        ...(this.retention && scope === "retry" ? { backup: true } : {}),
        ...(others.length ? { repositories: others.map(entry => ({ checkoutPath: `${CLOUD_V2_HOME}/${entry.checkoutFolder}`, baseBranch: entry.baseBranch })) } : {}) });
      const { result, saved } = await this.measure(workspace, "checkpoint", async () => {
        const result = await this.deps.compute.exec(vm, command, CLOUD_V2_CHECKPOINT_SECONDS);
        return { result, saved: parseCheckpointResult(result.stdout) };
      }, ({ result, saved }): TimingDetail => saved.ok && result.exitCode === 0 && !result.timedOut ? { checkpoint: saved.unchanged ? "unchanged" : "saved" } : {});
      // A failure before the upload step never started one. A failed upload,
      // a timeout or a lost reply may still land, so its intent stays.
      if (!saved.ok) {
        settled = !result.timedOut && saved.step !== "upload" && saved.step !== "unknown";
        cause = result.timedOut ? "timeout" : CHECKPOINT_STEPS.has(saved.step) ? `step_${saved.step}` : "no_result";
        throw checkpointError(saved.code);
      }
      if (result.exitCode !== 0 || result.timedOut) { cause = result.timedOut ? "timeout" : "exit"; throw checkpointError("checkpoint_failed"); }
      // curl reported the upload complete, or there was nothing to upload, so nothing is in flight.
      settled = true;
      if (saved.unchanged) {
        // Only an answer about the checkpoint it was asked to compare with counts.
        if (!reuse || !workspace.checkpoint || saved.fingerprint !== reuse.fingerprint) { cause = "fingerprint"; throw checkpointError("checkpoint_failed"); }
        // Nothing was uploaded under the new name; remove anything that was.
        await checkpoints.storage.delete(workspace.id, object).catch(() => {});
        return await store.checkpointUnchanged(workspace.id, owner, generation, workspace.checkpoint.object, ...scoped) ? "unchanged" : "fenced";
      }
      if (await checkpoints.storage.size(workspace.id, object) !== saved.bytes) { cause = "size"; throw checkpointError("checkpoint_upload_failed"); }
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
      // A provider refusal, such as a command on a VM Boat already stopped, names its own code.
      this.deps.logger?.warn(`[cloud-v2] checkpoint failed (${code}) workspace=${workspace.id.slice(0, 8)} scope=${scope} cause=${cause || errorCode(error)}`);
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
    const retention = this.retention;
    const row = await store.claimCheckpointRetry({ leaseMs: RETRY_LEASE_MS, firstDelayMs: retention ? CLOUD_V2_BACKUP_DELAY_MS : RETRY_FIRST_MS,
      windowMs: CLOUD_V2_CHECKPOINT_RETRY_WINDOW_MS, excludeIds: [...this.inFlight.keys()],
      ...(retention ? { retention: { forksPerHour: this.deps.backupForksPerHour ?? CLOUD_V2_BACKUP_FORKS_PER_HOUR,
        maintenance: { perHour: this.deps.maintenancePerHour ?? CLOUD_V2_MAINTENANCE_PER_HOUR, perDay: this.deps.maintenancePerDay ?? CLOUD_V2_MAINTENANCE_PER_DAY } } } : {}) });
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
    // Boat forks only a VM whose stop has finished archiving: it refuses one still
    // archiving before making anything (boat-fake.ts, "Boat refuses a fork of a machine still archiving").
    let inspected: { name: string | null; state: string };
    try { inspected = await this.deps.compute.inspect(source); }
    catch (error) { if (!sandboxLost(error)) throw error; await this.retriesExhausted(row, retry, "checkpoint_failed"); return true; }
    if (inspected.state !== "archived") {
      // A stop Boat accepted but then failed left the VM running; Boat's own
      // guard still refuses one that would lose writes.
      // Fenced to this stop: a wake meanwhile owns the VM.
      if (inspected.state !== "archiving" && await store.stopCurrent(row.id, row.stopGeneration, "stopped"))
        await this.deps.compute.stop(source).catch(error => this.deps.logger?.warn(`[cloud-v2] checkpoint retry stop failed (${errorCode(error)})`));
      const next = now + (inspected.state === "archiving" ? ARCHIVING_RECHECK_MS : RETRY_BACKOFF_MS[Math.min(retry.attempts, RETRY_BACKOFF_MS.length - 1)]!);
      if (next >= until) await this.retriesExhausted(row, retry, "checkpoint_failed");
      else await store.checkpointRetryNext(row.id, retry.generation, { at: new Date(next) });
      return true;
    }
    const attempt = randomUUID();
    // Boat names every fork after its source. Recording that name, and asking
    // for it, keeps a fork findable whichever name Boat applies.
    const fork = await store.beginCheckpointFork(row.id, retry.generation, { attempt, name: inspected.name ? `${inspected.name} fork` : "", source }, retention);
    // The workspace was woken, stopped again or deleted meanwhile.
    if (!fork) { await store.checkpointRetryNext(row.id, retry.generation, { done: true }); return true; }
    let outcome: "saved" | "unchanged" | "fenced" | null = null, code: CloudV2CheckpointError = "checkpoint_failed", final = false, absent = false, unsafe = false;
    let forking = true;
    try {
      let sandboxId: string;
      try { ({ sandboxId } = await this.deps.compute.fork(source, { key: forkKey(row.id, attempt), ...(fork.name ? { name: fork.name } : {}), ttlSeconds: FORK_TTL_SECONDS })); }
      catch (error) { absent = neverCreated(error); throw error; }
      forking = false;
      fork.sandboxId = sandboxId;
      await store.checkpointForkCreated(row.id, attempt, sandboxId);
      await this.untilReady(sandboxId);
      // A fork is a fresh boot that starts every enabled unit (boat-fake.ts, "worker unit stays
      // disabled"). The fork is ours and goes afterwards: a worker it started is switched off
      // there first; one that will not switch off is never used.
      if (retention) {
        const unit = await this.deps.compute.exec(sandboxId, WORKER_UNIT_CHECK, 30).catch(() => null);
        if (!unit || unit.exitCode !== 0 || unit.timedOut || !workerUnitOff(unit.stdout)) {
          (this.deps.logger?.error ?? this.deps.logger?.warn)?.call(this.deps.logger,
            `[cloud-v2] backup fork had its worker unit on (not switched off at the stop); switching it off there workspace=${row.id.slice(0, 8)}`);
          if (!await this.switchWorkerOff(sandboxId)) {
            unsafe = true;
            throw checkpointError("checkpoint_failed");
          }
        }
      }
      outcome = await this.capture(row, sandboxId, source, "retry");
    } catch (error) {
      code = checkpointCode(error);
      // Nothing is left to fork from, and a stopped disk never shrinks.
      final = (forking && sandboxLost(error)) || code === "checkpoint_too_large" || unsafe;
      if (unsafe) (this.deps.logger?.error ?? this.deps.logger?.warn)?.call(this.deps.logger,
        `[cloud-v2] backup fork refused: its worker unit is on (left enabled at the stop) workspace=${row.id.slice(0, 8)}`);
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
      // With ready copies many VMs share one fork name, so a name could find
      // another workspace's fork; only its key is trusted, and its lease ends it.
      } else if (fork.name && !this.deps.readyCopies) sandboxId = await compute.findSandbox(fork.name, new Date(Date.parse(fork.requestedAt) - 10 * 60_000));
      // Without a name nothing can find it. Its lease archives it within the hour,
      // but a lease is not a delete: the stopped fork stays until Boat's own
      // retention removes it (boat-fake.ts, "a fork's lease is not a delete").
      else if (this.retention) (this.deps.logger?.error ?? this.deps.logger?.warn)?.call(this.deps.logger,
        `[cloud-v2] backup fork leaked (provider_not_found) workspace=${workspace.id.slice(0, 8)} source=${fork.source}`);
      else this.deps.logger?.warn("[cloud-v2] checkpoint fork unrecoverable (provider_not_found)");
    }
    if (sandboxId) await compute.delete(sandboxId);
    await store.checkpointForkGone(workspace.id, fork.attempt);
  }

  /** Boat accepts a stop and archives the VM afterwards, and can still fail
   * it then, e.g. refusing one without a recent snapshot of its own. Only
   * `archived` makes the workspace stopped. */
  /** Resolves Boat's stoppedAt: set only once archived, it is the archive's end, not when the stop was asked for. */
  private async untilArchived(sandboxId: string): Promise<Date | null> {
    for (let read = 1; read <= ARCHIVE_CONFIRM_READS; read++) {
      const { state, stoppedAt } = await this.deps.compute.inspect(sandboxId);
      if (state === "archived") return stoppedAt ?? null;
      if (state !== "archiving") break;
      if (read < ARCHIVE_CONFIRM_READS) await (this.deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(ARCHIVE_CONFIRM_MS);
    }
    throw Object.assign(new Error("Boat has not stopped the VM"), { code: "provider_stop_incomplete" });
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

  /** Retention: a lost VM starts again without a checkpoint when the latest stop left nothing that
   * is not on GitHub, or when there is no backup at all (then the loss is recorded on the workspace,
   * never a dead end). Shared execution keeps today's behavior. */
  private cleanRestore(workspace: CloudV2LifecycleWorkspace): boolean {
    return this.retention && (workspace.stopProbe === "clean" || !workspace.checkpoint) && !workspace.restorePending && workspace.executionIntent === undefined;
  }

  /** The latest stop may have left work off GitHub and no backup holds it: only the machine might. */
  private unbacked(workspace: CloudV2LifecycleWorkspace): boolean {
    return this.cleanRestore(workspace) && workspace.stopProbe !== "clean";
  }

  /** The machine may hold the latest stop's work and nothing else does: there is no backup, or only
   * one from an earlier stop. Its loss is confirmed twice and it is never deleted. */
  private onlyOnMachine(workspace: CloudV2LifecycleWorkspace): boolean {
    return this.retention && workspace.stopProbe !== "clean" && !workspace.restorePending && workspace.executionIntent === undefined
      && (!workspace.checkpoint || workspace.checkpoint.stopGeneration !== workspace.stopGeneration);
  }

  /** Two inspect reads CLOUD_V2_LOSS_CONFIRM_MS apart both report the machine gone: not found,
   * deleted, or archived with no snapshot left (Boat's own snapshotAvailable; an expired disk still
   * reads archived). An archived machine whose snapshot is available is never gone, whatever a
   * resume said. */
  private async confirmedGone(sandboxId: string, seen?: (inspected: Awaited<ReturnType<CloudV2Compute["inspect"]>>) => void): Promise<boolean> {
    const gone = async () => {
      try {
        const inspected = await this.deps.compute.inspect(sandboxId);
        seen?.(inspected);
        return inspected.state === "deleted" || (inspected.state === "archived" && inspected.snapshotAvailable === false);
      } catch (error) { if (sandboxLost(error)) return true; throw error; }
    };
    if (!await gone()) return false;
    await (this.deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(CLOUD_V2_LOSS_CONFIRM_MS);
    return gone();
  }

  /** Retention's replacement for a lost VM whose workspace had nothing off GitHub at
   * its latest stop: a fork of the project's ready copy, else a new VM from the
   * Cloud Computer with its repositories cloned, then each workspace branch. One
   * key per stop finds the same VM again on a retry; it is recorded only once it
   * holds the workspace, so the next step never treats a half-made one as ready. */
  private async cleanReplacement(workspace: CloudV2LifecycleWorkspace, lost: string | null, bootEnv: Record<string, string>): Promise<string | null> {
    const { store, compute } = this.deps, key = `restore-clean:${workspace.id}:${workspace.stopGeneration}`;
    const start = this.deps.now?.() ?? Date.now();
    const source = this.deps.restoreSource ? await this.deps.restoreSource(workspace).catch(() => null) : null;
    let sandboxId: string | null = null;
    if (source) {
      try { ({ sandboxId } = await compute.fork(source, { key, ttlSeconds: CLOUD_V2_LEASE_SECONDS })); }
      catch (error) {
        if (!neverCreated(error)) throw error;
        this.deps.logger?.warn(`[cloud-v2] ready copy fork refused for a restore; creating from the Cloud Computer (${errorCode(error)})`);
      }
    }
    if (!sandboxId) {
      const image = await store.workspaceImage(workspace.id);
      if (!image) { await store.transition(workspace.id, ["starting"], "failed", { errorCode: "cloud_computer_build_required" }); return null; }
      ({ sandboxId } = await compute.create({ key: `${key}:create`, name: `${this.deps.sandboxName(workspace)}-c${workspace.stopGeneration}`, env: bootEnv,
        ...(image.from ? { from: image.from } : {}) }));
      if (image.prune.length || !image.from) await this.prepareImage(sandboxId, image);
      if (!image.checkout) {
        if (!this.deps.prepareRepository) throw Object.assign(new Error("no clone path"), { code: "cloud_source_checkout_failed" });
        await this.deps.prepareRepository(workspace, sandboxId);
      }
    }
    await this.restoreBranches(workspace, sandboxId);
    // A machine that may hold unbacked work is never deleted here: if it is truly gone this
    // would do nothing, and if Boat was wrong it is the only copy. It is kept on the row instead.
    if (lost && !this.unbacked(workspace)) await compute.delete(lost).catch(() => {});
    else if (lost) (this.deps.logger?.error ?? this.deps.logger?.warn)?.call(this.deps.logger,
      `[cloud-v2] rebuilt a workspace whose machine is gone without a backup; the machine was kept workspace=${workspace.id.slice(0, 8)}`);
    if (!await store.replaceLostSandbox(workspace.id, lost, sandboxId, new Date(this.deps.now?.() ?? Date.now()))) return null;
    emitCloudV2Timing(this.deps.timing, { workspaceId: workspace.id.slice(0, 8), state: workspace.state, phase: "checkpoint_restore",
      durationMs: Math.max(0, Math.round((this.deps.now?.() ?? Date.now()) - start)), checkpoint: "none" });
    return sandboxId;
  }

  /** A restore without a checkpoint: every repository's workspace branch is
   * created from GitHub's when GitHub has it. When it does not (never pushed),
   * nothing is done and the worker creates it from the base branch, as at
   * create. Any other GitHub failure fails the step, which is retried. */
  private async restoreBranches(workspace: CloudV2LifecycleWorkspace, sandboxId: string): Promise<void> {
    await this.deps.authorizeWorkspace?.(workspace);
    const others = new Map((await this.deps.repositories?.(workspace) ?? []).map(entry => [entry.repository.toLowerCase(), entry.checkoutFolder]));
    for (const entry of await this.deps.store.workspaceBranches(workspace.id)) {
      const dir = entry.position === 0 ? workspaceCheckoutPath(workspace) : others.get(entry.repository.toLowerCase());
      if (!dir) continue;
      const path = entry.position === 0 ? dir : `${CLOUD_V2_HOME}/${dir}`;
      if (!/^[A-Za-z0-9._/-]{1,255}$/.test(entry.branch) || entry.branch.startsWith("-") || !path.startsWith(`${CLOUD_V2_HOME}/`)) continue;
      const token = entry.position === 0 ? await this.deps.githubToken?.(workspace) : await this.deps.githubToken?.(workspace, entry.repository);
      const result = await this.deps.compute.execLong(sandboxId, restoreBranchCommand(path, entry.branch), 300,
        `Authorization: Basic ${Buffer.from(`x-access-token:${token?.token ?? ""}`).toString("base64")}\n`);
      if (result.exitCode !== 0 || result.timedOut) throw checkpointError("checkpoint_restore_failed");
    }
  }

  /** Legacy restores replay in place. An active restore consumes its fresh
   * snapshot before credential delivery; an uncertain retry replaces the VM. */
  private async applyCheckpoint(workspace: CloudV2LifecycleWorkspace, sandboxId: string): Promise<void> {
    const checkpoints = this.deps.checkpoints, checkpoint = workspace.checkpoint;
    if (!checkpoints || !checkpoint) throw checkpointError("checkpoint_restore_failed");
    await this.deps.authorizeWorkspace?.(workspace);
    const active = workspace.executionIntent !== undefined;
    if (active && !await this.deps.claimExecutionRestore?.(workspace, sandboxId)) throw checkpointError("checkpoint_restore_failed");
    const github = await this.deps.githubToken?.(workspace) ?? null;
    // Each repository after the first is restored with its own token and clone URL.
    const others = await this.deps.repositories?.(workspace) ?? [];
    const repositories = await Promise.all(others.map(async entry => {
      const token = await this.deps.githubToken?.(workspace, entry.repository) ?? null;
      // Shared execution fetches every repository's objects with its own token, as for the first.
      if (active && !token) throw checkpointError("checkpoint_restore_failed");
      return { checkoutPath: `${CLOUD_V2_HOME}/${entry.checkoutFolder}`, repositoryUrl: `https://github.com/${entry.repository}.git`,
        ...(token ? { githubToken: token.token } : {}) };
    }));
    const key = checkpoints.open(checkpoint.key, workspace.id, checkpoint.object);
    try {
      const command = restoreCommand({ checkoutPath: workspaceCheckoutPath(workspace), home: CLOUD_V2_HOME, key,
        sha256: checkpoint.sha256, downloadUrl: await checkpoints.storage.downloadUrl(workspace.id, checkpoint.object),
        repositoryUrl: `https://github.com/${workspace.repository}.git`, ...(github ? { githubToken: github.token } : {}), ...(active ? { active: true } : {}),
        ...(repositories.length ? { repositories } : {}) });
      await this.deps.store.defer(workspace.id, "starting", CHECKPOINT_LEASE_MS, { failure: true });
      await this.deps.assertExecution?.(workspace);
      const result = await this.deps.compute.exec(sandboxId, command, CLOUD_V2_CHECKPOINT_SECONDS);
      await this.deps.assertExecution?.(workspace);
      const restored = parseRestoreResult(result.stdout);
      if (!restored.ok) throw checkpointError(restored.code);
      if (result.exitCode !== 0 || result.timedOut) throw checkpointError("checkpoint_restore_failed");
    } finally { key.fill(0); }
  }

  private async lookupBaseCommit(workspace: CloudV2LifecycleWorkspace): Promise<string | null> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const head = await Promise.race([this.deps.remoteHead!(workspace),
        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), BASE_COMMIT_MS); timer.unref(); })]);
      return head && /^[0-9a-f]{40}$/.test(head) ? head : null;
    } catch { return null; } finally { clearTimeout(timer); }
  }

  /** False when a worker already holds this start (hello bound its boot). */
  private async deliverToken(workspace: CloudV2LifecycleWorkspace, sandboxId: string, bootEnv: Record<string, string>): Promise<boolean> {
    await this.deps.authorizeWorkspace?.(workspace);
    const token = await this.deps.store.rotateWorkerToken(workspace.id, { state: workspace.state, sandboxId, stopGeneration: workspace.stopGeneration });
    if (!token) return false;
    await this.deps.assertExecution?.(workspace);
    const result = await this.execWhenReady(sandboxId, deliverWorkerTokenCommand(token, bootEnv), 30);
    await this.deps.assertExecution?.(workspace);
    if (result.exitCode !== 0 || result.timedOut) throw Object.assign(new Error("token delivery failed"), { code: "worker_token_delivery_failed" });
    return true;
  }

  private async host(workspace: CloudV2LifecycleWorkspace, sandboxId: string): Promise<boolean> {
    // The route starts beside the VM's first command, so Boat can still be
    // booting it; retry only that reply, as commands do.
    let route: Awaited<ReturnType<CloudV2Compute["hostPort"]>>;
    for (let attempt = 1; ; attempt++) {
      try { route = await this.deps.compute.hostPort(sandboxId, { port: CLOUD_V2_WORKER_PORT, localhost: true, title: "Zeros worker" }); break; }
      catch (error) {
        if (!(error instanceof BoatBootPendingError) || attempt >= 6) throw error;
        await (this.deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(2_000);
      }
    }
    await this.deps.assertExecution?.(workspace);
    return this.deps.store.setWorkerRoute(workspace.id, sandboxId, route.url, this.deps.sealPortToken(route.token, workspace.id));
  }

  /** Quick when the VM already has the runtime (or may keep `keep`); otherwise
   * downloads it. Token delivery restarts the worker, so this never does. */
  private async ensureRuntime(sandboxId: string, runtime: CloudV2Runtime, keep?: string): Promise<{ changed: boolean; kept: boolean }> {
    const result = await this.execWhenReady(sandboxId, installRuntimeCommand({ sha256: runtime.sha256, url: await runtime.url(), publicKeys: this.deps.publicKeys },
      { ...(keep ? { keep } : {}), restart: false }), 300);
    if (result.exitCode !== 0 || result.timedOut) throw Object.assign(new Error("runtime install failed"), { code: "worker_runtime_install_failed" });
    const lines = result.stdout.split(/\r?\n/);
    return { changed: lines.includes("runtime-changed"), kept: !!keep && lines.includes("runtime-kept") };
  }

  /** The release's previous pin, for a workspace on the channel runtime itself
   * (the same object, not an equal digest: canary, creation, activation and
   * recovery pins are never replaced). A refused hello installs the pin. */
  private keepableRuntime(workspace: CloudV2LifecycleWorkspace, runtime: CloudV2Runtime): string | undefined {
    const previous = this.deps.previousRuntimeSha256;
    if (!previous || previous === runtime.sha256 || runtime !== this.deps.runtime) return undefined;
    if (workspace.executionTransitionId || workspace.recoveryAttemptId || workspace.errorCode === CLOUD_V2_RUNTIME_REFUSED) return undefined;
    return previous;
  }

  /** Unpacks the pin beside the running worker without switching to it; the
   * next wake's install then only moves the link. */
  private stageRuntime(sandboxId: string, runtime: CloudV2Runtime): void {
    void (async () => {
      // Alpha's woken VMs kept their previous runtime on every wake when one staging attempt failed (2026-11-17).
      // Retry a few times, apart; the reason logged is a closed class, never command output.
      let cause = "unknown";
      for (let attempt = 1; attempt <= STAGE_ATTEMPTS; attempt++) {
        try {
          const result = await this.deps.compute.execLong(sandboxId, prepareRuntimeCommand({ sha256: runtime.sha256, url: await runtime.url() }), 300);
          if (result.exitCode === 0 && !result.timedOut) return;
          cause = result.timedOut ? "timeout" : `exit_${Number.isInteger(result.exitCode) ? result.exitCode : "other"}`;
        } catch (error) { cause = errorCode(error); }
        if (attempt < STAGE_ATTEMPTS) await (this.deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(STAGE_RETRY_MS * attempt);
      }
      this.deps.logger?.warn(`[cloud-v2] runtime staging deferred to the next wake (${cause}, attempts=${STAGE_ATTEMPTS})`);
    })().catch(() => {});
  }

  /** A v3 image keeps only this workspace's checkout; the stock image gets the
   * git-lfs a Cloud Computer build would have added. Both are idempotent. */
  private async prepareImage(sandboxId: string, image: { from: string | null; prune: string[] }): Promise<void> {
    if (image.prune.length) {
      const pruned = await this.deps.compute.exec(sandboxId, pruneCloudRepositories(image.prune), 120);
      if (pruned.exitCode !== 0 || pruned.timedOut) throw Object.assign(new Error("prune failed"), { code: "cloud_source_prune_failed" });
    }
    // Without git-lfs a workspace still works; LFS files stay placeholders.
    if (!image.from) await this.deps.compute.exec(sandboxId, GIT_LFS_INSTALL_COMMAND, 300).catch(() => undefined);
  }

  private async boot(workspace: CloudV2Workspace) {
    const runtime = this.deps.runtimeForWorkspace ? await this.deps.runtimeForWorkspace(workspace) : this.deps.runtime;
    return { runtime, env: await this.deps.bootEnv(workspace, runtime) };
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

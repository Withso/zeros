// Zeros's shared standard base: one Boat named snapshot per worker runtime with the runtime and Git LFS on Boat's stock
// image, and nothing private (no source, no credentials, no token). Organizations without an install script start
// from it, so they need no machine of their own. The builder makes it for the channel's pinned runtime whatever
// CLOUD_V2_READY_COPIES_ENABLED says; CLOUD_V2_SHARED_BASE_SNAPSHOT may pin a name or turn it off.
// Every name is recorded in cloud_v2_shared_bases (0269) before its save, and deleted only when nothing refers to it.
import type pg from "pg";
import { withSystemTx, type Tx } from "../db.js";
import type { CloudV2SharedBaseOverride } from "../config.js";
import type { CloudV2Compute } from "./boat.js";
import { asZeros, GIT_LFS_INSTALL_COMMAND, type CloudV2Build } from "./computer.js";
import { installRuntimeCommand } from "./runtime.js";
import { cloudV2ResourcePrefix, cloudV2SandboxName, cloudV2SharedBaseName } from "./resource-names.js";
import { buildClaimAllowed } from "./runtime-build-drain.js";

/** The worker runtime a base installs. */
export type SharedBaseRuntime = { sha256: string; url(sha256?: string): Promise<string> };

export type InstallBaseHooks = {
  log(text: string): Promise<void>;
  assertHeld(): void;
  /** Computer builds record the runtime they installed (CloudV2Computers.setRuntime). */
  runtimeInstalled?(sha256: string): Promise<void>;
  /** Asked before the install script runs: false means the build was cancelled meanwhile. */
  running?(): Promise<boolean>;
};

/**
 * The one definition of what a base installs on Boat's stock image: the worker runtime (bounded at 300 s, a failure
 * fails the build), Git LFS (300 s, a failure is tolerated: the worker then tells LFS repositories how to fetch their
 * files) and, for an organization's own base, its install script. Returns false when the build stopped before the script.
 */
export async function installBase(compute: CloudV2Compute, sandboxId: string,
  input: { runtime: { sha256: string; url: string }; publicKeys?: readonly string[]; installScript?: string | null },
  hooks: InstallBaseHooks): Promise<boolean> {
  const { sha256, url } = input.runtime;
  const installed = await compute.exec(sandboxId, installRuntimeCommand({ sha256, url, ...(input.publicKeys ? { publicKeys: input.publicKeys } : {}) }), 300);
  if (installed.exitCode !== 0 || installed.timedOut) throw Object.assign(new Error("runtime install failed"), { code: "worker_runtime_install_failed" });
  await hooks.runtimeInstalled?.(sha256);
  await hooks.log(`[zeros] runtime ${sha256.slice(0, 12)} installed\n`);
  const lfs = await compute.exec(sandboxId, GIT_LFS_INSTALL_COMMAND, 300);
  await hooks.log(lfs.exitCode === 0 && !lfs.timedOut ? "[zeros] git-lfs installed\n"
    : "[zeros] git-lfs could not be installed; Git LFS files stay placeholders until a later build adds it\n");
  if (input.installScript) {
    hooks.assertHeld();
    if (hooks.running && !await hooks.running()) return false;
    await hooks.log("[zeros] running the install script\n");
    const script = await compute.execLong(sandboxId, `${asZeros(["cd /home/user", input.installScript])} 2>&1`, 3600);
    await hooks.log(script.stdout.slice(-64 * 1024) + `\n[zeros] install script: exit ${script.exitCode}\n`);
    if (script.exitCode !== 0 || script.timedOut) throw Object.assign(new Error("install script failed"), { code: "computer_install_script_failed" });
  }
  return true;
}

/** Every outcome a shared base build reports; operators see these and names, nothing else. */
export const SHARED_BASE_CODES = [
  "shared_base_ready", "shared_base_exists", "shared_base_building", "shared_base_backoff", "shared_base_drain_held",
  "shared_base_off", "shared_base_planned", "shared_base_builder_refused", "worker_runtime_install_failed",
  "computer_snapshot_failed", "computer_snapshot_timeout", "shared_base_readback_failed", "shared_base_interrupted",
  "shared_base_rebuilds_exhausted", "shared_base_build_failed",
] as const;
export type SharedBaseCode = typeof SHARED_BASE_CODES[number];
const FAILURE_CODES: ReadonlySet<string> = new Set<SharedBaseCode>(["shared_base_builder_refused", "worker_runtime_install_failed",
  "computer_snapshot_failed", "computer_snapshot_timeout", "shared_base_readback_failed", "shared_base_interrupted"]);
function failureCode(error: unknown): SharedBaseCode {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && FAILURE_CODES.has(code) ? code as SharedBaseCode : "shared_base_build_failed";
}

/** After a failed shared base build: 15 minutes, doubling, at most 6 hours, as automatic bases back off. */
export function sharedBaseRetryDelay(failures: number): number {
  return Math.min(15 * 60_000 * 2 ** Math.max(0, Math.min(failures, 16) - 1), 6 * 60 * 60_000);
}
/** A build whose process stopped beating (a deploy, a crash) is failed after this, as Computer builds are. */
const INTERRUPTED_AFTER = "5 minutes";
const HEARTBEAT_MS = 60_000;
/** How long the resolver keeps an answer. */
export const SHARED_BASE_CACHE_MS = 60_000;

export type SharedBaseScope = { channel: string; localOwner?: string | undefined };
/** The start every name of this deployment's shared bases has: `zeros-<channel>-base-` or `zeros-local-<owner>-base-`. */
export function sharedBasePrefix(scope: SharedBaseScope): string {
  return `${cloudV2ResourcePrefix(scope.channel, scope.localOwner)}base-`;
}

export type SharedBaseRow = {
  name: string; channel: string; runtime_sha256: string; rebuild: number; state: "building" | "ready" | "failed" | "deleted";
  build_id: string; builder_sandbox_id: string | null; builder_create_pending: boolean; builder_deleted_at: Date | null;
  save_requested_at: Date | null; error_code: string | null; failures: number; next_attempt_at: Date | null;
  missing_at: Date | null; created_at: Date; ready_at: Date | null; superseded_at: Date | null; deleted_at: Date | null;
};
export type SharedBaseClaim =
  | { kind: "claimed"; row: SharedBaseRow }
  | { kind: "exists"; name: string }
  | { kind: "building"; name: string }
  | { kind: "backoff"; name: string; nextAttemptAt: Date }
  | { kind: "drain_held" }
  | { kind: "exhausted" };

/** The rows of cloud_v2_shared_bases. Every statement runs as the system and touches only this deployment's names. */
export class CloudV2SharedBases {
  constructor(private readonly pool: pg.Pool) {}

  /** What the next build for this runtime would be named, and whether one is due, changing nothing. */
  async plan(scope: SharedBaseScope, runtimeSha256: string, now = new Date()): Promise<SharedBaseClaim> {
    return withSystemTx(this.pool, tx => this.decide(tx, scope, runtimeSha256, now));
  }

  /**
   * Claims the build of this runtime's base: at most one per runtime at a time, serialized on an advisory lock per
   * deployment, never while the runtime build drain is held. The row is written (state building) before any machine.
   */
  async claim(scope: SharedBaseScope, runtimeSha256: string, now = new Date()): Promise<SharedBaseClaim> {
    const prefix = sharedBasePrefix(scope);
    return withSystemTx(this.pool, async tx => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`cloud-v2-shared-base:${prefix}`]);
      await this.failInterrupted(tx, prefix);
      const decided = await this.decide(tx, scope, runtimeSha256, now);
      if (decided.kind !== "claimed") return decided;
      // The drain row is locked here, so a release that takes the drain waits for this claim or sees its build.
      if (!await buildClaimAllowed(tx)) return { kind: "drain_held" };
      const row = (await tx.query<SharedBaseRow>(
        `INSERT INTO cloud_v2_shared_bases (name, channel, runtime_sha256, rebuild, state, failures, heartbeat_at)
         VALUES ($1, $2, $3, $4, 'building', $5, clock_timestamp()) RETURNING *`,
        [decided.row.name, scope.channel, runtimeSha256, decided.row.rebuild, decided.row.failures])).rows[0]!;
      return { kind: "claimed", row };
    });
  }

  /** The next row a claim would write ("claimed" carries only its name, rebuild and carried failures). */
  private async decide(tx: Tx, scope: SharedBaseScope, runtimeSha256: string, now: Date): Promise<SharedBaseClaim> {
    const prefix = sharedBasePrefix(scope);
    const rows = (await tx.query<SharedBaseRow>(
      `SELECT * FROM cloud_v2_shared_bases WHERE starts_with(name, $1) AND channel = $2 AND runtime_sha256 = $3 ORDER BY rebuild DESC`,
      [prefix, scope.channel, runtimeSha256])).rows;
    const ready = rows.find(row => row.state === "ready");
    if (ready) return { kind: "exists", name: ready.name };
    const building = rows.find(row => row.state === "building");
    if (building) return { kind: "building", name: building.name };
    const last = rows[0];
    if (last?.state === "failed" && last.next_attempt_at && last.next_attempt_at > now)
      return { kind: "backoff", name: last.name, nextAttemptAt: last.next_attempt_at };
    const rebuild = last ? last.rebuild + 1 : 0;
    if (rebuild > 999) return { kind: "exhausted" };
    // A base Boat lost starts its backoff again; consecutive failures of builds carry on.
    const failures = last?.state === "failed" && !last.missing_at ? last.failures : 0;
    return { kind: "claimed", row: { name: cloudV2SharedBaseName(scope.channel, runtimeSha256, rebuild, scope.localOwner), rebuild, failures } as SharedBaseRow };
  }

  private async failInterrupted(tx: Tx, prefix: string): Promise<void> {
    await tx.query(`UPDATE cloud_v2_shared_bases SET state = 'failed', error_code = 'shared_base_interrupted', finished_at = clock_timestamp(),
        failures = failures + 1, next_attempt_at = clock_timestamp() + least(interval '15 minutes' * power(2, least(failures, 16)), interval '6 hours')
      WHERE starts_with(name, $1) AND state = 'building' AND coalesce(heartbeat_at, created_at) < clock_timestamp() - interval '${INTERRUPTED_AFTER}'`, [prefix]);
  }

  async heartbeat(name: string): Promise<void> {
    await withSystemTx(this.pool, tx => tx.query("UPDATE cloud_v2_shared_bases SET heartbeat_at = clock_timestamp() WHERE name = $1 AND state = 'building'", [name]));
  }

  /** Before the create: a lost reply leaves a builder that cleanup finds by replaying the same key. */
  async builderPending(name: string): Promise<boolean> {
    const { rowCount } = await withSystemTx(this.pool, tx => tx.query(
      "UPDATE cloud_v2_shared_bases SET builder_create_pending = true WHERE name = $1 AND state = 'building'", [name]));
    return !!rowCount;
  }

  async builderCreated(name: string, sandboxId: string): Promise<void> {
    await withSystemTx(this.pool, tx => tx.query(
      "UPDATE cloud_v2_shared_bases SET builder_sandbox_id = $2, builder_create_pending = false WHERE name = $1", [name, sandboxId]));
  }

  async builderGone(name: string): Promise<void> {
    await withSystemTx(this.pool, tx => tx.query(
      "UPDATE cloud_v2_shared_bases SET builder_deleted_at = clock_timestamp(), builder_create_pending = false WHERE name = $1", [name]));
  }

  /** Recorded before the save: from here Boat may hold the name until it is confirmed deleted. */
  async saveRequested(name: string): Promise<boolean> {
    const { rowCount } = await withSystemTx(this.pool, tx => tx.query(
      "UPDATE cloud_v2_shared_bases SET save_requested_at = coalesce(save_requested_at, clock_timestamp()) WHERE name = $1 AND state = 'building'", [name]));
    return !!rowCount;
  }

  async ready(name: string): Promise<boolean> {
    const { rowCount } = await withSystemTx(this.pool, tx => tx.query(
      `UPDATE cloud_v2_shared_bases SET state = 'ready', ready_at = clock_timestamp(), finished_at = clock_timestamp(), error_code = NULL,
         failures = 0, next_attempt_at = NULL WHERE name = $1 AND state = 'building'`, [name]));
    return !!rowCount;
  }

  async fail(name: string, code: SharedBaseCode): Promise<Date | null> {
    const row = (await withSystemTx(this.pool, tx => tx.query<{ next_attempt_at: Date }>(
      `UPDATE cloud_v2_shared_bases SET state = 'failed', error_code = $2, finished_at = clock_timestamp(), failures = failures + 1,
         next_attempt_at = clock_timestamp() + least(interval '15 minutes' * power(2, least(failures, 16)), interval '6 hours')
       WHERE name = $1 AND state = 'building' RETURNING next_attempt_at`, [name, code]))).rows[0];
    return row?.next_attempt_at ?? null;
  }

  /** Boat confirmed the name is gone (read back after the delete). */
  async snapshotGone(name: string, deleted: boolean): Promise<void> {
    await withSystemTx(this.pool, tx => tx.query(
      `UPDATE cloud_v2_shared_bases SET deleted_at = coalesce(deleted_at, clock_timestamp()),
         state = CASE WHEN $2 THEN 'deleted' ELSE state END WHERE name = $1 AND state <> 'building'`, [name, deleted]));
  }

  async row(name: string): Promise<SharedBaseRow | null> {
    return (await withSystemTx(this.pool, tx => tx.query<SharedBaseRow>("SELECT * FROM cloud_v2_shared_bases WHERE name = $1", [name]))).rows[0] ?? null;
  }

  async rows(scope: SharedBaseScope): Promise<SharedBaseRow[]> {
    return (await withSystemTx(this.pool, tx => tx.query<SharedBaseRow>(
      "SELECT * FROM cloud_v2_shared_bases WHERE starts_with(name, $1) AND channel = $2 ORDER BY created_at, name",
      [sharedBasePrefix(scope), scope.channel]))).rows;
  }

  /** What the shared base is for this runtime, from the rows alone (see sharedBaseState for the override). */
  async state(scope: SharedBaseScope, runtimeSha256: string, now = new Date()): Promise<SharedBaseState> {
    const prefix = sharedBasePrefix(scope);
    return withSystemTx(this.pool, async tx => {
      // The newest ready base of this runtime, else of any runtime: the worker installs the pinned runtime at boot when
      // the image's differs, so an older base serves while this runtime's builds, and the re-point moves it on later.
      const ready = (await tx.query<{ name: string; runtime_sha256: string }>(
        `SELECT name, runtime_sha256 FROM cloud_v2_shared_bases WHERE starts_with(name, $1) AND channel = $2 AND state = 'ready'
         ORDER BY runtime_sha256 = $3 DESC, ready_at DESC, name DESC LIMIT 1`, [prefix, scope.channel, runtimeSha256])).rows[0];
      if (ready) return { state: "ready", name: ready.name, source: "database", runtimeSha256: ready.runtime_sha256 };
      const decided = await this.decide(tx, scope, runtimeSha256, now);
      if (decided.kind === "backoff") return { state: "failed", nextAttemptAt: decided.nextAttemptAt.toISOString() };
      if (decided.kind === "exhausted") return { state: "failed", nextAttemptAt: null };
      // Building now, or due at the builder's next tick.
      return { state: "building" };
    });
  }
}

export type SharedBaseState =
  | { state: "ready"; name: string; source: "database" | "override"; runtimeSha256?: string }
  | { state: "building" }
  | { state: "failed"; nextAttemptAt: string | null }
  | { state: "off" };

/** The shared base for activations: the override first (off, or a pinned name), then the rows. */
export async function sharedBaseState(bases: CloudV2SharedBases, input: SharedBaseScope & {
  runtimeSha256: string; override?: CloudV2SharedBaseOverride | null; now?: Date;
}): Promise<SharedBaseState> {
  if (input.override?.kind === "off") return { state: "off" };
  if (input.override?.kind === "name") return { state: "ready", name: input.override.name, source: "override" };
  return bases.state(input, input.runtimeSha256, input.now);
}

/** sharedBaseState, cached for at most a minute per process; one read at a time. */
export class CloudV2SharedBaseResolver {
  private cached: { at: number; value: SharedBaseState } | null = null;
  private pending: Promise<SharedBaseState> | null = null;

  constructor(private readonly bases: CloudV2SharedBases, private readonly input: SharedBaseScope & {
    runtimeSha256: string; override?: CloudV2SharedBaseOverride | null; now?: () => number; ttlMs?: number;
  }) {}

  async state(): Promise<SharedBaseState> {
    const now = this.input.now?.() ?? Date.now();
    if (this.cached && now - this.cached.at < Math.min(this.input.ttlMs ?? SHARED_BASE_CACHE_MS, SHARED_BASE_CACHE_MS)) return this.cached.value;
    this.pending ??= sharedBaseState(this.bases, { ...this.input, now: new Date(now) })
      .then(value => { this.cached = { at: now, value }; return value; })
      .finally(() => { this.pending = null; });
    return this.pending;
  }

  /** The name an activation stores (as "<name>@<build>"), or null when there is none to use now. */
  async current(): Promise<string | null> {
    const state = await this.state();
    return state.state === "ready" ? state.name : null;
  }

  invalidate(): void { this.cached = null; }
}

export type SharedBaseBuildDeps = {
  bases: CloudV2SharedBases;
  compute: CloudV2Compute;
  /** The worker's grant verification keys, installed as Computer builds install them. Public, never secret. */
  publicKeys?: readonly string[];
  logger?: Pick<Console, "warn" | "info">;
  heartbeatMs?: number;
};
export type SharedBaseBuildResult = {
  code: SharedBaseCode; name: string | null; runtime12: string;
  /** Plan mode: whether Boat has that name now, and what execute would do. */
  exists?: boolean; steps?: readonly string[]; nextAttemptAt?: string | null;
};
export const SHARED_BASE_STEPS = [
  "record the name (state building)", "create a builder from Boat's stock image", "install the worker runtime", "install Git LFS",
  "sync", "save the named snapshot", "read the snapshot back", "delete the builder", "mark the base ready",
] as const;

/**
 * Builds this runtime's shared base. Plan mode reads and creates nothing. Execute claims the build (the row is
 * written first), makes one builder from Boat's stock image with an empty environment, installs the base with no
 * script, saves and reads back the snapshot, and always deletes the builder. A failure keeps every earlier base.
 */
export async function buildSharedBase(deps: SharedBaseBuildDeps, input: SharedBaseScope & {
  runtime: SharedBaseRuntime; mode: "plan" | "execute"; now?: Date;
}): Promise<SharedBaseBuildResult> {
  const { bases, compute } = deps;
  const sha256 = input.runtime.sha256, runtime12 = sha256.slice(0, 12);
  if (input.mode === "plan") {
    const decided = await bases.plan(input, sha256, input.now);
    if (decided.kind === "exists") return { code: "shared_base_exists", name: decided.name, runtime12, exists: await exists(compute, decided.name) };
    if (decided.kind === "building") return { code: "shared_base_building", name: decided.name, runtime12 };
    if (decided.kind === "backoff") return { code: "shared_base_backoff", name: decided.name, runtime12, nextAttemptAt: decided.nextAttemptAt.toISOString() };
    if (decided.kind !== "claimed") return { code: "shared_base_rebuilds_exhausted", name: null, runtime12 };
    return { code: "shared_base_planned", name: decided.row.name, runtime12, exists: await exists(compute, decided.row.name), steps: SHARED_BASE_STEPS };
  }
  const claim = await bases.claim(input, sha256, input.now);
  if (claim.kind === "exists") return { code: "shared_base_exists", name: claim.name, runtime12 };
  if (claim.kind === "building") return { code: "shared_base_building", name: claim.name, runtime12 };
  if (claim.kind === "backoff") return { code: "shared_base_backoff", name: claim.name, runtime12, nextAttemptAt: claim.nextAttemptAt.toISOString() };
  if (claim.kind === "drain_held") return { code: "shared_base_drain_held", name: null, runtime12 };
  if (claim.kind === "exhausted") return { code: "shared_base_rebuilds_exhausted", name: null, runtime12 };
  const { name, build_id: buildId } = claim.row;
  const beat = setInterval(() => { void bases.heartbeat(name).catch(() => {}); }, deps.heartbeatMs ?? HEARTBEAT_MS);
  beat.unref();
  let sandboxId: string | null = null;
  let saveRequested = false;
  // A row that is no longer building (failed as interrupted meanwhile) is never made ready.
  const held = (ok: boolean) => { if (!ok) throw Object.assign(new Error("build interrupted"), { code: "shared_base_interrupted" }); };
  try {
    held(await bases.builderPending(name));
    try {
      // The same key and body replay an uncertain create. Nothing private reaches this machine: no environment,
      // no token, no source; the runtime arrives by its signed download URL, as every Computer build's does.
      ({ sandboxId } = await compute.create(sharedBaseBuilderInput(input, buildId)));
    } catch (error) {
      throw Object.assign(new Error("builder refused"), { code: "shared_base_builder_refused", cause: error });
    }
    await bases.builderCreated(name, sandboxId);
    await installBase(compute, sandboxId, { runtime: { sha256, url: await input.runtime.url(sha256) }, ...(deps.publicKeys ? { publicKeys: deps.publicKeys } : {}) },
      { log: async () => {}, assertHeld: () => {} });
    await compute.exec(sandboxId, "sync", 120);
    held(await bases.saveRequested(name));
    saveRequested = true;
    await compute.saveSnapshot(sandboxId, name);
    if (!await exists(compute, name)) throw Object.assign(new Error("snapshot not readable"), { code: "shared_base_readback_failed" });
    held(await bases.ready(name));
    deps.logger?.info(`[cloud-v2] shared base ready channel=${input.channel} runtime=${runtime12} name=${name}`);
    return { code: "shared_base_ready", name, runtime12 };
  } catch (error) {
    const code = failureCode(error);
    const nextAttemptAt = await bases.fail(name, code).catch(() => null);
    deps.logger?.warn(`[cloud-v2] shared base build failed channel=${input.channel} runtime=${runtime12} code=${code}`);
    // A failed save may still have made the name; it was never anyone's base, so it goes now (or at cleanup).
    if (saveRequested) await removeSnapshot(deps, name).catch(() => {});
    return { code, name, runtime12, nextAttemptAt: nextAttemptAt?.toISOString() ?? null };
  } finally {
    clearInterval(beat);
    if (sandboxId) await compute.delete(sandboxId).then(() => bases.builderGone(name)).catch(() => {});
  }
}

/** The builder's create, the same body for a replay: Computer builds' naming and kind, an empty environment. */
export function sharedBaseBuilderInput(scope: SharedBaseScope, buildId: string) {
  return { key: `shared-base:${buildId}`, name: cloudV2SandboxName(scope.channel, "build", buildId, scope.localOwner), env: {} };
}

async function exists(compute: CloudV2Compute, name: string): Promise<boolean> {
  return compute.snapshotExists ? compute.snapshotExists(name) : false;
}

/** Deletes a name and reads it back; the row records the deletion only once Boat no longer has it. */
async function removeSnapshot(deps: Pick<SharedBaseBuildDeps, "bases" | "compute">, name: string, state: "deleted" | "kept" = "kept"): Promise<boolean> {
  await deps.compute.deleteSnapshot(name);
  if (await exists(deps.compute, name)) return false;
  await deps.bases.snapshotGone(name, state === "deleted");
  return true;
}

/** Overview history: an automatic re-point to a newer shared base, one per runtime release for every organization on it. */
export function isSharedRepoint(build: Pick<CloudV2Build, "reason" | "state" | "snapshotId" | "createdBy"> & { automatic?: true }): boolean {
  return build.reason === "runtime" && build.state === "succeeded" && build.createdBy === null && build.automatic === true
    && typeof build.snapshotId === "string" && build.snapshotId.includes("@");
}

/**
 * Folds each run of consecutive shared re-points (newest first, as the overview lists builds) into its newest row,
 * which counts the ones it stands for. A build in `keep` (the live one) is never folded away.
 */
export function foldSharedRepoints<T extends Pick<CloudV2Build, "id" | "reason" | "state" | "snapshotId" | "createdBy"> & { automatic?: true }>(
  builds: readonly T[], keep: ReadonlySet<string> = new Set()): (T & { repoints?: number })[] {
  const folded: (T & { repoints?: number })[] = [];
  for (const build of builds) {
    const head = folded[folded.length - 1];
    if (head && isSharedRepoint(build) && isSharedRepoint(head) && !keep.has(build.id)) {
      folded[folded.length - 1] = { ...head, repoints: (head.repoints ?? 1) + 1 };
      continue;
    }
    folded.push(build);
  }
  return folded;
}

export { removeSnapshot as removeSharedBaseSnapshot };

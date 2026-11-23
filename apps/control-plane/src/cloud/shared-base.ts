// Zeros's shared standard base: one Boat named snapshot per worker runtime with the runtime and Git LFS on Boat's stock
// image, and nothing private (no source, no credentials, no token). Organizations without an install script start
// from it, so they need no machine of their own. The builder makes it for the channel's pinned runtime whatever
// CLOUD_V2_READY_COPIES_ENABLED says; CLOUD_V2_SHARED_BASE_SNAPSHOT may pin a name or turn it off.
// Every name is recorded in cloud_v2_shared_bases (0268) before its save, and deleted only when nothing refers to it.
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { withSystemTx, type Tx } from "../db.js";
import type { CloudV2SharedBaseOverride } from "../config.js";
import type { CloudV2Compute } from "./boat.js";
import { installBase } from "./computer.js";
import { cloudV2BoatSnapshotName, cloudV2ResourcePrefix, cloudV2SandboxName, cloudV2SharedBaseName, cloudV2SharedSnapshotReference, cloudV2SnapshotName } from "./resource-names.js";
import { buildClaimAllowed } from "./runtime-build-drain.js";

/** The worker runtime a base installs. */
export type SharedBaseRuntime = { sha256: string; url(sha256?: string): Promise<string> };

// The one definition of what a base installs lives beside the Computer builder that also runs it (computer.ts), so an
// organization's own base and the shared base cannot drift; it is re-exported here.
export { installBase, type InstallBaseHooks } from "./computer.js";

/** Every outcome a shared base build reports; operators see these and names, nothing else. */
export const SHARED_BASE_CODES = [
  "shared_base_ready", "shared_base_exists", "shared_base_building", "shared_base_backoff", "shared_base_drain_held",
  "shared_base_off", "shared_base_planned", "shared_base_builder_refused", "worker_runtime_install_failed",
  "computer_snapshot_failed", "computer_snapshot_timeout", "shared_base_readback_failed", "shared_base_interrupted",
  "shared_base_rebuilds_exhausted", "shared_base_build_failed", "shared_base_missing",
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
  interruptions: number; missing_seen_at: Date | null;
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
      await tx.query("/* lock_purpose='cloud-v2-shared-base-claim' */ SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`cloud-v2-shared-base:${prefix}`]);
      await this.failInterrupted(tx, prefix);
      const decided = await this.decide(tx, scope, runtimeSha256, now);
      if (decided.kind !== "claimed") return decided;
      // The drain row is locked here, so a release that takes the drain waits for this claim or sees its build.
      if (!await buildClaimAllowed(tx)) return { kind: "drain_held" };
      const row = (await tx.query<SharedBaseRow>(
        `INSERT INTO cloud_v2_shared_bases (name, channel, runtime_sha256, rebuild, state, failures, interruptions, heartbeat_at)
         VALUES ($1, $2, $3, $4, 'building', $5, $6, clock_timestamp()) RETURNING *`,
        [decided.row.name, scope.channel, runtimeSha256, decided.row.rebuild, decided.row.failures, decided.row.interruptions])).rows[0]!;
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
    // Interruptions in a row carry on, so a fourth counts as a failure (failInterrupted); anything else starts them again.
    const interruptions = last?.state === "failed" && last.error_code === "shared_base_interrupted" && last.interruptions <= SHARED_BASE_INTERRUPTION_RETRIES
      ? last.interruptions : 0;
    return { kind: "claimed", row: { name: cloudV2SharedBaseName(scope.channel, runtimeSha256, rebuild, scope.localOwner), rebuild, failures,
      interruptions } as SharedBaseRow };
  }

  /** Fails builds whose process stopped beating, so cleanup can remove what they left. */
  async interrupted(scope: SharedBaseScope): Promise<void> {
    await withSystemTx(this.pool, tx => this.failInterrupted(tx, sharedBasePrefix(scope)));
  }

  /** A build whose process stopped beating (a deploy, a crash) was interrupted, not failed: the release drain does not
   * wait for shared builds (runtime-build-drain.ts counts Cloud Computer builds only), and on Alpha almost every merge
   * deploys. Up to three interruptions in a row retry at the next claim without counting toward the backoff; a fourth
   * counts as a failure, with the normal backoff. The previous base keeps serving meanwhile. */
  private async failInterrupted(tx: Tx, prefix: string): Promise<void> {
    await tx.query(`UPDATE cloud_v2_shared_bases SET state = 'failed', error_code = 'shared_base_interrupted', finished_at = clock_timestamp(),
        interruptions = interruptions + 1,
        failures = CASE WHEN interruptions + 1 > ${SHARED_BASE_INTERRUPTION_RETRIES} THEN failures + 1 ELSE failures END,
        next_attempt_at = CASE WHEN interruptions + 1 > ${SHARED_BASE_INTERRUPTION_RETRIES}
          THEN clock_timestamp() + least(interval '15 minutes' * power(2, least(failures, 16)), interval '6 hours') ELSE clock_timestamp() END
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

  /** The current base is the only ready one not superseded; a base that is current again (a rollback) is no longer superseded. */
  async supersede(scope: SharedBaseScope, current: string): Promise<void> {
    await withSystemTx(this.pool, async tx => {
      await tx.query(`UPDATE cloud_v2_shared_bases SET superseded_at = clock_timestamp()
        WHERE starts_with(name, $1) AND channel = $2 AND state = 'ready' AND superseded_at IS NULL AND name <> $3`, [sharedBasePrefix(scope), scope.channel, current]);
      await tx.query("UPDATE cloud_v2_shared_bases SET superseded_at = NULL WHERE name = $1 AND superseded_at IS NOT NULL", [current]);
    });
  }

  /** The missing-base sweep's reading of Boat for a name: absent (a 404) is recorded as a first sighting and only a second
   * scan in a row acts (true); present clears a sighting; unknown changes nothing. Names with no row (a pinned override)
   * keep their sightings in `memory`. */
  async sighting(name: string, reading: "present" | "absent" | "unknown", memory: Map<string, number>): Promise<boolean> {
    if (reading === "unknown") return false;
    const present = reading === "present";
    const row = (await withSystemTx(this.pool, tx => tx.query<{ seen_before: boolean }>(
      `WITH before AS (SELECT name, missing_seen_at FROM cloud_v2_shared_bases WHERE name = $1 FOR UPDATE)
       UPDATE cloud_v2_shared_bases s SET missing_seen_at = CASE WHEN $2 THEN NULL ELSE coalesce(s.missing_seen_at, clock_timestamp()) END
       FROM before WHERE s.name = before.name RETURNING (NOT $2 AND before.missing_seen_at IS NOT NULL) AS seen_before`, [name, present]))).rows[0];
    if (row) return row.seen_before === true;
    if (present) { memory.delete(name); return false; }
    const seen = memory.has(name);
    if (!seen) memory.set(name, Date.now());
    return seen;
  }

  /** Boat no longer has a ready base: it is failed at once (no backoff), so the next claim rebuilds it under a new name. */
  async missing(name: string): Promise<boolean> {
    const { rowCount } = await withSystemTx(this.pool, tx => tx.query(
      `UPDATE cloud_v2_shared_bases SET state = 'failed', error_code = 'shared_base_missing', missing_at = clock_timestamp(), failures = 0,
         next_attempt_at = clock_timestamp(), superseded_at = coalesce(superseded_at, clock_timestamp()) WHERE name = $1 AND state = 'ready'`, [name]));
    return !!rowCount;
  }

  /** Rows whose builder or failed save is left over: an interrupted build, a lost reply, a failed delete. */
  async leftovers(scope: SharedBaseScope, limit = 20): Promise<SharedBaseRow[]> {
    return (await withSystemTx(this.pool, tx => tx.query<SharedBaseRow>(
      `SELECT * FROM cloud_v2_shared_bases WHERE starts_with(name, $1) AND channel = $2 AND state <> 'building'
         AND ((builder_sandbox_id IS NOT NULL AND builder_deleted_at IS NULL) OR builder_create_pending
           OR (state = 'failed' AND save_requested_at IS NOT NULL AND deleted_at IS NULL))
       ORDER BY created_at LIMIT $3`, [sharedBasePrefix(scope), scope.channel, limit]))).rows;
  }

  async row(name: string): Promise<SharedBaseRow | null> {
    return (await withSystemTx(this.pool, tx => tx.query<SharedBaseRow>("SELECT * FROM cloud_v2_shared_bases WHERE name = $1", [name]))).rows[0] ?? null;
  }

  async hasRows(scope: SharedBaseScope): Promise<boolean> {
    return (await withSystemTx(this.pool, tx => tx.query("SELECT 1 FROM cloud_v2_shared_bases WHERE starts_with(name, $1) AND channel = $2 LIMIT 1",
      [sharedBasePrefix(scope), scope.channel]))).rowCount! > 0;
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

// Folding consecutive shared re-points in the Computer history lives with the overview that uses it (computer.ts).
export { foldSharedRepoints, isSharedRepoint } from "./computer.js";

/** Interruptions in a row that retry at once (failInterrupted). */
export const SHARED_BASE_INTERRUPTION_RETRIES = 3;
/** How long a superseded base is kept before deletion may take it (references are checked as well): the resolver caches a
 * minute, and the worker installs the pinned runtime at boot, so no rollback needs an old image. */
export const SHARED_BASE_SUPERSEDED_KEEP = "24 hours";

/** How often the builder's hooks run. */
export const SHARED_BASE_CLAIM_MS = 60_000;
export const SHARED_BASE_REPOINT_MS = 60_000;
export const SHARED_BASE_MISSING_SCAN_MS = 10 * 60_000;
export const SHARED_BASE_DELETION_MS = 60 * 60_000;
export const SHARED_BASE_INVENTORY_MS = 24 * 60 * 60_000;
/** Organizations moved to the current shared base per re-point pass. */
export const SHARED_BASE_REPOINT_LIMIT = 100;

function notFound(error: unknown): boolean {
  const value = error as { code?: unknown; httpStatus?: unknown } | null;
  return typeof value === "object" && value !== null && (value.httpStatus === 404 || value.code === "provider_not_found");
}

/** Removes leftover builders (replaying an uncertain create by its key) and saves a failed build may have made. */
export async function cleanupSharedBaseBuilders(deps: Pick<SharedBaseBuildDeps, "bases" | "compute">, scope: SharedBaseScope): Promise<void> {
  const { bases, compute } = deps;
  for (const row of await bases.leftovers(scope)) {
    try {
      let sandboxId = row.builder_sandbox_id;
      if (!sandboxId && row.builder_create_pending) {
        try { ({ sandboxId } = await compute.create(sharedBaseBuilderInput(scope, row.build_id))); }
        catch (error) { if (!notFound(error)) throw error; }
      }
      if (sandboxId && !row.builder_deleted_at) await compute.delete(sandboxId);
      if (sandboxId || row.builder_create_pending) await bases.builderGone(row.name);
      if (row.state === "failed" && row.save_requested_at && !row.deleted_at) await removeSnapshot(deps, row.name);
    } catch { /* Tried again at the next pass. */ }
  }
}

/** Sightings of names with no row, when the caller keeps none of its own (one process's memory). */
const memorySightings = new Map<string, number>();

export type SharedBaseSweepDeps = SharedBaseBuildDeps & {
  /** The missing-base sweep's first sightings of names with no row (a pinned override). */
  sightings?: Map<string, number>;
  pool: pg.Pool;
  scope: SharedBaseScope;
  runtime: SharedBaseRuntime;
  /** CLOUD_V2_RUNTIME_PREVIOUS_SHA256: its base is kept for a rollback. */
  previousRuntimeSha256?: string | undefined;
  override?: CloudV2SharedBaseOverride | null;
};

/**
 * The builder's claim, each tick, whenever cloud is enabled on the channel, whatever CLOUD_V2_READY_COPIES_ENABLED
 * says: this runtime's base is built once (one builder machine per runtime release), retried after its backoff.
 * Off (CLOUD_V2_SHARED_BASE_SNAPSHOT=off) builds nothing; a pinned name still builds, ready for when the pin goes.
 * A claimed build runs to its end here (minutes): the builder runs this beside admission, never before it.
 */
export async function claimSharedBaseBuild(deps: SharedBaseSweepDeps, now?: Date): Promise<SharedBaseBuildResult> {
  const runtime12 = deps.runtime.sha256.slice(0, 12);
  if (deps.override?.kind === "off") return { code: "shared_base_off", name: null, runtime12 };
  await deps.bases.interrupted(deps.scope);
  await cleanupSharedBaseBuilders(deps, deps.scope);
  const result = await buildSharedBase(deps, { ...deps.scope, runtime: deps.runtime, mode: "execute", ...(now ? { now } : {}) });
  const current = await deps.bases.state(deps.scope, deps.runtime.sha256);
  if (current.state === "ready") await deps.bases.supersede(deps.scope, current.name);
  return result;
}

let automaticColumn: Promise<boolean> | null = null;
/** 0267 (ready copies' safe switch-on) adds cloud_v2_computer_builds.automatic; a re-point is automatic once it exists. */
async function hasAutomaticColumn(tx: Tx): Promise<boolean> {
  automaticColumn ??= tx.query<{ found: boolean }>(`SELECT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'cloud_v2_computer_builds' AND column_name = 'automatic') AS found`)
    .then(result => result.rows[0]?.found === true, error => { automaticColumn = null; throw error; });
  return automaticColumn;
}

/**
 * Moves organizations whose live build is a shared base other than `current` onto it, at most `limit` per pass:
 * under the organization lock, a new automatic shared build (reason runtime, so no ready copy is marked stale; copies
 * take the new base at their own next refresh) becomes live, as #1260's insertSharedBase writes one. The old build
 * keeps its reference while a workspace or recovery pins it; ordinary cleanup then clears only that reference.
 * Nobody moves unless Boat has `current` now.
 */
export async function repointOrganizations(pool: pg.Pool, compute: CloudV2Compute, input: {
  current: { name: string; runtimeSha256: string | null }; limit?: number; from?: string;
  onRepointed?(organizationId: string): Promise<void>;
}): Promise<{ repointed: string[] }> {
  const { current } = input;
  const candidates = (await withSystemTx(pool, tx => tx.query<{ org_id: string; snapshot_name: string; active_build_id: string }>(
    `SELECT c.org_id, c.snapshot_name, c.active_build_id FROM cloud_v2_computers c
     JOIN cloud_v2_computer_builds b ON b.id = c.active_build_id AND b.org_id = c.org_id AND b.state = 'succeeded' AND b.base_shared
     JOIN organizations o ON o.id = c.org_id AND o.deleted_at IS NULL AND o.lifecycle_status = 'active'
     WHERE position('@' in c.snapshot_name) > 0 AND split_part(c.snapshot_name, '@', 1) <> $1
       AND ($3::text IS NULL OR split_part(c.snapshot_name, '@', 1) = $3)
       AND NOT EXISTS (SELECT 1 FROM cloud_v2_computer_builds q WHERE q.org_id = c.org_id AND q.state IN ('queued', 'building'))
     ORDER BY c.updated_at, c.org_id LIMIT $2`,
    [current.name, Math.max(1, Math.min(input.limit ?? SHARED_BASE_REPOINT_LIMIT, 1000)), input.from ?? null]))).rows;
  if (!candidates.length || !await exists(compute, current.name)) return { repointed: [] };
  const repointed: string[] = [];
  for (const candidate of candidates) {
    const moved = await withSystemTx(pool, async tx => {
      const org = await tx.query("SELECT 1 FROM organizations WHERE id = $1 AND deleted_at IS NULL AND lifecycle_status = 'active' FOR UPDATE", [candidate.org_id]);
      if (!org.rowCount) return false;
      // Re-read under the lock: a build or another pass may have moved it meanwhile.
      const still = await tx.query(`SELECT 1 FROM cloud_v2_computers c WHERE c.org_id = $1 AND c.active_build_id = $2 AND c.snapshot_name = $3
          AND NOT EXISTS (SELECT 1 FROM cloud_v2_computer_builds q WHERE q.org_id = c.org_id AND q.state IN ('queued', 'building'))
        FOR UPDATE OF c`, [candidate.org_id, candidate.active_build_id, candidate.snapshot_name]);
      if (!still.rowCount) return false;
      const id = randomUUID(), reference = cloudV2SharedSnapshotReference(current.name, id), automatic = await hasAutomaticColumn(tx);
      await tx.query(
        `INSERT INTO cloud_v2_computer_builds (id, org_id, version, recipe, state, created_by, reason, base_snapshot, runtime_sha256, source_targets,
           source_policy_version, base_only, base_shared${automatic ? ", automatic" : ""}, snapshot_id, started_at, finished_at)
         VALUES ($1, $2, coalesce((SELECT max(version) FROM cloud_v2_computer_builds WHERE org_id = $2), 0) + 1, '{"repositories":[]}', 'succeeded', NULL,
           'runtime', $3, $4, '[]', 2, true, true${automatic ? ", true" : ""}, $5, clock_timestamp(), clock_timestamp())`,
        [id, candidate.org_id, candidate.snapshot_name, current.runtimeSha256, reference]);
      await tx.query("UPDATE cloud_v2_computers SET active_build_id = $2, snapshot_name = $3, updated_at = clock_timestamp() WHERE org_id = $1",
        [candidate.org_id, id, reference]);
      return true;
    }).catch(() => false);
    if (!moved) continue;
    repointed.push(candidate.org_id);
    await input.onRepointed?.(candidate.org_id).catch(() => {});
  }
  return { repointed };
}

/**
 * Deletes old shared bases nothing needs: never the current one, a kept one (a pinned override), or the previous
 * runtime's (kept for a rollback; the newest base of another runtime when CLOUD_V2_RUNTIME_PREVIOUS_SHA256 is unset);
 * only 24 hours after it was superseded; and only with no reference left: no live pointer, no build row still holding
 * it, no ready copy being built from it. A stale resolver cache (a minute at most) cannot activate a base superseded a
 * week ago, so no new reference appears between this check and the delete. The row is marked deleted only after Boat
 * reads it back gone.
 */
export async function deleteSupersededSharedBases(deps: SharedBaseSweepDeps & { keep?: readonly string[]; limit?: number }): Promise<{ deleted: string[] }> {
  const { pool, scope } = deps;
  const current = await deps.bases.state(scope, deps.runtime.sha256);
  const keep = [...(deps.keep ?? []), ...(current.state === "ready" ? [current.name] : []),
    ...(deps.override?.kind === "name" ? [deps.override.name] : [])];
  const names = (await withSystemTx(pool, tx => tx.query<{ name: string }>(
    `SELECT s.name FROM cloud_v2_shared_bases s
     WHERE starts_with(s.name, $1) AND s.channel = $2 AND s.state = 'ready' AND s.deleted_at IS NULL
       AND s.superseded_at < clock_timestamp() - interval '${SHARED_BASE_SUPERSEDED_KEEP}'
       AND s.name <> ALL($3::text[]) AND s.runtime_sha256 <> $4 AND s.runtime_sha256 <> coalesce($5, '')
       AND ($5::text IS NOT NULL OR s.name <> coalesce((SELECT p.name FROM cloud_v2_shared_bases p
         WHERE starts_with(p.name, $1) AND p.channel = $2 AND p.state = 'ready' AND p.runtime_sha256 <> $4
         ORDER BY p.ready_at DESC, p.name DESC LIMIT 1), ''))
       AND NOT EXISTS (SELECT 1 FROM cloud_v2_computers c WHERE c.snapshot_name = s.name OR c.snapshot_name LIKE s.name || '@%')
       AND NOT EXISTS (SELECT 1 FROM cloud_v2_computer_builds b WHERE (b.snapshot_id = s.name OR b.snapshot_id LIKE s.name || '@%')
         AND b.snapshot_deleted_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM cloud_v2_ready_copies r WHERE r.state = 'building'
         AND (r.built_from_base = 'snapshot:' || s.name OR r.built_from_base LIKE 'snapshot:' || s.name || '@%'))
     ORDER BY s.superseded_at, s.name LIMIT $6`,
    [sharedBasePrefix(scope), scope.channel, keep, deps.runtime.sha256, deps.previousRuntimeSha256 ?? null, deps.limit ?? 10]))).rows;
  const deleted: string[] = [];
  for (const { name } of names) {
    const gone = await removeSnapshot(deps, name, "deleted").catch(() => false);
    if (gone) deleted.push(name);
    else deps.logger?.warn(`[cloud-v2] shared base deletion unconfirmed name=${name}`);
  }
  return { deleted };
}

/**
 * Every 10 minutes: whether Boat still has the current base and every shared base something refers to. A missing
 * one is logged, its row failed (the next claim rebuilds it under a new name), and the organizations on it moved to
 * the newest base Boat has, or, with none, left without a live base (as sharedBaseMissing does), so their next
 * create builds one under the automatic budget instead of failing at Boat.
 */
export async function checkMissingSharedBases(deps: SharedBaseSweepDeps & { onRepointed?(organizationId: string): Promise<void> }):
  Promise<{ missing: string[]; repointed: string[]; cleared: string[] }> {
  const { pool, scope, bases, compute } = deps;
  const current = await sharedBaseState(bases, { ...scope, runtimeSha256: deps.runtime.sha256, override: deps.override ?? null });
  const referenced = (await withSystemTx(pool, tx => tx.query<{ name: string }>(
    `SELECT DISTINCT split_part(c.snapshot_name, '@', 1) AS name FROM cloud_v2_computers c
       JOIN cloud_v2_computer_builds b ON b.id = c.active_build_id AND b.org_id = c.org_id AND b.base_shared
       WHERE position('@' in c.snapshot_name) > 0
     UNION SELECT DISTINCT split_part(b.snapshot_id, '@', 1) FROM cloud_v2_computer_builds b
       WHERE b.base_shared AND b.snapshot_deleted_at IS NULL AND position('@' in b.snapshot_id) > 0
     LIMIT 50`))).rows.map(row => row.name);
  const names = [...new Set([...(current.state === "ready" ? [current.name] : []), ...referenced])];
  const missing: string[] = [];
  for (const name of names) {
    // Proven before it acts: an explicit 404 (never a status other than ready, never an error) on two scans in a row.
    const reading = compute.snapshotState ? await compute.snapshotState(name).catch(() => "unknown" as const) : "unknown";
    const second = await bases.sighting(name, reading, deps.sightings ?? memorySightings);
    if (reading === "absent" && !second) { deps.logger?.warn(`[cloud-v2] shared base not found once name=${name}; checking again at the next scan`); continue; }
    if (!second) continue;
    missing.push(name);
    deps.logger?.warn(`[cloud-v2] shared base missing name=${name}`);
    await bases.missing(name);
  }
  const repointed: string[] = [], cleared: string[] = [];
  for (const name of missing) {
    const replacement = await presentReadyBase(deps, new Set(missing));
    if (replacement) {
      repointed.push(...(await repointOrganizations(pool, compute, { current: replacement, from: name,
        ...(deps.onRepointed ? { onRepointed: deps.onRepointed } : {}) })).repointed);
      continue;
    }
    cleared.push(...await clearSharedPointers(pool, name));
  }
  return { missing, repointed, cleared };
}

/** The newest ready base of this deployment that Boat has now, preferring this runtime's. */
async function presentReadyBase(deps: SharedBaseSweepDeps, skip: ReadonlySet<string>): Promise<{ name: string; runtimeSha256: string } | null> {
  if (deps.override?.kind === "off") return null;
  const rows = (await deps.bases.rows(deps.scope)).filter(row => row.state === "ready" && !skip.has(row.name))
    .sort((a, b) => Number(b.runtime_sha256 === deps.runtime.sha256) - Number(a.runtime_sha256 === deps.runtime.sha256)
      || (b.ready_at?.getTime() ?? 0) - (a.ready_at?.getTime() ?? 0));
  for (const row of rows.slice(0, 3))
    if (await exists(deps.compute, row.name).catch(() => false)) return { name: row.name, runtimeSha256: row.runtime_sha256 };
  return null;
}

/** sharedBaseMissing for every organization whose live base is this name, a bounded number per pass. */
async function clearSharedPointers(pool: pg.Pool, name: string): Promise<string[]> {
  const organizations = (await withSystemTx(pool, tx => tx.query<{ org_id: string }>(
    `SELECT c.org_id FROM cloud_v2_computers c JOIN cloud_v2_computer_builds b ON b.id = c.active_build_id AND b.org_id = c.org_id AND b.base_shared
     WHERE position('@' in c.snapshot_name) > 0 AND split_part(c.snapshot_name, '@', 1) = $1 ORDER BY c.org_id LIMIT $2`,
    [name, SHARED_BASE_REPOINT_LIMIT]))).rows.map(row => row.org_id);
  const cleared: string[] = [];
  for (const organizationId of organizations) {
    const changed = await withSystemTx(pool, async tx => {
      const org = await tx.query("SELECT 1 FROM organizations WHERE id = $1 AND deleted_at IS NULL FOR UPDATE", [organizationId]);
      if (!org.rowCount) return false;
      const result = await tx.query(`UPDATE cloud_v2_computers c SET active_build_id = NULL, snapshot_name = NULL, updated_at = clock_timestamp()
        FROM cloud_v2_computer_builds b WHERE c.org_id = $1 AND b.id = c.active_build_id AND b.org_id = c.org_id AND b.base_shared
          AND position('@' in c.snapshot_name) > 0 AND split_part(c.snapshot_name, '@', 1) = $2`, [organizationId, name]);
      return !!result.rowCount;
    }).catch(() => false);
    if (changed) cleared.push(organizationId);
  }
  return cleared;
}

export type SharedBaseInventory = {
  listed: number; accounted: number;
  /** This deployment's names no row accounts for. Reported, never deleted. */
  unaccounted: string[];
  allowance: { included: number; used: number; extra: number } | null;
};

/**
 * Daily: Boat's named snapshots under this deployment's prefix, against every name a row accounts for (shared bases
 * not yet deleted, and Computer builds' snapshots not yet deleted, an organization's shared reference read as the
 * base it names). Anything else is reported as a count and never deleted: this cannot tell whose it is. Use beyond
 * the account's included snapshots is an information line, as Boat's plan sets how many are included.
 */
export async function dailySnapshotInventory(deps: Pick<SharedBaseSweepDeps, "pool" | "compute" | "scope" | "logger">): Promise<SharedBaseInventory | null> {
  const { pool, compute, scope } = deps;
  if (!compute.listNamedSnapshots) return null;
  const listed = await compute.listNamedSnapshots();
  const prefix = cloudV2ResourcePrefix(scope.channel, scope.localOwner);
  const ours = [...new Set(listed.snapshots.map(snapshot => snapshot.name).filter(name => name.startsWith(prefix)))];
  const known = await withSystemTx(pool, async tx => {
    const shared = (await tx.query<{ name: string }>("SELECT name FROM cloud_v2_shared_bases WHERE starts_with(name, $1) AND deleted_at IS NULL",
      [prefix])).rows.map(row => row.name);
    const builds = (await tx.query<{ snapshot_id: string | null; org_id: string; version: number; cleanup_requested_at: Date | null }>(
      `SELECT snapshot_id, org_id, version, cleanup_requested_at FROM cloud_v2_computer_builds
       WHERE snapshot_deleted_at IS NULL AND (snapshot_id IS NOT NULL OR cleanup_requested_at IS NOT NULL)`)).rows;
    // Older builds may have cleared snapshot_id before a failed delete; their names are deterministic (computer.ts cleanup).
    return new Set([...shared, ...builds.map(build => build.snapshot_id ? cloudV2BoatSnapshotName(build.snapshot_id)
      : cloudV2SnapshotName(scope.channel, build.org_id, build.version, scope.localOwner))]);
  });
  const unaccounted = ours.filter(name => !known.has(name)).sort();
  const result: SharedBaseInventory = { listed: ours.length, accounted: ours.length - unaccounted.length, unaccounted,
    allowance: listed.allowance ? { included: listed.allowance.included, used: listed.allowance.used, extra: listed.allowance.extra } : null };
  const line = `[cloud-v2] named snapshot inventory channel=${scope.channel} listed=${result.listed} accounted=${result.accounted} unaccounted=${unaccounted.length}`;
  if (unaccounted.length) deps.logger?.warn(line); else deps.logger?.info(line);
  if (result.allowance && result.allowance.extra > 0)
    deps.logger?.info(`[cloud-v2] named snapshot allowance used=${result.allowance.used} included=${result.allowance.included} extra=${result.allowance.extra}`);
  return result;
}

/**
 * The builder's shared base hooks at their cadences, for one tick: cleanup and the build claim every minute (in the
 * background, one at a time), the re-point every minute, the missing-base check every 10 minutes, deletion hourly and the
 * inventory daily. Each hook's failure is logged and retried at its next turn; none blocks the others.
 */
export class CloudV2SharedBaseSweeper {
  private building: Promise<unknown> | null = null;
  private readonly last = { claim: -Infinity, repoint: -Infinity, missing: -Infinity, deletion: -Infinity, inventory: -Infinity };

  constructor(private readonly deps: SharedBaseSweepDeps & { onRepointed?(organizationId: string): Promise<void>; now?: () => number }) {}

  async tick(): Promise<void> {
    const deps = this.deps, now = deps.now?.() ?? Date.now();
    // Off (CLOUD_V2_SHARED_BASE_SNAPSHOT=off): none of the shared base's hooks run, its inventory included.
    if (deps.override?.kind === "off") return;
    // A Local control plane (a developer's own) builds no shared base unless asked (a name or auto): every runtime sha a
    // developer builds would otherwise leave a zeros-local-… snapshot on the shared Boat account. Its other hooks run only
    // once it has rows of its own (the CLI's --execute still builds one on purpose).
    const local = deps.scope.localOwner !== undefined && deps.override?.kind !== "auto" && deps.override?.kind !== "name";
    if (local && !await deps.bases.hasRows(deps.scope).catch(() => false)) return;
    const due = (key: keyof typeof this.last, every: number) => {
      if (now - this.last[key] < every) return false;
      this.last[key] = now;
      return true;
    };
    const warn = (what: string) => () => deps.logger?.warn(`[cloud-v2] shared base ${what} will retry`);
    if (!local && !this.building && due("claim", SHARED_BASE_CLAIM_MS))
      this.building = claimSharedBaseBuild(deps).catch(warn("build")).finally(() => { this.building = null; });
    if (due("repoint", SHARED_BASE_REPOINT_MS)) {
      const current = await sharedBaseState(deps.bases, { ...deps.scope, runtimeSha256: deps.runtime.sha256, override: deps.override ?? null }).catch(() => null);
      if (current?.state === "ready")
        await repointOrganizations(deps.pool, deps.compute, { current: { name: current.name, runtimeSha256: current.runtimeSha256 ?? null },
          ...(deps.onRepointed ? { onRepointed: deps.onRepointed } : {}) }).catch(warn("re-point"));
    }
    if (due("missing", SHARED_BASE_MISSING_SCAN_MS)) await checkMissingSharedBases(deps).catch(warn("check"));
    if (due("deletion", SHARED_BASE_DELETION_MS)) await deleteSupersededSharedBases(deps).catch(warn("deletion"));
    if (due("inventory", SHARED_BASE_INVENTORY_MS)) await dailySnapshotInventory(deps).catch(warn("inventory"));
  }

  /** Waits for a build started by tick (tests and shutdown). */
  async settled(): Promise<void> { await this.building; }
}

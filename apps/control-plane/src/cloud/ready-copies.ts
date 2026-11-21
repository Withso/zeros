// Ready copies: one stopped Boat machine per organization, repository and
// generation, fully cloned and set up from the Cloud Computer base. New
// workspaces fork the ready generation; without one they take the direct
// clone path as before. Only composed when CloudV2Config.readyCopies is on.
//
// Every provider call is keyed: a generation's machine by its idempotency key,
// a workspace's fork by `ready-copy-fork:<workspace>`. A lost reply replays the
// key. Nothing is ever found by name, since Boat names every fork
// "<source name> fork". A copy only becomes ready once stopped, and a newer
// generation replaces it in one transaction; the old machine is deleted only
// after every fork that began from it has its machine.
import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { withSystemTx, type Tx } from "../db.js";
import { HttpError } from "../authz.js";
import { CLOUD_V2_LEASE_SECONDS, type CloudV2Compute } from "./boat.js";
import { BoatCreateRejectedError, BoatForkRefusedError, BoatSnapshotExpiredError } from "./boat-client.js";
import { CloudProviderError } from "./provider-error.js";
import { asZeros, checkoutScript, shellQuote } from "./computer.js";
import { installRuntimeCommand, type CloudV2Runtime } from "./runtime.js";
import { cloudV2BoatSnapshotName, cloudV2SandboxName } from "./resource-names.js";
import type { CloudSourceTarget } from "./source-authority.js";
import type { ReadyCopySecrets } from "./ready-copy-secrets.js";

const DAY_MS = 24 * 60 * 60_000;
/** A ready copy is rebuilt after this, so Boat never deletes its stopped disk (14 days after its stop). */
export const READY_COPY_REFRESH_MS = 7 * DAY_MS;
/** Past this a copy is never forked and is marked stale: Boat deletes its disk a day later. */
export const READY_COPY_EXPIRY_MS = 13 * DAY_MS;
/** Copies no workspace forked for this long are no longer refreshed; the row stays. */
export const READY_COPY_UNUSED_MS = 60 * DAY_MS;
/** A private repository's copy is no longer refreshed after this unforked. */
export const READY_COPY_PRIVATE_UNUSED_MS = 14 * DAY_MS;
/** Refresh starts across the deployment; first copies are never held back. */
export const READY_COPY_REFRESH_STARTS = { perMinute: 12, perHour: 60 } as const;
/** A create waits this long for a copy that is building, then clones directly. */
export const READY_COPY_FORK_WAIT_MS = 90_000;
const FORK_WAIT_POLL_MS = 3_000;
/** Boat keeps an idempotency key for 24 hours. */
const KEY_WINDOW_MS = 23 * 60 * 60_000;
/** A build whose server stopped beating is failed after this. */
const INTERRUPTED_MS = 5 * 60_000;
/** A failed generation is not retried sooner than this. */
/** A generation that failed is retried after 1 hour, then twice as long each
 * time, at most a day apart, and not at all after READY_COPY_RETRY_LIMIT
 * failures in a row: one that fails for its setup would otherwise rebuild a
 * whole repository every hour forever. Anything that could fix it (a new base,
 * install script, setup, branch, build secrets or private entry, all in the
 * inputs fingerprint) or an admin's Retry now starts it over. */
export const READY_COPY_RETRY_FIRST_MS = 60 * 60_000;
export const READY_COPY_RETRY_MAX_MS = 24 * 60 * 60_000;
export const READY_COPY_RETRY_LIMIT = 5;
export type ReadyCopyRetry = { failures: number; nextAt: Date | null; allowed: boolean };
const HEARTBEAT_MS = 60_000;
const ARCHIVE_READS = 24, ARCHIVE_WAIT_MS = 5_000;
const READY_ATTEMPTS = 36, READY_WAIT_MS = 5_000;
const MAX_LOG_BYTES = 64 * 1024;

export type ReadyCopyState = "building" | "ready" | "failed" | "retired";
/** Why a generation ran, stored when it was queued. */
export type ReadyCopyTrigger = "repository_added" | "weekly_update" | "computer_build" | "setup_changed" | "branch_changed" | "secrets_changed" | "retry" | "manual";
/** Generations whose detail (setup output, location) is kept per repository; older rows keep only their result. */
export const READY_COPY_HISTORY_LIMIT = 20;
/** The last part of a failed setup's output that is kept, redacted. */
export const READY_COPY_OUTPUT_BYTES = 16 * 1024;
/** Build now: at most one manual start per repository in this long. */
export const READY_COPY_MANUAL_INTERVAL_MS = 10 * 60_000;
export type CloudV2ReadyCopy = {
  id: string; organizationId: string; repository: string; repositoryId: string; generation: number; state: ReadyCopyState;
  /** A private repository's member; null for a shared repository. */
  ownerUserId: string | null;
  idempotencyKey: string; machineId: string | null; machinePending: boolean; builtFromBase: string | null;
  computerBuildId: string | null; createdBy: string | null; branch: string | null; commit: string | null;
  failureReason: string | null; failureDetail: string | null; stale: boolean; refresh: boolean; machineDeletedAt: Date | null;
  inputs: string | null; manualRetry: boolean; trigger: ReadyCopyTrigger | null; triggeredBy: string | null;
  setupOutput: string | null; detailPrunedAt: Date | null;
  stoppedAt: Date | null; lastForkedAt: Date | null; createdAt: Date; startedAt: Date | null; finishedAt: Date | null;
};
type Row = {
  id: string; org_id: string; repository: string; repository_id: string; generation: number; state: ReadyCopyState;
  owner_user_id: string | null; idempotency_key: string; machine_id: string | null; machine_pending: boolean; built_from_base: string | null;
  computer_build_id: string | null; created_by: string | null; branch: string | null; commit_sha: string | null;
  failure_reason: string | null; failure_detail: string | null; stale: boolean; refresh: boolean; machine_deleted_at: Date | null;
  inputs: string | null; manual_retry: boolean; trigger: ReadyCopyTrigger | null; triggered_by: string | null;
  setup_output: string | null; detail_pruned_at: Date | null;
  stopped_at: Date | null; last_forked_at: Date | null; created_at: Date; started_at: Date | null; finished_at: Date | null;
};
const copy = (row: Row): CloudV2ReadyCopy => ({
  id: row.id, organizationId: row.org_id, repository: row.repository, repositoryId: row.repository_id, generation: row.generation,
  state: row.state, ownerUserId: row.owner_user_id, idempotencyKey: row.idempotency_key, machineId: row.machine_id, machinePending: row.machine_pending,
  builtFromBase: row.built_from_base, computerBuildId: row.computer_build_id, createdBy: row.created_by, branch: row.branch,
  commit: row.commit_sha, failureReason: row.failure_reason, failureDetail: row.failure_detail, stale: row.stale, refresh: row.refresh,
  machineDeletedAt: row.machine_deleted_at, inputs: row.inputs, manualRetry: row.manual_retry, trigger: row.trigger,
  triggeredBy: row.triggered_by, setupOutput: row.setup_output, detailPrunedAt: row.detail_pruned_at, stoppedAt: row.stopped_at,
  lastForkedAt: row.last_forked_at, createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at,
});

/** The organization's live base-only Cloud Computer build: only such a base
 * holds no repository source, so only it may start a ready copy. */
export type ReadyCopyBase = {
  buildId: string; snapshot: string; createdBy: string; shared: boolean;
  repositories: { repository: string; ref?: string; setup?: string; branch?: string }[];
  sources: CloudSourceTarget[];
};

export type ReadyCopyFork = { copyId: string; key: string; machineId: string; sandboxId: string | null; requestedAt: Date };

/** Lock order, for every transaction that touches these rows: the
 * organization row (Cloud Computer and deletion paths), then ready copy rows
 * in ascending id, then Cloud Computer build rows. A transaction takes the
 * strongest lock it will need on a row the first time it touches it and never
 * upgrades one (a shared lock followed by a write to the same row deadlocks two
 * creates); multi-row writes lock through an id-ordered subquery. */
export class CloudV2ReadyCopies {
  constructor(private readonly pool: pg.Pool) {}

  private tx<T>(work: (tx: Tx) => Promise<T>): Promise<T> { return withSystemTx(this.pool, work); }

  async base(organizationId: string): Promise<ReadyCopyBase | null> {
    const row = (await this.tx(tx => tx.query<{ id: string; snapshot_name: string; created_by: string | null; base_shared: boolean;
      recipe: { repositories?: ReadyCopyBase["repositories"] }; source_targets: unknown;
      configured: { repositories?: ReadyCopyBase["repositories"] } | null; configured_targets: unknown }>(
      `SELECT b.id, c.snapshot_name, b.created_by, b.base_shared, b.recipe, b.source_targets,
         c.recipe AS configured, c.recipe_source_targets AS configured_targets FROM cloud_v2_computers c
       JOIN cloud_v2_computer_builds b ON b.id=c.active_build_id AND b.org_id=c.org_id AND b.state='succeeded' AND b.base_only
       JOIN organizations o ON o.id=c.org_id AND o.deleted_at IS NULL AND o.lifecycle_status='active' AND o.cloud_workspaces_allowed
       WHERE c.org_id=$1 AND c.snapshot_name IS NOT NULL`, [organizationId]))).rows[0];
    if (!row?.created_by) return null;
    // A repository's setup and branch are read as configured: saving them rebuilds that
    // repository's copy without a Cloud Computer build. Verified branches come from the build.
    const configured = Array.isArray(row.configured?.repositories) && Array.isArray(row.configured_targets)
      && row.configured!.repositories!.length === (row.configured_targets as unknown[]).length;
    const built = row.recipe.repositories ?? [];
    const repositories = configured ? row.configured!.repositories!.map(entry => {
      const live = built.find(candidate => candidate.repository.toLowerCase() === entry.repository.toLowerCase());
      return { ...entry, ...(live?.branch && (live.ref ?? null) === (entry.ref ?? null) ? { branch: live.branch } : {}) };
    }) : built;
    const sources = (configured ? row.configured_targets : Array.isArray(row.source_targets) ? row.source_targets : []) as CloudSourceTarget[];
    return { buildId: row.id, snapshot: row.snapshot_name, createdBy: row.created_by, shared: row.base_shared, repositories, sources };
  }

  /** Queues a generation, or joins the one already building for this repository. */
  async request(input: { organizationId: string; repository: string; repositoryId: string; createdBy: string; computerBuildId: string;
    builtFromBase: string; refresh?: boolean; now?: Date; ownerUserId?: string | null; inputs?: string | null; manualRetry?: boolean;
    trigger?: ReadyCopyTrigger; triggeredBy?: string | null }): Promise<CloudV2ReadyCopy> {
    const repository = input.repository.toLowerCase(), id = randomUUID(), owner = input.ownerUserId ?? null;
    return this.tx(async tx => {
      await tx.query(
        `INSERT INTO cloud_v2_ready_copies (id, org_id, repository, repository_id, generation, state, idempotency_key, built_from_base,
           computer_build_id, created_by, refresh, created_at, updated_at, owner_user_id, inputs, manual_retry, trigger, triggered_by)
         VALUES ($1,$2,$3,$4,coalesce((SELECT max(generation) FROM cloud_v2_ready_copies
             WHERE org_id=$2 AND repository=$3 AND owner_user_id IS NOT DISTINCT FROM $11::uuid),0)+1,
           'building',$5,$6,$7,$8,$9,coalesce($10,clock_timestamp()),coalesce($10,clock_timestamp()),$11,$12,$13,$14,$15)
         ON CONFLICT (org_id, repository, owner_user_id) WHERE state='building' DO NOTHING`,
        [id, input.organizationId, repository, input.repositoryId, `ready-copy:${id}`, input.builtFromBase, input.computerBuildId,
          input.createdBy, input.refresh === true, input.now ?? null, owner, input.inputs ?? null, input.manualRetry === true,
          input.trigger ?? null, input.triggeredBy ?? null]);
      return copy((await tx.query<Row>(`SELECT * FROM cloud_v2_ready_copies WHERE org_id=$1 AND repository=$2 AND state='building'
        AND owner_user_id IS NOT DISTINCT FROM $3::uuid`, [input.organizationId, repository, owner])).rows[0]!);
    });
  }

  async get(id: string): Promise<CloudV2ReadyCopy | null> {
    const row = (await this.tx(tx => tx.query<Row>("SELECT * FROM cloud_v2_ready_copies WHERE id=$1", [id]))).rows[0];
    return row ? copy(row) : null;
  }

  async list(organizationId: string, repository?: string): Promise<CloudV2ReadyCopy[]> {
    const { rows } = await this.tx(tx => tx.query<Row>(
      `SELECT * FROM cloud_v2_ready_copies WHERE org_id=$1 AND ($2::text IS NULL OR repository=$2) ORDER BY repository, generation`,
      [organizationId, repository?.toLowerCase() ?? null]));
    return rows.map(copy);
  }

  /** Each repository's latest generation that failed after its last ready
   * one, for the Cloud Computer page. Detail is a path at most. */
  async failures(organizationId: string): Promise<{ repository: string; generation: number; reason: string; detail: string | null; finishedAt: string }[]> {
    const { rows } = await this.tx(tx => tx.query<{ repository: string; generation: number; failure_reason: string; failure_detail: string | null; finished_at: Date }>(
      // Shared copies only: a member's private copy never reaches the admin's page.
      `SELECT DISTINCT ON (f.repository) f.repository, f.generation, f.failure_reason, f.failure_detail, f.finished_at
       FROM cloud_v2_ready_copies f WHERE f.org_id=$1 AND f.owner_user_id IS NULL AND f.state='failed' AND f.failure_reason IS NOT NULL AND f.finished_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM cloud_v2_ready_copies n WHERE n.org_id=f.org_id AND n.repository=f.repository AND n.owner_user_id IS NULL
           AND n.generation>f.generation AND n.state IN ('ready','retired'))
       ORDER BY f.repository, f.generation DESC`, [organizationId]));
    return rows.map(row => ({ repository: row.repository, generation: row.generation, reason: row.failure_reason, detail: row.failure_detail,
      finishedAt: row.finished_at.toISOString() }));
  }

  /** Repositories whose latest generation failed with none ready or building:
   * candidates for an automatic retry once the backoff allows. */
  async unrecovered(limit = 100): Promise<CloudV2ReadyCopy[]> {
    const { rows } = await this.tx(tx => tx.query<Row>(
      `SELECT DISTINCT ON (f.org_id, f.repository, f.owner_user_id) f.* FROM cloud_v2_ready_copies f
       JOIN organizations o ON o.id=f.org_id AND o.deleted_at IS NULL AND o.lifecycle_status='active' AND o.cloud_workspaces_allowed
       WHERE f.state='failed' AND f.failure_reason IS DISTINCT FROM 'organization_deleted' AND NOT EXISTS (SELECT 1 FROM cloud_v2_ready_copies n
         WHERE n.org_id=f.org_id AND n.repository=f.repository AND n.owner_user_id IS NOT DISTINCT FROM f.owner_user_id
           AND (n.state IN ('building','ready') OR n.generation>f.generation))
       ORDER BY f.org_id, f.repository, f.owner_user_id, f.generation DESC LIMIT $1`, [limit]));
    return rows.map(copy);
  }

  /** The Cloud Computer page's line per failed shared repository: what failed,
   * where, how many times in a row, and when the next automatic retry is (null: stopped). */
  async failureSummaries(organizationId: string, now: Date): Promise<{ repository: string; generation: number; reason: string; detail: string | null;
    finishedAt: string; failures: number; nextRetryAt: string | null }[]> {
    const summaries = [];
    for (const failure of await this.failures(organizationId)) {
      const retry = await this.retryState(organizationId, failure.repository, null, await this.inputs(organizationId, failure.repository, null), now);
      summaries.push({ ...failure, failures: Math.max(retry.failures, 1), nextRetryAt: retry.nextAt?.toISOString() ?? null });
    }
    return summaries;
  }

  /** Per repository: whether its first copy is still being made. */
  async status(organizationId: string, viewerUserId: string | null = null): Promise<Map<string, "ready" | "building" | null>> {
    // Shared copies, and the viewer's own private ones; nobody else's.
    const { rows } = await this.tx(tx => tx.query<{ repository: string; ready: boolean; building: boolean }>(
      `SELECT repository, bool_or(state='ready') AS ready, bool_or(state='building') AS building
       FROM cloud_v2_ready_copies WHERE org_id=$1 AND (owner_user_id IS NULL OR owner_user_id=$2::uuid) GROUP BY repository`, [organizationId, viewerUserId]));
    return new Map(rows.map(row => [row.repository, row.ready ? "ready" : row.building ? "building" : null]));
  }

  /** The generation a workspace may fork now: ready, not stale, stopped recently enough. */
  async forkable(organizationId: string, repository: string, now: Date, ownerUserId: string | null = null): Promise<CloudV2ReadyCopy | null> {
    const row = (await this.tx(tx => tx.query<Row>(
      `SELECT * FROM cloud_v2_ready_copies WHERE org_id=$1 AND repository=$2 AND state='ready' AND NOT stale
         AND owner_user_id IS NOT DISTINCT FROM $5::uuid
         AND machine_id IS NOT NULL AND stopped_at > $3::timestamptz - make_interval(secs => $4::double precision / 1000)`,
      [organizationId, repository.toLowerCase(), now, READY_COPY_EXPIRY_MS, ownerUserId]))).rows[0];
    return row ? copy(row) : null;
  }

  async building(organizationId: string, repository: string, ownerUserId: string | null = null): Promise<CloudV2ReadyCopy | null> {
    const row = (await this.tx(tx => tx.query<Row>(
      "SELECT * FROM cloud_v2_ready_copies WHERE org_id=$1 AND repository=$2 AND state='building' AND owner_user_id IS NOT DISTINCT FROM $3::uuid",
      [organizationId, repository.toLowerCase(), ownerUserId]))).rows[0];
    return row ? copy(row) : null;
  }

  // ── Builds ──────────────────────────────────────────────

  /** Starts the oldest queued generation. First copies go first; refresh
   * starts stay within READY_COPY_REFRESH_STARTS across the deployment. */
  async claim(now: Date): Promise<CloudV2ReadyCopy | null> {
    const row = (await this.tx(async tx => {
      await tx.query("/* lock_purpose='cloud-v2-ready-copy-claim' */ SELECT pg_advisory_xact_lock(hashtextextended('cloud-v2-ready-copy-claim',0))");
      return tx.query<Row>(
        `UPDATE cloud_v2_ready_copies SET started_at=$1, heartbeat_at=$1, updated_at=$1
         WHERE id=(SELECT c.id FROM cloud_v2_ready_copies c
           JOIN organizations o ON o.id=c.org_id AND o.deleted_at IS NULL AND o.lifecycle_status='active' AND o.cloud_workspaces_allowed
           WHERE c.state='building' AND c.started_at IS NULL AND (NOT c.refresh OR (
             (SELECT count(*) FROM cloud_v2_ready_copies s WHERE s.refresh AND s.started_at > $1::timestamptz - interval '1 minute') < $2
             AND (SELECT count(*) FROM cloud_v2_ready_copies s WHERE s.refresh AND s.started_at > $1::timestamptz - interval '1 hour') < $3))
           ORDER BY c.refresh, c.created_at, c.id LIMIT 1 FOR UPDATE OF c SKIP LOCKED)
         RETURNING *`, [now, READY_COPY_REFRESH_STARTS.perMinute, READY_COPY_REFRESH_STARTS.perHour]);
    })).rows[0];
    return row ? copy(row) : null;
  }

  async heartbeat(id: string): Promise<void> {
    await this.tx(tx => tx.query("UPDATE cloud_v2_ready_copies SET heartbeat_at=clock_timestamp() WHERE id=$1 AND state='building'", [id]));
  }

  /** Persists the intent before Boat is asked, so a crash replays the key. */
  async machinePending(id: string): Promise<boolean> {
    const { rowCount } = await this.tx(tx => tx.query(
      "UPDATE cloud_v2_ready_copies SET machine_pending=true, updated_at=clock_timestamp() WHERE id=$1 AND state='building'", [id]));
    return !!rowCount;
  }

  async machineCreated(id: string, machineId: string): Promise<void> {
    await this.tx(tx => tx.query(
      "UPDATE cloud_v2_ready_copies SET machine_id=$2, machine_pending=false, updated_at=clock_timestamp() WHERE id=$1", [id, machineId]));
  }

  /** The previous ready generation stays the one workspaces fork. */
  async fail(id: string, reason: string, now = new Date(), detail: string | null = null, output: string | null = null): Promise<void> {
    const code = /^[a-z0-9_]{1,64}$/.test(reason) ? reason : "ready_copy_failed";
    await this.tx(async tx => {
      await tx.query(
        `UPDATE cloud_v2_ready_copies SET state='failed', failure_reason=$2, failure_detail=$4, setup_output=$5, finished_at=$3, updated_at=$3
         WHERE id=$1 AND state='building'`, [id, code, now, detail?.slice(0, 1100) || null, output ? tailBytes(output, READY_COPY_OUTPUT_BYTES) : null]);
      await this.pruneDetail(tx, id);
    });
  }

  /** The atomic pointer switch: the previous ready generation retires in the
   * same transaction this one becomes ready. */
  async promote(id: string, result: { branch: string | null; commit: string | null; stoppedAt: Date }): Promise<boolean> {
    return this.tx(async tx => {
      // This generation and the ready one it replaces, locked together in id order.
      const target = (await tx.query<{ org_id: string; repository: string; owner_user_id: string | null }>(
        "SELECT org_id, repository, owner_user_id FROM cloud_v2_ready_copies WHERE id=$1", [id])).rows[0];
      if (!target) return false;
      const locked = (await tx.query<Row>(`SELECT * FROM cloud_v2_ready_copies WHERE org_id=$1 AND repository=$2
        AND owner_user_id IS NOT DISTINCT FROM $4::uuid AND (id=$3 OR state='ready') ORDER BY id FOR UPDATE`,
        [target.org_id, target.repository, id, target.owner_user_id])).rows;
      const row = locked.find(candidate => candidate.id === id);
      if (!row || row.state !== "building" || !row.machine_id) return false;
      await tx.query(`UPDATE cloud_v2_ready_copies SET state='retired', updated_at=clock_timestamp()
        WHERE org_id=$1 AND repository=$2 AND owner_user_id IS NOT DISTINCT FROM $4::uuid AND state='ready' AND id<>$3`,
        [row.org_id, row.repository, id, row.owner_user_id]);
      await tx.query(`UPDATE cloud_v2_ready_copies SET state='ready', stale=false, branch=$2, commit_sha=$3, stopped_at=$4,
        finished_at=clock_timestamp(), updated_at=clock_timestamp() WHERE id=$1`, [id, result.branch, result.commit, result.stoppedAt]);
      await this.pruneDetail(tx, id);
      // A base build pins no branch for a repository it never had: the first
      // copy's verified branch becomes its default, which released desktops read.
      if (result.branch && row.computer_build_id) {
        const build = (await tx.query<{ recipe: { repositories?: { repository: string; branch?: string }[] } }>(
          "SELECT recipe FROM cloud_v2_computer_builds WHERE id=$1 AND org_id=$2 AND base_only FOR UPDATE", [row.computer_build_id, row.org_id])).rows[0];
        const entries = build?.recipe.repositories ?? [];
        if (entries.some(entry => entry.repository.toLowerCase() === row.repository && !entry.branch)) {
          const repositories = entries.map(entry => entry.repository.toLowerCase() === row.repository && !entry.branch ? { ...entry, branch: result.branch! } : entry);
          await tx.query("UPDATE cloud_v2_computer_builds SET recipe=$2 WHERE id=$1", [row.computer_build_id, JSON.stringify({ ...build!.recipe, repositories })]);
        }
      }
      return true;
    });
  }

  async retire(id: string): Promise<void> {
    await this.tx(tx => tx.query("UPDATE cloud_v2_ready_copies SET state='retired', updated_at=clock_timestamp() WHERE id=$1 AND state='ready'", [id]));
  }

  /** Copies of organizations deleted or without cloud access: retired, or
   * failed while building, so cleanup deletes their machines. */
  async retireUnavailable(): Promise<number> {
    const { rowCount } = await this.tx(tx => tx.query(`UPDATE cloud_v2_ready_copies SET
        state=CASE WHEN state='building' THEN 'failed' ELSE 'retired' END,
        failure_reason=CASE WHEN state='building' THEN 'organization_unavailable' ELSE failure_reason END, updated_at=clock_timestamp()
      WHERE id IN (SELECT c.id FROM cloud_v2_ready_copies c
        LEFT JOIN organizations o ON o.id=c.org_id AND o.deleted_at IS NULL AND o.lifecycle_status='active' AND o.cloud_workspaces_allowed
        WHERE c.state IN ('building','ready') AND o.id IS NULL ORDER BY c.id FOR UPDATE OF c)`));
    // A private copy whose entry was removed or folded into a shared one.
    const orphans = await this.tx(tx => tx.query(`UPDATE cloud_v2_ready_copies SET state=CASE WHEN state='building' THEN 'failed' ELSE 'retired' END,
        failure_reason=CASE WHEN state='building' THEN 'private_repository_removed' ELSE failure_reason END, updated_at=clock_timestamp()
      WHERE id IN (SELECT c.id FROM cloud_v2_ready_copies c WHERE c.owner_user_id IS NOT NULL AND c.state IN ('building','ready')
        AND NOT EXISTS (SELECT 1 FROM cloud_repositories p WHERE p.org_id=c.org_id AND p.level='private' AND p.owner_user_id=c.owner_user_id
          AND p.repository_id=c.repository_id AND p.folded_at IS NULL) ORDER BY c.id FOR UPDATE OF c)`));
    return (rowCount ?? 0) + (orphans.rowCount ?? 0);
  }

  /** A member's standing private entry for a repository, while members may keep repositories. */
  async privateEntry(organizationId: string, ownerUserId: string, repository: string): Promise<{ id: string; repositoryId: string } | null> {
    const row = (await this.tx(tx => tx.query<{ id: string; repository_id: string }>(
      `SELECT p.id, p.repository_id FROM cloud_repositories p JOIN organizations o ON o.id=p.org_id AND o.cloud_personal_repositories_allowed
       WHERE p.org_id=$1 AND p.owner_user_id=$2 AND p.repository=$3 AND p.level='private' AND p.folded_at IS NULL`,
      [organizationId, ownerUserId, repository.toLowerCase()]))).rows[0];
    return row ? { id: row.id, repositoryId: row.repository_id } : null;
  }

  /** Build secrets of repositories the live base no longer has. */
  async pruneSecrets(organizationId: string, repositories: readonly string[]): Promise<void> {
    await this.tx(tx => tx.query("DELETE FROM cloud_v2_ready_copy_secrets WHERE org_id=$1 AND NOT (repository = ANY($2::text[]))",
      [organizationId, repositories.map(repository => repository.toLowerCase())]));
  }

  /** Past READY_COPY_HISTORY_LIMIT generations a row keeps its result, not its detail. */
  private async pruneDetail(tx: Tx, id: string): Promise<void> {
    await tx.query(`UPDATE cloud_v2_ready_copies SET setup_output=NULL, failure_detail=NULL, detail_pruned_at=clock_timestamp()
      WHERE id IN (SELECT o.id FROM cloud_v2_ready_copies o JOIN cloud_v2_ready_copies c ON c.id=$1
        WHERE o.org_id=c.org_id AND o.repository=c.repository AND o.owner_user_id IS NOT DISTINCT FROM c.owner_user_id
          AND o.detail_pruned_at IS NULL ORDER BY o.generation DESC OFFSET $2)`, [id, READY_COPY_HISTORY_LIMIT]);
  }

  /** A repository's generations, newest first, within the history bound. */
  async history(organizationId: string, repository: string, ownerUserId: string | null): Promise<CloudV2ReadyCopy[]> {
    const { rows } = await this.tx(tx => tx.query<Row>(
      `SELECT * FROM cloud_v2_ready_copies WHERE org_id=$1 AND repository=$2 AND owner_user_id IS NOT DISTINCT FROM $3::uuid
       ORDER BY generation DESC LIMIT $4`, [organizationId, repository.toLowerCase(), ownerUserId, READY_COPY_HISTORY_LIMIT]));
    return rows.map(copy);
  }

  /** Whether Build now may start one: at most one manual start per repository per READY_COPY_MANUAL_INTERVAL_MS. */
  async manualAllowed(organizationId: string, repository: string, ownerUserId: string | null, now: Date): Promise<boolean> {
    const { rows } = await this.tx(tx => tx.query<{ recent: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM cloud_v2_ready_copies WHERE org_id=$1 AND repository=$2 AND owner_user_id IS NOT DISTINCT FROM $3::uuid
         AND trigger='manual' AND created_at > $4::timestamptz - make_interval(secs => $5::double precision / 1000)) AS recent`,
      [organizationId, repository.toLowerCase(), ownerUserId, now, READY_COPY_MANUAL_INTERVAL_MS]));
    return !rows[0]?.recent;
  }

  /** A new Cloud Computer base: every ready copy is rebuilt from it. */
  async markStale(organizationId: string): Promise<number> {
    const { rowCount } = await this.tx(tx => tx.query(
      `UPDATE cloud_v2_ready_copies SET stale=true, updated_at=clock_timestamp() WHERE id IN (SELECT id FROM cloud_v2_ready_copies
        WHERE org_id=$1 AND state='ready' AND NOT stale ORDER BY id FOR UPDATE)`, [organizationId]));
    return rowCount ?? 0;
  }

  /** Copies near Boat's deletion of their stopped disk are never forked again. */
  async markExpiring(now: Date): Promise<number> {
    const { rowCount } = await this.tx(tx => tx.query(
      `UPDATE cloud_v2_ready_copies SET stale=true, updated_at=$1 WHERE id IN (SELECT id FROM cloud_v2_ready_copies WHERE state='ready' AND NOT stale
         AND stopped_at <= $1::timestamptz - make_interval(secs => $2::double precision / 1000) ORDER BY id FOR UPDATE)`, [now, READY_COPY_EXPIRY_MS]));
    return rowCount ?? 0;
  }

  /** Builds a server stopped running: failed, so cleanup deletes their machine. */
  async failInterrupted(now: Date): Promise<number> {
    const { rowCount } = await this.tx(tx => tx.query(
      `UPDATE cloud_v2_ready_copies SET state='failed', failure_reason='ready_copy_interrupted', finished_at=$1, updated_at=$1
       WHERE id IN (SELECT id FROM cloud_v2_ready_copies WHERE state='building' AND started_at IS NOT NULL
         AND coalesce(heartbeat_at, started_at) < $1::timestamptz - interval '5 minutes' ORDER BY id FOR UPDATE)`, [now]));
    return rowCount ?? 0;
  }

  /** Ready copies due a new generation: stale, or stopped a week ago, and forked
   * within the last 60 days (14 for a private one), not while one builds. The
   * retry backoff is the caller's (retryState). */
  async refreshCandidates(now: Date, limit = 100): Promise<CloudV2ReadyCopy[]> {
    const { rows } = await this.tx(tx => tx.query<Row>(
      `SELECT r.* FROM cloud_v2_ready_copies r
       JOIN organizations o ON o.id=r.org_id AND o.deleted_at IS NULL AND o.lifecycle_status='active' AND o.cloud_workspaces_allowed
       WHERE r.state='ready'
         AND (r.stale OR r.stopped_at <= $1::timestamptz - make_interval(secs => $2::double precision / 1000))
         -- Shared copies stop refreshing after 60 days unforked, private ones after 14.
         AND coalesce(r.last_forked_at, r.created_at) > $1::timestamptz - make_interval(secs =>
           (CASE WHEN r.owner_user_id IS NULL THEN $3 ELSE $5 END)::double precision / 1000)
         -- A private copy refreshes only while its entry stands and members may keep repositories.
         AND (r.owner_user_id IS NULL OR (o.cloud_personal_repositories_allowed AND EXISTS (SELECT 1 FROM cloud_repositories p
           WHERE p.org_id=r.org_id AND p.level='private' AND p.owner_user_id=r.owner_user_id AND p.repository_id=r.repository_id AND p.folded_at IS NULL)))
         AND NOT EXISTS (SELECT 1 FROM cloud_v2_ready_copies b WHERE b.org_id=r.org_id AND b.repository=r.repository
           AND b.owner_user_id IS NOT DISTINCT FROM r.owner_user_id AND b.state='building')
       ORDER BY r.stale DESC, r.stopped_at, r.id LIMIT $4`, [now, READY_COPY_REFRESH_MS, READY_COPY_UNUSED_MS, limit, READY_COPY_PRIVATE_UNUSED_MS]));
    return rows.map(copy);
  }

  /** Whether a first copy for this repository may be queued now: none
   * building or ready, and the retry backoff allows it for these inputs. */
  async mayQueueFirst(organizationId: string, repository: string, now: Date, ownerUserId: string | null = null, inputs: string | null = null): Promise<boolean> {
    const { rows } = await this.tx(tx => tx.query<{ blocked: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM cloud_v2_ready_copies WHERE org_id=$1 AND repository=$2 AND owner_user_id IS NOT DISTINCT FROM $3::uuid
         AND state IN ('building','ready')) AS blocked`, [organizationId, repository.toLowerCase(), ownerUserId]));
    return !rows[0]?.blocked && (await this.retryState(organizationId, repository, ownerUserId, inputs, now)).allowed;
  }

  /** Consecutive failed generations since the last ready or building one,
   * counted while their inputs equal `inputs` and up to an admin's Retry now. */
  async retryState(organizationId: string, repository: string, ownerUserId: string | null, inputs: string | null, now: Date): Promise<ReadyCopyRetry> {
    const { rows } = await this.tx(tx => tx.query<{ state: ReadyCopyState; inputs: string | null; manual_retry: boolean; finished_at: Date | null }>(
      `SELECT state, inputs, manual_retry, finished_at FROM cloud_v2_ready_copies WHERE org_id=$1 AND repository=$2
         AND owner_user_id IS NOT DISTINCT FROM $3::uuid ORDER BY generation DESC LIMIT $4`,
      [organizationId, repository.toLowerCase(), ownerUserId, READY_COPY_RETRY_LIMIT + 1]));
    let failures = 0, last: Date | null = null;
    for (const row of rows) {
      if (row.state !== "failed" || row.inputs !== inputs) break;
      failures++; last ??= row.finished_at;
      if (row.manual_retry) break;
    }
    if (!failures) return { failures, nextAt: now, allowed: true };
    if (failures >= READY_COPY_RETRY_LIMIT) return { failures, nextAt: null, allowed: false };
    const nextAt = new Date((last ?? now).getTime() + Math.min(READY_COPY_RETRY_FIRST_MS * 2 ** (failures - 1), READY_COPY_RETRY_MAX_MS));
    return { failures, nextAt, allowed: nextAt.getTime() <= now.getTime() };
  }

  /** What a shared or private copy is built from; see READY_COPY_RETRY_LIMIT. */
  async inputs(organizationId: string, repository: string, ownerUserId: string | null): Promise<string | null> {
    const base = await this.base(organizationId);
    if (!base) return null;
    const name = repository.toLowerCase();
    if (ownerUserId) {
      const entry = await this.privateEntry(organizationId, ownerUserId, name);
      return entry ? createHash("sha256").update(JSON.stringify(["private", base.buildId, entry.id])).digest("hex") : null;
    }
    const entry = base.repositories.find(candidate => candidate.repository.toLowerCase() === name);
    const secrets = (await this.tx(tx => tx.query<{ updated_at: Date }>(
      "SELECT updated_at FROM cloud_v2_ready_copy_secrets WHERE org_id=$1 AND repository=$2", [organizationId, name]))).rows[0];
    return createHash("sha256").update(JSON.stringify(["shared", base.buildId, entry?.setup ?? null, entry?.ref ?? null,
      secrets?.updated_at.toISOString() ?? null])).digest("hex");
  }

  /** Failed or retired generations whose machine can go: no fork that began
   * from it is still waiting for its machine within Boat's key window. */
  async cleanupCandidates(now: Date, limit = 50): Promise<CloudV2ReadyCopy[]> {
    const { rows } = await this.tx(tx => tx.query<Row>(
      `SELECT c.* FROM cloud_v2_ready_copies c WHERE c.state IN ('failed','retired') AND c.machine_deleted_at IS NULL
         AND (c.machine_id IS NOT NULL OR c.machine_pending)
         AND NOT EXISTS (SELECT 1 FROM cloud_v2_ready_copy_forks f WHERE f.copy_id=c.id AND f.completed_at IS NULL
           AND f.requested_at > $1::timestamptz - make_interval(secs => $2::double precision / 1000))
       ORDER BY c.updated_at, c.id LIMIT $3`, [now, KEY_WINDOW_MS, limit]));
    return rows.map(copy);
  }

  /** Locked against a fork beginning: retired rows are never forked anew, and
   * a fork that began first is visible here. */
  async deletable(id: string, now: Date): Promise<boolean> {
    return this.tx(async tx => {
      const row = (await tx.query<{ state: ReadyCopyState }>("SELECT state FROM cloud_v2_ready_copies WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!row || !["failed", "retired"].includes(row.state)) return false;
      const forks = await tx.query(`SELECT 1 FROM cloud_v2_ready_copy_forks WHERE copy_id=$1 AND completed_at IS NULL
        AND requested_at > $2::timestamptz - make_interval(secs => $3::double precision / 1000)`, [id, now, KEY_WINDOW_MS]);
      return !forks.rowCount;
    });
  }

  async machineDeleted(id: string): Promise<void> {
    await this.tx(tx => tx.query(
      "UPDATE cloud_v2_ready_copies SET machine_deleted_at=clock_timestamp(), machine_pending=false, updated_at=clock_timestamp() WHERE id=$1", [id]));
  }

  // ── Forks ───────────────────────────────────────────────

  async forkOf(workspaceId: string): Promise<ReadyCopyFork | null> {
    const row = (await this.tx(tx => tx.query<{ copy_id: string; fork_key: string; machine_id: string | null; sandbox_id: string | null; requested_at: Date }>(
      `SELECT f.copy_id, f.fork_key, c.machine_id, f.sandbox_id, f.requested_at FROM cloud_v2_ready_copy_forks f
       JOIN cloud_v2_ready_copies c ON c.id=f.copy_id WHERE f.workspace_id=$1`, [workspaceId]))).rows[0];
    if (!row?.machine_id) return null;
    return { copyId: row.copy_id, key: row.fork_key, machineId: row.machine_id, sandboxId: row.sandbox_id, requestedAt: row.requested_at };
  }

  /** Records the fork before Boat is asked, holding the copy row against a
   * concurrent retire or promote until the fork row commits (both need that
   * row's lock, and a retired copy is never forked anew), and stamps the copy's own use. Never the workspace's
   * activity: active_at belongs to people. Null when it is no longer ready. */
  async beginFork(workspaceId: string, organizationId: string, copyId: string, now: Date): Promise<ReadyCopyFork | null> {
    return this.tx(async tx => {
      const row = (await tx.query<{ machine_id: string | null; owner_user_id: string | null }>(
        // The write below needs this lock anyway; taking a weaker one first deadlocks concurrent creates.
        `SELECT machine_id, owner_user_id FROM cloud_v2_ready_copies WHERE id=$1 AND org_id=$2 AND state='ready' AND NOT stale FOR NO KEY UPDATE`, [copyId, organizationId])).rows[0];
      if (!row?.machine_id) return null;
      // A private copy is its member's alone: only a workspace that member creates may fork it.
      if (row.owner_user_id !== null) {
        const workspace = (await tx.query<{ creator_user_id: string | null; private_owner_user_id: string | null }>(
          "SELECT creator_user_id, private_owner_user_id FROM cloud_v2_workspaces WHERE id=$1 AND org_id=$2", [workspaceId, organizationId])).rows[0];
        if (!workspace || workspace.private_owner_user_id !== row.owner_user_id || workspace.creator_user_id !== row.owner_user_id)
          throw new HttpError(403, "private_repository_owner_only", "Only the member who added this repository can use its ready copy.");
      }
      const key = `ready-copy-fork:${workspaceId}`;
      const inserted = await tx.query<{ requested_at: Date }>(
        `INSERT INTO cloud_v2_ready_copy_forks (workspace_id, org_id, copy_id, fork_key, requested_at) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (workspace_id) DO NOTHING RETURNING requested_at`, [workspaceId, organizationId, copyId, key, now]);
      if (!inserted.rows[0]) return null;
      await tx.query("UPDATE cloud_v2_ready_copies SET last_forked_at=$2 WHERE id=$1", [copyId, now]);
      return { copyId, key, machineId: row.machine_id, sandboxId: null, requestedAt: inserted.rows[0].requested_at };
    });
  }

  async completeFork(workspaceId: string, sandboxId: string | null): Promise<void> {
    await this.tx(tx => tx.query(
      "UPDATE cloud_v2_ready_copy_forks SET sandbox_id=coalesce($2, sandbox_id), completed_at=coalesce(completed_at, clock_timestamp()) WHERE workspace_id=$1",
      [workspaceId, sandboxId]));
  }
}

// ── Builder ───────────────────────────────────────────────

function lostOrRefused(error: unknown): boolean {
  return error instanceof BoatSnapshotExpiredError || error instanceof BoatCreateRejectedError || error instanceof BoatForkRefusedError ||
    (error instanceof CloudProviderError && (error.code === "provider_not_found" || [400, 401, 402, 403, 422].includes(error.httpStatus ?? 0)));
}
function code(error: unknown, fallback: string): string {
  const value = (error as { code?: unknown } | null)?.code;
  return typeof value === "string" && /^[a-z0-9_]{1,64}$/.test(value) ? value : fallback;
}
const failure = (reason: string) => Object.assign(new Error(reason), { code: reason });

function tailBytes(text: string, limit: number): string {
  const bytes = Buffer.from(text, "utf8");
  return bytes.length <= limit ? text : bytes.subarray(bytes.length - limit).toString("utf8").replace(/^\uFFFD+/, "");
}
/** Every build secret out of a setup's output before it is kept: the exact
 * value, and its base64, base64url and URL-encoded forms. */
export function redactSecrets(output: string, values: readonly string[]): string {
  const forms = values.filter(value => value.length > 0).flatMap(value => [value, Buffer.from(value, "utf8").toString("base64"),
    Buffer.from(value, "utf8").toString("base64url"), encodeURIComponent(value), Buffer.from(value, "utf8").toString("base64").replace(/=+$/, "")])
    .filter((form, index, all) => form.length >= 3 && all.indexOf(form) === index).sort((a, b) => b.length - a.length);
  let redacted = output;
  for (const form of forms) redacted = redacted.split(form).join("[redacted]");
  return redacted;
}

/** Setup reads `NAME=<base64>` lines from standard input, then runs with no
 * input at all. Values never reach argv, the environment of anything but
 * this one command, or a file the command did not write itself. */
export function readyCopySetupCommand(dir: string, setup: string, withSecrets: boolean): string {
  return `${asZeros([
    `cd ${shellQuote(dir)}`,
    ...(withSecrets ? [
      'while IFS= read -r zeros_secret; do [ -n "$zeros_secret" ] || continue; export "${zeros_secret%%=*}=$(printf %s "${zeros_secret#*=}" | base64 -d)"; done',
      "unset zeros_secret",
      "exec </dev/null",
    ] : []),
    setup,
  ])} 2>&1`;
}
/** Before stop: nothing of a build's input stays on the disk workspaces fork. */
export const READY_COPY_SCRUB_COMMAND = "rm -rf /tmp/zeros-command-input-* /tmp/zeros-job-* 2>/dev/null; sync";
/** A setup can write a secret anywhere it may write. Before stop the disk is
 * searched for every value, read from standard input; only a path is printed. */
/**
 * Searched: the user's home and /tmp, and where tools, services and package
 * managers keep configuration and data a setup run with sudo may write: /etc,
 * /usr/local, /opt, /srv, /root and /var. All survive the stop and are in every
 * fork. Not searched: the package-managed system trees (/usr outside
 * /usr/local, /bin, /lib, /sbin, /boot); a setup with sudo can write there, but
 * they hold the image itself and searching them would multiply the time for
 * places a setup does not keep its own files.
 *
 * Skipped inside them: Git's object store (.git/objects), whose loose objects
 * and packs are zlib-compressed, so a value can never appear there as plain
 * text. Git's plain files (config, refs, logs, hooks) are searched. Binary
 * files are skipped (-I): a value a setup writes is text.
 *
 * The time allowed scales with the bytes to read: measured at about 430 MB/s on
 * 8 cores for a 3.8 GB checkout with node_modules (8.8 s), and assumed at
 * READY_COPY_SEARCH.bytesPerSecond for fewer cores and a cold disk. The floor
 * covers start-up on small disks; the ceiling stops a stuck search from holding
 * this replica's copy builds for more than a few hours. Nobody waits on it: a
 * create forks the previous generation or clones directly meanwhile. The search
 * runs across every core with LC_ALL=C, and its patterns stay in /dev/shm
 * (memory, outside the searched disk), removed when it ends.
 */
export const READY_COPY_SECRET_PATHS = ["/home/user", "/tmp", "/etc", "/usr/local", "/opt", "/srv", "/root", "/var"] as const;
export const READY_COPY_SEARCH = { bytesPerSecond: 64 * 1024 * 1024, floorSeconds: 300, ceilingSeconds: 3 * 60 * 60 } as const;
export function readyCopySecretSearchScript(paths: readonly string[] = READY_COPY_SECRET_PATHS,
  limits: { bytesPerSecond: number; floorSeconds: number; ceilingSeconds: number } = READY_COPY_SEARCH): string {
  const roots = paths.map(shellQuote).join(" ");
  return [
    "set -u", "export LC_ALL=C",
    "patterns=$(mktemp -p /dev/shm zeros-secret-patterns.XXXXXX) || exit 70",
    "trap 'rm -f \"$patterns\"' EXIT",
    "cat > \"$patterns\"",
    `bytes=$(du -sxb ${roots} 2>/dev/null | awk '{ s += $1 } END { print s + 0 }')`,
    `limit=$(( bytes / ${limits.bytesPerSecond} ))`,
    `if [ "$limit" -lt ${limits.floorSeconds} ]; then limit=${limits.floorSeconds}; fi`,
    `if [ "$limit" -gt ${limits.ceilingSeconds} ]; then limit=${limits.ceilingSeconds}; fi`,
    'echo "zeros-search-bytes=$bytes zeros-search-limit=$limit"',
    `timeout -k 10 "$limit" find ${roots} -xdev -path '*/.git/objects' -prune -o -type f -print0 2>/dev/null \\`,
    `  | timeout -k 10 "$limit" xargs -0 -r -P "$(nproc)" -n 256 sh -c 'grep -lsIF -f "$0" -- "$@" || true' "$patterns" \\`,
    "  | head -n 1",
    'echo "zeros-search-status=${PIPESTATUS[0]},${PIPESTATUS[1]}"',
  ].join("\n");
}
/** One quoted command, since only the last simple command of a line receives Boat's standard input. */
export const READY_COPY_SECRET_SEARCH_COMMAND = `sudo -n bash -c ${shellQuote(readyCopySecretSearchScript())}`;
/** Generous over the ceiling: the search's own limit ends it first. */
export const READY_COPY_SECRET_SEARCH_SECONDS = READY_COPY_SEARCH.ceilingSeconds + 120;
/** Values shorter than this are not searched for: they would match ordinary files. */
export const READY_COPY_SECRET_MIN_SEARCH_LENGTH = 4;

/** What the search printed: a path it found, whether it finished. find and
 * xargs end 0 (or find 1, for an entry that vanished while it ran) when they
 * finished; a timeout is 124 and a kill 137. Any path printed means a secret
 * was found, whatever the status (head ends the pipeline early). */
export function readyCopySearchResult(stdout: string): { found: string | null; complete: boolean } {
  const lines = stdout.split("\n");
  const status = /^zeros-search-status=(\d+),(\d+)$/.exec(lines.find(line => line.startsWith("zeros-search-status=")) ?? "");
  const found = lines.find(line => line.length > 0 && !line.startsWith("zeros-search-")) ?? null;
  const complete = !!status && ["0", "1"].includes(status[1]!) && status[2] === "0";
  return { found, complete };
}

/** The location shown to an admin: a path the search printed, with any part
 * that is, or holds part of, a secret withheld. Never a value or file content. */
export function readyCopySecretLocation(printed: string, values: readonly string[]): string {
  const path = printed.split("\n")[0]!.trim();
  if (!/^\/[\x20-\x7e]{1,1024}$/.test(path)) return "a file whose name cannot be shown";
  const secret = (part: string) => values.some(value => part.includes(value) || (part.length >= READY_COPY_SECRET_MIN_SEARCH_LENGTH && value.includes(part)));
  const parts = path.split("/").filter(Boolean), shown: string[] = [];
  for (const part of parts) {
    if (secret(part)) return `/${[...shown, "…"].join("/")} (a name there contains a build secret)`;
    shown.push(part);
  }
  return secret(path) ? "a file whose path contains a build secret" : path;
}

export type ReadyCopyBuilderDeps = {
  copies: CloudV2ReadyCopies;
  compute: CloudV2Compute;
  channel: string;
  localOwner?: string | undefined;
  runtime: CloudV2Runtime;
  publicKeys?: readonly string[];
  /** A short-lived token able to clone one repository, as one member (a private copy's). */
  cloneToken(organizationId: string, userId: string, target: CloudSourceTarget): Promise<string>;
  /** Two GitHub levels: a shared copy's token from the organization's installation. */
  sharedCloneToken?(organizationId: string, target: CloudSourceTarget): Promise<string>;
  /** Admin build secrets for a shared repository; empty when none. */
  secrets?(organizationId: string, repository: string): Promise<ReadyCopySecrets>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  logger?: Pick<Console, "warn">;
};

export class CloudV2ReadyCopyBuilder {
  private closed = false;
  constructor(private readonly deps: ReadyCopyBuilderDeps) {}

  private now(): Date { return new Date(this.deps.now?.() ?? Date.now()); }
  private sleep(ms: number): Promise<void> { return (this.deps.sleep ?? (value => new Promise(resolve => setTimeout(resolve, value))))(ms); }
  close(): void { this.closed = true; }

  /** A Cloud Computer base went live: first copies for its repositories, and
   * every ready copy rebuilt from it. A runtime-only refresh changes nothing a
   * copy holds; workspaces install the runtime they need when they start. */
  async baseActivated(organizationId: string, reason: string): Promise<void> {
    if (reason !== "runtime") await this.deps.copies.markStale(organizationId);
    const base = await this.deps.copies.base(organizationId);
    if (base) await this.deps.copies.pruneSecrets(organizationId, base.repositories.map(entry => entry.repository));
    await this.queueFirstCopies(organizationId);
  }

  /** A private repository's first copy, cloned as its member. */
  async queuePrivateCopy(organizationId: string, ownerUserId: string, repository: string, trigger: ReadyCopyTrigger = "repository_added"): Promise<void> {
    const { copies } = this.deps;
    const base = await copies.base(organizationId), entry = await copies.privateEntry(organizationId, ownerUserId, repository);
    const inputs = await copies.inputs(organizationId, repository, ownerUserId);
    if (!base || !entry || !await copies.mayQueueFirst(organizationId, repository, this.now(), ownerUserId, inputs)) return;
    await copies.request({ organizationId, repository, repositoryId: entry.repositoryId, createdBy: ownerUserId, ownerUserId,
      computerBuildId: base.buildId, builtFromBase: `snapshot:${base.snapshot}`, inputs, trigger });
  }

  async queueFirstCopies(organizationId: string, only?: string, trigger: ReadyCopyTrigger = "repository_added"): Promise<void> {
    const { copies } = this.deps;
    const base = await copies.base(organizationId);
    if (!base) return;
    for (const entry of base.repositories) {
      if (only && entry.repository.toLowerCase() !== only.toLowerCase()) continue;
      const target = base.sources.find(source => source.repository.toLowerCase() === entry.repository.toLowerCase());
      const inputs = await copies.inputs(organizationId, entry.repository, null);
      if (!target || !await copies.mayQueueFirst(organizationId, entry.repository, this.now(), null, inputs)) continue;
      await copies.request({ organizationId, repository: entry.repository, repositoryId: target.repositoryId, createdBy: base.createdBy,
        computerBuildId: base.buildId, builtFromBase: `snapshot:${base.snapshot}`, inputs, trigger });
    }
  }

  /** A repository's setup, branch or build secrets were saved: rebuild that
   * repository's copy alone, once its inputs differ from the copy's. */
  async reconcile(organizationId: string, repository: string, trigger: "setup_changed" | "branch_changed" | "secrets_changed" | "repository_added"): Promise<void> {
    const { copies } = this.deps, base = await copies.base(organizationId), name = repository.toLowerCase();
    const entry = base?.repositories.find(candidate => candidate.repository.toLowerCase() === name);
    const target = base?.sources.find(source => source.repository.toLowerCase() === name);
    if (!base || !entry || !target) return;
    const inputs = await copies.inputs(organizationId, name, null);
    const latest = (await copies.history(organizationId, name, null)).find(row => row.state !== "retired");
    if (latest && latest.inputs === inputs && latest.state !== "failed") return;
    const ready = await copies.forkable(organizationId, name, this.now());
    await copies.request({ organizationId, repository: entry.repository, repositoryId: target.repositoryId, createdBy: base.createdBy,
      computerBuildId: base.buildId, builtFromBase: ready ? `copy:${ready.id}` : `snapshot:${base.snapshot}`, refresh: !!ready, inputs,
      trigger: latest || trigger !== "repository_added" ? trigger : "repository_added" });
  }

  /** Build now (admins for a shared repository, its member for a private one;
   * the route checks which): coalesces with a running build, at most one manual start per repository each READY_COPY_MANUAL_INTERVAL_MS. */
  async buildNow(organizationId: string, repository: string, ownerUserId: string | null, userId: string): Promise<CloudV2ReadyCopy | null> {
    const { copies } = this.deps, now = this.now(), name = repository.toLowerCase();
    const building = await copies.building(organizationId, name, ownerUserId);
    if (building) return building;
    if (!await copies.manualAllowed(organizationId, name, ownerUserId, now))
      throw new HttpError(429, "ready_copy_build_limited", "This repository's copy was started a few minutes ago. Try again later.");
    const base = await copies.base(organizationId);
    if (!base) return null;
    const ready = await copies.forkable(organizationId, name, now, ownerUserId);
    const inputs = await copies.inputs(organizationId, name, ownerUserId);
    if (ownerUserId) {
      const entry = await copies.privateEntry(organizationId, ownerUserId, name);
      if (!entry) return null;
      return copies.request({ organizationId, repository: name, repositoryId: entry.repositoryId, createdBy: ownerUserId, ownerUserId,
        computerBuildId: base.buildId, builtFromBase: ready ? `copy:${ready.id}` : `snapshot:${base.snapshot}`, refresh: true, inputs,
        manualRetry: true, trigger: "manual", triggeredBy: userId });
    }
    const target = base.sources.find(source => source.repository.toLowerCase() === name);
    if (!target) return null;
    return copies.request({ organizationId, repository: name, repositoryId: target.repositoryId, createdBy: base.createdBy, computerBuildId: base.buildId,
      builtFromBase: ready ? `copy:${ready.id}` : `snapshot:${base.snapshot}`, refresh: true, inputs, manualRetry: true, trigger: "manual", triggeredBy: userId });
  }

  async tick(): Promise<void> {
    if (this.closed) return;
    await this.maintain();
    if (this.closed) return;
    const job = await this.deps.copies.claim(this.now());
    if (job) await this.run(job);
    await this.cleanup();
  }

  /** Staleness, refresh queueing and interrupted builds, from the database alone. */
  async maintain(): Promise<void> {
    const { copies } = this.deps, now = this.now();
    await copies.retireUnavailable();
    await copies.markExpiring(now);
    await copies.failInterrupted(now);
    for (const ready of await copies.refreshCandidates(now)) {
      if (this.closed) return;
      const base = await copies.base(ready.organizationId);
      // A refresh that keeps failing backs off and stops like a first copy; the
      // older generation keeps serving until it expires, and nobody but admins hears of it.
      const inputs = await copies.inputs(ready.organizationId, ready.repository, ready.ownerUserId);
      const retry = await copies.retryState(ready.organizationId, ready.repository, ready.ownerUserId, inputs, now);
      if (!retry.allowed) continue;
      const trigger: ReadyCopyTrigger = retry.failures ? "retry" : base && ready.computerBuildId !== base.buildId ? "computer_build" : "weekly_update";
      if (ready.ownerUserId) {
        // A private copy: its entry still stands (refreshCandidates checks); rebuilt as its member.
        if (!base) continue;
        await copies.request({ organizationId: ready.organizationId, repository: ready.repository, repositoryId: ready.repositoryId,
          createdBy: ready.ownerUserId, ownerUserId: ready.ownerUserId, computerBuildId: base.buildId, refresh: true, inputs, trigger,
          builtFromBase: ready.stale || !ready.machineId || ready.computerBuildId !== base.buildId ? `snapshot:${base.snapshot}` : `copy:${ready.id}` });
        continue;
      }
      const target = base?.sources.find(source => source.repository.toLowerCase() === ready.repository);
      if (!base) continue;
      // Removed from the Cloud Computer: retired, so cleanup deletes its machine.
      if (!target || !base.repositories.some(entry => entry.repository.toLowerCase() === ready.repository)) { await copies.retire(ready.id); continue; }
      // A copy on the current base is refreshed by forking it; a stale one is rebuilt from the base.
      await copies.request({ organizationId: ready.organizationId, repository: ready.repository, repositoryId: target.repositoryId,
        createdBy: base.createdBy, computerBuildId: base.buildId, refresh: true, inputs, trigger,
        builtFromBase: ready.stale || !ready.machineId || ready.computerBuildId !== base.buildId ? `snapshot:${base.snapshot}` : `copy:${ready.id}` });
    }
    // First copies that failed: retried on the backoff, then left until something changes.
    for (const failed of await copies.unrecovered()) {
      if (this.closed) return;
      if (failed.ownerUserId) await this.queuePrivateCopy(failed.organizationId, failed.ownerUserId, failed.repository, "retry");
      else await this.queueFirstCopies(failed.organizationId, failed.repository, "retry");
    }
  }

  /** An admin's Retry now: a new generation whatever the backoff, which also starts it over. */
  async retryNow(organizationId: string, repository: string, userId: string | null = null): Promise<CloudV2ReadyCopy | null> {
    const { copies } = this.deps, base = await copies.base(organizationId);
    const entry = base?.repositories.find(candidate => candidate.repository.toLowerCase() === repository.toLowerCase());
    const target = base?.sources.find(source => source.repository.toLowerCase() === repository.toLowerCase());
    if (!base || !entry || !target) return null;
    const ready = await copies.forkable(organizationId, repository, this.now());
    return copies.request({ organizationId, repository, repositoryId: target.repositoryId, createdBy: base.createdBy, computerBuildId: base.buildId,
      builtFromBase: `snapshot:${base.snapshot}`, refresh: !!ready, manualRetry: true, inputs: await copies.inputs(organizationId, repository, null),
      trigger: "manual", triggeredBy: userId });
  }

  async cleanup(): Promise<void> {
    const { copies, compute } = this.deps, now = this.now();
    for (const candidate of await copies.cleanupCandidates(now)) {
      if (!await copies.deletable(candidate.id, now)) continue;
      try {
        let machineId = candidate.machineId;
        // A create or fork whose reply was lost: the same key names its machine.
        if (!machineId && candidate.machinePending && now.getTime() - (candidate.startedAt ?? candidate.createdAt).getTime() < KEY_WINDOW_MS) {
          machineId = await this.machine(candidate).catch(error => { if (lostOrRefused(error)) return null; throw error; });
        }
        if (machineId) await compute.delete(machineId);
        await copies.machineDeleted(candidate.id);
      } catch (error) { this.deps.logger?.warn(`[cloud-v2] ready copy cleanup will retry (${code(error, "provider_request_failed")})`); }
    }
  }

  /** The generation's machine, by its own key: from the base, or a fork of the previous generation. */
  private async machine(job: CloudV2ReadyCopy): Promise<string> {
    const { compute, copies } = this.deps;
    const name = cloudV2SandboxName(this.deps.channel, "copy", job.id, this.deps.localOwner);
    if (job.builtFromBase?.startsWith("copy:")) {
      const previous = await copies.get(job.builtFromBase.slice("copy:".length));
      if (!previous?.machineId || previous.machineDeletedAt) throw failure("ready_copy_source_missing");
      return (await compute.fork(previous.machineId, { key: job.idempotencyKey, name, ttlSeconds: CLOUD_V2_LEASE_SECONDS })).sandboxId;
    }
    const snapshot = job.builtFromBase?.startsWith("snapshot:") ? cloudV2BoatSnapshotName(job.builtFromBase.slice("snapshot:".length)) : undefined;
    return (await compute.create({ key: job.idempotencyKey, ...(snapshot ? { from: snapshot } : {}), name, env: {} })).sandboxId;
  }

  private async run(job: CloudV2ReadyCopy): Promise<void> {
    const { copies } = this.deps;
    const beat = setInterval(() => { void copies.heartbeat(job.id).catch(() => {}); }, HEARTBEAT_MS);
    beat.unref();
    try { await this.build(job); }
    catch (error) {
      const reason = code(error, "ready_copy_failed");
      const detail = (error as { detail?: unknown } | null)?.detail, output = (error as { output?: unknown } | null)?.output;
      this.deps.logger?.warn(`[cloud-v2] ready copy ${job.repository} generation ${job.generation} failed (${reason})`);
      await copies.fail(job.id, reason, this.now(), typeof detail === "string" ? detail : null, typeof output === "string" ? output : null);
    } finally { clearInterval(beat); }
  }

  private async build(job: CloudV2ReadyCopy): Promise<void> {
    const { compute, copies } = this.deps;
    const base = await copies.base(job.organizationId);
    // A private repository has no admin setup or secrets: it is cloned as its member only.
    const privateEntry = job.ownerUserId ? await copies.privateEntry(job.organizationId, job.ownerUserId, job.repository) : null;
    const entry = job.ownerUserId ? (privateEntry ? { repository: job.repository } as ReadyCopyBase["repositories"][number] : undefined)
      : base?.repositories.find(candidate => candidate.repository.toLowerCase() === job.repository);
    const target = job.ownerUserId ? (privateEntry?.repositoryId === job.repositoryId ? { repository: job.repository, repositoryId: job.repositoryId } : undefined)
      : base?.sources.find(source => source.repository.toLowerCase() === job.repository && source.repositoryId === job.repositoryId);
    if (!base || !entry || !target) throw failure("ready_copy_base_changed");
    if (!await copies.machinePending(job.id)) return;
    const machineId = await this.machine(job);
    await copies.machineCreated(job.id, machineId);
    await this.ready(machineId);
    // A fork of the previous generation already has both; a base made before
    // a runtime release still installs the pin workspaces need.
    if (!job.builtFromBase?.startsWith("copy:")) {
      const installed = await compute.exec(machineId, installRuntimeCommand({ sha256: this.deps.runtime.sha256, url: await this.deps.runtime.url(this.deps.runtime.sha256),
        ...(this.deps.publicKeys ? { publicKeys: this.deps.publicKeys } : {}) }), 300);
      if (installed.exitCode !== 0 || installed.timedOut) throw failure("worker_runtime_install_failed");
    }
    const dir = `/home/user/${entry.repository}`;
    // Shared copies clone through the organization's GitHub connection, never an admin's own login.
    const token = job.ownerUserId ? await this.deps.cloneToken(job.organizationId, job.ownerUserId, target)
      : this.deps.sharedCloneToken ? await this.deps.sharedCloneToken(job.organizationId, target)
      : await this.deps.cloneToken(job.organizationId, base.createdBy, target);
    const header = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}\n`;
    // Always a full clone; a refresh fetches into the previous generation's.
    const clone = await compute.execLong(machineId, asZeros(checkoutScript({ repository: entry.repository, ...(entry.ref ? { ref: entry.ref } : {}) },
      dir, target.repository)), 900, header);
    if (clone.exitCode !== 0) throw failure("ready_copy_clone_failed");
    const commit = clone.stdout.trim().split("\n").pop() ?? "";
    const branch = /(?:^|\n)zeros-build-branch=([^\r\n]*)/.exec(clone.stdout)?.[1] || null;
    let values: string[] = [];
    if (entry.setup) {
      const secrets = await this.deps.secrets?.(job.organizationId, job.repository) ?? {};
      const names = Object.keys(secrets);
      const input = names.length ? names.map(name => `${name}=${Buffer.from(secrets[name]!, "utf8").toString("base64")}`).join("\n") + "\n" : undefined;
      const setup = await compute.execLong(machineId, readyCopySetupCommand(dir, entry.setup, input !== undefined), 3600, input);
      // Only a failed setup keeps its output: the last part, every build secret redacted.
      if (setup.exitCode !== 0 || setup.timedOut)
        throw Object.assign(failure("ready_copy_setup_failed"), { output: redactSecrets(setup.stdout, Object.values(secrets)) });
      const tidy = await compute.exec(machineId, asZeros([`cd ${shellQuote(dir)}`,
        "if [ \"$(git status --porcelain --untracked-files=no | wc -l)\" -gt 0 ]; then git reset -q --hard HEAD; fi"]), 120);
      if (tidy.exitCode !== 0 || tidy.timedOut) throw failure("ready_copy_setup_failed");
      values = Object.values(secrets).filter(value => value.length >= READY_COPY_SECRET_MIN_SEARCH_LENGTH);
    }
    const scrub = await compute.exec(machineId, READY_COPY_SCRUB_COMMAND, 120);
    if (scrub.exitCode !== 0 || scrub.timedOut) throw failure("ready_copy_scrub_failed");
    if (values.length) {
      const searched = await compute.execLong(machineId, READY_COPY_SECRET_SEARCH_COMMAND, READY_COPY_SECRET_SEARCH_SECONDS, `${values.join("\n")}\n`);
      const result = readyCopySearchResult(searched.stdout);
      // Every member's fork would hold it: this generation never becomes ready.
      if (result.found) throw Object.assign(failure("ready_copy_secret_left"), { detail: readyCopySecretLocation(result.found, values) });
      // Fails closed: a copy that was not searched in full never becomes ready.
      if (searched.exitCode !== 0 || searched.timedOut || !result.complete) throw failure("ready_copy_secret_search_incomplete");
    }
    await compute.stop(machineId);
    const stoppedAt = await this.archived(machineId);
    if (!await copies.promote(job.id, { branch, commit: /^[0-9a-f]{40}$/.test(commit) ? commit : null, stoppedAt }))
      throw failure("ready_copy_superseded");
  }

  private async ready(machineId: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        const result = await this.deps.compute.exec(machineId, "true", 30);
        if (result.exitCode === 0 && !result.timedOut) return;
      } catch (error) { if (lostOrRefused(error) || attempt >= READY_ATTEMPTS) throw error; }
      if (attempt >= READY_ATTEMPTS) throw failure("ready_copy_boot_timeout");
      await this.sleep(READY_WAIT_MS);
    }
  }

  /** Boat's stop time, which starts its 14-day clock; ours if it gives none. */
  private async archived(machineId: string): Promise<Date> {
    for (let read = 1; read <= ARCHIVE_READS; read++) {
      const inspected = await this.deps.compute.inspect(machineId);
      if (inspected.state === "archived") return inspected.stoppedAt ?? this.now();
      if (inspected.state !== "archiving") break;
      await this.sleep(ARCHIVE_WAIT_MS);
    }
    throw failure("ready_copy_stop_incomplete");
  }
}

// ── Workspace forks ───────────────────────────────────────

export type ReadyCopyForkOutcome = { sandboxId: string } | { waitMs: number } | null;

/** The create path's half: fork the ready generation, wait a bounded time for
 * one that is building, or return null for the direct clone path. */
export class CloudV2ReadyCopyForks<W extends ReadyCopyWorkspace = ReadyCopyWorkspace> {
  constructor(private readonly deps: {
    copies: CloudV2ReadyCopies;
    compute: CloudV2Compute;
    /** Queues the repository's first copy when it has none. */
    queueFirst?(organizationId: string, repository: string, ownerUserId: string | null): Promise<void>;
    /** A repository token for the creator, to fetch the base branch. */
    githubToken?(workspace: W): Promise<{ token: string }>;
    now?: () => number;
    logger?: Pick<Console, "warn">;
  }) {}

  private now(): Date { return new Date(this.deps.now?.() ?? Date.now()); }

  /** Whether this workspace's VM is a fork of a ready copy. */
  async forked(workspaceId: string): Promise<boolean> {
    return !!(await this.deps.copies.forkOf(workspaceId))?.sandboxId;
  }

  async prepare(workspace: ReadyCopyWorkspace): Promise<ReadyCopyForkOutcome> {
    const { copies, compute } = this.deps, now = this.now();
    const existing = await copies.forkOf(workspace.id);
    if (existing) {
      if (existing.sandboxId) return { sandboxId: existing.sandboxId };
      // Recovered by its key only. Past Boat's key window nothing can find it,
      // and its lease stops it; this create takes the direct path.
      if (now.getTime() - existing.requestedAt.getTime() >= KEY_WINDOW_MS) { await copies.completeFork(workspace.id, null); return null; }
      return this.fork(workspace, existing);
    }
    if (workspace.boatSandboxId) return null;
    const owner = workspace.privateOwnerUserId ?? null;
    const ready = await copies.forkable(workspace.organizationId, workspace.repository, now, owner);
    if (!ready) {
      const building = await copies.building(workspace.organizationId, workspace.repository, owner);
      if (!building) await this.deps.queueFirst?.(workspace.organizationId, workspace.repository, owner).catch(() => undefined);
      if (building && now.getTime() - Date.parse(workspace.createdAt) < READY_COPY_FORK_WAIT_MS) return { waitMs: FORK_WAIT_POLL_MS };
      this.deps.logger?.warn(`[cloud-v2] ready copy unavailable; cloning directly (${building ? "still_building" : "none_ready"})`);
      return null;
    }
    const begun = await copies.beginFork(workspace.id, workspace.organizationId, ready.id, now);
    if (!begun) return null;
    return this.fork(workspace, begun);
  }

  private async fork(workspace: ReadyCopyWorkspace, fork: ReadyCopyFork): Promise<ReadyCopyForkOutcome> {
    try {
      const { sandboxId } = await this.deps.compute.fork(fork.machineId, { key: fork.key, ttlSeconds: CLOUD_V2_LEASE_SECONDS });
      await this.deps.copies.completeFork(workspace.id, sandboxId);
      return { sandboxId };
    } catch (error) {
      // Boat refused before making anything: the direct path, logged once.
      if (!lostOrRefused(error)) throw error;
      await this.deps.copies.completeFork(workspace.id, null);
      this.deps.logger?.warn(`[cloud-v2] ready copy fork refused; cloning directly (${code(error, "provider_request_failed")})`);
      return null;
    }
  }

  /** Brings the copy's checkout up to the requested base branch before the
   * worker starts. A failure is not the workspace's: it opens on the copy's
   * commit and the worker's own refresh retries the fetch in the background. */
  async fetchBase(workspace: W, sandboxId: string): Promise<boolean> {
    if (!this.deps.githubToken || !/^[A-Za-z0-9._/-]{1,255}$/.test(workspace.baseBranch) || workspace.baseBranch.startsWith("-")) return false;
    try {
      const { token } = await this.deps.githubToken(workspace);
      const dir = `/home/user/${workspace.repository}`, q = shellQuote, branch = workspace.baseBranch;
      const result = await this.deps.compute.execLong(sandboxId, asZeros([
        "set -e", "IFS= read -r ZEROS_GITHUB_AUTH_HEADER", "export ZEROS_GITHUB_AUTH_HEADER",
        `git -C ${q(dir)} --config-env=http.extraHeader=ZEROS_GITHUB_AUTH_HEADER fetch --quiet --prune origin ${q(`+refs/heads/${branch}:refs/remotes/origin/${branch}`)}`,
      ]), 300, `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}\n`);
      if (result.exitCode === 0 && !result.timedOut) return true;
    } catch { /* Reported below; the workspace still opens. */ }
    this.deps.logger?.warn("[cloud-v2] ready copy fork could not update its base branch; opening on the copy's commit");
    return false;
  }
}

export type ReadyCopyWorkspace = { id: string; organizationId: string; repository: string; baseBranch: string; createdAt: string; boatSandboxId: string | null;
  /** Set for a workspace of a private repository: its member. */
  privateOwnerUserId?: string | null };

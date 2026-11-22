// Ready copies: one stopped Boat machine per project and generation, with
// every repository of the project fully cloned and set up on the Cloud
// Computer base. New workspaces fork the ready generation; without one they
// take the direct clone path as before. Only composed when
// CloudV2Config.readyCopies is on.
//
// Every provider call is keyed: a generation's machine by its idempotency key,
// a workspace's fork by `ready-copy-fork:<workspace>`. A lost reply replays the
// key. Nothing is ever found by name, since Boat names every fork
// "<source name> fork". A copy only becomes ready once stopped, and a newer
// generation replaces it in one transaction; the old machine is deleted only
// after every fork that began from it has its machine.
import { projectFolderName, repositoryFolderNames } from "./workspace-layout.js";
import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { withSystemTx, type Tx } from "../db.js";
import { HttpError } from "../authz.js";
import { CLOUD_V2_LEASE_SECONDS, type CloudV2Compute } from "./boat.js";
import { BoatCreateRejectedError, BoatForkRefusedError, BoatSnapshotExpiredError } from "./boat-client.js";
import { CloudProviderError } from "./provider-error.js";
import { asZeros, checkoutScript, shellQuote } from "./computer.js";
import type { z } from "zod";
import { SUBMODULE_FETCHED, composeSubmodulePlan, readSubmoduleLevel, rememberedSubmoduleLevel, submoduleFetchLines, type SubmoduleLevel, type SubmodulePlan } from "./submodules.js";
import { installRuntimeCommand, type CloudV2Runtime } from "./runtime.js";
import { cloudV2BoatSnapshotName, cloudV2SandboxName } from "./resource-names.js";
import type { CloudSourceTarget } from "./source-authority.js";
import type { ReadyCopySecrets } from "./ready-copy-secrets.js";
import type { CloudProjectLevel } from "./projects.js";

const DAY_MS = 24 * 60 * 60_000;
/** A ready copy is rebuilt after this, so Boat never deletes its stopped disk (14 days after its stop). */
export const READY_COPY_REFRESH_MS = 7 * DAY_MS;
/** Past this a copy is never forked and is marked stale: Boat deletes its disk a day later. */
export const READY_COPY_EXPIRY_MS = 13 * DAY_MS;
/** An organization project's copy no workspace forked for this long is no longer refreshed; the row stays. */
export const READY_COPY_UNUSED_MS = 60 * DAY_MS;
/** A personal project's copy is no longer refreshed after this unforked. */
export const READY_COPY_PRIVATE_UNUSED_MS = 14 * DAY_MS;
/** Refresh starts across the deployment; first copies are never held back. */
export const READY_COPY_REFRESH_STARTS = { perMinute: 12, perHour: 60 } as const;
/** A create waits this long for a copy that is building, then clones directly. */
export const READY_COPY_FORK_WAIT_MS = 90_000;
const FORK_WAIT_POLL_MS = 3_000;
/** Boat keeps an idempotency key for 24 hours. */
const KEY_WINDOW_MS = 23 * 60 * 60_000;
/** A generation that failed is retried after 1 hour, then twice as long each
 * time, at most a day apart, and not at all after READY_COPY_RETRY_LIMIT
 * failures in a row: one that fails for its setup would otherwise rebuild a
 * whole project every hour forever. Anything that could fix it (a new base,
 * the project's repositories, a setup, a branch, its level or build secrets,
 * all in the inputs fingerprint) or Retry now starts it over. */
export const READY_COPY_RETRY_FIRST_MS = 60 * 60_000;
export const READY_COPY_RETRY_MAX_MS = 24 * 60 * 60_000;
export const READY_COPY_RETRY_LIMIT = 5;
export type ReadyCopyRetry = { failures: number; nextAt: Date | null; allowed: boolean };
const HEARTBEAT_MS = 60_000;
const ARCHIVE_READS = 24, ARCHIVE_WAIT_MS = 5_000;
const READY_ATTEMPTS = 36, READY_WAIT_MS = 5_000;

export type ReadyCopyState = "building" | "ready" | "failed" | "retired";
/** Why a generation ran, stored when it was queued. */
export type ReadyCopyTrigger = "project_created" | "repositories_changed" | "weekly_update" | "computer_build" | "setup_changed" | "branch_changed"
  | "secrets_changed" | "retry" | "manual";
/** The step of a build that failed, with the repository it was working on. */
export type ReadyCopyStep = "machine" | "runtime" | "clone" | "submodules" | "setup" | "scrub" | "secret_search" | "stop";
/** Generations whose detail (setup output, location) is kept per project; older rows keep only their result. */
export const READY_COPY_HISTORY_LIMIT = 20;
/** The last part of a failed setup's output that is kept, redacted. */
export const READY_COPY_OUTPUT_BYTES = 16 * 1024;
/** Build now: at most one manual start per project in this long. */
export const READY_COPY_MANUAL_INTERVAL_MS = 10 * 60_000;
/** What a generation cloned, per repository in position order. */
export type ReadyCopyRepositoryResult = { repository: string; repositoryId: string; branch: string | null; commit: string | null;
  /** Where it was cloned under /home/user: <project-folder>/<repository-folder>, the layout its workspaces have. */
  checkoutFolder?: string;
  /** With "fetch submodules" on: each submodule the copy holds, and each it skipped and why. */
  submodules?: ReadyCopySubmodule[] };
/** A submodule of a copy's repository. A create whose creator can't read a fetched one never forks the copy. */
export type ReadyCopySubmodule = { path: string; repository?: string; repositoryId?: string; commit?: string; fetched: boolean; reason?: string };
export type CloudV2ReadyCopy = {
  id: string; organizationId: string; projectId: string; generation: number; state: ReadyCopyState;
  idempotencyKey: string; machineId: string | null; machinePending: boolean; builtFromBase: string | null;
  computerBuildId: string | null; createdBy: string | null; result: ReadyCopyRepositoryResult[] | null;
  failureReason: string | null; failureRepository: string | null; failureStep: ReadyCopyStep | null; failureDetail: string | null;
  stale: boolean; refresh: boolean; machineDeletedAt: Date | null;
  inputs: string | null; manualRetry: boolean; trigger: ReadyCopyTrigger | null; triggeredBy: string | null;
  /** A finer reason for the history line: the submodules switch, which rebuilds as setup_changed. */
  triggerDetail: "submodules_changed" | null;
  setupOutput: string | null; detailPrunedAt: Date | null;
  stoppedAt: Date | null; lastForkedAt: Date | null; createdAt: Date; startedAt: Date | null; finishedAt: Date | null;
};
type Row = {
  id: string; org_id: string; project_id: string; generation: number; state: ReadyCopyState;
  idempotency_key: string; machine_id: string | null; machine_pending: boolean; built_from_base: string | null;
  computer_build_id: string | null; created_by: string | null; result: ReadyCopyRepositoryResult[] | null;
  failure_reason: string | null; failure_repository: string | null; failure_step: ReadyCopyStep | null; failure_detail: string | null;
  stale: boolean; refresh: boolean; machine_deleted_at: Date | null;
  inputs: string | null; manual_retry: boolean; trigger: ReadyCopyTrigger | null; triggered_by: string | null; trigger_detail: "submodules_changed" | null;
  setup_output: string | null; detail_pruned_at: Date | null;
  stopped_at: Date | null; last_forked_at: Date | null; created_at: Date; started_at: Date | null; finished_at: Date | null;
};
const copy = (row: Row): CloudV2ReadyCopy => ({
  id: row.id, organizationId: row.org_id, projectId: row.project_id, generation: row.generation, state: row.state,
  idempotencyKey: row.idempotency_key, machineId: row.machine_id, machinePending: row.machine_pending,
  builtFromBase: row.built_from_base, computerBuildId: row.computer_build_id, createdBy: row.created_by, result: row.result,
  failureReason: row.failure_reason, failureRepository: row.failure_repository, failureStep: row.failure_step, failureDetail: row.failure_detail,
  stale: row.stale, refresh: row.refresh, machineDeletedAt: row.machine_deleted_at, inputs: row.inputs, manualRetry: row.manual_retry,
  trigger: row.trigger, triggeredBy: row.triggered_by, triggerDetail: row.trigger_detail ?? null, setupOutput: row.setup_output, detailPrunedAt: row.detail_pruned_at,
  stoppedAt: row.stopped_at, lastForkedAt: row.last_forked_at, createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at,
});

/** The organization's live base-only Cloud Computer build: tools only, no
 * repository source, so only it may start a ready copy. */
export type ReadyCopyBase = { buildId: string; snapshot: string; createdBy: string; shared: boolean };

/** A project as its copy is built: its repositories in position order. Not
 * buildable while a personal project's member has left or the organization no
 * longer allows personal projects. */
export type ReadyCopyProject = {
  id: string; organizationId: string; name: string; level: CloudProjectLevel; ownerUserId: string | null; createdBy: string | null;
  buildable: boolean;
  repositories: { repository: string; repositoryId: string; connectionId: string | null; defaultBranch: string | null; setup: string | null; fetchSubmodules: boolean }[];
};

export type ReadyCopyFork = { copyId: string; key: string; machineId: string; sandboxId: string | null; requestedAt: Date };

/** Whether a personal project may still build: personal projects allowed, its member still in the organization. */
const PERSONAL_BUILDABLE = `(o.cloud_personal_projects_allowed AND EXISTS (SELECT 1 FROM organization_members m
  JOIN users u ON u.id=m.user_id AND u.auth_status='active' AND u.deleted_at IS NULL WHERE m.org_id=p.org_id AND m.user_id=p.owner_user_id))`;
const ORGANIZATION_AVAILABLE = "o.deleted_at IS NULL AND o.lifecycle_status='active' AND o.cloud_workspaces_allowed";

/** Lock order, for every transaction that touches these rows: the
 * organization row (Cloud Computer, project and deletion paths), then ready
 * copy rows in ascending id, then Cloud Computer build rows. A transaction
 * takes the strongest lock it will need on a row the first time it touches it
 * and never upgrades one (a shared lock followed by a write to the same row
 * deadlocks two creates); multi-row writes lock through an id-ordered subquery. */
export class CloudV2ReadyCopies {
  constructor(private readonly pool: pg.Pool) {}

  private tx<T>(work: (tx: Tx) => Promise<T>): Promise<T> { return withSystemTx(this.pool, work); }

  /** One submodule level of a repository at a commit, read only on a miss (cloud/submodules.ts). */
  submoduleLevel(organizationId: string, repository: { repository: string; repositoryId: string }, commit: string, read: () => Promise<SubmoduleLevel>) {
    return rememberedSubmoduleLevel(work => this.tx(work), organizationId, repository, commit, read);
  }

  async base(organizationId: string): Promise<ReadyCopyBase | null> {
    const row = (await this.tx(tx => tx.query<{ id: string; snapshot_name: string; created_by: string | null; base_shared: boolean }>(
      `SELECT b.id, c.snapshot_name, b.created_by, b.base_shared FROM cloud_v2_computers c
       JOIN cloud_v2_computer_builds b ON b.id=c.active_build_id AND b.org_id=c.org_id AND b.state='succeeded' AND b.base_only
       JOIN organizations o ON o.id=c.org_id AND ${ORGANIZATION_AVAILABLE}
       WHERE c.org_id=$1 AND c.snapshot_name IS NOT NULL`, [organizationId]))).rows[0];
    if (!row?.created_by) return null;
    return { buildId: row.id, snapshot: row.snapshot_name, createdBy: row.created_by, shared: row.base_shared };
  }

  /** Null once the project is gone or its organization is unavailable. */
  async project(projectId: string): Promise<ReadyCopyProject | null> {
    return this.tx(async tx => {
      const row = (await tx.query<{ id: string; org_id: string; name: string; level: CloudProjectLevel; owner_user_id: string | null;
        created_by: string | null; buildable: boolean }>(
        `SELECT p.id, p.org_id, p.name, p.level, p.owner_user_id, p.created_by, (p.level='organization' OR ${PERSONAL_BUILDABLE}) AS buildable
         FROM cloud_projects p JOIN organizations o ON o.id=p.org_id AND ${ORGANIZATION_AVAILABLE} WHERE p.id=$1`, [projectId])).rows[0];
      if (!row) return null;
      const repositories = (await tx.query<{ repository: string; repository_id: string; connection: string | null; default_branch: string | null; setup: string | null;
        fetch_submodules: boolean }>(
        "SELECT repository, repository_id, connection, default_branch, setup, fetch_submodules FROM cloud_project_repositories WHERE project_id=$1 ORDER BY position", [projectId])).rows;
      return { id: row.id, organizationId: row.org_id, name: row.name, level: row.level, ownerUserId: row.owner_user_id, createdBy: row.created_by,
        buildable: row.buildable, repositories: repositories.map(entry => ({ repository: entry.repository, repositoryId: entry.repository_id,
          connectionId: entry.connection, defaultBranch: entry.default_branch, setup: entry.setup, fetchSubmodules: entry.fetch_submodules })) };
    });
  }

  /** The organization's projects that should hold a copy now: every organization
   * project, and personal ones only once their member asked (a create or a save). */
  async organizationProjects(organizationId: string): Promise<string[]> {
    const { rows } = await this.tx(tx => tx.query<{ id: string }>(
      `SELECT p.id FROM cloud_projects p JOIN organizations o ON o.id=p.org_id AND ${ORGANIZATION_AVAILABLE}
       WHERE p.org_id=$1 AND p.level='organization' ORDER BY p.created_at, p.id`, [organizationId]));
    return rows.map(row => row.id);
  }

  /** Queues a generation, or joins the one already building for this project. */
  async request(input: { organizationId: string; projectId: string; createdBy: string; computerBuildId: string;
    builtFromBase: string; refresh?: boolean; now?: Date; inputs?: string | null; manualRetry?: boolean;
    trigger?: ReadyCopyTrigger; triggerDetail?: "submodules_changed"; triggeredBy?: string | null }): Promise<CloudV2ReadyCopy> {
    const id = randomUUID();
    return this.tx(async tx => {
      await tx.query(
        `INSERT INTO cloud_v2_ready_copies (id, org_id, project_id, generation, state, idempotency_key, built_from_base,
           computer_build_id, created_by, refresh, created_at, updated_at, inputs, manual_retry, trigger, triggered_by, trigger_detail)
         SELECT $1,$2,$3,coalesce((SELECT max(generation) FROM cloud_v2_ready_copies WHERE project_id=$3),0)+1,
           'building',$4,$5,$6,$7,$8,coalesce($9,clock_timestamp()),coalesce($9,clock_timestamp()),$10,$11,$12,$13,$14
         WHERE EXISTS (SELECT 1 FROM cloud_projects WHERE id=$3 AND org_id=$2)
         ON CONFLICT (project_id) WHERE state='building' DO NOTHING`,
        [id, input.organizationId, input.projectId, `ready-copy:${id}`, input.builtFromBase, input.computerBuildId,
          input.createdBy, input.refresh === true, input.now ?? null, input.inputs ?? null, input.manualRetry === true,
          input.trigger ?? null, input.triggeredBy ?? null, input.triggerDetail ?? null]);
      const row = (await tx.query<Row>("SELECT * FROM cloud_v2_ready_copies WHERE org_id=$1 AND project_id=$2 AND state='building'",
        [input.organizationId, input.projectId])).rows[0];
      if (!row) throw new HttpError(404, "not_found", "Project not found");
      return copy(row);
    });
  }

  async get(id: string): Promise<CloudV2ReadyCopy | null> {
    const row = (await this.tx(tx => tx.query<Row>("SELECT * FROM cloud_v2_ready_copies WHERE id=$1", [id]))).rows[0];
    return row ? copy(row) : null;
  }

  async list(organizationId: string, projectId?: string): Promise<CloudV2ReadyCopy[]> {
    const { rows } = await this.tx(tx => tx.query<Row>(
      `SELECT * FROM cloud_v2_ready_copies WHERE org_id=$1 AND ($2::uuid IS NULL OR project_id=$2) ORDER BY project_id, generation`,
      [organizationId, projectId ?? null]));
    return rows.map(copy);
  }

  /** Each organization project's latest generation that failed after its last
   * ready one, for the Cloud Computer page. Detail is a path at most. A personal
   * project's never reaches an admin. */
  async failures(organizationId: string): Promise<{ projectId: string; project: string; generation: number; reason: string; repository: string | null;
    step: ReadyCopyStep | null; detail: string | null; finishedAt: string }[]> {
    const { rows } = await this.tx(tx => tx.query<{ project_id: string; name: string; generation: number; failure_reason: string;
      failure_repository: string | null; failure_step: ReadyCopyStep | null; failure_detail: string | null; finished_at: Date }>(
      `SELECT DISTINCT ON (f.project_id) f.project_id, p.name, f.generation, f.failure_reason, f.failure_repository, f.failure_step, f.failure_detail, f.finished_at
       FROM cloud_v2_ready_copies f JOIN cloud_projects p ON p.id=f.project_id AND p.org_id=f.org_id AND p.level='organization'
       WHERE f.org_id=$1 AND f.state='failed' AND f.failure_reason IS NOT NULL AND f.finished_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM cloud_v2_ready_copies n WHERE n.project_id=f.project_id AND n.generation>f.generation AND n.state IN ('ready','retired'))
       ORDER BY f.project_id, f.generation DESC`, [organizationId]));
    return rows.map(row => ({ projectId: row.project_id, project: row.name, generation: row.generation, reason: row.failure_reason,
      repository: row.failure_repository, step: row.failure_step, detail: row.failure_detail, finishedAt: row.finished_at.toISOString() }))
      .sort((a, b) => a.project.localeCompare(b.project));
  }

  /** Projects whose latest generation failed with none ready or building:
   * candidates for an automatic retry once the backoff allows. */
  async unrecovered(limit = 100): Promise<CloudV2ReadyCopy[]> {
    const { rows } = await this.tx(tx => tx.query<Row>(
      `SELECT DISTINCT ON (f.project_id) f.* FROM cloud_v2_ready_copies f
       JOIN organizations o ON o.id=f.org_id AND ${ORGANIZATION_AVAILABLE}
       JOIN cloud_projects p ON p.id=f.project_id AND p.org_id=f.org_id AND (p.level='organization' OR ${PERSONAL_BUILDABLE})
       WHERE f.state='failed' AND NOT EXISTS (SELECT 1 FROM cloud_v2_ready_copies n
         WHERE n.project_id=f.project_id AND (n.state IN ('building','ready') OR n.generation>f.generation))
       ORDER BY f.project_id, f.generation DESC LIMIT $1`, [limit]));
    return rows.map(copy);
  }

  /** The Cloud Computer page's line per failed organization project: what
   * failed, in which repository and step, how many times in a row, and when the
   * next automatic retry is (null: stopped). */
  async failureSummaries(organizationId: string, now: Date): Promise<(Awaited<ReturnType<CloudV2ReadyCopies["failures"]>>[number]
    & { failures: number; nextRetryAt: string | null })[]> {
    const summaries = [];
    for (const failure of await this.failures(organizationId)) {
      const retry = await this.retryState(failure.projectId, await this.inputs(organizationId, failure.projectId), now);
      summaries.push({ ...failure, failures: Math.max(retry.failures, 1), nextRetryAt: retry.nextAt?.toISOString() ?? null });
    }
    return summaries;
  }

  /** Per project the viewer may see (the organization's and their own): whether its first copy is still being made. */
  async status(organizationId: string, viewerUserId: string | null = null): Promise<Map<string, "ready" | "building" | null>> {
    const { rows } = await this.tx(tx => tx.query<{ project_id: string; ready: boolean; building: boolean }>(
      `SELECT c.project_id, bool_or(c.state='ready') AS ready, bool_or(c.state='building') AS building
       FROM cloud_v2_ready_copies c JOIN cloud_projects p ON p.id=c.project_id AND p.org_id=c.org_id
       WHERE c.org_id=$1 AND (p.level='organization' OR p.owner_user_id=$2::uuid) GROUP BY c.project_id`, [organizationId, viewerUserId]));
    return new Map(rows.map(row => [row.project_id, row.ready ? "ready" : row.building ? "building" : null]));
  }

  /** The generation a workspace may fork now: ready, not stale, stopped recently enough. */
  async forkable(organizationId: string, projectId: string, now: Date): Promise<CloudV2ReadyCopy | null> {
    const row = (await this.tx(tx => tx.query<Row>(
      `SELECT * FROM cloud_v2_ready_copies WHERE org_id=$1 AND project_id=$2 AND state='ready' AND NOT stale
         AND machine_id IS NOT NULL AND stopped_at > $3::timestamptz - make_interval(secs => $4::double precision / 1000)`,
      [organizationId, projectId, now, READY_COPY_EXPIRY_MS]))).rows[0];
    return row ? copy(row) : null;
  }

  async building(organizationId: string, projectId: string): Promise<CloudV2ReadyCopy | null> {
    const row = (await this.tx(tx => tx.query<Row>(
      "SELECT * FROM cloud_v2_ready_copies WHERE org_id=$1 AND project_id=$2 AND state='building'", [organizationId, projectId]))).rows[0];
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
           JOIN organizations o ON o.id=c.org_id AND ${ORGANIZATION_AVAILABLE}
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
  async fail(id: string, reason: string, now = new Date(), where: { repository?: string | null; step?: ReadyCopyStep | null;
    detail?: string | null; output?: string | null } = {}): Promise<void> {
    const code = /^[a-z0-9_]{1,64}$/.test(reason) ? reason : "ready_copy_failed";
    const repository = where.repository && /^[a-z0-9_.-]{1,100}\/[a-z0-9_.-]{1,100}$/.test(where.repository) ? where.repository : null;
    await this.tx(async tx => {
      await tx.query(
        `UPDATE cloud_v2_ready_copies SET state='failed', failure_reason=$2, failure_detail=$4, setup_output=$5, failure_repository=$6, failure_step=$7,
           finished_at=$3, updated_at=$3 WHERE id=$1 AND state='building'`,
        [id, code, now, where.detail?.slice(0, 1100) || null, where.output ? tailBytes(where.output, READY_COPY_OUTPUT_BYTES) : null,
          repository, where.step ?? null]);
      await this.pruneDetail(tx, id);
    });
  }

  /** The atomic pointer switch: the previous ready generation retires in the
   * same transaction this one becomes ready. */
  async promote(id: string, result: { repositories: ReadyCopyRepositoryResult[]; stoppedAt: Date }): Promise<boolean> {
    return this.tx(async tx => {
      const target = (await tx.query<{ project_id: string }>("SELECT project_id FROM cloud_v2_ready_copies WHERE id=$1", [id])).rows[0];
      if (!target) return false;
      // This generation and the ready one it replaces, locked together in id order.
      const locked = (await tx.query<Row>(`SELECT * FROM cloud_v2_ready_copies WHERE project_id=$1 AND (id=$2 OR state='ready') ORDER BY id FOR UPDATE`,
        [target.project_id, id])).rows;
      const row = locked.find(candidate => candidate.id === id);
      if (!row || row.state !== "building" || !row.machine_id) return false;
      await tx.query(`UPDATE cloud_v2_ready_copies SET state='retired', updated_at=clock_timestamp() WHERE project_id=$1 AND state='ready' AND id<>$2`,
        [row.project_id, id]);
      await tx.query(`UPDATE cloud_v2_ready_copies SET state='ready', stale=false, result=$2, stopped_at=$3,
        finished_at=clock_timestamp(), updated_at=clock_timestamp() WHERE id=$1`, [id, JSON.stringify(result.repositories), result.stoppedAt]);
      await this.pruneDetail(tx, id);
      return true;
    });
  }

  async retire(id: string): Promise<void> {
    await this.tx(tx => tx.query("UPDATE cloud_v2_ready_copies SET state='retired', updated_at=clock_timestamp() WHERE id=$1 AND state='ready'", [id]));
  }

  /** Copies of organizations deleted or without cloud access, of removed
   * projects, and of personal projects whose member left: retired, or failed
   * while building, so cleanup deletes their machines. */
  async retireUnavailable(): Promise<number> {
    const { rowCount } = await this.tx(tx => tx.query(`UPDATE cloud_v2_ready_copies SET
        state=CASE WHEN state='building' THEN 'failed' ELSE 'retired' END,
        failure_reason=CASE WHEN state='building' THEN 'organization_unavailable' ELSE failure_reason END, updated_at=clock_timestamp()
      WHERE id IN (SELECT c.id FROM cloud_v2_ready_copies c
        LEFT JOIN organizations o ON o.id=c.org_id AND ${ORGANIZATION_AVAILABLE}
        WHERE c.state IN ('building','ready') AND o.id IS NULL ORDER BY c.id FOR UPDATE OF c)`));
    const orphans = await this.tx(tx => tx.query(`UPDATE cloud_v2_ready_copies SET state=CASE WHEN state='building' THEN 'failed' ELSE 'retired' END,
        failure_reason=CASE WHEN state='building' THEN 'project_unavailable' ELSE failure_reason END, updated_at=clock_timestamp()
      WHERE id IN (SELECT c.id FROM cloud_v2_ready_copies c WHERE c.state IN ('building','ready')
        AND NOT EXISTS (SELECT 1 FROM cloud_projects p WHERE p.id=c.project_id AND p.org_id=c.org_id AND (p.level='organization' OR EXISTS (
          SELECT 1 FROM organization_members m JOIN users u ON u.id=m.user_id AND u.auth_status='active' AND u.deleted_at IS NULL
          WHERE m.org_id=p.org_id AND m.user_id=p.owner_user_id)))
        ORDER BY c.id FOR UPDATE OF c)`));
    return (rowCount ?? 0) + (orphans.rowCount ?? 0);
  }

  /** Past READY_COPY_HISTORY_LIMIT generations a row keeps its result, not its detail. */
  private async pruneDetail(tx: Tx, id: string): Promise<void> {
    await tx.query(`UPDATE cloud_v2_ready_copies SET setup_output=NULL, failure_detail=NULL, detail_pruned_at=clock_timestamp()
      WHERE id IN (SELECT o.id FROM cloud_v2_ready_copies o JOIN cloud_v2_ready_copies c ON c.id=$1
        WHERE o.project_id=c.project_id AND o.detail_pruned_at IS NULL ORDER BY o.generation DESC OFFSET $2)`, [id, READY_COPY_HISTORY_LIMIT]);
  }

  /** A project's generations, newest first, within the history bound. */
  async history(organizationId: string, projectId: string): Promise<CloudV2ReadyCopy[]> {
    const { rows } = await this.tx(tx => tx.query<Row>(
      `SELECT * FROM cloud_v2_ready_copies WHERE org_id=$1 AND project_id=$2 ORDER BY generation DESC LIMIT $3`,
      [organizationId, projectId, READY_COPY_HISTORY_LIMIT]));
    return rows.map(copy);
  }

  /** Whether Build now may start one: at most one manual start per project per READY_COPY_MANUAL_INTERVAL_MS. */
  async manualAllowed(projectId: string, now: Date): Promise<boolean> {
    const { rows } = await this.tx(tx => tx.query<{ recent: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM cloud_v2_ready_copies WHERE project_id=$1 AND trigger='manual'
         AND created_at > $2::timestamptz - make_interval(secs => $3::double precision / 1000)) AS recent`,
      [projectId, now, READY_COPY_MANUAL_INTERVAL_MS]));
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
   * within the last 60 days (14 for a personal project), not while one builds.
   * The retry backoff is the caller's (retryState). */
  async refreshCandidates(now: Date, limit = 100): Promise<CloudV2ReadyCopy[]> {
    const { rows } = await this.tx(tx => tx.query<Row>(
      `SELECT r.* FROM cloud_v2_ready_copies r
       JOIN organizations o ON o.id=r.org_id AND ${ORGANIZATION_AVAILABLE}
       JOIN cloud_projects p ON p.id=r.project_id AND p.org_id=r.org_id
       WHERE r.state='ready'
         AND (r.stale OR r.stopped_at <= $1::timestamptz - make_interval(secs => $2::double precision / 1000))
         AND coalesce(r.last_forked_at, r.created_at) > $1::timestamptz - make_interval(secs =>
           (CASE WHEN p.level='organization' THEN $3 ELSE $5 END)::double precision / 1000)
         -- A personal project refreshes only while personal projects are allowed and its member stays.
         AND (p.level='organization' OR ${PERSONAL_BUILDABLE})
         AND NOT EXISTS (SELECT 1 FROM cloud_v2_ready_copies b WHERE b.project_id=r.project_id AND b.state='building')
       ORDER BY r.stale DESC, r.stopped_at, r.id LIMIT $4`, [now, READY_COPY_REFRESH_MS, READY_COPY_UNUSED_MS, limit, READY_COPY_PRIVATE_UNUSED_MS]));
    return rows.map(copy);
  }

  /** Whether a first copy for this project may be queued now: none building
   * or ready, and the retry backoff allows it for these inputs. */
  async mayQueueFirst(projectId: string, now: Date, inputs: string | null = null): Promise<boolean> {
    const { rows } = await this.tx(tx => tx.query<{ blocked: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM cloud_v2_ready_copies WHERE project_id=$1 AND state IN ('building','ready')) AS blocked`, [projectId]));
    return !rows[0]?.blocked && (await this.retryState(projectId, inputs, now)).allowed;
  }

  /** Consecutive failed generations since the last ready or building one,
   * counted while their inputs equal `inputs` and up to a Retry now or Build now. */
  async retryState(projectId: string, inputs: string | null, now: Date): Promise<ReadyCopyRetry> {
    const { rows } = await this.tx(tx => tx.query<{ state: ReadyCopyState; inputs: string | null; manual_retry: boolean; finished_at: Date | null }>(
      `SELECT state, inputs, manual_retry, finished_at FROM cloud_v2_ready_copies WHERE project_id=$1 ORDER BY generation DESC LIMIT $2`,
      [projectId, READY_COPY_RETRY_LIMIT + 1]));
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

  /** What a project's copy is built from; see READY_COPY_RETRY_LIMIT. Null without a base or project. */
  async inputs(organizationId: string, projectId: string): Promise<string | null> {
    const base = await this.base(organizationId), project = await this.project(projectId);
    if (!base || !project || project.organizationId !== organizationId) return null;
    const secrets = (await this.tx(tx => tx.query<{ updated_at: Date }>(
      "SELECT updated_at FROM cloud_v2_ready_copy_secrets WHERE org_id=$1 AND project_id=$2", [organizationId, projectId]))).rows[0];
    return createHash("sha256").update(JSON.stringify(["project", base.buildId, project.level, project.ownerUserId,
      // Fetching submodules joins only when on, so every existing copy's inputs stay as they were.
      project.repositories.map(entry => [entry.repositoryId, entry.defaultBranch, entry.setup, ...(entry.fetchSubmodules ? [true] : [])]),
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
   * row's lock, and a retired copy is never forked anew), and stamps the copy's
   * own use. Never the workspace's activity: active_at belongs to people. Null
   * when it is no longer ready. */
  async beginFork(workspaceId: string, organizationId: string, copyId: string, now: Date): Promise<ReadyCopyFork | null> {
    return this.tx(async tx => {
      const row = (await tx.query<{ machine_id: string | null; project_id: string }>(
        // The write below needs this lock anyway; taking a weaker one first deadlocks concurrent creates.
        `SELECT machine_id, project_id FROM cloud_v2_ready_copies WHERE id=$1 AND org_id=$2 AND state='ready' AND NOT stale FOR NO KEY UPDATE`,
        [copyId, organizationId])).rows[0];
      if (!row?.machine_id) return null;
      const scope = (await tx.query<{ level: CloudProjectLevel; owner_user_id: string | null; workspace_project: string | null;
        creator_user_id: string | null; private_owner_user_id: string | null }>(
        `SELECT p.level, p.owner_user_id, w.project_id AS workspace_project, w.creator_user_id, w.private_owner_user_id
         FROM cloud_projects p JOIN cloud_v2_workspaces w ON w.id=$2 AND w.org_id=p.org_id WHERE p.id=$1`, [row.project_id, workspaceId])).rows[0];
      // Only a workspace of this project forks its copy; a personal project's,
      // only a workspace its member creates for themselves.
      if (!scope || scope.workspace_project !== row.project_id || (scope.level === "personal"
        && (scope.private_owner_user_id !== scope.owner_user_id || scope.creator_user_id !== scope.owner_user_id)))
        throw new HttpError(403, "ready_copy_project_mismatch", "This workspace can't use that project's ready copy.");
      const key = `ready-copy-fork:${workspaceId}`;
      const inserted = await tx.query<{ requested_at: Date }>(
        `INSERT INTO cloud_v2_ready_copy_forks (workspace_id, org_id, copy_id, fork_key, requested_at) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (workspace_id) DO NOTHING RETURNING requested_at`, [workspaceId, organizationId, copyId, key, now]);
      if (!inserted.rows[0]) return null;
      await tx.query("UPDATE cloud_v2_ready_copies SET last_forked_at=$2 WHERE id=$1", [copyId, now]);
      return { copyId, key, machineId: row.machine_id, sandboxId: null, requestedAt: inserted.rows[0].requested_at };
    });
  }

  /** A workspace's repositories as [id, checkout folder] in position order, to match a copy's layout. */
  async workspaceLayout(workspaceId: string): Promise<[string, string | null][]> {
    const { rows } = await this.tx(tx => tx.query<{ id: string | null; checkout: string | null }>(
      `SELECT coalesce(r.repository_id, s.repository_id)::text AS id,
         CASE WHEN r.position=0 THEN w.checkout_path ELSE w.folder || '/' || r.folder END AS checkout
       FROM cloud_v2_workspace_repositories r JOIN cloud_v2_workspaces w ON w.id=r.workspace_id
       LEFT JOIN cloud_v2_github_sources s ON s.workspace_id=r.workspace_id AND s.source_repository=lower(r.repository)
       WHERE r.workspace_id=$1 ORDER BY r.position`, [workspaceId]));
    return rows.map(row => [row.id ?? "", row.checkout]);
  }

  /** Each repository's requested base branch and checkout, for the fork's update. */
  async workspaceBases(workspaceId: string): Promise<{ repository: string; baseBranch: string; checkoutFolder: string | null; first: boolean }[]> {
    const { rows } = await this.tx(tx => tx.query<{ position: number; repository: string; base_branch: string; checkout: string | null }>(
      `SELECT r.position, r.repository, r.base_branch, CASE WHEN r.position=0 THEN w.checkout_path ELSE w.folder || '/' || r.folder END AS checkout
       FROM cloud_v2_workspace_repositories r JOIN cloud_v2_workspaces w ON w.id=r.workspace_id WHERE r.workspace_id=$1 ORDER BY r.position`, [workspaceId]));
    return rows.map(row => ({ repository: row.repository, baseBranch: row.base_branch, checkoutFolder: row.checkout, first: row.position === 0 }));
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
  /** A short-lived token able to clone one repository, as one member (a personal project's). */
  cloneToken(organizationId: string, userId: string, target: CloudSourceTarget): Promise<string>;
  /** An organization project's token, from the organization's GitHub connection, never an admin's own login. */
  sharedCloneToken?(organizationId: string, target: CloudSourceTarget): Promise<string>;
  /** A project's build secrets; empty when none. */
  secrets?(organizationId: string, projectId: string): Promise<ReadyCopySecrets>;
  /** GitHub's API as one token (cloud/submodules.ts reads a level with the token of that repository). */
  githubHttp?(token: string): { json<T>(path: string, schema: z.ZodType<T>): Promise<T> };
  /** A submodule repository the build may read: its id and a token to read and clone it, as the project's
   * clone tokens are (the member's for a personal project, the organization's connection otherwise); null when not. */
  submoduleRepository?(organizationId: string, project: { level: CloudProjectLevel; ownerUserId: string | null }, repository: string):
    Promise<{ repositoryId: string; token: string } | null>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  logger?: Pick<Console, "warn">;
};

/** Each repository's folder in a project's copy: the layout a workspace
 * created from the project now has (workspace-layout.ts), so a fork's checkouts
 * are where its worker expects them and setup output keeps its paths. */
export const readyCopyLayout = (project: { name: string; repositories: readonly { repository: string }[] }): string[] => {
  const folder = projectFolderName(project.name);
  return repositoryFolderNames(project.repositories.map(entry => entry.repository)).map(name => `${folder}/${name}`);
};
const homePath = (checkoutFolder: string) => `/home/user/${checkoutFolder}`;

export class CloudV2ReadyCopyBuilder {
  private closed = false;
  constructor(private readonly deps: ReadyCopyBuilderDeps) {}

  private now(): Date { return new Date(this.deps.now?.() ?? Date.now()); }
  private sleep(ms: number): Promise<void> { return (this.deps.sleep ?? (value => new Promise(resolve => setTimeout(resolve, value))))(ms); }
  close(): void { this.closed = true; }

  /** A Cloud Computer base went live: first copies for the organization's
   * projects, and every ready copy rebuilt from it. A runtime-only refresh
   * changes nothing a copy holds; workspaces install the runtime they need. */
  async baseActivated(organizationId: string, reason: string): Promise<void> {
    if (reason !== "runtime") await this.deps.copies.markStale(organizationId);
    for (const projectId of await this.deps.copies.organizationProjects(organizationId)) {
      if (this.closed) return;
      await this.queueFirst(organizationId, projectId, "computer_build");
    }
  }

  /** A project's first copy, once nothing is building or ready and the backoff allows. */
  async queueFirst(organizationId: string, projectId: string, trigger: ReadyCopyTrigger = "project_created"): Promise<CloudV2ReadyCopy | null> {
    const { copies } = this.deps;
    const base = await copies.base(organizationId), project = await copies.project(projectId);
    if (!base || !project || project.organizationId !== organizationId || !project.buildable || !project.repositories.length) return null;
    const inputs = await copies.inputs(organizationId, projectId);
    if (!await copies.mayQueueFirst(projectId, this.now(), inputs)) return null;
    return copies.request({ organizationId, projectId, createdBy: project.ownerUserId ?? project.createdBy ?? base.createdBy,
      computerBuildId: base.buildId, builtFromBase: `snapshot:${base.snapshot}`, inputs, trigger });
  }

  /** A project was created or saved, or its build secrets changed: rebuild that
   * project's copy alone, once its inputs differ from the copy's. A changed set
   * of repositories always starts from the base. */
  async reconcile(organizationId: string, projectId: string, change: "project_created" | "repositories_changed" | "setup_changed" | "submodules_changed" | "branch_changed" | "secrets_changed"): Promise<void> {
    // The switch rebuilds as a setup change (the trigger's CHECK is unchanged); the history names it.
    const trigger = change === "submodules_changed" ? "setup_changed" as const : change;
    const triggerDetail = change === "submodules_changed" ? "submodules_changed" as const : undefined;
    const { copies } = this.deps, base = await copies.base(organizationId), project = await copies.project(projectId);
    if (!base || !project || project.organizationId !== organizationId || !project.buildable || !project.repositories.length) return;
    const inputs = await copies.inputs(organizationId, projectId);
    const latest = (await copies.history(organizationId, projectId)).find(row => row.state !== "retired");
    if (!latest) { await this.queueFirst(organizationId, projectId, trigger); return; }
    if (latest.inputs === inputs && latest.state !== "failed") return;
    const ready = trigger === "repositories_changed" ? null : await copies.forkable(organizationId, projectId, this.now());
    await copies.request({ organizationId, projectId, createdBy: project.ownerUserId ?? project.createdBy ?? base.createdBy,
      computerBuildId: base.buildId, builtFromBase: ready && ready.computerBuildId === base.buildId ? `copy:${ready.id}` : `snapshot:${base.snapshot}`,
      refresh: !!ready, inputs, trigger, ...(triggerDetail ? { triggerDetail } : {}) });
  }

  /** Build now (whoever may edit the project; the route checks): coalesces with
   * a running build, at most one manual start per project each READY_COPY_MANUAL_INTERVAL_MS. */
  async buildNow(organizationId: string, projectId: string, userId: string): Promise<CloudV2ReadyCopy | null> {
    const { copies } = this.deps, now = this.now();
    const building = await copies.building(organizationId, projectId);
    if (building) return building;
    if (!await copies.manualAllowed(projectId, now))
      throw new HttpError(429, "ready_copy_build_limited", "This project's copy was started a few minutes ago. Try again later.");
    return this.manual(organizationId, projectId, userId, now);
  }

  /** Retry now from the Cloud Computer page: a new generation whatever the backoff, which also starts it over. */
  async retryNow(organizationId: string, projectId: string, userId: string | null = null): Promise<CloudV2ReadyCopy | null> {
    return (await this.deps.copies.building(organizationId, projectId)) ?? this.manual(organizationId, projectId, userId, this.now());
  }

  private async manual(organizationId: string, projectId: string, userId: string | null, now: Date): Promise<CloudV2ReadyCopy | null> {
    const { copies } = this.deps, base = await copies.base(organizationId), project = await copies.project(projectId);
    if (!base || !project || project.organizationId !== organizationId || !project.buildable || !project.repositories.length) return null;
    const ready = await copies.forkable(organizationId, projectId, now);
    return copies.request({ organizationId, projectId, createdBy: project.ownerUserId ?? project.createdBy ?? base.createdBy,
      computerBuildId: base.buildId, builtFromBase: ready && ready.computerBuildId === base.buildId ? `copy:${ready.id}` : `snapshot:${base.snapshot}`,
      refresh: !!ready, inputs: await copies.inputs(organizationId, projectId), manualRetry: true, trigger: "manual", triggeredBy: userId });
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
      const base = await copies.base(ready.organizationId), project = await copies.project(ready.projectId);
      if (!base || !project?.buildable) continue;
      // A refresh that keeps failing backs off and stops like a first copy; the
      // older generation keeps serving until it expires, and only those who edit the project hear of it.
      const inputs = await copies.inputs(ready.organizationId, ready.projectId);
      const retry = await copies.retryState(ready.projectId, inputs, now);
      if (!retry.allowed) continue;
      const trigger: ReadyCopyTrigger = retry.failures ? "retry" : ready.computerBuildId !== base.buildId ? "computer_build" : "weekly_update";
      // A copy on the current base, with the same repositories, is refreshed by forking it; otherwise it is rebuilt from the base.
      const same = JSON.stringify(ready.result?.map(entry => entry.repositoryId) ?? []) === JSON.stringify(project.repositories.map(entry => entry.repositoryId));
      await copies.request({ organizationId: ready.organizationId, projectId: ready.projectId,
        createdBy: project.ownerUserId ?? project.createdBy ?? base.createdBy, computerBuildId: base.buildId, refresh: true, inputs, trigger,
        builtFromBase: ready.stale || !ready.machineId || ready.computerBuildId !== base.buildId || !same ? `snapshot:${base.snapshot}` : `copy:${ready.id}` });
    }
    // First copies that failed: retried on the backoff, then left until something changes.
    for (const failed of await copies.unrecovered()) {
      if (this.closed) return;
      await this.queueFirst(failed.organizationId, failed.projectId, "retry");
    }
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
    // Which repository and step the build is in, for the failure line.
    const at: { step: ReadyCopyStep; repository: string | null } = { step: "machine", repository: null };
    try { await this.build(job, at); }
    catch (error) {
      const reason = code(error, "ready_copy_failed");
      const detail = (error as { detail?: unknown } | null)?.detail, output = (error as { output?: unknown } | null)?.output;
      this.deps.logger?.warn(`[cloud-v2] ready copy of project ${job.projectId} generation ${job.generation} failed (${reason}, ${at.step})`);
      await copies.fail(job.id, reason, this.now(), { repository: at.repository, step: at.step,
        detail: typeof detail === "string" ? detail : null, output: typeof output === "string" ? output : null });
    } finally { clearInterval(beat); }
  }

  private async build(job: CloudV2ReadyCopy, at: { step: ReadyCopyStep; repository: string | null }): Promise<void> {
    const { compute, copies } = this.deps;
    const base = await copies.base(job.organizationId), project = await copies.project(job.projectId);
    if (!base) throw failure("ready_copy_base_changed");
    if (!project || project.organizationId !== job.organizationId || !project.buildable || !project.repositories.length) throw failure("ready_copy_project_changed");
    if (!await copies.machinePending(job.id)) return;
    const machineId = await this.machine(job);
    await copies.machineCreated(job.id, machineId);
    await this.ready(machineId);
    // A fork of the previous generation already has both; a base made before
    // a runtime release still installs the pin workspaces need.
    if (!job.builtFromBase?.startsWith("copy:")) {
      at.step = "runtime";
      const installed = await compute.exec(machineId, installRuntimeCommand({ sha256: this.deps.runtime.sha256, url: await this.deps.runtime.url(this.deps.runtime.sha256),
        ...(this.deps.publicKeys ? { publicKeys: this.deps.publicKeys } : {}) }), 300);
      if (installed.exitCode !== 0 || installed.timedOut) throw failure("worker_runtime_install_failed");
    }
    // Every repository is cloned in full first; a refresh fetches into the previous generation's.
    const result: ReadyCopyRepositoryResult[] = [], layout = readyCopyLayout(project), tokens: string[] = [];
    at.step = "clone";
    for (const [index, entry] of project.repositories.entries()) {
      at.repository = entry.repository;
      const target = { repository: entry.repository, repositoryId: entry.repositoryId };
      // An organization project clones through the organization's GitHub connection; a personal one as its member.
      const token = project.level === "personal" ? await this.deps.cloneToken(job.organizationId, project.ownerUserId!, target)
        : this.deps.sharedCloneToken ? await this.deps.sharedCloneToken(job.organizationId, target)
        : await this.deps.cloneToken(job.organizationId, base.createdBy, target);
      tokens.push(token);
      const header = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}\n`;
      const clone = await compute.execLong(machineId, asZeros(checkoutScript({ repository: entry.repository, ...(entry.defaultBranch ? { ref: entry.defaultBranch } : {}) },
        homePath(layout[index]!), entry.repository)), 900, header);
      if (clone.exitCode !== 0) throw failure("ready_copy_clone_failed");
      const commit = clone.stdout.trim().split("\n").pop() ?? "";
      result.push({ repository: entry.repository, repositoryId: entry.repositoryId, checkoutFolder: layout[index]!,
        branch: /(?:^|\n)zeros-build-branch=([^\r\n]*)/.exec(clone.stdout)?.[1] || null, commit: /^[0-9a-f]{40}$/.test(commit) ? commit : null });
    }
    // Then submodules where a repository fetches them, before setup, so a setup can use their files.
    for (const [index, entry] of project.repositories.entries())
      if (entry.fetchSubmodules && result[index]!.commit) {
        at.step = "submodules"; at.repository = entry.repository;
        result[index]!.submodules = await this.fetchSubmodules(machineId, job, project, { ...entry, commit: result[index]!.commit! }, homePath(layout[index]!), tokens[index]!);
      }
    // Then each repository's setup in its own folder, in position order, with the project's build secrets.
    let values: string[] = [];
    if (project.repositories.some(entry => entry.setup)) {
      at.step = "setup";
      const secrets = await this.deps.secrets?.(job.organizationId, job.projectId) ?? {};
      const names = Object.keys(secrets);
      const input = names.length ? names.map(name => `${name}=${Buffer.from(secrets[name]!, "utf8").toString("base64")}`).join("\n") + "\n" : undefined;
      for (const [index, entry] of project.repositories.entries()) {
        if (!entry.setup) continue;
        at.repository = entry.repository;
        const dir = homePath(layout[index]!);
        const setup = await compute.execLong(machineId, readyCopySetupCommand(dir, entry.setup, input !== undefined), 3600, input);
        // Only a failed setup keeps its output: the last part, every build secret redacted.
        if (setup.exitCode !== 0 || setup.timedOut)
          throw Object.assign(failure("ready_copy_setup_failed"), { output: redactSecrets(setup.stdout, Object.values(secrets)) });
        const tidy = await compute.exec(machineId, asZeros([`cd ${shellQuote(dir)}`,
          "if [ \"$(git status --porcelain --untracked-files=no | wc -l)\" -gt 0 ]; then git reset -q --hard HEAD; fi"]), 120);
        if (tidy.exitCode !== 0 || tidy.timedOut) throw failure("ready_copy_setup_failed");
      }
      values = Object.values(secrets).filter(value => value.length >= READY_COPY_SECRET_MIN_SEARCH_LENGTH);
    }
    at.repository = null;
    at.step = "scrub";
    const scrub = await compute.exec(machineId, READY_COPY_SCRUB_COMMAND, 120);
    if (scrub.exitCode !== 0 || scrub.timedOut) throw failure("ready_copy_scrub_failed");
    if (values.length) {
      at.step = "secret_search";
      const searched = await compute.execLong(machineId, READY_COPY_SECRET_SEARCH_COMMAND, READY_COPY_SECRET_SEARCH_SECONDS, `${values.join("\n")}\n`);
      const found = readyCopySearchResult(searched.stdout);
      // Every member's fork would hold it: this generation never becomes ready.
      if (found.found) {
        const location = readyCopySecretLocation(found.found, values);
        at.repository = project.repositories.find((_entry, index) => location.startsWith(`${homePath(layout[index]!)}/`))?.repository ?? null;
        throw Object.assign(failure("ready_copy_secret_left"), { detail: location });
      }
      // Fails closed: a copy that was not searched in full never becomes ready.
      if (searched.exitCode !== 0 || searched.timedOut || !found.complete) throw failure("ready_copy_secret_search_incomplete");
    }
    at.step = "stop";
    await compute.stop(machineId);
    const stoppedAt = await this.archived(machineId);
    if (!await copies.promote(job.id, { repositories: result, stoppedAt })) throw failure("ready_copy_superseded");
  }

  /** One repository's submodules on the build machine: the plan composed with the build's own access, then each
   * fetched in order. A submodule the build can't read, or that fails, is skipped and named; its own submodules
   * are skipped with it. A GitHub failure skips them all; the build still goes on. */
  private async fetchSubmodules(machineId: string, job: CloudV2ReadyCopy, project: { level: CloudProjectLevel; ownerUserId: string | null },
    root: { repository: string; repositoryId: string; commit: string }, checkout: string, rootToken: string): Promise<ReadyCopySubmodule[]> {
    const { githubHttp, submoduleRepository, copies, compute } = this.deps;
    if (!githubHttp || !submoduleRepository) return [];
    const tokens = new Map([[root.repositoryId, rootToken]]);
    let plan: SubmodulePlan;
    try {
      plan = await composeSubmodulePlan({ root,
        level: (repository, commit) => copies.submoduleLevel(job.organizationId, repository, commit,
          () => readSubmoduleLevel(githubHttp(tokens.get(repository.repositoryId)!), repository, commit)),
        access: async repository => {
          const found = await submoduleRepository(job.organizationId, project, repository).catch(() => null);
          if (!found) return null;
          tokens.set(found.repositoryId, found.token);
          return found.repositoryId;
        } });
    } catch (error) {
      this.deps.logger?.warn(`[cloud-v2] ready copy of project ${job.projectId} could not read ${root.repository}'s submodules (${code(error, "failed")})`);
      return [{ path: ".gitmodules", fetched: false, reason: "GitHub could not be read" }];
    }
    const outcomes: ReadyCopySubmodule[] = [...plan.notices.map(reason => ({ path: ".gitmodules", fetched: false, reason })),
      ...plan.skipped.map(entry => ({ path: entry.path, ...(entry.repository ? { repository: entry.repository } : {}), fetched: false, reason: entry.reason }))];
    const failed: string[] = [];
    for (const entry of plan.submodules) {
      const summary = { path: entry.path, repository: entry.repository, repositoryId: entry.repositoryId, commit: entry.commit };
      if (failed.some(parent => entry.path.startsWith(`${parent}/`))) { outcomes.push({ ...summary, fetched: false, reason: "its parent submodule was not fetched" }); failed.push(entry.path); continue; }
      const header = `Authorization: Basic ${Buffer.from(`x-access-token:${tokens.get(entry.repositoryId)!}`).toString("base64")}\n`;
      const fetched = await compute.execLong(machineId, asZeros(submoduleFetchLines(checkout, entry)), 300, header).catch(() => null);
      if (fetched && fetched.exitCode === 0 && !fetched.timedOut && fetched.stdout.includes(SUBMODULE_FETCHED)) outcomes.push({ ...summary, fetched: true });
      else { outcomes.push({ ...summary, fetched: false, reason: "could not be fetched" }); failed.push(entry.path); }
    }
    return outcomes;
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

/** The create path's half: fork the project's ready generation, wait a
 * bounded time for one that is building, or return null for the direct clone path. */
export class CloudV2ReadyCopyForks<W extends ReadyCopyWorkspace = ReadyCopyWorkspace> {
  constructor(private readonly deps: {
    copies: CloudV2ReadyCopies;
    compute: CloudV2Compute;
    /** Queues the project's first copy when it has none. */
    queueFirst?(organizationId: string, projectId: string): Promise<unknown>;
    /** A repository token for the creator, to fetch the base branch: the first repository's, or the one named. */
    githubToken?(workspace: W, repository?: string): Promise<{ token: string }>;
    now?: () => number;
    logger?: Pick<Console, "warn">;
  }) {}

  private now(): Date { return new Date(this.deps.now?.() ?? Date.now()); }

  /** Whether this workspace's VM is a fork of a ready copy. */
  async forked(workspaceId: string): Promise<boolean> {
    return !!(await this.deps.copies.forkOf(workspaceId))?.sandboxId;
  }

  async prepare(workspace: ReadyCopyWorkspace): Promise<ReadyCopyForkOutcome> {
    const { copies } = this.deps, now = this.now();
    const existing = await copies.forkOf(workspace.id);
    if (existing) {
      if (existing.sandboxId) return { sandboxId: existing.sandboxId };
      // Recovered by its key only. Past Boat's key window nothing can find it,
      // and its lease stops it; this create takes the direct path.
      if (now.getTime() - existing.requestedAt.getTime() >= KEY_WINDOW_MS) { await copies.completeFork(workspace.id, null); return null; }
      return this.fork(workspace, existing);
    }
    // A workspace made before projects, or without one, clones directly.
    if (workspace.boatSandboxId || !workspace.projectId) return null;
    const ready = await copies.forkable(workspace.organizationId, workspace.projectId, now);
    if (!ready) {
      const building = await copies.building(workspace.organizationId, workspace.projectId);
      if (!building) await this.deps.queueFirst?.(workspace.organizationId, workspace.projectId).catch(() => undefined);
      if (building && now.getTime() - Date.parse(workspace.createdAt) < READY_COPY_FORK_WAIT_MS) return { waitMs: FORK_WAIT_POLL_MS };
      this.deps.logger?.warn(`[cloud-v2] ready copy unavailable; cloning directly (${building ? "still_building" : "none_ready"})`);
      return null;
    }
    // Only a copy laid out as this workspace is: the same repositories in the same folders. One built
    // before the project changed (or was renamed) clones directly; moving set-up checkouts would break paths.
    const layout = await copies.workspaceLayout(workspace.id);
    if (!ready.result || JSON.stringify(ready.result.map(entry => [entry.repositoryId, entry.checkoutFolder ?? null])) !== JSON.stringify(layout)) {
      this.deps.logger?.warn("[cloud-v2] ready copy laid out for another version of the project; cloning directly");
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

  /** Brings each of the fork's checkouts up to its requested base branch
   * before the worker starts. A failure is not the workspace's, and one
   * repository's never stops another's: that checkout opens on the copy's
   * commit and the worker's own refresh retries the fetch in the background. */
  async fetchBase(workspace: W, sandboxId: string): Promise<boolean> {
    if (!this.deps.githubToken) return false;
    const repositories = await this.deps.copies.workspaceBases(workspace.id);
    let fetched = 0;
    for (const entry of repositories.length ? repositories : [{ repository: workspace.repository, baseBranch: workspace.baseBranch, checkoutFolder: null, first: true }]) {
      if (!/^[A-Za-z0-9._/-]{1,255}$/.test(entry.baseBranch) || entry.baseBranch.startsWith("-")) continue;
      try {
        const { token } = entry.first ? await this.deps.githubToken(workspace) : await this.deps.githubToken(workspace, entry.repository);
        const dir = homePath(entry.checkoutFolder ?? workspace.checkoutFolder ?? workspace.repository), q = shellQuote, branch = entry.baseBranch;
        const result = await this.deps.compute.execLong(sandboxId, asZeros([
          "set -e", "IFS= read -r ZEROS_GITHUB_AUTH_HEADER", "export ZEROS_GITHUB_AUTH_HEADER",
          `git -C ${q(dir)} --config-env=http.extraHeader=ZEROS_GITHUB_AUTH_HEADER fetch --quiet --prune origin ${q(`+refs/heads/${branch}:refs/remotes/origin/${branch}`)}`,
        ]), 300, `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}\n`);
        if (result.exitCode === 0 && !result.timedOut) { fetched++; continue; }
      } catch { /* Reported below; the workspace still opens. */ }
      this.deps.logger?.warn("[cloud-v2] ready copy fork could not update a repository's base branch; it opens on the copy's commit");
    }
    return fetched === Math.max(repositories.length, 1);
  }
}

export type ReadyCopyWorkspace = { id: string; organizationId: string; repository: string; baseBranch: string; createdAt: string; boatSandboxId: string | null;
  /** workspace-layout.ts: the first checkout under /home/user. */
  checkoutFolder?: string | null;
  /** The project the workspace was created from; none for one made before projects. */
  projectId?: string | null;
  /** Set for a workspace of a personal project: its member. */
  privateOwnerUserId?: string | null };

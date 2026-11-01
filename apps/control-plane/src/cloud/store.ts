import type pg from "pg";
import { createHash } from "node:crypto";
import { withSystemTx, type Tx } from "../db.js";
import type { AuthedUser } from "../auth.js";
import { securityStreamAuthority } from "../security-events.js";
import { HttpError } from "../authz.js";
import type { CloudV2MessageRow } from "./contract.js";
import { hashCloudV2Token, newCloudV2Token } from "./tokens.js";
import { CLOUD_V2_CREATOR_ON_HOLD, CLOUD_V2_LIVE_ACCESS as LIVE_ACCESS } from "./workspace-access.js";
import { memberOnHoldSql, organizationMemberOnHold } from "../organization-seats.js";
import { CloudV2PromptOutbox } from "./prompt-outbox.js";
import { computerSourceReviewRequired, readComputerSourceTargets } from "./computer-provenance.js";
import { CloudSourceTargetSchema } from "./source-authority.js";

import { mirrorMessageWindow, type MessageWindow, type WindowOptions } from "./history.js";

export type CloudV2WorkspaceState =
  | "creating" | "running" | "stopping" | "stopped" | "starting" | "deleting" | "deleted" | "failed";

export type CloudV2InstalledRepository = { repository: string; defaultBranch: string | null };
type CreateWorkspace = {
  id: string; organizationId: string; creatorUserId: string; name: string; repository: string; branch: string;
  baseBranch: string; computerBuildId: string | null;
  sourceRepositoryId?: string;
};
type CreateReceipt = { status: 201; response: Record<string, unknown> };
type HistoryInput = {
  chats?: readonly { id: string }[] | undefined; chatDeletions?: readonly string[] | undefined;
  messages?: { chatId: string; rows: readonly CloudV2MessageRow[] } | undefined;
};
export type CloudV2WorkerSession = CloudV2Workspace & {
  accessEpoch: string; loginRevision: string;
  /** Present only on the hello that actually changes a booting state to running. */
  helloTiming?: { state: "creating" | "starting"; durationMs: number };
};
export type CloudV2AppGrant = { userId: string; accessEpoch: string; wake: boolean; sessionId: string | null };

export type CloudV2Workspace = {
  id: string;
  organizationId: string;
  creatorUserId: string;
  name: string;
  repository: string;
  branch: string;
  baseBranch: string;
  state: CloudV2WorkspaceState;
  boatSandboxId: string | null;
  computerBuildId: string | null;
  errorCode: string | null;
  activeAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** What a checkpoint is compared by at the next stop: the fingerprint of what
 * it holds and the base commit whose objects it left out. */
export type CloudV2CheckpointReuse = { fingerprint: string; base: string | null };
/** The last confirmed checkpoint; the key is still sealed. `reuse` is present
 * only when it was recorded for this exact object. */
export type CloudV2Checkpoint = { object: string; key: unknown; sha256: string; bytes: number; savedAt: string; stopGeneration: string | null;
  reuse?: CloudV2CheckpointReuse };
/** A fork of a stopped VM that a checkpoint retry requested, recorded before
 * the request. `sandboxId` is null until Boat's reply arrives. */
export type CloudV2CheckpointFork = { attempt: string; name: string; source: string; requestedAt: string; sandboxId: string | null };
/** Which stop a checkpoint write belongs to: the one still stopping the VM,
 * or a retry of the latest stop while that VM is stopped or woken again. */
export type CloudV2CheckpointScope = "stop" | "retry";
export type CloudV2CheckpointRetry = { generation: string; attempts: number; stoppedAt: string; exhaustedAt: string | null };

/** Internal lifecycle metadata is never included in public workspace documents. */
export type CloudV2LifecycleWorkspace = CloudV2Workspace & {
  leaseRenewedAt: string | null;
  baseCommit: string | null;
  checkpoint: CloudV2Checkpoint | null;
  /** boat_sandbox_id is a replacement VM (or, while null, one being created)
   * that the checkpoint has not been applied to yet. */
  restorePending: boolean;
  /** The identity and exact request a pending restore creates its replacement with. */
  restoreAttempt: string | null;
  restoreCreate: CloudV2RestoreCreate | null;
  /** Which entry into stopping this is; a checkpoint belongs to one stop. */
  stopGeneration: string;
  /** The latest time an upload whose outcome is unknown could still land. */
  checkpointUploadUntil: string | null;
  /** A checkpoint retry's fork that may still exist at Boat. */
  checkpointRetryFork: CloudV2CheckpointFork | null;
};
export type CloudV2RestoreCreate = { from: string; name: string; env: Record<string, string>; requestedAt: string };

type Row = {
  id: string; org_id: string; creator_user_id: string; name: string; repository: string; branch: string; base_branch: string;
  state: CloudV2WorkspaceState; boat_sandbox_id: string | null; computer_build_id: string | null;
  error_code: string | null; active_at: Date | null; archived_at: Date | null; created_at: Date; updated_at: Date;
};

const COLUMNS = `id, org_id, creator_user_id, name, repository, branch, base_branch, state, boat_sandbox_id,
  computer_build_id, error_code, active_at, archived_at, created_at, updated_at`;

type LifecycleRow = Row & {
  lease_renewed_at: Date | null; base_commit: string | null; restore_pending: boolean; restore_attempt: string | null;
  restore_create: CloudV2RestoreCreate | null; checkpoint_uploads: Record<string, string>;
  stop_generation: string; checkpoint_stop_generation: string | null;
  checkpoint_object: string | null; checkpoint_key: unknown; checkpoint_sha256: string | null; checkpoint_bytes: string | null; checkpoint_saved_at: Date | null;
  checkpoint_reuse: unknown; checkpoint_retry_fork: unknown;
};
const LIFECYCLE_COLUMNS = `${COLUMNS}, lease_renewed_at, base_commit, restore_pending, restore_attempt, restore_create, checkpoint_uploads,
  stop_generation, checkpoint_stop_generation,
  checkpoint_object, checkpoint_key, checkpoint_sha256, checkpoint_bytes, checkpoint_saved_at, checkpoint_reuse, checkpoint_retry_fork`;
type RetryRow = LifecycleRow & { retry_stopped_at: Date; checkpoint_retry_generation: string; checkpoint_retry_attempts: number; checkpoint_retry_exhausted_at: Date | null };

function uploadHorizon(uploads: Record<string, string>): string | null {
  const latest = Math.max(...Object.values(uploads ?? {}).map(value => Date.parse(value)).filter(Number.isFinite));
  return Number.isFinite(latest) ? new Date(latest).toISOString() : null;
}

const FINGERPRINT = /^[0-9a-f]{64}$/, COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/, SANDBOX = /^bx_[a-z0-9]{4,32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Trusted only for the object it was recorded with; anything else, such as
 * an object an older release saved without one, is compared by nothing. */
function checkpointReuse(value: unknown, object: string): CloudV2CheckpointReuse | null {
  const reuse = value as { object?: unknown; fingerprint?: unknown; base?: unknown } | null;
  if (!reuse || reuse.object !== object || typeof reuse.fingerprint !== "string" || !FINGERPRINT.test(reuse.fingerprint)) return null;
  if (reuse.base !== null && (typeof reuse.base !== "string" || !COMMIT.test(reuse.base))) return null;
  return { fingerprint: reuse.fingerprint, base: reuse.base as string | null };
}

function checkpointFork(value: unknown): CloudV2CheckpointFork | null {
  const fork = value as Partial<Record<keyof CloudV2CheckpointFork, unknown>> | null;
  if (!fork || typeof fork.attempt !== "string" || !UUID.test(fork.attempt) || typeof fork.name !== "string" ||
      typeof fork.source !== "string" || !SANDBOX.test(fork.source) || typeof fork.requestedAt !== "string" ||
      (fork.sandboxId !== undefined && fork.sandboxId !== null && (typeof fork.sandboxId !== "string" || !SANDBOX.test(fork.sandboxId)))) return null;
  return { attempt: fork.attempt, name: fork.name, source: fork.source, requestedAt: new Date(fork.requestedAt).toISOString(),
    sandboxId: typeof fork.sandboxId === "string" ? fork.sandboxId : null };
}

function lifecycleWorkspace(row: LifecycleRow): CloudV2LifecycleWorkspace {
  const reuse = row.checkpoint_object ? checkpointReuse(row.checkpoint_reuse, row.checkpoint_object) : null;
  const checkpoint = row.checkpoint_object && row.checkpoint_sha256 && row.checkpoint_bytes && row.checkpoint_saved_at
    ? { object: row.checkpoint_object, key: row.checkpoint_key, sha256: row.checkpoint_sha256, bytes: Number(row.checkpoint_bytes),
        savedAt: row.checkpoint_saved_at.toISOString(), stopGeneration: row.checkpoint_stop_generation, ...(reuse ? { reuse } : {}) }
    : null;
  return { ...workspace(row), leaseRenewedAt: row.lease_renewed_at?.toISOString() ?? null, baseCommit: row.base_commit,
    checkpoint, restorePending: row.restore_pending, restoreAttempt: row.restore_attempt, restoreCreate: row.restore_create,
    stopGeneration: row.stop_generation, checkpointUploadUntil: uploadHorizon(row.checkpoint_uploads),
    checkpointRetryFork: checkpointFork(row.checkpoint_retry_fork) };
}

/** Where a checkpoint write may land. A stop's own write needs that stop to
 * still be stopping this VM. A retry's needs the latest stop to be the one it
 * retries, with that VM, and no checkpoint for it yet; the VM may have been
 * woken since, but a stop, a restore or deletion fences it out. */
function checkpointFence(scope: CloudV2CheckpointScope): string {
  return scope === "stop"
    ? "boat_sandbox_id=$2 AND state='stopping' AND NOT restore_pending AND stop_generation=$3::bigint"
    : `boat_sandbox_id=$2 AND state IN ('stopped','starting','running','failed') AND NOT restore_pending AND stop_generation=$3::bigint
       AND checkpoint_stop_generation IS DISTINCT FROM stop_generation`;
}

function workspace(row: Row): CloudV2Workspace {
  return {
    id: row.id,
    organizationId: row.org_id,
    creatorUserId: row.creator_user_id,
    name: row.name,
    repository: row.repository,
    branch: row.branch,
    baseBranch: row.base_branch,
    state: row.state,
    boatSandboxId: row.boat_sandbox_id,
    computerBuildId: row.computer_build_id,
    errorCode: row.error_code,
    activeAt: row.active_at?.toISOString() ?? null,
    archivedAt: row.archived_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

// WorkOS sid is the device/session authority, independent of the workspace's
// account/membership epoch. Do not let a lost broker notification keep it live.
const LIVE_SESSION = `s.provider = 'workos' AND s.user_id = w.creator_user_id
  AND s.status = 'active' AND s.revoked_at IS NULL
  AND (s.provider_session_expires_at IS NULL OR s.provider_session_expires_at > clock_timestamp())
  AND EXISTS (SELECT 1 FROM user_identities i WHERE i.user_id = s.user_id
    AND i.provider = s.provider AND i.provider_sub = s.provider_sub AND i.status = 'active')`;

const notFound = () => new HttpError(404, "not_found", "Cloud workspace not found");

/** v2 is creator-only: the caller must have created the workspace and still
 * belong to its organization. Anyone else sees the same 404. */
async function ownedRow(tx: Tx, id: string, userId: string, lock = false): Promise<Row> {
  const { rows } = await tx.query<Row>(
    `SELECT ${COLUMNS} FROM cloud_v2_workspaces w
     WHERE w.id = $1 AND w.creator_user_id = $2 AND w.state <> 'deleted'
       AND ${LIVE_ACCESS}
     ${lock ? "FOR UPDATE OF w" : ""}`,
    [id, userId],
  );
  if (rows[0]) return rows[0];
  // Tell a creator on Hold why their own workspace is unavailable.
  const held = await tx.query(
    `SELECT 1 FROM cloud_v2_workspaces w
     WHERE w.id = $1 AND w.creator_user_id = $2 AND w.state <> 'deleted' AND ${CLOUD_V2_CREATOR_ON_HOLD}`,
    [id, userId],
  );
  throw held.rowCount ? organizationMemberOnHold() : notFound();
}

export class CloudV2Store {
  readonly prompts: CloudV2PromptOutbox;
  constructor(private readonly pool: pg.Pool) { this.prompts = new CloudV2PromptOutbox(pool); }

  async createWorkspace(input: CreateWorkspace): Promise<CloudV2Workspace> {
    return withSystemTx(this.pool, tx => this.insertWorkspace(tx, input));
  }

  private async insertWorkspace(tx: Tx, input: CreateWorkspace): Promise<CloudV2Workspace> {
    let sourceRepositoryId = input.sourceRepositoryId;
    const member = await tx.query<{ pro: boolean; held: boolean }>(
      `SELECT account_pro_active(m.user_id) AS pro, ${memberOnHoldSql("m.org_id", "m.user_id")} AS held
       FROM organization_members m JOIN organizations o ON o.id = m.org_id AND o.deleted_at IS NULL
       WHERE m.org_id = $1 AND m.user_id = $2 AND NOT o.is_personal AND o.cloud_workspaces_allowed FOR SHARE OF o,m`,
      [input.organizationId, input.creatorUserId],
    );
    if (!member.rows[0]) throw new HttpError(404, "not_found", "Organization not found");
    if (member.rows[0].held) throw organizationMemberOnHold();
    if (!member.rows[0].pro) throw new HttpError(403, "pro_required", "Creating a cloud workspace requires Pro");
    if (input.computerBuildId) {
      // Activation waits for this lock, so cleanup observes the new workspace
      // pin before it can retire an inactive source snapshot.
      const selected = await tx.query<{ recipe: { repositories: { repository: string }[] }; source_targets: unknown }>(
        `SELECT b.recipe,b.source_targets FROM cloud_v2_computers c
         JOIN cloud_v2_computer_builds b ON b.id=c.active_build_id AND b.org_id=c.org_id
         WHERE c.org_id=$1 AND c.active_build_id=$2 AND c.snapshot_name IS NOT NULL
           AND b.state='succeeded' AND b.source_policy_version=2 AND b.snapshot_id=c.snapshot_name AND b.snapshot_deleted_at IS NULL AND b.cleanup_requested_at IS NULL
         FOR SHARE OF c,b`, [input.organizationId, input.computerBuildId]);
      if (!selected.rowCount) throw new HttpError(409, "cloud_computer_changed", "The Cloud Computer changed. Create the workspace again.");
      const build = selected.rows[0]!;
      const target = readComputerSourceTargets(build.recipe.repositories, build.source_targets)
        .find(source => source.repository.toLowerCase() === input.repository.toLowerCase());
      if (!target || sourceRepositoryId !== undefined && sourceRepositoryId !== target.repositoryId) throw computerSourceReviewRequired();
      sourceRepositoryId = target.repositoryId;
    }
    const row = (await tx.query<Row>(
      `INSERT INTO cloud_v2_workspaces (id, org_id, creator_user_id, name, repository, branch, base_branch, state, computer_build_id, source_repositories)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'creating', $8, ARRAY[lower($5)]) RETURNING ${COLUMNS}`,
      [input.id, input.organizationId, input.creatorUserId, input.name, input.repository, input.branch,
        input.baseBranch, input.computerBuildId],
    )).rows[0]!;
    if (sourceRepositoryId !== undefined) {
      if (!CloudSourceTargetSchema.safeParse({ repository: input.repository, repositoryId: sourceRepositoryId }).success) throw new HttpError(422, "github_repository_invalid", "Invalid repository identity.");
      await tx.query("INSERT INTO cloud_v2_github_sources(workspace_id,source_repository,repository_id) VALUES($1,lower($2),$3)",
        [input.id, input.repository, sourceRepositoryId]);
    }
    return workspace(row);
  }

  private async createReceipt(tx: Tx, creator: string, key: string, hash: string): Promise<CreateReceipt | null> {
    const { rows } = await tx.query<CreateReceipt & { request_hash: string }>(
      "SELECT request_hash,status,response FROM cloud_v2_create_requests WHERE creator_user_id=$1 AND request_key=$2", [creator, key]);
    if (!rows[0]) return null;
    if (rows[0].request_hash !== hash) throw new HttpError(409, "idempotency_conflict", "This creation key was already used with different content");
    return { status: rows[0].status, response: rows[0].response };
  }

  readCreateReceipt(creator: string, key: string, hash: string): Promise<CreateReceipt | null> {
    return withSystemTx(this.pool, tx => this.createReceipt(tx, creator, key, hash));
  }

  createWorkspaceOnce(input: CreateWorkspace, key: string, hash: string,
    response: (workspace: CloudV2Workspace) => Record<string, unknown>): Promise<CreateReceipt> {
    return withSystemTx(this.pool, async tx => {
      await tx.query("/* lock_purpose='cloud-v2-workspace-create' */ SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`cloud-v2-create:${input.creatorUserId}:${key}`]);
      const previous = await this.createReceipt(tx, input.creatorUserId, key, hash);
      if (previous) return previous;
      const workspace = await this.insertWorkspace(tx, input);
      const receipt = { status: 201 as const, response: response(workspace) };
      await tx.query(`INSERT INTO cloud_v2_create_requests(creator_user_id,request_key,request_hash,workspace_id,status,response)
        VALUES($1,$2,$3,$4,$5,$6)`, [input.creatorUserId, key, hash, workspace.id, receipt.status, JSON.stringify(receipt.response)]);
      return receipt;
    });
  }

  async get(id: string, userId: string): Promise<CloudV2Workspace> {
    return workspace(await withSystemTx(this.pool, tx => ownedRow(tx, id, userId)));
  }

  async list(organizationId: string, userId: string): Promise<CloudV2Workspace[]> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<Row>(
      `SELECT ${COLUMNS} FROM cloud_v2_workspaces w
       WHERE w.org_id = $1 AND w.creator_user_id = $2 AND w.state <> 'deleted'
         AND EXISTS (SELECT 1 FROM organization_members m WHERE m.org_id = w.org_id AND m.user_id = $2)
       ORDER BY w.created_at DESC, w.id LIMIT 200`,
      [organizationId, userId],
    ));
    return rows.map(workspace);
  }

  /** Serialize a creator's intent with lifecycle progress. Flag-only changes
   * advance the document version without rescheduling a pending stop. A wake
   * revokes the suspended boot before Boat can resume its old service. */
  async requestLifecycle(id: string, userId: string, action: "start" | "stop" | "archive"):
    Promise<{ workspace: CloudV2Workspace; moved: boolean }> {
    return withSystemTx(this.pool, async tx => {
      const current = await ownedRow(tx, id, userId, true);
      if (action === "archive" && (current.state === "creating" || current.state === "deleting"))
        throw new HttpError(409, "workspace_unavailable", "This cloud workspace cannot be archived yet");
      const state = action === "start"
        ? current.state === "stopped" || current.state === "failed" ? "starting" : current.state
        : current.state === "running" || current.state === "starting" ? "stopping" : current.state;
      const moved = state !== current.state;
      const archived = action === "archive" || (action === "stop" && current.archived_at !== null);
      if (!moved && archived === (current.archived_at !== null)) return { workspace: workspace(current), moved };
      const { rows } = await tx.query<Row>(
        `UPDATE cloud_v2_workspaces SET
           archived_at = CASE WHEN $3::boolean THEN coalesce(archived_at, clock_timestamp()) ELSE NULL END,
           attempts = CASE WHEN state <> $2 THEN 0 ELSE attempts END,
           next_attempt_at = CASE WHEN state <> $2 THEN NULL ELSE next_attempt_at END,
           worker_token_hash = CASE WHEN state <> $2 AND $2 = 'starting' THEN NULL ELSE worker_token_hash END,
           worker_boot_id = CASE WHEN state <> $2 AND $2 = 'starting' THEN NULL ELSE worker_boot_id END,
           stop_generation = stop_generation + CASE WHEN state <> $2 AND $2 = 'stopping' THEN 1 ELSE 0 END,
           updated_at = clock_timestamp(),
           state = $2
         WHERE id = $1 RETURNING ${COLUMNS}`,
        [id, state, archived],
      );
      return { workspace: workspace(rows[0]!), moved };
    });
  }

  /** Compare-and-set. Returns null when the workspace was not in `from`, or,
   * with `stopGeneration`, when another stop has begun since. `revoke` drops
   * the worker's credentials in the same transaction, only if it moved, so a
   * late step can never revoke a worker that a newer wake started. */
  async transition(id: string, from: readonly CloudV2WorkspaceState[], to: CloudV2WorkspaceState,
    patch: { boatSandboxId?: string | null; errorCode?: string | null; stopGeneration?: string; revoke?: boolean } = {}): Promise<CloudV2Workspace | null> {
    return withSystemTx(this.pool, async tx => {
    const { rows } = await tx.query<Row>(
      `UPDATE cloud_v2_workspaces SET state = $3,
         boat_sandbox_id = CASE WHEN $4::boolean THEN $5 ELSE boat_sandbox_id END,
         error_code = CASE WHEN $6::boolean THEN $7 ELSE error_code END,
         worker_token_hash = CASE WHEN $3 IN ('starting','deleted') THEN NULL ELSE worker_token_hash END,
         worker_boot_id = CASE WHEN $3 IN ('starting','deleted') THEN NULL ELSE worker_boot_id END,
         active_at = CASE WHEN $3 = 'running' THEN clock_timestamp() ELSE active_at END,
         archived_at = CASE WHEN $3 = 'starting' THEN NULL ELSE archived_at END,
         stop_generation = stop_generation + CASE WHEN $3 = 'stopping' AND state <> 'stopping' THEN 1 ELSE 0 END,
         checkpoint_object = CASE WHEN $3 = 'deleted' THEN NULL ELSE checkpoint_object END,
         checkpoint_key = CASE WHEN $3 = 'deleted' THEN NULL ELSE checkpoint_key END,
         checkpoint_sha256 = CASE WHEN $3 = 'deleted' THEN NULL ELSE checkpoint_sha256 END,
         checkpoint_bytes = CASE WHEN $3 = 'deleted' THEN NULL ELSE checkpoint_bytes END,
         checkpoint_saved_at = CASE WHEN $3 = 'deleted' THEN NULL ELSE checkpoint_saved_at END,
         checkpoint_reuse = CASE WHEN $3 = 'deleted' THEN NULL ELSE checkpoint_reuse END,
         stopped_at = CASE WHEN $3 = 'stopped' THEN clock_timestamp() ELSE stopped_at END,
         restore_pending = restore_pending AND $3 <> 'deleted',
         attempts = 0, next_attempt_at = NULL, updated_at = clock_timestamp()
       WHERE id = $1 AND state = ANY($2::text[]) AND ($8::bigint IS NULL OR stop_generation = $8::bigint) RETURNING ${COLUMNS}`,
      [id, from, to, patch.boatSandboxId !== undefined, patch.boatSandboxId ?? null,
        patch.errorCode !== undefined, patch.errorCode ?? null, patch.stopGeneration ?? null],
    );
    if (!rows[0]) return null;
    if (patch.revoke) {
      await tx.query(`UPDATE cloud_v2_workspaces SET worker_token_hash = NULL, worker_boot_id = NULL WHERE id = $1`, [id]);
      await tx.query(`DELETE FROM cloud_v2_tokens WHERE workspace_id = $1`, [id]);
    }
    return workspace(rows[0]);
    });
  }

  /** The worker's identity. A deleted workspace has no token hash. */
  async byWorkerToken(token: string): Promise<(CloudV2Workspace & { accessEpoch: string }) | null> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<Row & { access_epoch: string }>(
      `SELECT ${COLUMNS}, access_epoch::text FROM cloud_v2_workspaces w
       WHERE worker_token_hash = $1 AND state NOT IN ('deleting','deleted') AND ${LIVE_ACCESS}`,
      [hashCloudV2Token(token)],
    ));
    return rows[0] ? { ...workspace(rows[0]), accessEpoch: rows[0].access_epoch } : null;
  }

  async accessEpoch(id: string): Promise<string | null> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<{ access_epoch: string }>(
      `SELECT access_epoch::text FROM cloud_v2_workspaces w
       WHERE id = $1 AND state NOT IN ('deleting','deleted') AND ${LIVE_ACCESS}`, [id]));
    return rows[0]?.access_epoch ?? null;
  }

  /** One read for a room's workspace authority and every attached session;
   * streaming must not add one database transaction per viewing device. */
  async appAccessSnapshot(id: string, sessionIds: readonly string[]): Promise<{ accessEpoch: string; loginRevision?: string; validUntil?: number; activeSessionIds: string[] } | null> {
    const started = Date.now();
    const { rows } = await withSystemTx(this.pool, tx => tx.query<{ access_epoch: string; login_revision: string; active_session_ids: string[]; session_expires_at: Date | null; database_now: Date }>(
      `SELECT access_epoch::text, login_revision::text, ARRAY(SELECT s.provider_session_id FROM auth_sessions s
         WHERE s.provider_session_id = ANY($2::text[]) AND ${LIVE_SESSION}) AS active_session_ids,
         (SELECT min(s.provider_session_expires_at) FROM auth_sessions s
          WHERE s.provider_session_id = ANY($2::text[]) AND ${LIVE_SESSION}) AS session_expires_at,
         clock_timestamp() AS database_now
       FROM cloud_v2_workspaces w WHERE w.id = $1 AND w.state NOT IN ('deleting','deleted') AND ${LIVE_ACCESS}`,
      [id, sessionIds]));
    const row = rows[0];
    return row ? { accessEpoch: row.access_epoch, loginRevision: row.login_revision, activeSessionIds: row.active_session_ids,
      ...(row.session_expires_at ? { validUntil: started + Math.max(0, row.session_expires_at.getTime() - row.database_now.getTime()) } : {}) } : null;
  }

  /** Internal only: private route data is deliberately absent from workspace(). */
  async workerRoute(id: string): Promise<{ workspace: CloudV2Workspace; accessEpoch: string; url: string | null; portToken: unknown; bootId: string | null } | null> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<Row & { access_epoch: string; worker_route_url: string | null; worker_port_token: unknown; worker_boot_id: string | null }>(
      `SELECT ${COLUMNS}, access_epoch::text, worker_route_url, worker_port_token, worker_boot_id
       FROM cloud_v2_workspaces w WHERE id=$1 AND state NOT IN ('deleting','deleted') AND ${LIVE_ACCESS}`, [id]));
    const row = rows[0];
    return row ? { workspace: workspace(row), accessEpoch: row.access_epoch, url: row.worker_route_url, portToken: row.worker_port_token, bootId: row.worker_boot_id } : null;
  }

  async setWorkerRoute(id: string, sandboxId: string, url: string, portToken: unknown): Promise<boolean> {
    const result = await withSystemTx(this.pool, tx => tx.query(
      `UPDATE cloud_v2_workspaces SET worker_route_url=$3, worker_port_token=$4
       WHERE id=$1 AND boat_sandbox_id=$2 AND state IN ('creating','starting')`, [id, sandboxId, url, JSON.stringify(portToken)]));
    return Boolean(result.rowCount);
  }

  async acceptWorkerHello(token: string, bootId: string): Promise<CloudV2WorkerSession | null> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<Row & { access_epoch: string; login_revision: string; prior_state: "creating" | "starting" | "running"; hello_ms: number }>(
      `WITH prior AS MATERIALIZED (
         SELECT id AS prior_id, state AS prior_state, updated_at AS prior_updated_at FROM cloud_v2_workspaces w
         WHERE worker_token_hash=$1 AND state IN ('creating','starting','running') AND ${LIVE_ACCESS} FOR UPDATE)
       UPDATE cloud_v2_workspaces w SET
         worker_history_sequence=CASE WHEN worker_boot_id=$2 THEN worker_history_sequence ELSE 0 END,
         worker_history_digest=CASE WHEN worker_boot_id=$2 THEN worker_history_digest ELSE NULL END,
         worker_boot_id=$2, state='running', attempts=0, next_attempt_at=NULL,
         active_at=CASE WHEN state='running' THEN active_at ELSE clock_timestamp() END,
         updated_at=CASE WHEN state='running' THEN updated_at ELSE clock_timestamp() END
       FROM prior WHERE w.id=prior.prior_id
       RETURNING ${COLUMNS.replace(/\b(\w+)\b/g, "w.$1")}, access_epoch::text, login_revision::text, prior.prior_state,
         greatest(0, extract(epoch FROM (clock_timestamp()-prior.prior_updated_at))*1000)::float8 AS hello_ms`, [hashCloudV2Token(token), bootId]));
    const row = rows[0];
    return row ? { ...workspace(row), accessEpoch: row.access_epoch, loginRevision: row.login_revision,
      ...(row.prior_state === "running" ? {} : { helloTiming: { state: row.prior_state, durationMs: Math.round(row.hello_ms) } }) } : null;
  }

  async workerSession(token: string, bootId: string): Promise<CloudV2WorkerSession | null> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<Row & { access_epoch: string; login_revision: string }>(
      `SELECT ${COLUMNS}, access_epoch::text, login_revision::text FROM cloud_v2_workspaces w
       WHERE worker_token_hash=$1 AND worker_boot_id=$2 AND state NOT IN ('deleting','deleted') AND ${LIVE_ACCESS}`,
      [hashCloudV2Token(token), bootId]));
    const row = rows[0];
    return row ? { ...workspace(row), accessEpoch: row.access_epoch, loginRevision: row.login_revision } : null;
  }

  /** Sequence and rows commit together. A retry after a lost HTTP response is
   * a no-op, while a gap or a conflicting reuse cannot overwrite newer rows. */
  async writeWorkerHistory(token: string, bootId: string, sequence: number, input: HistoryInput): Promise<void> {
    const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    await withSystemTx(this.pool, async tx => {
      const { rows } = await tx.query<{ id: string; worker_boot_id: string | null; worker_history_sequence: string; worker_history_digest: string | null }>(
        `SELECT id, worker_boot_id, worker_history_sequence::text, worker_history_digest FROM cloud_v2_workspaces w
         WHERE worker_token_hash=$1 AND state IN ('running','stopping') AND ${LIVE_ACCESS} FOR UPDATE`, [hashCloudV2Token(token)]);
      const row = rows[0];
      if (!row || row.worker_boot_id !== bootId) throw new HttpError(401, "worker_boot_changed", "Worker authorization changed");
      const previous = Number(row.worker_history_sequence);
      if (sequence === previous && digest !== row.worker_history_digest) throw new HttpError(409, "history_sequence_conflict", "History request was already used");
      if (sequence <= previous) return;
      if (sequence !== previous + 1) throw new HttpError(409, "history_sequence_gap", "History sequence is not contiguous");
      await this.mirrorHistory(tx, row.id, input);
      await tx.query("UPDATE cloud_v2_workspaces SET worker_history_sequence=$2, worker_history_digest=$3 WHERE id=$1", [row.id, sequence, digest]);
    });
  }

  async markActive(id: string): Promise<void> {
    await withSystemTx(this.pool, tx => tx.query(
      `UPDATE cloud_v2_workspaces SET active_at = clock_timestamp() WHERE id = $1 AND state='running'
       AND coalesce(active_at,'-infinity') < clock_timestamp() - interval '30 seconds'`, [id]));
  }

  /** Workspaces running with no activity since `before`. */
  async idleSince(before: Date, limit = 50): Promise<CloudV2Workspace[]> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<Row>(
      `SELECT ${COLUMNS} FROM cloud_v2_workspaces w
       WHERE state = 'running' AND coalesce(active_at, updated_at) < $1
         AND NOT EXISTS (SELECT 1 FROM cloud_v2_prompt_outbox p WHERE p.workspace_id=w.id
           AND p.state IN ('queued','inboxed','dispatching','accepted') AND p.access_epoch=w.access_epoch)
       ORDER BY coalesce(active_at, updated_at) LIMIT $2`,
      [before, limit],
    ));
    return rows.map(workspace);
  }

  /** Recheck at the mutation, so a send between idle discovery and Stop wins. */
  async stopIdle(id: string, before: Date): Promise<void> {
    await withSystemTx(this.pool, tx => tx.query(`UPDATE cloud_v2_workspaces w SET state='stopping',attempts=0,stop_generation=stop_generation+1,
      next_attempt_at=NULL,updated_at=clock_timestamp()
      WHERE id=$1 AND state='running' AND coalesce(active_at,updated_at)<$2
        AND NOT EXISTS (SELECT 1 FROM cloud_v2_prompt_outbox p WHERE p.workspace_id=w.id
          AND p.state IN ('queued','inboxed','dispatching','accepted') AND p.access_epoch=w.access_epoch)`, [id, before]));
  }

  /** A one-use app connect ticket, or a worker model-proxy token. */
  async issueToken(input: { workspaceId: string; kind: "connect" | "proxy"; userId: string | null; ttlMs: number; authority?: AuthedUser; wake?: boolean }) {
    const issued = newCloudV2Token(input.kind);
    const expiresAt = new Date(Date.now() + input.ttlMs);
    await withSystemTx(this.pool, async tx => {
      // Serialize issuance with workspace revocation and recheck the HTTP
      // authority. A concurrent session sign-out is also checked at consumption.
      const allowed = await tx.query(`SELECT id FROM cloud_v2_workspaces w
        WHERE id = $1 AND state NOT IN ('deleting','deleted') AND ${LIVE_ACCESS}
          AND ($2::text = 'proxy' OR creator_user_id = $3) FOR UPDATE`,
        [input.workspaceId, input.kind, input.userId]);
      if (!allowed.rowCount) throw notFound();
      if (input.authority && !await securityStreamAuthority(tx, input.authority))
        throw new HttpError(401, "session_revoked", "Authentication is no longer current");
      await tx.query(`DELETE FROM cloud_v2_tokens WHERE expires_at < clock_timestamp() - interval '1 hour'`);
      await tx.query(
        `INSERT INTO cloud_v2_tokens (token_hash, workspace_id, kind, user_id, expires_at, wake_on_connect, provider_session_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [issued.hash, input.workspaceId, input.kind, input.userId, expiresAt, input.wake ?? true,
          input.kind === "connect" ? input.authority?.authentication.sessionId ?? null : null],
      );
    });
    return { token: issued.token, expiresAt };
  }

  /** Consumes a connect ticket exactly once. */
  async consumeConnectTicket(token: string, workspaceId: string): Promise<CloudV2AppGrant | null> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<{ user_id: string; access_epoch: string; wake_on_connect: boolean; provider_session_id: string | null }>(
      `UPDATE cloud_v2_tokens t SET used_at = clock_timestamp()
       FROM cloud_v2_workspaces w
       WHERE t.token_hash = $1 AND t.kind = 'connect' AND t.workspace_id = $2 AND t.used_at IS NULL
         AND t.expires_at > clock_timestamp() AND w.id = t.workspace_id AND w.creator_user_id = t.user_id
         AND w.state NOT IN ('deleting','deleted') AND ${LIVE_ACCESS}
         AND (t.provider_session_id IS NULL OR EXISTS (SELECT 1 FROM auth_sessions s
           WHERE s.provider_session_id = t.provider_session_id AND ${LIVE_SESSION}))
       RETURNING t.user_id, w.access_epoch::text, t.wake_on_connect, t.provider_session_id`,
      [hashCloudV2Token(token), workspaceId],
    ));
    return rows[0] ? { userId: rows[0].user_id, accessEpoch: rows[0].access_epoch, wake: rows[0].wake_on_connect, sessionId: rows[0].provider_session_id } : null;
  }

  async verifyProxyToken(token: string): Promise<(CloudV2Workspace & { accessEpoch?: string; loginRevision?: string }) | null> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<Row & { access_epoch: string; login_revision: string }>(
      `SELECT ${COLUMNS.replace(/\b(\w+)\b/g, "w.$1")},w.access_epoch::text,w.login_revision::text FROM cloud_v2_tokens t JOIN cloud_v2_workspaces w ON w.id = t.workspace_id
       WHERE t.token_hash = $1 AND t.kind = 'proxy' AND t.expires_at > clock_timestamp() AND w.state = 'running' AND ${LIVE_ACCESS}`,
      [hashCloudV2Token(token)],
    ));
    return rows[0] ? { ...workspace(rows[0]), accessEpoch: rows[0].access_epoch, loginRevision: rows[0].login_revision } : null;
  }

  /** Leases up to `limit` workspaces in a transitional state to one lifecycle
   * worker. A crashed worker's lease simply expires. */
  async claimPending(limit: number, leaseMs: number, excludeIds: readonly string[] = [],
    states: readonly CloudV2WorkspaceState[] = ["creating", "starting", "stopping", "deleting"]): Promise<(CloudV2LifecycleWorkspace & { attempts: number })[]> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<LifecycleRow & { attempts: number }>(
      `WITH claimed AS MATERIALIZED (
         SELECT id FROM cloud_v2_workspaces
         WHERE state IN ('creating','starting','stopping','deleting') AND state = ANY($4::text[])
           AND NOT (id = ANY($3::uuid[]))
           AND coalesce(next_attempt_at, '-infinity') <= clock_timestamp()
         ORDER BY coalesce(next_attempt_at, updated_at) LIMIT $1 FOR UPDATE SKIP LOCKED)
       UPDATE cloud_v2_workspaces w SET attempts = w.attempts + 1,
         next_attempt_at = clock_timestamp() + make_interval(secs => $2::double precision / 1000)
       FROM claimed WHERE w.id = claimed.id
       RETURNING ${LIFECYCLE_COLUMNS.replace(/\b(\w+)\b/g, "w.$1")}, w.attempts`,
      [limit, leaseMs, excludeIds, states],
    ));
    return rows.map(row => ({ ...lifecycleWorkspace(row), attempts: row.attempts }));
  }

  async leasesDue(before: Date, limit = 4): Promise<CloudV2Workspace[]> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<Row>(
      `SELECT ${COLUMNS} FROM cloud_v2_workspaces WHERE state='running' AND boat_sandbox_id IS NOT NULL
       AND (lease_renewed_at IS NULL OR lease_renewed_at<$1)
       ORDER BY lease_renewed_at NULLS FIRST LIMIT $2`, [before, limit]));
    return rows.map(workspace);
  }

  /** A late renewal cannot advance the lease of a replacement or stopped VM. */
  async markLeaseRenewed(id: string, sandboxId: string, renewedAt: Date): Promise<boolean> {
    const result = await withSystemTx(this.pool, tx => tx.query(
      `UPDATE cloud_v2_workspaces SET lease_renewed_at=greatest(lease_renewed_at,$3::timestamptz)
       WHERE id=$1 AND boat_sandbox_id=$2 AND state IN ('creating','starting','running')`, [id, sandboxId, renewedAt]));
    return Boolean(result.rowCount);
  }

  /** The base branch's GitHub head when the workspace was created. */
  async setBaseCommit(id: string, commit: string): Promise<void> {
    if (!/^[0-9a-f]{40}$/.test(commit)) return;
    await withSystemTx(this.pool, tx => tx.query(
      `UPDATE cloud_v2_workspaces SET base_commit=$2 WHERE id=$1 AND state='creating' AND base_commit IS NULL`, [id, commit]));
  }

  /** Offered through the first run, while the worker may still create the
   * branch. The hello makes the row running before configuration is built.
   * A restored branch already exists, so a checkpoint ends the offer. */
  async baseCommit(id: string): Promise<string | null> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<{ base_commit: string | null }>(
      `SELECT base_commit FROM cloud_v2_workspaces WHERE id=$1 AND state IN ('creating','running') AND checkpoint_object IS NULL`, [id]));
    return rows[0]?.base_commit ?? null;
  }

  /** Only the stop that is still stopping this VM, or a retry of the latest
   * stop, records what it uploaded. Returns the checkpoint it replaced, or
   * false when it was fenced out. */
  async saveCheckpoint(id: string, sandboxId: string, generation: string, checkpoint: Omit<CloudV2Checkpoint, "savedAt" | "stopGeneration">,
    scope: CloudV2CheckpointScope = "stop"): Promise<{ replaced: string | null } | false> {
    return withSystemTx(this.pool, async tx => {
      const { rows } = await tx.query<{ checkpoint_object: string | null }>(
        `SELECT checkpoint_object FROM cloud_v2_workspaces WHERE id=$1 AND ${checkpointFence(scope)} FOR UPDATE`,
        [id, sandboxId, generation]);
      if (!rows[0]) return false;
      const reuse = checkpoint.reuse ? { object: checkpoint.object, fingerprint: checkpoint.reuse.fingerprint, base: checkpoint.reuse.base } : null;
      await tx.query(
        `UPDATE cloud_v2_workspaces SET checkpoint_object=$2, checkpoint_key=$3, checkpoint_sha256=$4, checkpoint_bytes=$5, checkpoint_reuse=$6,
           checkpoint_saved_at=clock_timestamp(), checkpoint_stop_generation=stop_generation, checkpoint_error=NULL WHERE id=$1`,
        [id, checkpoint.object, JSON.stringify(checkpoint.key), checkpoint.sha256, checkpoint.bytes, reuse ? JSON.stringify(reuse) : null]);
      return { replaced: rows[0].checkpoint_object };
    });
  }

  /** The VM found everything as `object` holds it: that checkpoint now also
   * covers this stop. Refused unless `object` is still the one compared. */
  async checkpointUnchanged(id: string, sandboxId: string, generation: string, object: string, scope: CloudV2CheckpointScope = "stop"): Promise<boolean> {
    const result = await withSystemTx(this.pool, tx => tx.query(
      `UPDATE cloud_v2_workspaces SET checkpoint_stop_generation=stop_generation, checkpoint_error=NULL
       WHERE id=$1 AND ${checkpointFence(scope)} AND checkpoint_object=$4 AND checkpoint_reuse->>'object'=$4`,
      [id, sandboxId, generation, object]));
    return Boolean(result.rowCount);
  }

  /** Recorded before an upload URL exists, and only while the stop or retry
   * still owns the VM: once deletion has begun no new upload is admitted.
   * `until` bounds when the upload could still land if its outcome is never known. */
  async checkpointUpload(id: string, sandboxId: string, generation: string, object: string, until: Date, scope: CloudV2CheckpointScope = "stop"): Promise<boolean> {
    const result = await withSystemTx(this.pool, tx => tx.query(
      `UPDATE cloud_v2_workspaces SET checkpoint_uploads = coalesce((SELECT jsonb_object_agg(key, value) FROM jsonb_each_text(checkpoint_uploads)
           WHERE value::timestamptz > clock_timestamp()), '{}'::jsonb) || jsonb_build_object($4::text, $5::timestamptz)
       WHERE id=$1 AND ${checkpointFence(scope)}`,
      [id, sandboxId, generation, object, until]));
    return Boolean(result.rowCount);
  }

  /** Whether this is still the workspace's current stop. */
  async stopCurrent(id: string, generation: string): Promise<boolean> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query(
      `SELECT 1 FROM cloud_v2_workspaces WHERE id=$1 AND state='stopping' AND stop_generation=$2::bigint`, [id, generation]));
    return rows.length > 0;
  }

  /** The latest time an upload whose outcome is unknown could still land, read live. */
  async checkpointUploadHorizon(id: string): Promise<string | null> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<{ checkpoint_uploads: Record<string, string> }>(
      `SELECT checkpoint_uploads FROM cloud_v2_workspaces WHERE id=$1`, [id]));
    return rows[0] ? uploadHorizon(rows[0].checkpoint_uploads) : null;
  }

  /** That upload is over, whatever its outcome; other uploads stay. */
  async checkpointUploadDone(id: string, object: string): Promise<void> {
    await withSystemTx(this.pool, tx => tx.query(
      `UPDATE cloud_v2_workspaces SET checkpoint_uploads = checkpoint_uploads - $2::text WHERE id=$1`, [id, object]));
  }

  async checkpointFailed(id: string, sandboxId: string, generation: string, code: string, scope: CloudV2CheckpointScope = "stop"): Promise<void> {
    await withSystemTx(this.pool, tx => tx.query(
      `UPDATE cloud_v2_workspaces SET checkpoint_error=$4 WHERE id=$1 AND ${checkpointFence(scope)}`,
      [id, sandboxId, generation, /^[a-z0-9_]{1,64}$/.test(code) ? code : "checkpoint_failed"]));
  }

  /** Leases one workspace whose latest stop has no checkpoint and is due a
   * retry, or one whose earlier retry may have left a fork. A first retry
   * waits `firstDelayMs` after the stop; none starts after `windowMs`. */
  async claimCheckpointRetry(input: { leaseMs: number; firstDelayMs: number; windowMs: number; excludeIds?: readonly string[] }):
    Promise<(CloudV2LifecycleWorkspace & { retry: CloudV2CheckpointRetry }) | null> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<RetryRow>(
      `WITH due AS MATERIALIZED (
         SELECT id FROM cloud_v2_workspaces
         WHERE NOT (id = ANY($4::uuid[])) AND (
           (checkpoint_retry_fork IS NOT NULL AND state NOT IN ('deleting','deleted')
             AND coalesce(checkpoint_retry_at, '-infinity') <= clock_timestamp())
           OR (state = 'stopped' AND boat_sandbox_id IS NOT NULL AND NOT restore_pending
             AND checkpoint_stop_generation IS DISTINCT FROM stop_generation
             AND coalesce(stopped_at, updated_at) > clock_timestamp() - make_interval(secs => $3::double precision / 1000)
             AND (checkpoint_retry_generation IS DISTINCT FROM stop_generation OR checkpoint_retry_exhausted_at IS NULL)
             AND CASE WHEN checkpoint_retry_generation IS NOT DISTINCT FROM stop_generation THEN coalesce(checkpoint_retry_at, '-infinity')
               ELSE coalesce(stopped_at, updated_at) + make_interval(secs => $2::double precision / 1000) END <= clock_timestamp()))
         ORDER BY coalesce(checkpoint_retry_at, stopped_at, updated_at) LIMIT 1 FOR UPDATE SKIP LOCKED)
       UPDATE cloud_v2_workspaces w SET
         checkpoint_retry_attempts = CASE WHEN w.checkpoint_retry_generation IS NOT DISTINCT FROM w.stop_generation THEN w.checkpoint_retry_attempts ELSE 0 END,
         checkpoint_retry_exhausted_at = CASE WHEN w.checkpoint_retry_generation IS NOT DISTINCT FROM w.stop_generation THEN w.checkpoint_retry_exhausted_at END,
         checkpoint_retry_generation = w.stop_generation,
         checkpoint_retry_at = clock_timestamp() + make_interval(secs => $1::double precision / 1000)
       FROM due WHERE w.id = due.id
       RETURNING ${LIFECYCLE_COLUMNS.replace(/\b(\w+)\b/g, "w.$1")}, coalesce(w.stopped_at, w.updated_at) AS retry_stopped_at,
         w.checkpoint_retry_generation, w.checkpoint_retry_attempts, w.checkpoint_retry_exhausted_at`,
      [input.leaseMs, input.firstDelayMs, input.windowMs, input.excludeIds ?? []]));
    const row = rows[0];
    return row ? { ...lifecycleWorkspace(row), retry: { generation: row.checkpoint_retry_generation, attempts: row.checkpoint_retry_attempts,
      stoppedAt: row.retry_stopped_at.toISOString(), exhaustedAt: row.checkpoint_retry_exhausted_at?.toISOString() ?? null } } : null;
  }

  /** Records a retry's fork before it is requested, while the latest stop of
   * `source` still lacks a checkpoint and no other fork is recorded. */
  async beginCheckpointFork(id: string, generation: string, fork: Pick<CloudV2CheckpointFork, "attempt" | "name" | "source">): Promise<CloudV2CheckpointFork | null> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<{ checkpoint_retry_fork: unknown }>(
      `UPDATE cloud_v2_workspaces SET checkpoint_retry_attempts = checkpoint_retry_attempts + 1,
         checkpoint_retry_fork = jsonb_build_object('attempt',$3::text,'name',$4::text,'source',$2::text,'requestedAt',clock_timestamp())
       WHERE id=$1 AND state='stopped' AND boat_sandbox_id=$2 AND NOT restore_pending AND stop_generation=$5::bigint
         AND checkpoint_stop_generation IS DISTINCT FROM stop_generation AND checkpoint_retry_generation=$5::bigint
         AND checkpoint_retry_fork IS NULL
       RETURNING checkpoint_retry_fork`, [id, fork.source, fork.attempt, fork.name, generation]));
    return rows[0] ? checkpointFork(rows[0].checkpoint_retry_fork) : null;
  }

  async checkpointForkCreated(id: string, attempt: string, sandboxId: string): Promise<boolean> {
    const result = await withSystemTx(this.pool, tx => tx.query(
      `UPDATE cloud_v2_workspaces SET checkpoint_retry_fork = checkpoint_retry_fork || jsonb_build_object('sandboxId',$3::text)
       WHERE id=$1 AND checkpoint_retry_fork->>'attempt'=$2`, [id, attempt, sandboxId]));
    return Boolean(result.rowCount);
  }

  /** Boat confirmed that fork is gone, or it was never created. */
  async checkpointForkGone(id: string, attempt: string): Promise<void> {
    await withSystemTx(this.pool, tx => tx.query(
      `UPDATE cloud_v2_workspaces SET checkpoint_retry_fork=NULL WHERE id=$1 AND checkpoint_retry_fork->>'attempt'=$2`, [id, attempt]));
  }

  /** Schedules this stop's next retry, ends its retries, or records that they
   * ran out; a retry for an older stop changes nothing. */
  async checkpointRetryNext(id: string, generation: string, next: { at: Date } | { done: true } | { exhausted: true }): Promise<void> {
    await withSystemTx(this.pool, tx => tx.query(
      `UPDATE cloud_v2_workspaces SET checkpoint_retry_at=$3,
         checkpoint_retry_exhausted_at=CASE WHEN $4::boolean THEN clock_timestamp() ELSE checkpoint_retry_exhausted_at END
       WHERE id=$1 AND checkpoint_retry_generation=$2::bigint`,
      [id, generation, "at" in next ? next.at : null, "exhausted" in next]));
  }

  /** Boat lost the VM. Pins the organization's active Cloud Computer and
   * records the restore before any replacement exists, so a stop or deletion
   * that wins the race still finds the replacement. */
  async beginRestore(id: string, lostSandboxId: string | null, request: { attempt: string } & Omit<CloudV2RestoreCreate, "from" | "requestedAt">): Promise<{ attempt: string; create: CloudV2RestoreCreate } | "no_computer" | null> {
    return withSystemTx(this.pool, async tx => {
      const { rows } = await tx.query<{ org_id: string }>(
        `SELECT org_id FROM cloud_v2_workspaces WHERE id=$1 AND state='starting' AND boat_sandbox_id IS NOT DISTINCT FROM $2::text
           AND checkpoint_object IS NOT NULL FOR UPDATE`, [id, lostSandboxId]);
      if (!rows[0]) return null;
      // As at creation: activation and cleanup wait for this pin.
      const active = await tx.query<{ id: string; snapshot_name: string }>(
        `SELECT b.id, c.snapshot_name FROM cloud_v2_computers c
         JOIN cloud_v2_computer_builds b ON b.id=c.active_build_id AND b.org_id=c.org_id
         WHERE c.org_id=$1 AND c.snapshot_name IS NOT NULL AND b.state='succeeded' AND b.source_policy_version=2 AND b.snapshot_id=c.snapshot_name
           AND b.snapshot_deleted_at IS NULL AND b.cleanup_requested_at IS NULL
         FOR SHARE OF c,b`, [rows[0].org_id]);
      if (!active.rows[0]) return "no_computer";
      const recorded = await tx.query<{ restore_attempt: string; restore_create: CloudV2RestoreCreate }>(
        `UPDATE cloud_v2_workspaces SET restore_pending=true, restore_attempt=$3, boat_sandbox_id=NULL, computer_build_id=$2,
           restore_create=jsonb_build_object('from',$4::text,'name',$5::text,'env',$6::jsonb,'requestedAt',clock_timestamp()),
           worker_route_url=NULL, worker_port_token=NULL, worker_token_hash=NULL, worker_boot_id=NULL
         WHERE id=$1 RETURNING restore_attempt, restore_create`,
        [id, active.rows[0].id, request.attempt, active.rows[0].snapshot_name, request.name, JSON.stringify(request.env)]);
      return { attempt: recorded.rows[0]!.restore_attempt, create: recorded.rows[0]!.restore_create };
    });
  }

  /** Records this attempt's replacement VM in any live state, so cleanup can
   * find it. A late reply from an earlier attempt cannot take a later slot. */
  async replaceSandbox(id: string, attempt: string, sandboxId: string, renewedAt: Date): Promise<CloudV2WorkspaceState | null> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<{ state: CloudV2WorkspaceState }>(
      `UPDATE cloud_v2_workspaces SET boat_sandbox_id=$3, lease_renewed_at=$4
       WHERE id=$1 AND restore_attempt=$2 AND restore_pending AND boat_sandbox_id IS NULL AND state<>'deleted' RETURNING state`,
      [id, attempt, sandboxId, renewedAt]));
    return rows[0]?.state ?? null;
  }

  /** The checkpoint is on the replacement VM. */
  async finishRestore(id: string, sandboxId: string): Promise<boolean> {
    const result = await withSystemTx(this.pool, tx => tx.query(
      // The worker's boot deadline starts now: the restore used its own.
      `UPDATE cloud_v2_workspaces SET restore_pending=false, updated_at=clock_timestamp()
       WHERE id=$1 AND boat_sandbox_id=$2 AND restore_pending AND state='starting'`,
      [id, sandboxId]));
    return Boolean(result.rowCount);
  }

  /** Schedules the next step. Waiting for an outside event (the worker's
   * hello) clears the failure count; a failure keeps it. `updated_at` stays
   * the time the state was entered. */
  async defer(id: string, state: CloudV2WorkspaceState, ms: number, patch: { boatSandboxId?: string; failure?: boolean; stopGeneration?: string } = {}): Promise<void> {
    await withSystemTx(this.pool, tx => tx.query(
      `UPDATE cloud_v2_workspaces SET next_attempt_at = clock_timestamp() + make_interval(secs => $3::double precision / 1000),
         boat_sandbox_id = coalesce($4, boat_sandbox_id), attempts = CASE WHEN $5::boolean THEN attempts ELSE 0 END
       WHERE id = $1 AND state = $2 AND ($6::bigint IS NULL OR stop_generation = $6::bigint)`,
      [id, state, ms, patch.boatSandboxId ?? null, patch.failure === true, patch.stopGeneration ?? null],
    ));
  }

  /** Replaces the worker credential; the plaintext goes only to the VM. */
  async rotateWorkerToken(id: string): Promise<string> {
    const worker = newCloudV2Token("worker");
    const changed = await withSystemTx(this.pool, tx => tx.query(
      `UPDATE cloud_v2_workspaces w SET worker_token_hash = $2, worker_boot_id = NULL
       WHERE id = $1 AND state IN ('creating','starting','running') AND ${LIVE_ACCESS}`,
      [id, worker.hash],
    ));
    if (!changed.rowCount) throw notFound();
    return worker.token;
  }

  async loginRevision(id: string): Promise<string | null> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<{ revision: string }>(
      "SELECT login_revision::text AS revision FROM cloud_v2_workspaces WHERE id=$1 AND state<>'deleted'", [id]));
    return rows[0]?.revision ?? null;
  }

  async computerSnapshot(organizationId: string, buildId: string | null = null): Promise<string | null> {
    if (buildId) {
      const { rows } = await withSystemTx(this.pool, tx => tx.query<{ snapshot_id: string | null }>(
        `SELECT snapshot_id FROM cloud_v2_computer_builds WHERE id=$1 AND org_id=$2 AND state='succeeded' AND source_policy_version=2
         AND snapshot_deleted_at IS NULL AND cleanup_requested_at IS NULL`, [buildId, organizationId]));
      return rows[0]?.snapshot_id ?? null;
    }
    // Pre-pin workspaces retain their original active-computer behavior.
    const { rows } = await withSystemTx(this.pool, tx => tx.query<{ snapshot_name: string | null }>(
      `SELECT c.snapshot_name FROM cloud_v2_computers c JOIN cloud_v2_computer_builds b ON b.id=c.active_build_id
       WHERE c.org_id = $1 AND b.source_policy_version=2`, [organizationId]));
    return rows[0]?.snapshot_name ?? null;
  }

  /** One selection supplies the build pin and its installed repositories. */
  async activeComputer(organizationId: string): Promise<{ buildId: string; repositories: CloudV2InstalledRepository[] } | null> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<{ id: string; recipe: { repositories?: { repository?: unknown; branch?: unknown }[] } }>(
      `SELECT build.id, build.recipe FROM cloud_v2_computers computer
       JOIN cloud_v2_computer_builds build ON build.id = computer.active_build_id AND build.org_id = computer.org_id
       WHERE computer.org_id = $1 AND computer.snapshot_name IS NOT NULL AND build.state = 'succeeded' AND build.source_policy_version=2`,
      [organizationId],
    ));
    if (!rows[0]) return null;
    return { buildId: rows[0].id, repositories: (rows[0].recipe.repositories ?? []).flatMap(entry => typeof entry.repository === "string" ? [{
      repository: entry.repository,
      // A recipe ref can be a tag. Only the build's verified branch is a
      // supported source for the worker's origin/<baseBranch> checkout.
      defaultBranch: typeof entry.branch === "string" && entry.branch ? entry.branch : null,
    }] : []) };
  }

  /** Keep the public repository listing unchanged. */
  async installedRepositories(organizationId: string): Promise<CloudV2InstalledRepository[] | null> {
    return (await this.activeComputer(organizationId))?.repositories ?? null;
  }

  /** Setup follows the build that supplied this workspace's disk, never the
   * organization's currently configured or newly activated recipe. */
  async workspaceSetup(id: string): Promise<string | null> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<{ repository: string; recipe: { repositories?: { repository?: unknown; setup?: unknown }[] } }>(
      `SELECT w.repository,b.recipe FROM cloud_v2_workspaces w
       JOIN cloud_v2_computer_builds b ON b.id=w.computer_build_id AND b.org_id=w.org_id
       WHERE w.id=$1 AND w.state<>'deleted' AND b.state='succeeded' AND ${LIVE_ACCESS}`, [id]));
    const row = rows[0];
    const entry = row?.recipe.repositories?.find(repo => typeof repo.repository === "string" && repo.repository.toLowerCase() === row.repository.toLowerCase());
    return typeof entry?.setup === "string" && entry.setup.length <= 8000 ? entry.setup : null;
  }

  /** Revokes a stopped or deleted workspace's tokens; deletion also drops its history. */
  async revoke(id: string, history: boolean): Promise<void> {
    await withSystemTx(this.pool, async tx => {
      await tx.query(`UPDATE cloud_v2_workspaces SET worker_token_hash = NULL, worker_boot_id = NULL WHERE id = $1`, [id]);
      await tx.query(`DELETE FROM cloud_v2_tokens WHERE workspace_id = $1`, [id]);
      if (!history) return;
      await tx.query(`DELETE FROM cloud_v2_prompt_chats WHERE workspace_id = $1`, [id]);
      await tx.query(`DELETE FROM cloud_v2_messages WHERE workspace_id = $1`, [id]);
      await tx.query(`DELETE FROM cloud_v2_chats WHERE workspace_id = $1`, [id]);
    });
  }

  /** Mirror of the worker's history; the same rows Local persists. */
  async writeHistory(workspaceId: string, input: HistoryInput): Promise<void> {
    await withSystemTx(this.pool, tx => this.mirrorHistory(tx, workspaceId, input));
  }

  private async mirrorHistory(tx: Tx, workspaceId: string, input: HistoryInput): Promise<void> {
      for (const chat of input.chats ?? []) {
        await tx.query(
          `INSERT INTO cloud_v2_chats (workspace_id, chat_id, row) VALUES ($1, $2, $3)
           ON CONFLICT (workspace_id, chat_id) DO UPDATE SET row = EXCLUDED.row, deleted_at = NULL, updated_at = clock_timestamp()`,
          [workspaceId, chat.id, JSON.stringify(chat)],
        );
      }
      for (const chatId of input.chatDeletions ?? []) {
        await tx.query(`DELETE FROM cloud_v2_messages WHERE workspace_id = $1 AND chat_id = $2`, [workspaceId, chatId]);
        await tx.query(
          `INSERT INTO cloud_v2_chats (workspace_id, chat_id, row, deleted_at) VALUES ($1, $2, jsonb_build_object('id', $2::text), clock_timestamp())
           ON CONFLICT (workspace_id, chat_id) DO UPDATE SET deleted_at = clock_timestamp(), updated_at = clock_timestamp()`,
          [workspaceId, chatId],
        );
      }
      const batch = input.messages;
      if (batch?.rows.length) {
        await tx.query(
          `INSERT INTO cloud_v2_messages (workspace_id, chat_id, msg_id, kind, payload, created_at_ms)
           SELECT $1, $2, r.msg_id, r.kind, r.payload, r.created_at_ms
           FROM jsonb_to_recordset($3::jsonb) AS r(msg_id text, kind text, payload text, created_at_ms bigint)
           ON CONFLICT (workspace_id, chat_id, msg_id) DO UPDATE
             SET kind = EXCLUDED.kind, payload = EXCLUDED.payload, created_at_ms = EXCLUDED.created_at_ms`,
          [workspaceId, batch.chatId, JSON.stringify(batch.rows.map(row => ({
            msg_id: row.msgId, kind: row.kind, payload: row.payload, created_at_ms: row.createdAt,
          })))],
        );
      }
  }

  async listChats(workspaceId: string): Promise<{ chats: unknown[]; chatDeletions: string[] }> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<{ chat_id: string; row: unknown; deleted_at: Date | null }>(
      `SELECT chat_id, row, deleted_at FROM cloud_v2_chats WHERE workspace_id = $1 ORDER BY updated_at DESC LIMIT 1000`,
      [workspaceId],
    ));
    return {
      chats: rows.filter(row => !row.deleted_at).map(row => row.row),
      chatDeletions: rows.filter(row => row.deleted_at).map(row => row.chat_id),
    };
  }

  messageWindow(workspaceId: string, chatId: string, options: WindowOptions = {}): Promise<MessageWindow> {
    return withSystemTx(this.pool, tx => mirrorMessageWindow(tx, workspaceId, chatId, options), { consistentRead: true });
  }

  /** Rows-only compatibility for internal callers; HTTP also returns turnOpening. */
  async windowMessages(workspaceId: string, chatId: string, limit: number): Promise<CloudV2MessageRow[]> {
    return (await this.messageWindow(workspaceId, chatId, { limit })).messages;
  }
}

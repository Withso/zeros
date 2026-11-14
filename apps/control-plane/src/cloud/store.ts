import { executionIntentAuthority, type ExecutionAdmission, type ExecutionIntentAuthority } from "./execution/authority.js";
import { assertNoExecutionTransition, cancelExecutionActivation, clearStoppedExecutionTransition, confirmExecutionStop, failExecutionActivation, needsExecutionStopConfirmation } from "./execution/activation-state.js";
import { bindExecutionActivationBoot } from "./execution/activation.js";
import { CLOUD_RECOVERY_TURN_HOLD } from "./recovery-state.js";
import { assertExecutionCreationBoot, recordExecutionCreation } from "./execution/creation.js";
import type { RuntimeCapabilities } from "./runtime-capabilities.js";
import type { ExecutionConnectAuthority } from "./execution/clients.js";
import type pg from "pg";
import { createHash } from "node:crypto";
import { CloudApiReads } from "./api/reads.js";
import { acknowledgeCloudChatEdits, CloudV2ChatEdits, overlayCloudChatEdits } from "./chat-edits.js";
import type { ApiWorkspaceList } from "./api/contract.js";
import { withSystemStatement, withSystemTx, type Tx } from "../db.js";
import { sql, SqlFragment } from "../sql-fragment.js";
import type { AuthedUser } from "../auth.js";
import type { CloudAgentCredentialKeys } from "../agent-credentials/agent-credential-envelope.js";
import { securityStreamAuthority } from "../security-events.js";
import { HttpError } from "../authz.js";
import { CloudV2HistoryDigestsReplySchema, type CloudV2HistoryState, type CloudV2MessageRow } from "./contract.js";
import { hashCloudV2Token, newCloudV2Token } from "./tokens.js";
import { CLOUD_V2_CREATOR_ON_HOLD, CLOUD_V2_CREATOR_ACCESS_SQL, CLOUD_V2_LIVE_ACCESS as LIVE_ACCESS, CLOUD_V2_LIVE_ACCESS_SQL, requireWorkspaceCreator } from "./workspace-access.js";
import { memberOnHoldSql, organizationMemberOnHold } from "../organization-seats.js";
import { CloudV2PromptOutbox, type CloudApiPrompt } from "./prompt-outbox.js";
import { computerSourceReviewRequired, readComputerSourceTargets } from "./computer-provenance.js";
import { CloudSourceTargetSchema, type CloudSourceTarget } from "./source-authority.js";
import { pinCloudEnvironment, releaseCloudEnvironment } from "./environment-store.js";
import { originalSetupBuild } from "./setup-selection.js";

import { mirrorMessageSenders, mirrorMessageWindow, type MessageWindow, type WindowOptions } from "./history.js";
import { mirrorMessageSearch, type SearchOptions } from "./history-search.js";
import { cacheCounter, mirrorMessageDelta, mirrorMessageRange } from "./history-cache.js";
import { MESSAGE_SEARCH_DEADLINE_MS } from "./message-search.js";
import { consumeRuntimeCanary } from "./runtime-canary-store.js";
import type { RuntimeCanaryAdmission } from "./runtime-canary.js";
import { RUNTIME_HANDOFF_SESSION } from "./runtime-handoff-store.js";
import { notifyCloudV2WorkerReady } from "./worker-ready.js";
import type { CloudV2SetupStatus } from "./setup-status-contract.js";

export type CloudV2WorkspaceState =
  | "creating" | "running" | "stopping" | "stopped" | "starting" | "deleting" | "deleted" | "failed";

export type CloudV2InstalledRepository = { repository: string; defaultBranch: string | null };
type CreateWorkspace = {
  id: string; organizationId: string; creatorUserId: string; name: string; repository: string; branch: string;
  baseBranch: string; computerBuildId: string | null;
  sourceRepositoryId?: string;
  initialPrompt?: CloudApiPrompt;
  createdBySessionId?: string | null;
  env?: Record<string, string>;
  workspaceTokenCreate?: true;
  /** GitHub repository IDs the creator was just verified to read. */
  readableRepositoryIds?: readonly string[];
  runtimeCanary?: RuntimeCanaryAdmission;
  executionRuntime?: RuntimeCapabilities;
  /** The lifecycle runs the GitHub checks and sets the source scope before
   * any VM exists; until then the row has no scope (resolvePendingSource). */
  pendingSource?: true;
};
type CreateReceipt = { status: 201; response: Record<string, unknown> };
type HistoryInput = {
  chats?: readonly { id: string }[] | undefined; chatDeletions?: readonly string[] | undefined;
  chatEditAcks?: readonly { chatId: string; version: string }[] | undefined;
  messages?: { chatId: string; rows: readonly CloudV2MessageRow[]; replace?: true | undefined; historyState?: CloudV2HistoryState | undefined; digest?: string | undefined } | undefined;
};
export type CloudV2WorkerSession = CloudV2Workspace & {
  accessEpoch: string; loginRevision: string; executionMode?: "legacy" | "prepared" | "active";
  executionTransitionId?: string;
  recoveryAttemptId?: string;
  /** Present only on the hello that actually changes a booting state to running. */
  helloTiming?: { state: "creating" | "starting"; durationMs: number };
};
/** Kept on the CP side of the authenticated dial, never supplied in a frame. */
export type CloudV2WorkerBinding = { workspaceId: string; bootId: string; accessEpoch: string; workerTokenHash: string };
const PENDING_WORKER_PROMPTS_SQL = sql`(
  EXISTS (SELECT 1 FROM cloud_v2_prompt_outbox p JOIN cloud_v2_prompt_chats c USING(workspace_id,chat_id)
    WHERE p.workspace_id=w.id AND p.state IN ('queued','inboxed') AND p.epoch=c.epoch
      AND p.access_epoch=w.access_epoch AND NOT p.cancel_requested AND p.payload IS NOT NULL)
  OR EXISTS (SELECT 1 FROM cloud_v2_prompt_chats c WHERE c.workspace_id=w.id AND c.stop_acked_epoch<c.epoch))`;
export type CloudV2AppGrant = { userId: string; accessEpoch: string; wake: boolean; sessionId: string | null; execution?: ExecutionConnectAuthority };

export type CloudV2Workspace = {
  id: string;
  organizationId: string;
  creatorUserId: string | null;
  createdBySessionId?: string | null;
  name: string;
  /** Permanent within the organization (`w-<n>`); never reused. */
  number?: number | null;
  /** The first name one of its chats received; null shows as "Untitled". */
  title?: string | null;
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
  setup?: CloudV2SetupStatus;
  agentCost?: { totalUsd: number; estimated: boolean };
  /** Created before its GitHub checks: no source scope, sandbox or worker
   * yet. Only the lifecycle's resolvePendingSource may end it. */
  sourcePending?: true;
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
  recoveryAttemptId?: string;
  executionTransitionId?: string;
  executionRestoreClaimed?: true;
  executionIntent?: { id: string | null; userId: string | null; accessEpoch: string; authority: ExecutionIntentAuthority | null };
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
/** `from` is null for Boat's stock image; `prune` lists the other recipe
 * checkouts a v3 image starts with. */
export type CloudV2RestoreCreate = { from: string | null; prune?: string[]; name: string; env: Record<string, string>; requestedAt: string };
/** `checkout`: the image already holds this workspace's clone, so creation
 * skips hydrating it. Only a source-holding (v3) image ever does. */
export type CloudV2WorkspaceImage = { from: string | null; prune: string[]; checkout: boolean };

/** A v3 image holds every recipe repository, so it starts only a workspace
 * whose immutable source scope covers them all; that workspace removes the
 * other checkouts before its worker starts. Any other starts from Boat's
 * stock image and clones its own repository. A v2 image holds no source. */
export function cloudV2WorkspaceImage(input: { policy: number; snapshot: string; recipe: unknown; scope: readonly string[]; repository: string }): CloudV2WorkspaceImage {
  if (input.policy !== 3) return { from: input.snapshot, prune: [], checkout: false };
  const entries = (input.recipe as { repositories?: { repository?: unknown }[] } | null)?.repositories ?? [];
  const names = entries.flatMap(entry => typeof entry.repository === "string" ? [entry.repository] : []);
  const scope = new Set(input.scope.map(name => name.toLowerCase()));
  if (!names.length || names.length !== entries.length || !names.every(name => scope.has(name.toLowerCase()))) return { from: null, prune: [], checkout: false };
  const own = (name: string) => name.toLowerCase() === input.repository.toLowerCase();
  return { from: input.snapshot, prune: names.filter(name => !own(name)), checkout: names.some(own) };
}

function restoreCreate(value: CloudV2RestoreCreate | null): CloudV2RestoreCreate | null {
  return value && { from: value.from, ...(value.prune?.length ? { prune: value.prune } : {}), name: value.name, env: value.env, requestedAt: value.requestedAt };
}

export type CloudV2WorkspaceRow = {
  id: string; org_id: string; creator_user_id: string | null; name: string; number: number | null; title: string | null;
  repository: string; branch: string; base_branch: string;
  state: CloudV2WorkspaceState; boat_sandbox_id: string | null; computer_build_id: string | null;
  error_code: string | null; active_at: Date | null; archived_at: Date | null; created_at: Date; updated_at: Date;
  source_pending: boolean;
  created_by_session_id: string | null;
  setup_status: CloudV2SetupStatus | null;
  agent_cost_usd: string; agent_cost_turns: string; agent_cost_estimated_turns: string;
};
type Row = CloudV2WorkspaceRow;

const WORKSPACE_COLUMNS_SQL = sql`id, org_id, creator_user_id, name, number, title, repository, branch, base_branch, state, boat_sandbox_id,
  computer_build_id, error_code, active_at, archived_at, created_at, updated_at, source_pending, created_by_session_id, setup_status,
  agent_cost_usd, agent_cost_turns, agent_cost_estimated_turns`;
const COLUMNS = WORKSPACE_COLUMNS_SQL.text;
export const CLOUD_V2_WORKSPACE_COLUMNS = COLUMNS.split(",").map(value => value.trim());

type LifecycleRow = Row & {
  execution_transition_id: string | null;
  execution_restore_claimed_at: Date | null;
  execution_mode: string; execution_initiator_user_id: string | null; execution_intent_id: string | null;
  execution_intent_authority: ExecutionIntentAuthority | null; access_epoch: string;
  lease_renewed_at: Date | null; base_commit: string | null; restore_pending: boolean; restore_attempt: string | null;
  restore_create: CloudV2RestoreCreate | null; checkpoint_uploads: Record<string, string>;
  stop_generation: string; checkpoint_stop_generation: string | null;
  checkpoint_object: string | null; checkpoint_key: unknown; checkpoint_sha256: string | null; checkpoint_bytes: string | null; checkpoint_saved_at: Date | null;
  checkpoint_reuse: unknown; checkpoint_retry_fork: unknown;
};
const LIFECYCLE_COLUMNS = `${COLUMNS}, lease_renewed_at, base_commit, restore_pending, restore_attempt, restore_create, checkpoint_uploads,
  execution_mode, execution_transition_id, execution_restore_claimed_at, execution_initiator_user_id, execution_intent_id, execution_intent_authority, access_epoch,
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

export function cloudV2LifecycleWorkspaceFromRow(row: LifecycleRow): CloudV2LifecycleWorkspace {
  const reuse = row.checkpoint_object ? checkpointReuse(row.checkpoint_reuse, row.checkpoint_object) : null;
  const checkpoint = row.checkpoint_object && row.checkpoint_sha256 && row.checkpoint_bytes && row.checkpoint_saved_at
    ? { object: row.checkpoint_object, key: row.checkpoint_key, sha256: row.checkpoint_sha256, bytes: Number(row.checkpoint_bytes),
        savedAt: row.checkpoint_saved_at.toISOString(), stopGeneration: row.checkpoint_stop_generation, ...(reuse ? { reuse } : {}) }
    : null;
  return { ...workspace(row), leaseRenewedAt: row.lease_renewed_at?.toISOString() ?? null, baseCommit: row.base_commit,
    ...(row.execution_transition_id ? { executionTransitionId: row.execution_transition_id } : {}),
    ...(row.execution_mode === "active" && row.execution_restore_claimed_at ? { executionRestoreClaimed: true as const } : {}),
    ...(row.execution_mode === "active" ? { executionIntent: { id: row.execution_intent_id, userId: row.execution_initiator_user_id,
      accessEpoch: row.access_epoch, authority: row.execution_intent_authority } } : {}),
    checkpoint, restorePending: row.restore_pending, restoreAttempt: row.restore_attempt, restoreCreate: restoreCreate(row.restore_create),
    stopGeneration: row.stop_generation, checkpointUploadUntil: uploadHorizon(row.checkpoint_uploads),
    checkpointRetryFork: checkpointFork(row.checkpoint_retry_fork) };
}
const lifecycleWorkspace = cloudV2LifecycleWorkspaceFromRow;

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
    createdBySessionId: row.created_by_session_id,
    name: row.name,
    number: row.number ?? null,
    title: row.title ?? null,
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
    ...(row.setup_status ? { setup: row.setup_status } : {}),
    ...(Number(row.agent_cost_turns) > 0 ? { agentCost: { totalUsd: Number(row.agent_cost_usd), estimated: Number(row.agent_cost_estimated_turns) > 0 } } : {}),
    ...(row.source_pending ? { sourcePending: true as const } : {}),
  };
}
export { workspace as cloudV2WorkspaceFromRow };

// WorkOS sid is the device/session authority, independent of the workspace's
// account/membership epoch. Do not let a lost broker notification keep it live.
const LIVE_SESSION = `s.provider = 'workos' AND s.user_id = w.creator_user_id
  AND s.status = 'active' AND s.revoked_at IS NULL
  AND (s.provider_session_expires_at IS NULL OR s.provider_session_expires_at > clock_timestamp())
  AND EXISTS (SELECT 1 FROM user_identities i WHERE i.user_id = s.user_id
    AND i.provider = s.provider AND i.provider_sub = s.provider_sub AND i.status = 'active')`;

const notFound = () => new HttpError(404, "not_found", "Cloud workspace not found");

/** Creator-only paths remain closed to members even after shared execution
 * activates; those callers use the separate per-person admission. */
async function ownedRow(tx: Tx, id: string, userId: string, lock = false): Promise<Row & { access_epoch: string; login_revision: string }> {
  const { rows } = await tx.query<Row & { access_epoch: string; login_revision: string }>(
    `SELECT ${COLUMNS}, access_epoch::text, login_revision::text FROM cloud_v2_workspaces w
     WHERE w.id = $1 AND w.creator_user_id = $2 AND w.state <> 'deleted'
       AND ${CLOUD_V2_CREATOR_ACCESS_SQL.text}
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

/** Titles a chat carries before it is named; they never name a workspace. */
const UNNAMED_CHAT_TITLES = new Set(["", "Untitled", "New chat"]);
const MAX_WORKSPACE_TITLE_CHARS = 200;

/** The title a workspace takes from a chat row: its name, unless it is still
 * unnamed, a terminal tab or archived. Mirrors the Local engine's rule. */
export function workspaceTitleFromChat(chat: unknown): string | null {
  const row = chat as { title?: unknown; kind?: unknown; archived?: unknown } | null;
  if (!row || typeof row.title !== "string" || row.kind === "terminal" || row.archived === true) return null;
  const title = row.title.replace(/\s+/g, " ").trim();
  return UNNAMED_CHAT_TITLES.has(title) ? null : Array.from(title).slice(0, MAX_WORKSPACE_TITLE_CHARS).join("");
}

/** The earliest-created named chat in one mirror write. */
function firstWorkspaceTitle(chats: readonly unknown[]): string | null {
  let best: { title: string; createdAt: number } | null = null;
  for (const chat of chats) {
    const title = workspaceTitleFromChat(chat);
    if (!title) continue;
    const created = (chat as { createdAt?: unknown }).createdAt;
    const createdAt = typeof created === "number" && Number.isFinite(created) ? created : Number.POSITIVE_INFINITY;
    if (!best || createdAt < best.createdAt) best = { title, createdAt };
  }
  return best?.title ?? null;
}

export class CloudV2Store {
  readonly prompts: CloudV2PromptOutbox;
  readonly api: CloudApiReads;
  readonly chatEdits: CloudV2ChatEdits;
  constructor(private readonly pool: pg.Pool, private readonly environmentKeys?: CloudAgentCredentialKeys) {
    this.prompts = new CloudV2PromptOutbox(pool);
    this.api = new CloudApiReads(pool);
    this.chatEdits = new CloudV2ChatEdits(pool);
  }

  async createWorkspace(input: CreateWorkspace): Promise<CloudV2Workspace> {
    return withSystemTx(this.pool, tx => this.insertWorkspace(tx, input));
  }

  /** Shared by insertion and a pending create's resolution. */
  private async admitCreator(tx: Tx, organizationId: string, creatorUserId: string, serializeCreates = false): Promise<void> {
    const member = await tx.query<{ pro: boolean; held: boolean }>(
      `SELECT account_pro_active(m.user_id) AS pro, ${memberOnHoldSql("m.org_id", "m.user_id")} AS held
       FROM organization_members m JOIN organizations o ON o.id = m.org_id AND o.deleted_at IS NULL
       WHERE m.org_id = $1 AND m.user_id = $2 AND NOT o.is_personal AND o.cloud_workspaces_allowed
       FOR SHARE OF o ${serializeCreates ? "FOR UPDATE OF m" : "FOR SHARE OF m"}`,
      [organizationId, creatorUserId],
    );
    if (!member.rows[0]) throw new HttpError(404, "not_found", "Organization not found");
    if (member.rows[0].held) throw organizationMemberOnHold();
    if (!member.rows[0].pro) throw new HttpError(403, "pro_required", "Creating a cloud workspace requires Pro");
  }

  /** The build's ID for this repository, and the scope a v3 image needs. */
  private async computerScope(tx: Tx, organizationId: string, computerBuildId: string, repository: string,
    sourceRepositoryId?: string, readableRepositoryIds?: readonly string[]) {
    // Activation waits for this lock, so cleanup observes the new workspace
    // pin before it can retire an inactive source snapshot.
    const selected = await tx.query<{ recipe: { repositories: { repository: string }[] }; source_targets: unknown; source_policy_version: number }>(
      `SELECT b.recipe,b.source_targets,b.source_policy_version FROM cloud_v2_computers c
       JOIN cloud_v2_computer_builds b ON b.id=c.active_build_id AND b.org_id=c.org_id
       WHERE c.org_id=$1 AND c.active_build_id=$2 AND c.snapshot_name IS NOT NULL
         AND b.state='succeeded' AND b.source_policy_version IN (2,3) AND b.snapshot_id=c.snapshot_name AND b.snapshot_deleted_at IS NULL AND b.cleanup_requested_at IS NULL
       FOR SHARE OF c,b`, [organizationId, computerBuildId]);
    if (!selected.rowCount) throw new HttpError(409, "cloud_computer_changed", "The Cloud Computer changed. Create the workspace again.");
    const build = selected.rows[0]!;
    const targets = readComputerSourceTargets(build.recipe.repositories, build.source_targets);
    const target = targets.find(source => source.repository.toLowerCase() === repository.toLowerCase());
    if (!target || sourceRepositoryId !== undefined && sourceRepositoryId !== target.repositoryId) throw computerSourceReviewRequired();
    // A v3 image carries every recipe repository's source. Only a creator
    // verified to read all of them may take that whole scope and start from it.
    const scope = build.source_policy_version === 3 && targets.every(source => readableRepositoryIds?.includes(source.repositoryId)) ? targets : undefined;
    return { sourceRepositoryId: target.repositoryId, scope };
  }

  private async bindSources(tx: Tx, workspace: CloudV2Workspace, sourceRepositoryId: string, scope: readonly CloudSourceTarget[] | undefined,
    variables?: Record<string, string>): Promise<void> {
    if (!CloudSourceTargetSchema.safeParse({ repository: workspace.repository, repositoryId: sourceRepositoryId }).success) throw new HttpError(422, "github_repository_invalid", "Invalid repository identity.");
    for (const source of scope ?? [{ repository: workspace.repository, repositoryId: sourceRepositoryId }])
      await tx.query("INSERT INTO cloud_v2_github_sources(workspace_id,source_repository,repository_id) VALUES($1,lower($2),$3)",
        [workspace.id, source.repository, source.repositoryId]);
    if (variables && Object.keys(variables).length) {
      if (!this.environmentKeys) throw new HttpError(503, "cloud_environment_unavailable", "Cloud environment encryption is unavailable.");
      await pinCloudEnvironment(tx, workspace, sourceRepositoryId, { variables, keys: this.environmentKeys });
    } else await pinCloudEnvironment(tx, workspace, sourceRepositoryId);
  }

  private async insertWorkspace(tx: Tx, input: CreateWorkspace, createKey?: string): Promise<CloudV2Workspace> {
    const pending = input.pendingSource === true;
    if (pending && (!input.computerBuildId || input.sourceRepositoryId !== undefined || input.runtimeCanary || input.executionRuntime || Object.keys(input.env ?? {}).length))
      throw new Error("A pending create needs a Computer build and no verified source");
    let sourceRepositoryId = input.sourceRepositoryId, scope: readonly CloudSourceTarget[] | undefined;
    await this.admitCreator(tx, input.organizationId, input.creatorUserId, input.workspaceTokenCreate);
    if (input.workspaceTokenCreate) {
      // Membership locking serializes this budget across tokens and replicas;
      // the fresh statement also sees any creator admitted before the lock.
      const budget = (await tx.query<{ count: number; retry_after: number }>(`SELECT count(*)::int AS count,
        greatest(1,ceil(extract(epoch FROM min(created_at)+interval '1 hour'-statement_timestamp())))::int AS retry_after
        FROM (SELECT created_at FROM cloud_v2_workspaces WHERE org_id=$1 AND creator_user_id=$2
          AND created_at>statement_timestamp()-interval '1 hour' ORDER BY created_at DESC LIMIT 10) recent`,
      [input.organizationId, input.creatorUserId])).rows[0]!;
      if (budget.count >= 10) throw new HttpError(429, "workspace_create_limit", "Workspace token creation limit reached for this user and organization",
        { retryAfterSeconds: budget.retry_after });
    }
    if (input.computerBuildId)
      ({ sourceRepositoryId, scope } = await this.computerScope(tx, input.organizationId, input.computerBuildId, input.repository,
        input.sourceRepositoryId, input.readableRepositoryIds));
    if (Object.keys(input.env ?? {}).length && sourceRepositoryId === undefined)
      throw new HttpError(409, "cloud_source_review_required", "A workspace environment requires a verified repository identity.");
    const row = (await tx.query<Row>(
      `INSERT INTO cloud_v2_workspaces (id, org_id, creator_user_id, name, repository, branch, base_branch, state, computer_build_id, source_repositories, source_pending, api_access, created_by_session_id, execution_initiator_user_id, execution_intent_id, execution_mode)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'creating', $8, $9::text[], $10,
         coalesce((SELECT workspace_api_access FROM cloud_api_access_settings WHERE org_id=$2 AND user_id=$3),true), $11, $3, gen_random_uuid(), $12) RETURNING ${COLUMNS}`,
      [input.id, input.organizationId, input.creatorUserId, input.name, input.repository, input.branch,
        input.baseBranch, input.computerBuildId,
        pending ? null : (scope ?? [{ repository: input.repository }]).map(source => source.repository.toLowerCase()), pending, input.createdBySessionId ?? null,
        input.executionRuntime ? "active" : "legacy"],
    )).rows[0]!;
    if (!pending && sourceRepositoryId !== undefined) await this.bindSources(tx, workspace(row), sourceRepositoryId, scope, input.env);
    if (input.runtimeCanary) await consumeRuntimeCanary(tx, workspace(row), input.runtimeCanary, sourceRepositoryId, createKey);
    let promptAdmission;
    if (input.executionRuntime) {
      if (!this.prompts.execution) throw new HttpError(503, "execution_unavailable", "Shared execution is unavailable");
      const authority = await this.prompts.execution.deps.authority.creation(tx, row.id, input.creatorUserId);
      await tx.query("UPDATE cloud_v2_workspaces SET execution_intent_authority=$2 WHERE id=$1", [row.id, executionIntentAuthority(authority)]);
      await recordExecutionCreation(tx, row.id, input.executionRuntime);
      if (input.initialPrompt) promptAdmission = await this.prompts.execution.creationPrompt(tx, authority, input.initialPrompt);
    }
    if (input.initialPrompt) await this.prompts.enqueueApi(row.id, input.creatorUserId, input.initialPrompt, tx, undefined, promptAdmission);
    return workspace(row);
  }

  /** Ends a pending create with the scope its creator was just verified for,
   * before any VM exists. False when it is no longer a pending creating row. */
  async resolvePendingSource(id: string, input: { sourceRepositoryId: string; readableRepositoryIds: readonly string[]; baseCommit: string | null }): Promise<boolean> {
    return withSystemTx(this.pool, async tx => {
      const { rows } = await tx.query<Row>(`SELECT ${COLUMNS} FROM cloud_v2_workspaces
        WHERE id=$1 AND state='creating' AND source_pending AND boat_sandbox_id IS NULL AND computer_build_id IS NOT NULL FOR UPDATE`, [id]);
      if (!rows[0]) return false;
      const current = workspace(rows[0]);
      requireWorkspaceCreator(current);
      await this.admitCreator(tx, current.organizationId, current.creatorUserId);
      const { sourceRepositoryId, scope } = await this.computerScope(tx, current.organizationId, current.computerBuildId!, current.repository,
        input.sourceRepositoryId, input.readableRepositoryIds);
      await tx.query(`UPDATE cloud_v2_workspaces SET source_repositories=$2::text[], source_pending=false,
          base_commit=coalesce(base_commit,$3) WHERE id=$1`,
        [id, (scope ?? [{ repository: current.repository }]).map(source => source.repository.toLowerCase()), input.baseCommit]);
      await this.bindSources(tx, current, sourceRepositoryId, scope);
      return true;
    });
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
      const workspace = await this.insertWorkspace(tx, input, key);
      const receipt = { status: 201 as const, response: response(workspace) };
      await tx.query(`INSERT INTO cloud_v2_create_requests(creator_user_id,request_key,request_hash,workspace_id,status,response)
        VALUES($1,$2,$3,$4,$5,$6)`, [input.creatorUserId, key, hash, workspace.id, receipt.status, JSON.stringify(receipt.response)]);
      return receipt;
    });
  }

  async get(id: string, userId: string): Promise<CloudV2Workspace> {
    return workspace(await withSystemTx(this.pool, tx => ownedRow(tx, id, userId)));
  }

  /** The workspace an organization's page names (`<slug>/w/<n>`), with the
   * same creator-only access as by id: anyone else sees the same 404. */
  async getByNumber(organizationSlug: string, number: number, userId: string): Promise<CloudV2Workspace> {
    return workspace(await withSystemTx(this.pool, async tx => {
      const { rows } = await tx.query<{ id: string }>(
        `SELECT w.id FROM cloud_v2_workspaces w JOIN organizations o ON o.id = w.org_id
         WHERE o.slug = $1 AND o.deleted_at IS NULL AND NOT o.is_personal AND w.number = $2`,
        [organizationSlug, number],
      );
      if (!rows[0]) throw notFound();
      return ownedRow(tx, rows[0].id, userId);
    }));
  }

  async promptContext(id: string, userId: string) {
    const { rows } = await withSystemStatement<Row & { access_epoch: string; login_revision: string }>(this.pool,
      sql`SELECT ${WORKSPACE_COLUMNS_SQL}, access_epoch::text, login_revision::text FROM cloud_v2_workspaces w
        WHERE w.id=${SqlFragment.uuid(id.toLowerCase())} AND w.creator_user_id=${SqlFragment.uuid(userId.toLowerCase())}
          AND w.state<>'deleted' AND ${CLOUD_V2_CREATOR_ACCESS_SQL}`);
    const row = rows[0] ?? await withSystemTx(this.pool, tx => ownedRow(tx, id, userId));
    return { workspace: workspace(row), proof: { accessEpoch: row.access_epoch, loginRevision: row.login_revision } };
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

  async listApiWorkspaces(organizationId: string, userId: string, page: ApiWorkspaceList): Promise<CloudV2Workspace[]> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<Row>(
      `SELECT ${COLUMNS} FROM cloud_v2_workspaces w WHERE w.org_id=$1 AND w.creator_user_id=$2
        AND w.state<>'deleted' AND ${CLOUD_V2_CREATOR_ACCESS_SQL.text} AND ($3::boolean OR w.archived_at IS NULL)
        AND ($4::text IS NULL OR w.state=$4) AND ($5::text IS NULL OR lower(w.repository)=lower($5))
        AND ($6::text IS NULL OR strpos(lower(w.name || ' ' || coalesce(w.title,'')),lower($6))>0)
        ORDER BY w.created_at DESC,w.id LIMIT $7 OFFSET $8`,
      [organizationId, userId, page.includeArchived, page.state ?? null, page.repository ?? null, page.name ?? null, page.limit + 1, page.offset]));
    return rows.map(workspace);
  }

  rename(id: string, userId: string, title: string): Promise<CloudV2Workspace> {
    return withSystemTx(this.pool, async tx => {
      await ownedRow(tx, id, userId, true);
      const { rows } = await tx.query<Row>(`UPDATE cloud_v2_workspaces w SET title=$3,updated_at=clock_timestamp()
        WHERE w.id=$1 AND w.creator_user_id=$2 AND ${CLOUD_V2_CREATOR_ACCESS_SQL.text} RETURNING ${COLUMNS}`, [id, userId, title]);
      if (!rows[0]) throw notFound();
      return workspace(rows[0]);
    });
  }

  /** Serialize the initiator's intent with lifecycle progress. Flag-only changes
   * advance the document version without rescheduling a pending stop. A wake
   * revokes the suspended boot before Boat can resume its old service. */
  async requestLifecycle(id: string, userId: string, action: "start" | "stop" | "archive" | "restart"):
    Promise<{ workspace: CloudV2Workspace; moved: boolean }> {
    const execution = this.prompts.execution;
    if (execution && await execution.active(id)) {
      const proof = action === "stop" ? undefined : await execution.deps.authority.admit(id, userId);
      return this.requestExecutionLifecycle(id, userId, action, proof);
    }
    return withSystemTx(this.pool, async tx => {
      const current = await ownedRow(tx, id, userId, true);
      await ownedRow(tx, id, userId);
      const result = await this.lifecycleIntent(tx,id,current,action);
      if (action === "stop" || action === "archive") await clearStoppedExecutionTransition(tx, id);
      return result;
    });
  }

  async requestExecutionLifecycle(id: string, userId: string, action: "start" | "stop" | "archive" | "restart", proof?: ExecutionAdmission,
    user?: AuthedUser, unarchived = false): Promise<{ workspace: CloudV2Workspace; moved: boolean }> {
    const authority = this.prompts.execution!.deps.authority;
    return withSystemTx(this.pool, async tx => {
      const row = (await tx.query<Row>(`SELECT ${COLUMNS} FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE`, [id])).rows[0];
      if (!row) throw notFound();
      if (user) await authority.session(tx, user, userId);
      const before = await authority.snapshot(tx, id, userId);
      if (proof) await authority.assert(proof, tx);
      else if (action !== "stop") throw new HttpError(409, "actor_changed", "Execution authority changed");
      if (action === "archive" && before.role === "member" && row.creator_user_id !== userId) throw new HttpError(403, "workspace_management_denied", "Only the Creator or an administrator may archive this workspace");
      if (unarchived && row.archived_at) throw new HttpError(409, "cloud_workspace_not_running", "This cloud workspace is not ready for a connection");
      const result = await this.lifecycleIntent(tx, id, row, action, userId, proof ? executionIntentAuthority(proof) : undefined);
      if (proof) await authority.assert(proof, tx, true);
      else if ((await authority.snapshot(tx, id, userId)).permissionSignature !== before.permissionSignature) throw new HttpError(409, "actor_changed", "Execution authority changed");
      if (user) await authority.session(tx, user, userId);
      if (action === "stop" || action === "archive") await clearStoppedExecutionTransition(tx, id);
      return result;
    });
  }

  /** The only shared management entry point. Its caller proves the viewer's
   * source scope and admin role again after the workspace lock; no actor is
   * substituted for the Creator and no start/restart action is accepted. */
  async manage(id: string, action: "stop" | "archive" | "delete" | "rename", authorize: (tx: Tx) => Promise<void>, title?: string):
    Promise<{ workspace: CloudV2Workspace; moved: boolean }> {
    return withSystemTx(this.pool,async tx => {
      const row = (await tx.query<Row>(`SELECT ${COLUMNS} FROM cloud_v2_workspaces w
        WHERE w.id=$1 AND w.state<>'deleted' FOR UPDATE OF w`,[id])).rows[0];
      if (!row) throw notFound();
      await authorize(tx);
      if (action === "stop" || action === "archive") {
        const result = await this.lifecycleIntent(tx,id,row,action);
        await authorize(tx);
        await clearStoppedExecutionTransition(tx, id);
        return result;
      }
      if (action === "rename") {
        if (title === undefined) throw new Error("workspace_title_required");
        const updated = (await tx.query<Row>(`UPDATE cloud_v2_workspaces SET title=$2,updated_at=clock_timestamp()
          WHERE id=$1 RETURNING ${COLUMNS}`,[id,title])).rows[0]!;
        await authorize(tx);
        return { workspace: workspace(updated),moved: false };
      }
      await cancelExecutionActivation(tx, id);
      const updated = (await tx.query<Row>(`UPDATE cloud_v2_workspaces SET state='deleting',restart_stop_generation=NULL,
        attempts=0,next_attempt_at=NULL,updated_at=clock_timestamp() WHERE id=$1 RETURNING ${COLUMNS}`,[id])).rows[0]!;
      await authorize(tx);
      return { workspace: workspace(updated),moved: row.state !== "deleting" };
    });
  }

  private async lifecycleIntent(tx: Tx, id: string, current: Row, action: "start" | "stop" | "archive" | "restart", initiator?: string,
    executionAuthority?: ExecutionIntentAuthority) {
      if (action === "stop" || action === "archive") await cancelExecutionActivation(tx, id);
      else await assertNoExecutionTransition(tx, id);
      const intent = (await tx.query<{ stop_generation: string; restart_stop_generation: string | null; execution_mode: string }>(
        "SELECT stop_generation::text,restart_stop_generation::text,execution_mode FROM cloud_v2_workspaces WHERE id=$1", [id])).rows[0]!;
      const priorRestart = intent.restart_stop_generation;
      if (action === "restart" && (current.state === "deleting" || current.state === "creating" && current.boat_sandbox_id === null))
        throw new HttpError(409, "workspace_unavailable", "This cloud workspace cannot be restarted yet");
      if (action === "archive" && (current.state === "creating" || current.state === "deleting"))
        throw new HttpError(409, "workspace_unavailable", "This cloud workspace cannot be archived yet");
      // A bound first boot already owns its VM, even while configuration keeps
      // it in creating. Stop must win without racing an unassigned allocation.
      const configuring = (action === "stop" || action === "restart") && current.state === "creating" && current.boat_sandbox_id !== null &&
        (action === "restart" || (await tx.query("SELECT 1 FROM cloud_v2_workspaces WHERE id=$1 AND worker_boot_id IS NOT NULL", [id])).rowCount === 1);
      const starts = action === "start" || action === "restart" && (current.state === "stopped" || current.state === "failed");
      const reconfirm = action === "stop" && current.state === "stopped" && intent.execution_mode === "prepared" &&
        await needsExecutionStopConfirmation(tx, id);
      const state = starts
        ? current.state === "stopped" || current.state === "failed" ? "starting" : current.state
        : current.state === "running" || current.state === "starting" || configuring || reconfirm ? "stopping" : current.state;
      const moved = state !== current.state;
      const archived = action === "archive" || (action === "stop" && current.archived_at !== null);
      const restart = state === "stopping" && action === "restart" ? (BigInt(intent.stop_generation) + (moved ? 1n : 0n)).toString()
        : state === "stopping" && action === "start" && priorRestart === intent.stop_generation ? priorRestart : null;
      if (!moved && archived === (current.archived_at !== null) && restart === priorRestart) return { workspace: workspace(current), moved };
      const { rows } = await tx.query<Row>(
        `UPDATE cloud_v2_workspaces SET
           archived_at = CASE WHEN $3::boolean THEN coalesce(archived_at, clock_timestamp()) ELSE NULL END,
           restart_stop_generation = $4::bigint,
           execution_initiator_user_id = CASE WHEN $5::uuid IS NOT NULL AND $6::boolean THEN $5 ELSE execution_initiator_user_id END,
           execution_intent_id = CASE WHEN $5::uuid IS NOT NULL AND $6::boolean THEN gen_random_uuid() ELSE execution_intent_id END,
           execution_intent_authority = CASE WHEN $5::uuid IS NOT NULL AND $6::boolean THEN $7::jsonb ELSE execution_intent_authority END,
           attempts = CASE WHEN state <> $2 THEN 0 ELSE attempts END,
           next_attempt_at = CASE WHEN state <> $2 THEN NULL ELSE next_attempt_at END,
           worker_token_hash = CASE WHEN state <> $2 AND $2 = 'starting' THEN NULL ELSE worker_token_hash END,
           worker_boot_id = CASE WHEN state <> $2 AND $2 = 'starting' THEN NULL ELSE worker_boot_id END,
           stop_generation = stop_generation + CASE WHEN state <> $2 AND $2 = 'stopping' THEN 1 ELSE 0 END,
           updated_at = clock_timestamp(),
           state = $2
         WHERE id = $1 RETURNING ${COLUMNS}`,
        [id, state, archived, restart, initiator ?? null, action === "start" || action === "restart", executionAuthority ?? null],
      );
      return { workspace: workspace(rows[0]!), moved };
  }

  /** Compare-and-set. Returns null when the workspace was not in `from`, or,
   * with `stopGeneration`, when another stop has begun since. `revoke` drops
   * the worker's credentials in the same transaction, only if it moved, so a
   * late step can never revoke a worker that a newer wake started.
   * `expectedSandboxId: null` fences an observed empty allocation slot. */
  async transition(id: string, from: readonly CloudV2WorkspaceState[], to: CloudV2WorkspaceState,
    patch: { boatSandboxId?: string | null; expectedSandboxId?: string | null; errorCode?: string | null; stopGeneration?: string; revoke?: boolean; unarchived?: boolean } = {}): Promise<CloudV2Workspace | null> {
    return withSystemTx(this.pool, async tx => {
    if (to === "starting") {
      await tx.query("SELECT id FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE", [id]);
      await assertNoExecutionTransition(tx, id);
    }
    const { rows } = await tx.query<Row>(
      `UPDATE cloud_v2_workspaces SET state = CASE WHEN state='stopping' AND $3='stopped'
           AND restart_stop_generation=$8::bigint AND archived_at IS NULL AND $12::boolean THEN 'starting' ELSE $3 END,
         restart_stop_generation = CASE WHEN $3 IN ('stopped','starting','failed','deleting','deleted') THEN NULL ELSE restart_stop_generation END,
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
       WHERE id = $1 AND state = ANY($2::text[]) AND ($8::bigint IS NULL OR stop_generation = $8::bigint)
         AND (NOT $9::boolean OR archived_at IS NULL)
         AND (NOT $10::boolean OR boat_sandbox_id IS NOT DISTINCT FROM $11::text) RETURNING ${COLUMNS}`,
      [id, from, to, patch.boatSandboxId !== undefined, patch.boatSandboxId ?? null,
        patch.errorCode !== undefined, patch.errorCode ?? null, patch.stopGeneration ?? null, patch.unarchived ?? false,
        patch.expectedSandboxId !== undefined, patch.expectedSandboxId ?? null, patch.revoke ?? false],
    );
    if (!rows[0]) return null;
    if (to === "deleting") await cancelExecutionActivation(tx, id);
    if (to === "deleted") await releaseCloudEnvironment(tx, id);
    if (patch.revoke) {
      await tx.query(`UPDATE cloud_v2_workspaces SET worker_token_hash = NULL, worker_boot_id = NULL WHERE id = $1`, [id]);
      await tx.query(`DELETE FROM cloud_v2_tokens WHERE workspace_id = $1`, [id]);
    }
    if (to === "deleted" || to === "stopped" && patch.revoke) {
      // Only provider-confirmed shutdown releases these process barriers. A
      // restart may already have changed the visible state back to starting.
      await tx.query(`UPDATE cloud_v2_execution_contexts SET state='retired',retired_at=clock_timestamp(),
        reason=coalesce(reason,'cancelled'),revoked_at=coalesce(revoked_at,clock_timestamp()),material=NULL,environment_version_id=NULL
        WHERE workspace_id=$1 AND state<>'retired'`, [id]);
      if (to === "stopped" && patch.stopGeneration) await confirmExecutionStop(tx, id, patch.stopGeneration);
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
  async workerRoute(id: string): Promise<{ workspace: CloudV2Workspace; executionMode?: "legacy" | "prepared" | "active"; recoveryAttemptId?: string; accessEpoch: string; url: string | null; portToken: unknown; bootId: string | null; workerTokenHash: string | null } | null> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<Row & { execution_mode: "legacy" | "prepared" | "active"; recovery_attempt_id: string | null; access_epoch: string; worker_route_url: string | null; worker_port_token: unknown; worker_boot_id: string | null; worker_token_hash: string | null }>(
      `SELECT ${COLUMNS}, execution_mode, recovery_attempt_id, access_epoch::text, worker_route_url, worker_port_token, worker_boot_id, encode(worker_token_hash,'hex') AS worker_token_hash
       FROM cloud_v2_workspaces w WHERE id=$1 AND state NOT IN ('deleting','deleted') AND ${LIVE_ACCESS}`, [id]));
    const row = rows[0];
    return row ? { workspace: workspace(row), executionMode: row.execution_mode,
      ...(row.recovery_attempt_id ? { recoveryAttemptId: row.recovery_attempt_id } : {}),
      accessEpoch: row.access_epoch, url: row.worker_route_url, portToken: row.worker_port_token, bootId: row.worker_boot_id, workerTokenHash: row.worker_token_hash } : null;
  }

  async setWorkerRoute(id: string, sandboxId: string, url: string, portToken: unknown): Promise<boolean> {
    const result = await withSystemTx(this.pool, tx => tx.query(
      `UPDATE cloud_v2_workspaces SET worker_route_url=$3, worker_port_token=$4
       WHERE id=$1 AND boat_sandbox_id=$2 AND state IN ('creating','starting')`, [id, sandboxId, url, JSON.stringify(portToken)]));
    return Boolean(result.rowCount);
  }

  /** Refusing a runtime must not retire the workspace's current boot. */
  async workerHelloIdentity(token: string): Promise<CloudV2WorkerSession | null> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<Row & { execution_mode: "legacy" | "prepared" | "active"; execution_transition_id: string | null; recovery_attempt_id: string | null; access_epoch: string; login_revision: string }>(
      `SELECT ${COLUMNS}, execution_mode, execution_transition_id, recovery_attempt_id, access_epoch::text, login_revision::text FROM cloud_v2_workspaces w
       WHERE worker_token_hash=$1 AND state IN ('creating','starting','running') AND ${LIVE_ACCESS}`, [hashCloudV2Token(token)]));
    const row = rows[0];
    return row ? { ...workspace(row), accessEpoch: row.access_epoch, loginRevision: row.login_revision, executionMode: row.execution_mode,
      ...(row.recovery_attempt_id ? { recoveryAttemptId: row.recovery_attempt_id } : {}),
      ...(row.execution_transition_id ? { executionTransitionId: row.execution_transition_id } : {}) } : null;
  }

  /** Bind the boot before configuration I/O, without publishing readiness.
   * Lifecycle delivery must not replace a credential once this boot claims it. */
  async beginWorkerHello(token: string, bootId: string, actingUser = false, runtimeSha256?: string, syncContext = false, recovery = false): Promise<CloudV2WorkerSession | null> {
    const { rows } = await withSystemTx(this.pool, async tx => {
      const result = await tx.query<Row & { execution_mode: "legacy" | "prepared" | "active"; recovery_attempt_id: string | null; access_epoch: string; login_revision: string; previous_boot_id: string | null }>(
      `WITH prior AS MATERIALIZED (
         SELECT id AS prior_id,worker_boot_id AS previous_boot_id FROM cloud_v2_workspaces w
         WHERE worker_token_hash=$1 AND state IN ('creating','starting','running') AND ${LIVE_ACCESS} FOR UPDATE)
       UPDATE cloud_v2_workspaces w SET
         worker_history_sequence=CASE WHEN worker_boot_id=$2 THEN worker_history_sequence ELSE 0 END,
         worker_history_digest=CASE WHEN worker_boot_id=$2 THEN worker_history_digest ELSE NULL END,
         state=CASE WHEN state='running' AND worker_boot_id IS DISTINCT FROM $2 THEN 'starting' ELSE state END,
         updated_at=CASE WHEN state='running' AND worker_boot_id IS DISTINCT FROM $2 THEN clock_timestamp() ELSE updated_at END,
         worker_boot_id=$2, acting_user_boot_ids=CASE WHEN $3 THEN ARRAY[$2::uuid] ELSE '{}'::uuid[] END,
         worker_recovery_boot_id=CASE WHEN $4 THEN $2 ELSE NULL END
       FROM prior WHERE w.id=prior.prior_id AND worker_token_hash=$1 AND state IN ('creating','starting','running') AND ${LIVE_ACCESS}
       RETURNING ${COLUMNS.replace(/\b(\w+)\b/g, "w.$1")},execution_mode,recovery_attempt_id,access_epoch::text,login_revision::text,prior.previous_boot_id`, [hashCloudV2Token(token), bootId, actingUser, recovery]);
      const current = result.rows[0];
      if (current?.execution_mode === "active") {
        if (!actingUser || !this.prompts.execution) throw new HttpError(409, "worker_update_required", "Update the worker before shared execution");
        await assertExecutionCreationBoot(tx, current.id, syncContext);
        await this.prompts.execution.boots.bind(tx, { token, bootId }, current.previous_boot_id);
        await bindExecutionActivationBoot(tx, await this.prompts.execution.worker(tx, { token, bootId }, false, true), runtimeSha256);
      }
      return result;
    });
    const row = rows[0];
    return row ? { ...workspace(row), accessEpoch: row.access_epoch, loginRevision: row.login_revision, executionMode: row.execution_mode,
      ...(row.recovery_attempt_id ? { recoveryAttemptId: row.recovery_attempt_id } : {}) } : null;
  }

  async acceptWorkerHello(token: string, bootId: string, proof?: { accessEpoch: string; loginRevision: string }): Promise<CloudV2WorkerSession | null> {
    const { rows } = await withSystemTx(this.pool, async tx => {
      const result = await tx.query<Row & { execution_mode: "legacy" | "prepared" | "active"; access_epoch: string; login_revision: string; prior_state: "creating" | "starting" | "running"; hello_ms: number }>(
      `WITH prior AS MATERIALIZED (
         SELECT id AS prior_id, state AS prior_state, updated_at AS prior_updated_at,
           (CASE WHEN execution_mode='active' THEN EXISTS(SELECT 1 FROM cloud_v2_execution_boots b WHERE b.workspace_id=w.id AND b.boot_id=$2
             AND b.clean_at IS NOT NULL AND b.legacy_material IN ('none','removed') AND b.replaced_by IS NULL
             AND b.access_epoch=w.access_epoch AND b.stop_generation=w.stop_generation AND b.worker_token_hash=w.worker_token_hash)
             ELSE NOT EXISTS (SELECT 1 FROM cloud_workspace_environment_pins p WHERE p.workspace_id=w.id
               AND (p.ready_boot_id IS NULL OR p.ready_boot_id IS DISTINCT FROM $2::uuid)) END
             AND NOT (${CLOUD_RECOVERY_TURN_HOLD})) AS environment_ready
         FROM cloud_v2_workspaces w
         WHERE worker_token_hash=$1 AND state IN ('creating','starting','running') AND ${LIVE_ACCESS}
           AND ($3::bigint IS NULL OR (worker_boot_id=$2 AND access_epoch=$3 AND login_revision=$4::bigint)) FOR UPDATE)
       UPDATE cloud_v2_workspaces w SET
         worker_history_sequence=CASE WHEN worker_boot_id=$2 THEN worker_history_sequence ELSE 0 END,
         worker_history_digest=CASE WHEN worker_boot_id=$2 THEN worker_history_digest ELSE NULL END,
         worker_boot_id=$2, state=CASE WHEN prior.environment_ready THEN 'running' ELSE 'starting' END, attempts=0, next_attempt_at=NULL,
         active_at=CASE WHEN state='running' OR NOT prior.environment_ready THEN active_at ELSE clock_timestamp() END,
         updated_at=CASE WHEN state='running' OR (state='starting' AND NOT prior.environment_ready) THEN updated_at ELSE clock_timestamp() END
       FROM prior WHERE w.id=prior.prior_id
       RETURNING ${COLUMNS.replace(/\b(\w+)\b/g, "w.$1")}, execution_mode, access_epoch::text, login_revision::text, prior.prior_state,
         greatest(0, extract(epoch FROM (clock_timestamp()-prior.prior_updated_at))*1000)::float8 AS hello_ms`,
      [hashCloudV2Token(token), bootId, proof?.accessEpoch ?? null, proof?.loginRevision ?? null]);
      const ready = result.rows[0];
      if (ready?.state === "running" && ready.prior_state !== "running") await notifyCloudV2WorkerReady(tx, ready.id);
      return result;
    });
    const row = rows[0];
    return row ? { ...workspace(row), accessEpoch: row.access_epoch, loginRevision: row.login_revision, executionMode: row.execution_mode,
      ...(row.prior_state === "running" || row.state !== "running" ? {} : { helloTiming: { state: row.prior_state, durationMs: Math.round(row.hello_ms) } }) } : null;
  }

  async workerSession(token: string, bootId: string, handoff?: { id: string; sha256?: string }): Promise<CloudV2WorkerSession | null> {
    const { rows } = handoff ? await withSystemTx(this.pool, tx => tx.query<Row & { execution_mode: "legacy" | "prepared" | "active"; execution_transition_id: string | null; recovery_attempt_id: string | null; access_epoch: string; login_revision: string }>(
      `SELECT ${COLUMNS}, execution_mode, execution_transition_id, recovery_attempt_id, access_epoch::text, login_revision::text FROM cloud_v2_workspaces w
       WHERE worker_token_hash=$1 AND ${RUNTIME_HANDOFF_SESSION}
       AND state NOT IN ('deleting','deleted') AND ${LIVE_ACCESS}`,
      [hashCloudV2Token(token), bootId, handoff.id, handoff.sha256 ?? null]))
      : await withSystemStatement<Row & { execution_mode: "legacy" | "prepared" | "active"; execution_transition_id: string | null; recovery_attempt_id: string | null; access_epoch: string; login_revision: string }>(this.pool,
        sql`SELECT ${WORKSPACE_COLUMNS_SQL}, execution_mode, execution_transition_id, recovery_attempt_id, access_epoch::text, login_revision::text FROM cloud_v2_workspaces w
          WHERE worker_token_hash=decode(${SqlFragment.text(hashCloudV2Token(token).toString("hex"), /^[0-9a-f]{64}$/)}, 'hex')
            AND worker_boot_id=${SqlFragment.uuid(bootId.toLowerCase())}
            AND state NOT IN ('deleting','deleted') AND ${CLOUD_V2_LIVE_ACCESS_SQL}`);
    const row = rows[0];
    return row ? { ...workspace(row), accessEpoch: row.access_epoch, loginRevision: row.login_revision, executionMode: row.execution_mode,
      ...(row.recovery_attempt_id ? { recoveryAttemptId: row.recovery_attempt_id } : {}),
      ...(row.execution_transition_id ? { executionTransitionId: row.execution_transition_id } : {}) } : null;
  }

  async reportWorkerSetup(token: string, bootId: string, value: CloudV2SetupStatus,
    proof: { accessEpoch: string; handoff?: string }): Promise<void> {
    await withSystemTx(this.pool, async tx => {
      const hash = hashCloudV2Token(token);
      await tx.query("SELECT id FROM cloud_v2_workspaces WHERE worker_token_hash=$1 FOR UPDATE", [hash]);
      // Recheck authority after a lock wait, including a private adoption boot.
      const { rows } = await tx.query<{ id: string; setup_status: CloudV2SetupStatus | null }>(
        `SELECT id, setup_status FROM cloud_v2_workspaces w WHERE worker_token_hash=$1
          AND (CASE WHEN $3::uuid IS NULL THEN worker_boot_id=$2 ELSE ${RUNTIME_HANDOFF_SESSION} END)
          AND access_epoch=$5::bigint AND state IN ('creating','starting','running','stopping') AND ${LIVE_ACCESS}`,
        [hash, bootId, proof.handoff ?? null, null, proof.accessEpoch]);
      const row = rows[0];
      if (!row) throw new HttpError(401, "worker_boot_changed", "Worker authorization changed");
      const previous = row.setup_status;
      if (previous && (value.startedAt < previous.startedAt ||
          (value.startedAt === previous.startedAt && previous.state !== "running"))) return;
      // Lifecycle deadlines and idle stop use updated_at; reports are not activity.
      await tx.query("UPDATE cloud_v2_workspaces SET setup_status=$2 WHERE id=$1 AND setup_status IS DISTINCT FROM $2::jsonb", [row.id, JSON.stringify(value)]);
    });
  }

  async relayActivity(binding: CloudV2WorkerBinding, idle: boolean): Promise<(CloudV2WorkerSession & { promptsPending: boolean }) | null> {
    type ActivityRow = Row & { execution_mode: "legacy" | "prepared" | "active"; access_epoch: string; login_revision: string; prompts_pending: boolean };
    const { rows } = idle ? await withSystemStatement<ActivityRow>(this.pool, sql`
      SELECT ${WORKSPACE_COLUMNS_SQL}, execution_mode, access_epoch::text, login_revision::text, ${PENDING_WORKER_PROMPTS_SQL} AS prompts_pending
      FROM cloud_v2_workspaces w WHERE w.id=${SqlFragment.uuid(binding.workspaceId)}
        AND worker_boot_id=${SqlFragment.uuid(binding.bootId)}
        AND access_epoch=${SqlFragment.text(binding.accessEpoch, /^(0|[1-9][0-9]{0,18})$/)}::bigint
        AND worker_token_hash=decode(${SqlFragment.text(binding.workerTokenHash, /^[0-9a-f]{64}$/)},'hex')
        AND state NOT IN ('deleting','deleted') AND ${CLOUD_V2_LIVE_ACCESS_SQL}`)
      : await withSystemTx(this.pool, async tx => {
        // Membership and boot are read in a fresh statement after the row lock.
        await tx.query("SELECT id FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE", [binding.workspaceId]);
        return tx.query<ActivityRow>(`UPDATE cloud_v2_workspaces w SET active_at=CASE
          WHEN state='running' AND coalesce(active_at,'-infinity')<clock_timestamp()-interval '30 seconds'
          THEN clock_timestamp() ELSE active_at END
          WHERE id=$1 AND worker_boot_id=$2 AND access_epoch=$3::bigint AND worker_token_hash=decode($4,'hex')
            AND state NOT IN ('deleting','deleted') AND ${LIVE_ACCESS}
          RETURNING ${COLUMNS}, execution_mode, access_epoch::text, login_revision::text, ${PENDING_WORKER_PROMPTS_SQL.text} AS prompts_pending`,
        [binding.workspaceId, binding.bootId, binding.accessEpoch, binding.workerTokenHash]);
      });
    const row = rows[0];
    return row ? { ...workspace(row), executionMode: row.execution_mode, accessEpoch: row.access_epoch, loginRevision: row.login_revision, promptsPending: row.prompts_pending } : null;
  }

  /** Hello precedes checkout. Only that same live boot can fail its admission;
   * a lost reply is replayable without changing the first failure or its time. */
  async failWorkerCheckout(token: string, bootId: string): Promise<boolean> {
    return withSystemTx(this.pool, async tx => {
      const proof = [hashCloudV2Token(token), bootId];
      const changed = await tx.query(
        `UPDATE cloud_v2_workspaces w SET state='failed', error_code='cloud_source_checkout_failed',
           access_epoch=access_epoch+1, worker_route_url=NULL, worker_port_token=NULL,
           attempts=0, next_attempt_at=NULL, updated_at=clock_timestamp()
         WHERE worker_token_hash=$1 AND worker_boot_id=$2 AND state IN ('creating','starting','running') AND ${LIVE_ACCESS}`, proof);
      if (changed.rowCount) return true;
      const previous = await tx.query(
        `SELECT 1 FROM cloud_v2_workspaces w WHERE worker_token_hash=$1 AND worker_boot_id=$2
         AND state='failed' AND error_code='cloud_source_checkout_failed' AND ${LIVE_ACCESS}`, proof);
      return Boolean(previous.rowCount);
    });
  }

  /** Sequence and rows commit together. A retry after a lost HTTP response is
   * a no-op, while a gap or a conflicting reuse cannot overwrite newer rows. */
  async writeWorkerHistory(token: string, bootId: string, sequence: number, input: HistoryInput, historyDigests = false): Promise<void> {
    const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    await withSystemTx(this.pool, async tx => {
      // Invalidation may preserve only this boot's immediately preceding
      // replacement. Other writers clear it without knowing this protocol.
      const { rows } = await tx.query<{ id: string; worker_boot_id: string | null; worker_history_sequence: string; worker_history_digest: string | null; history_replacement: boolean }>(
        `SELECT id, worker_boot_id, worker_history_sequence::text, worker_history_digest,
           EXISTS (SELECT 1 FROM cloud_v2_chats h WHERE h.workspace_id=w.id AND h.chat_id=$2
             AND h.history_replacement_boot_id=$3 AND h.history_replacement_sequence=$4::bigint-1) AS history_replacement,
           set_config('app.cloud_history_workspace',CASE WHEN $5::boolean THEN w.id::text ELSE '' END,true),
           set_config('app.cloud_history_chat',coalesce($2::text,''),true),
           set_config('app.cloud_history_boot',$3::uuid::text,true),
           set_config('app.cloud_history_previous',($4::bigint-1)::text,true),
           set_config('app.cloud_history_state',CASE WHEN $6::boolean THEN 'on' ELSE '' END,true)
         FROM cloud_v2_workspaces w
         WHERE worker_token_hash=$1 AND state IN ('running','stopping') AND ${LIVE_ACCESS} FOR UPDATE`,
        [hashCloudV2Token(token), input.messages?.chatId ?? null, bootId, sequence, historyDigests,
          !!input.messages?.historyState && !input.chats?.some(chat => chat.id === input.messages?.chatId)]);
      const row = rows[0];
      if (!row || row.worker_boot_id !== bootId) throw new HttpError(401, "worker_boot_changed", "Worker authorization changed");
      const previous = Number(row.worker_history_sequence);
      if (sequence === previous && digest !== row.worker_history_digest) throw new HttpError(409, "history_sequence_conflict", "History request was already used");
      if (sequence <= previous) return;
      if (sequence !== previous + 1) throw new HttpError(409, "history_sequence_gap", "History sequence is not contiguous");
      await this.mirrorHistory(tx, row.id, input);
      const batch = input.messages;
      const prepare = historyDigests && !batch ? input.chats?.filter(chat =>
        !input.chatDeletions?.includes(chat.id) && !input.chatEditAcks?.some(ack => ack.chatId === chat.id)).map(chat => chat.id) : undefined;
      if (prepare?.length) await tx.query(`UPDATE cloud_v2_chats h SET history_digest=NULL,
          history_replacement_boot_id=$3,history_replacement_sequence=$4,history_replacement_started=false
        WHERE workspace_id=$1 AND chat_id=ANY($2::text[]) AND deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM cloud_v2_chat_edits e WHERE e.workspace_id=h.workspace_id AND e.chat_id=h.chat_id
            AND e.version>e.acknowledged_version)`, [row.id, prepare, bootId, sequence]);
      if (historyDigests && batch && (batch.replace || batch.digest || row.history_replacement) && !input.chatEditAcks?.some(ack => ack.chatId === batch.chatId)) {
        // The trigger's marker is checked after all content writes. A cut,
        // retention or edit between frames cannot be covered by a later stamp.
        await tx.query(`UPDATE cloud_v2_chats h SET history_digest=$3,
            history_replacement_boot_id=CASE WHEN $3::text IS NULL THEN $4::uuid ELSE NULL END,
            history_replacement_sequence=CASE WHEN $3::text IS NULL THEN $5::bigint ELSE NULL END,
            history_replacement_started=CASE WHEN $3::text IS NULL THEN true ELSE NULL END
          WHERE workspace_id=$1 AND chat_id=$2 AND deleted_at IS NULL
            AND history_replacement_boot_id=$4 AND history_replacement_sequence=$5::bigint-1
            AND history_replacement_started=NOT $6::boolean
            AND NOT EXISTS (SELECT 1 FROM cloud_v2_chat_edits e WHERE e.workspace_id=h.workspace_id AND e.chat_id=h.chat_id
              AND e.version>e.acknowledged_version)`,
        [row.id, batch.chatId, batch.digest ?? null, bootId, sequence, batch.replace === true]);
      }
      await tx.query("UPDATE cloud_v2_workspaces SET worker_history_sequence=$2, worker_history_digest=$3 WHERE id=$1", [row.id, sequence, digest]);
    });
  }

  async workerHistoryDigests(token: string, bootId: string, includeDeleted = false) {
    const { rows } = await withSystemStatement<{ chat_id: string | null; history_digest: string | null; deleted: boolean | null }>(this.pool, sql`
      SELECT h.chat_id,h.history_digest,h.deleted FROM cloud_v2_workspaces w
      LEFT JOIN LATERAL (
        SELECT c.chat_id,c.deleted_at IS NOT NULL AS deleted,CASE WHEN c.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM cloud_v2_chat_edits e
          WHERE e.workspace_id=c.workspace_id AND e.chat_id=c.chat_id AND e.version>e.acknowledged_version)
          THEN c.history_digest ELSE NULL END AS history_digest
        FROM cloud_v2_chats c WHERE c.workspace_id=w.id ORDER BY c.chat_id LIMIT 4097
      ) h ON true
      WHERE w.worker_token_hash=decode(${SqlFragment.text(hashCloudV2Token(token).toString("hex"), /^[0-9a-f]{64}$/)},'hex')
        AND w.worker_boot_id=${SqlFragment.uuid(bootId)} AND w.state IN ('running','stopping') AND ${CLOUD_V2_LIVE_ACCESS_SQL}`);
    if (!rows.length) return null;
    const mirrored = rows.filter(row => row.chat_id !== null);
    const reply = CloudV2HistoryDigestsReplySchema.safeParse({
      chats: mirrored.filter(row => !includeDeleted || !row.deleted).map(row => ({ chatId: row.chat_id, digest: row.history_digest })),
      ...(includeDeleted ? { deleted: mirrored.filter(row => row.deleted).map(row => row.chat_id) } : {}),
    });
    if (!reply.success) throw new HttpError(503, "history_digest_limit", "History digests are unavailable");
    return reply.data;
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
         AND NOT EXISTS (SELECT 1 FROM local_command_requests r WHERE r.workspace_id=w.id AND r.phase IN ('pending','claimed'))
         AND NOT EXISTS (SELECT 1 FROM cloud_v2_execution_contexts e WHERE e.workspace_id=w.id AND w.execution_mode='active'
           AND e.state='active' AND e.expires_at>clock_timestamp() AND e.worker_boot_id=w.worker_boot_id
           AND e.access_epoch=w.access_epoch AND e.stop_generation=w.stop_generation
           AND (e.kind='bootstrap' OR e.kind='client' AND (e.operation IS NOT NULL
             OR e.client_id IS NOT NULL AND e.parent_context_id IS NULL AND e.sync_device_id IS NULL
               AND e.client_token_expires_at>clock_timestamp() AND e.worker_token_hash=w.worker_token_hash)))
       ORDER BY coalesce(active_at, updated_at) LIMIT $2`,
      [before, limit],
    ));
    return rows.map(workspace);
  }

  /** Recheck at the mutation, so a send between idle discovery and Stop wins. */
  async stopIdle(id: string, before: Date): Promise<void> {
    await withSystemTx(this.pool, async tx => {
      await tx.query("SELECT id FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE", [id]);
      await tx.query(`UPDATE cloud_v2_workspaces w SET state='stopping',attempts=0,stop_generation=stop_generation+1,
      next_attempt_at=NULL,updated_at=clock_timestamp()
      WHERE id=$1 AND state='running' AND coalesce(active_at,updated_at)<$2
        AND NOT EXISTS (SELECT 1 FROM cloud_v2_prompt_outbox p WHERE p.workspace_id=w.id
          AND p.state IN ('queued','inboxed','dispatching','accepted') AND p.access_epoch=w.access_epoch)
        AND NOT EXISTS (SELECT 1 FROM local_command_requests r WHERE r.workspace_id=w.id AND r.phase IN ('pending','claimed'))
        AND NOT EXISTS (SELECT 1 FROM cloud_v2_execution_contexts e WHERE e.workspace_id=w.id AND w.execution_mode='active'
          AND e.state='active' AND e.expires_at>clock_timestamp() AND e.worker_boot_id=w.worker_boot_id
          AND e.access_epoch=w.access_epoch AND e.stop_generation=w.stop_generation
          AND (e.kind='bootstrap' OR e.kind='client' AND (e.operation IS NOT NULL
            OR e.client_id IS NOT NULL AND e.parent_context_id IS NULL AND e.sync_device_id IS NULL
              AND e.client_token_expires_at>clock_timestamp() AND e.worker_token_hash=w.worker_token_hash)))`, [id, before]);
    });
  }

  /** A one-use app connect ticket, or a worker model-proxy token. */
  async issueToken(input: { workspaceId: string; kind: "connect" | "proxy"; userId: string | null; ttlMs: number; authority?: AuthedUser; wake?: boolean }) {
    const issued = newCloudV2Token(input.kind);
    const expiresAt = new Date(Date.now() + input.ttlMs);
    await withSystemTx(this.pool, async tx => {
      // Serialize issuance with workspace revocation and recheck the HTTP
      // authority. A concurrent session sign-out is also checked at consumption.
      const allowed = await tx.query(`SELECT id FROM cloud_v2_workspaces w
        WHERE id = $1 AND execution_mode<>'active' AND state NOT IN ('deleting','deleted') AND ${LIVE_ACCESS}
          AND ($2::text = 'proxy' OR creator_user_id = $3) FOR UPDATE`,
        [input.workspaceId, input.kind, input.userId]);
      if (!allowed.rowCount) throw notFound();
      await assertNoExecutionTransition(tx, input.workspaceId);
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
    const { rows } = await withSystemTx(this.pool, tx => tx.query<{ user_id: string; access_epoch: string; wake_on_connect: boolean; provider_session_id: string | null; execution_authority: ExecutionConnectAuthority | null }>(
      `UPDATE cloud_v2_tokens t SET used_at = clock_timestamp()
       FROM cloud_v2_workspaces w
       WHERE t.token_hash = $1 AND t.kind = 'connect' AND t.workspace_id = $2 AND t.used_at IS NULL
         AND t.expires_at > clock_timestamp() AND w.id = t.workspace_id AND ((w.execution_mode<>'active' AND w.creator_user_id=t.user_id AND t.execution_authority IS NULL)
           OR (w.execution_mode='active' AND t.execution_authority IS NOT NULL AND w.stop_generation=(t.execution_authority->>'stopGeneration')::bigint
             AND (t.execution_authority->>'tokenEnd')::double precision>extract(epoch FROM clock_timestamp())*1000))
         AND w.state NOT IN ('deleting','deleted') AND ${LIVE_ACCESS}
         AND (t.provider_session_id IS NULL OR EXISTS (SELECT 1 FROM auth_sessions s
           WHERE s.provider_session_id = t.provider_session_id AND ${LIVE_SESSION.replace("s.user_id = w.creator_user_id", "s.user_id = t.user_id")}))
       RETURNING t.user_id, w.access_epoch::text, t.wake_on_connect, t.provider_session_id, t.execution_authority`,
      [hashCloudV2Token(token), workspaceId],
    ));
    return rows[0] ? { userId: rows[0].user_id, accessEpoch: rows[0].access_epoch, wake: rows[0].wake_on_connect, sessionId: rows[0].provider_session_id, ...(rows[0].execution_authority ? { execution: rows[0].execution_authority } : {}) } : null;
  }

  async verifyProxyToken(token: string): Promise<(CloudV2Workspace & { accessEpoch?: string; loginRevision?: string }) | null> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<Row & { access_epoch: string; login_revision: string }>(
      `SELECT ${COLUMNS.replace(/\b(\w+)\b/g, "w.$1")},w.access_epoch::text,w.login_revision::text FROM cloud_v2_tokens t JOIN cloud_v2_workspaces w ON w.id = t.workspace_id
       WHERE t.token_hash = $1 AND t.kind = 'proxy' AND t.expires_at > clock_timestamp() AND w.state = 'running' AND w.execution_mode<>'active' AND ${LIVE_ACCESS}`,
      [hashCloudV2Token(token)],
    ));
    return rows[0] ? { ...workspace(rows[0]), accessEpoch: rows[0].access_epoch, loginRevision: rows[0].login_revision } : null;
  }

  /** Milliseconds until a lifecycle row next becomes claimable, by the
   * database clock that claims use; null when no row is in a lifecycle state. */
  async nextLifecycleDue(): Promise<number | null> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<{ due_in_ms: number | null }>(
      `SELECT (extract(epoch FROM min(due) - clock_timestamp()) * 1000)::float8 AS due_in_ms FROM (
        SELECT coalesce(next_attempt_at,clock_timestamp()) AS due FROM cloud_v2_workspaces WHERE state IN ('creating','starting','stopping','deleting')
        UNION ALL SELECT next_attempt_at FROM cloud_v2_execution_activations WHERE phase IN ('draining','authorizing','booting')) pending`));
    const due = rows[0]?.due_in_ms ?? null;
    return due === null ? null : Math.max(0, due);
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

  /** A create reply can outlive deletion. Keep its exact VM for cleanup,
   * without replacing a later restore or an already assigned VM. */
  async recordInitialSandbox(id: string, generation: string, sandboxId: string, renewedAt: Date): Promise<(CloudV2LifecycleWorkspace & { attempts: number }) | null> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<LifecycleRow & { attempts: number }>(
      `UPDATE cloud_v2_workspaces SET boat_sandbox_id=$3, lease_renewed_at=greatest(lease_renewed_at,$4::timestamptz),
         state=CASE WHEN state='deleted' THEN 'deleting' ELSE state END,
         attempts=CASE WHEN state IN ('creating','deleted') OR (state='deleting' AND boat_sandbox_id IS NULL) THEN 0 ELSE attempts END,
         next_attempt_at=CASE WHEN state IN ('creating','deleted') OR (state='deleting' AND boat_sandbox_id IS NULL) THEN clock_timestamp() ELSE next_attempt_at END,
         updated_at=CASE WHEN state='deleted' THEN clock_timestamp() ELSE updated_at END
       WHERE id=$1 AND stop_generation=$2::bigint AND NOT restore_pending AND restore_attempt IS NULL
         AND (boat_sandbox_id IS NULL OR boat_sandbox_id=$3)
       RETURNING ${LIFECYCLE_COLUMNS}, attempts`, [id, generation, sandboxId, renewedAt]));
    return rows[0] ? { ...lifecycleWorkspace(rows[0]), attempts: rows[0].attempts } : null;
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

  /** Offered during initial configuration and retries until a checkpoint
   * confirms that the workspace branch already exists. */
  async baseCommit(id: string, transaction?: Tx): Promise<string | null> {
    const query = (tx: Tx) => tx.query<{ base_commit: string | null }>(
      `SELECT base_commit FROM cloud_v2_workspaces WHERE id=$1 AND state IN ('creating','starting','running') AND checkpoint_object IS NULL`, [id]);
    const { rows } = await (transaction ? query(transaction) : withSystemTx(this.pool, query));
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
      const { rows } = await tx.query<{ org_id: string; execution_transition_id: string | null; computer_build_id: string | null; restore_create: unknown; repository: string; source_repositories: string[] }>(
        `SELECT org_id,execution_transition_id,computer_build_id,restore_create,repository,source_repositories FROM cloud_v2_workspaces WHERE id=$1 AND state='starting' AND boat_sandbox_id IS NOT DISTINCT FROM $2::text
           AND checkpoint_object IS NOT NULL FOR UPDATE`, [id, lostSandboxId]);
      if (!rows[0]) return null;
      if (rows[0].execution_transition_id) {
        await failExecutionActivation(tx, id, "activation_boot_failed");
        return null;
      }
      // As at creation: activation and cleanup wait for this pin.
      const active = await tx.query<{ id: string; snapshot_name: string; source_policy_version: number; recipe: unknown }>(
        `SELECT b.id, c.snapshot_name, b.source_policy_version, b.recipe FROM cloud_v2_computers c
         JOIN cloud_v2_computer_builds b ON b.id=c.active_build_id AND b.org_id=c.org_id
         WHERE c.org_id=$1 AND c.snapshot_name IS NOT NULL AND b.state='succeeded' AND b.source_policy_version IN (2,3) AND b.snapshot_id=c.snapshot_name
           AND b.snapshot_deleted_at IS NULL AND b.cleanup_requested_at IS NULL
         FOR SHARE OF c,b`, [rows[0].org_id]);
      if (!active.rows[0]) return "no_computer";
      const setup = originalSetupBuild(rows[0].computer_build_id, rows[0].restore_create);
      const image = cloudV2WorkspaceImage({ policy: active.rows[0].source_policy_version, snapshot: active.rows[0].snapshot_name,
        recipe: active.rows[0].recipe, scope: rows[0].source_repositories ?? [], repository: rows[0].repository });
      const recorded = await tx.query<{ restore_attempt: string; restore_create: CloudV2RestoreCreate }>(
        `UPDATE cloud_v2_workspaces SET restore_pending=true, restore_attempt=$3, boat_sandbox_id=NULL, computer_build_id=$2, execution_restore_claimed_at=NULL,
           restore_create=jsonb_build_object('from',$4::text,'name',$5::text,'env',$6::jsonb,'requestedAt',clock_timestamp(),'prune',$8::jsonb) || $7::jsonb,
           worker_route_url=NULL, worker_port_token=NULL, worker_token_hash=NULL, worker_boot_id=NULL
         WHERE id=$1 RETURNING restore_attempt, restore_create`,
        [id, active.rows[0].id, request.attempt, image.from, request.name, JSON.stringify(request.env), JSON.stringify(setup), JSON.stringify(image.prune)]);
      return { attempt: recorded.rows[0]!.restore_attempt, create: restoreCreate(recorded.rows[0]!.restore_create)! };
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
  async defer(id: string, state: CloudV2WorkspaceState, ms: number, patch: { boatSandboxId?: string; expectedSandboxId?: string | null; failure?: boolean; stopGeneration?: string } = {}): Promise<void> {
    await withSystemTx(this.pool, tx => tx.query(
      `UPDATE cloud_v2_workspaces SET next_attempt_at = clock_timestamp() + make_interval(secs => $3::double precision / 1000),
         boat_sandbox_id = coalesce($4, boat_sandbox_id), attempts = CASE WHEN $5::boolean THEN attempts ELSE 0 END
       WHERE id = $1 AND state = $2 AND ($6::bigint IS NULL OR stop_generation = $6::bigint)
         AND (NOT $7::boolean OR boat_sandbox_id IS NOT DISTINCT FROM $8::text)`,
      [id, state, ms, patch.boatSandboxId ?? null, patch.failure === true, patch.stopGeneration ?? null,
        patch.expectedSandboxId !== undefined, patch.expectedSandboxId ?? null],
    ));
  }

  /** Replaces the worker credential; the plaintext goes only to the VM. */
  async rotateWorkerToken(id: string): Promise<string>;
  async rotateWorkerToken(id: string, delivery: { state: CloudV2WorkspaceState; sandboxId: string; stopGeneration: string }): Promise<string | null>;
  async rotateWorkerToken(id: string, delivery?: { state: CloudV2WorkspaceState; sandboxId: string; stopGeneration: string }): Promise<string | null> {
    const worker = newCloudV2Token("worker");
    const changed = await withSystemTx(this.pool, tx => tx.query(
      `UPDATE cloud_v2_workspaces w SET worker_token_hash = $2, worker_boot_id = NULL
       WHERE id = $1 AND state IN ('creating','starting','running') AND ${LIVE_ACCESS}
         AND ($3::text IS NULL OR (state=$3 AND state IN ('creating','starting') AND boat_sandbox_id=$4
           AND stop_generation=$5::bigint AND worker_boot_id IS NULL))`,
      [id, worker.hash, delivery?.state ?? null, delivery?.sandboxId ?? null, delivery?.stopGeneration ?? null],
    ));
    if (!changed.rowCount) { if (delivery) return null; throw notFound(); }
    return worker.token;
  }

  async loginRevision(id: string): Promise<string | null> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<{ revision: string }>(
      "SELECT login_revision::text AS revision FROM cloud_v2_workspaces WHERE id=$1 AND state<>'deleted'", [id]));
    return rows[0]?.revision ?? null;
  }

  /** The image a new or replacement VM for this workspace boots, by its
   * pinned build (see cloudV2WorkspaceImage); null when that build is gone. */
  async workspaceImage(workspaceId: string): Promise<CloudV2WorkspaceImage | null> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<{ org_id: string; computer_build_id: string | null; repository: string;
      source_repositories: string[] | null; snapshot_id: string | null; source_policy_version: number | null; recipe: unknown }>(
      `SELECT w.org_id, w.computer_build_id, w.repository, w.source_repositories, b.snapshot_id, b.source_policy_version, b.recipe
       FROM cloud_v2_workspaces w LEFT JOIN cloud_v2_computer_builds b ON b.id=w.computer_build_id AND b.org_id=w.org_id
         AND b.state='succeeded' AND b.source_policy_version IN (2,3) AND b.snapshot_deleted_at IS NULL AND b.cleanup_requested_at IS NULL
       WHERE w.id=$1`, [workspaceId]));
    const row = rows[0];
    if (!row) return null;
    if (!row.computer_build_id) {
      const legacy = await this.computerSnapshot(row.org_id, null);
      return legacy ? { from: legacy, prune: [], checkout: false } : null;
    }
    if (!row.snapshot_id || row.source_policy_version === null) return null;
    return cloudV2WorkspaceImage({ policy: row.source_policy_version, snapshot: row.snapshot_id, recipe: row.recipe,
      scope: row.source_repositories ?? [], repository: row.repository });
  }

  async computerSnapshot(organizationId: string, buildId: string | null = null): Promise<string | null> {
    if (buildId) {
      const { rows } = await withSystemTx(this.pool, tx => tx.query<{ snapshot_id: string | null }>(
        `SELECT snapshot_id FROM cloud_v2_computer_builds WHERE id=$1 AND org_id=$2 AND state='succeeded' AND source_policy_version IN (2,3)
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
       WHERE computer.org_id = $1 AND computer.snapshot_name IS NOT NULL AND build.state = 'succeeded' AND build.source_policy_version IN (2,3)`,
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
    await withSystemTx(this.pool, async tx => {
      await tx.query("SELECT id FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE", [workspaceId]);
      await this.mirrorHistory(tx, workspaceId, input);
    });
  }

  private async mirrorHistory(tx: Tx, workspaceId: string, input: HistoryInput): Promise<void> {
      const ids = new Set(input.chats?.map(chat => chat.id));
      if (input.chatEditAcks?.some(ack => !ids.has(ack.chatId)))
        throw new HttpError(400, "invalid_request", "A chat edit acknowledgement requires its row in the same history batch");
      const chats = await overlayCloudChatEdits(tx, workspaceId, input.chats ?? []);
      for (const chat of chats) {
        await tx.query(
          `INSERT INTO cloud_v2_chats (workspace_id, chat_id, row) VALUES ($1, $2, $3::jsonb - 'historyState')
           ON CONFLICT (workspace_id, chat_id) DO UPDATE SET row = EXCLUDED.row ||
             CASE WHEN cloud_v2_chats.row ? 'historyState' THEN jsonb_build_object('historyState', cloud_v2_chats.row->'historyState') ELSE '{}'::jsonb END,
             deleted_at = NULL, updated_at = clock_timestamp()`,
          [workspaceId, chat.id, JSON.stringify(chat)],
        );
      }
      // An Untitled workspace takes the first name one of its chats receives,
      // and keeps it. The version moves so clients replace their document.
      const title = firstWorkspaceTitle(chats);
      if (title) await tx.query(
        `UPDATE cloud_v2_workspaces SET title = $2, updated_at = clock_timestamp() WHERE id = $1 AND title IS NULL`,
        [workspaceId, title],
      );
      for (const chatId of input.chatDeletions ?? []) {
        await tx.query("DELETE FROM cloud_v2_chat_edits WHERE workspace_id=$1 AND chat_id=$2", [workspaceId, chatId]);
        await tx.query(`DELETE FROM cloud_v2_messages WHERE workspace_id = $1 AND chat_id = $2`, [workspaceId, chatId]);
        await tx.query(
          `INSERT INTO cloud_v2_chats (workspace_id, chat_id, row, deleted_at) VALUES ($1, $2, jsonb_build_object('id', $2::text), clock_timestamp())
           ON CONFLICT (workspace_id, chat_id) DO UPDATE SET deleted_at = clock_timestamp(), updated_at = clock_timestamp()`,
          [workspaceId, chatId],
        );
      }
      const batch = input.messages;
      if (batch?.replace) await tx.query(`DELETE FROM cloud_v2_messages WHERE workspace_id=$1 AND chat_id=$2`, [workspaceId, batch.chatId]);
      if (batch?.historyState) await tx.query(
        `INSERT INTO cloud_v2_chats (workspace_id, chat_id, row) VALUES ($1, $2, jsonb_build_object('id', $2::text, 'historyState', $3::jsonb))
         ON CONFLICT (workspace_id, chat_id) DO UPDATE SET row = jsonb_set(cloud_v2_chats.row, '{historyState}', $3::jsonb), updated_at = clock_timestamp()`,
        [workspaceId, batch.chatId, JSON.stringify(batch.historyState)],
      );
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
      await acknowledgeCloudChatEdits(tx, workspaceId, input.chatEditAcks ?? []);
  }

  async listChats(workspaceId: string, includeActor = false, includeCache = false): Promise<{ chats: unknown[]; chatDeletions: string[] }> {
    const query = includeActor
      ? `SELECT h.chat_id,h.deleted_at,h.updated_at,(h.row-'actingUser') || CASE WHEN w.execution_mode='active' THEN
          jsonb_build_object('actingUser',CASE WHEN c.state='active' AND c.expires_at>clock_timestamp() THEN
            jsonb_build_object('userId',c.user_id,'generation',c.generation::text,'userMessageId',c.user_message_id) ELSE NULL END)
          ELSE '{}'::jsonb END AS row
        FROM cloud_v2_chats h JOIN cloud_v2_workspaces w ON w.id=h.workspace_id
        LEFT JOIN cloud_v2_prompt_chats p ON p.workspace_id=h.workspace_id AND p.chat_id=h.chat_id
        LEFT JOIN cloud_v2_execution_contexts c ON c.workspace_id=h.workspace_id AND c.id=p.active_context_id
        WHERE h.workspace_id=$1 ORDER BY h.updated_at DESC LIMIT 1000`
      : "SELECT chat_id,row-'actingUser' AS row,deleted_at,updated_at FROM cloud_v2_chats WHERE workspace_id=$1 ORDER BY updated_at DESC LIMIT 1000";
    const cached = `WITH chats AS (${query}) SELECT h.*,coalesce(s.revision,0)::text AS revision,
      coalesce(s.message_count,(SELECT count(*) FROM cloud_v2_messages m WHERE m.workspace_id=$1 AND m.chat_id=h.chat_id))::text AS message_count
      FROM chats h LEFT JOIN LATERAL (SELECT c.revision,c.message_count FROM cloud_v2_history_cache c
        WHERE c.workspace_id=$1 AND c.chat_id=h.chat_id LIMIT 1) s ON true ORDER BY h.updated_at DESC`;
    const { rows } = await withSystemTx(this.pool, tx => tx.query<{ chat_id: string; row: unknown; deleted_at: Date | null; revision: string; message_count: string }>(
      includeCache ? cached : query, [workspaceId],
    ));
    return {
      chats: rows.filter(row => !row.deleted_at).map(row => includeCache ? { ...row.row as Record<string, unknown>,
        historyCache: { revision: cacheCounter(row.revision), messageCount: cacheCounter(row.message_count) } } : row.row),
      chatDeletions: rows.filter(row => row.deleted_at).map(row => row.chat_id),
    };
  }

  messageWindow(workspaceId: string, chatId: string, options: WindowOptions = {}): Promise<MessageWindow> {
    return withSystemTx(this.pool, tx => mirrorMessageWindow(tx, workspaceId, chatId, options), { consistentRead: true });
  }

  messageRange(workspaceId: string, chatId: string, fromIndex: number, toIndex: number) {
    return withSystemTx(this.pool, tx => mirrorMessageRange(tx, workspaceId, chatId, fromIndex, toIndex), { consistentRead: true });
  }

  messageSince(workspaceId: string, chatId: string, revision: number) {
    return withSystemTx(this.pool, tx => mirrorMessageDelta(tx, workspaceId, chatId, revision), { consistentRead: true });
  }

  messageSenders(workspaceId: string, chatId: string, userMessageIds: string[]) {
    return withSystemTx(this.pool, tx => mirrorMessageSenders(tx, workspaceId, chatId, userMessageIds));
  }

  searchMessages(workspaceId: string, options: SearchOptions) {
    const deadline = Date.now() + MESSAGE_SEARCH_DEADLINE_MS;
    return withSystemTx(this.pool, tx => mirrorMessageSearch(tx, workspaceId, options, deadline), { consistentRead: true });
  }

  /** Rows-only compatibility for internal callers; HTTP also returns turnOpening. */
  async windowMessages(workspaceId: string, chatId: string, limit: number): Promise<CloudV2MessageRow[]> {
    return (await this.messageWindow(workspaceId, chatId, { limit })).messages;
  }
}

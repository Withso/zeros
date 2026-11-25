import { cloudV2BoatSnapshotName } from "./resource-names.js";
import { executionIntentAuthority, type ExecutionAdmission, type ExecutionIntentAuthority } from "./execution/authority.js";
import { assertNoExecutionTransition, cancelExecutionActivation, clearStoppedExecutionTransition, confirmExecutionStop, failExecutionActivation, needsExecutionStopConfirmation } from "./execution/activation-state.js";
import { bindExecutionActivationBoot } from "./execution/activation.js";
import { CLOUD_RECOVERY_TURN_HOLD } from "./recovery-state.js";
import { assertExecutionCreationBoot, recordExecutionCreation } from "./execution/creation.js";
import type { RuntimeCapabilities } from "./runtime-capabilities.js";
import type { BackupProbe } from "./checkpoint.js";
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
import { CLOUD_V2_CREATOR_ON_HOLD, CLOUD_V2_CREATOR_ACCESS_SQL, CLOUD_V2_LIVE_ACCESS as LIVE_ACCESS, CLOUD_V2_LIVE_ACCESS_SQL, cloudV2ActorAccess, requireWorkspaceCreator, CLOUD_V2_PERSONAL_PRO_ENDED } from "./workspace-access.js";
import { memberOnHoldSql, organizationMemberOnHold } from "../organization-seats.js";
import { CloudV2PromptOutbox, type CloudApiPrompt } from "./prompt-outbox.js";
import { computerSourceReviewRequired, readComputerSourceTargets } from "./computer-provenance.js";
import { CloudSourceTargetSchema, type CloudSourceTarget } from "./source-authority.js";
import { pinCloudEnvironment, pinCloudRepositoryEnvironments, releaseCloudEnvironment } from "./environment-store.js";
import { originalSetupBuild } from "./setup-selection.js";
import { teamOwnershipRequired } from "./team-sharing/contract.js";
import type { ArchiveScrubMode, ArchiveScrubResult } from "./archive-scrub.js";

import { mirrorMessageSenders, mirrorMessageWindow, type MessageWindow, type WindowOptions } from "./history.js";
import { mirrorMessageSearch, type SearchOptions } from "./history-search.js";
import { cacheCounter, mirrorMessageDelta, mirrorMessageRange } from "./history-cache.js";
import { MESSAGE_SEARCH_DEADLINE_MS } from "./message-search.js";
import { consumeRuntimeCanary } from "./runtime-canary-store.js";
import type { RuntimeCanaryAdmission } from "./runtime-canary.js";
import { RUNTIME_HANDOFF_SESSION } from "./runtime-handoff-store.js";
import { notifyCloudV2WorkerBoot, notifyCloudV2WorkerReady } from "./worker-ready.js";
import type { CloudV2SetupStatus } from "./setup-status-contract.js";
import { insertWorkspaceSubmodules, type WorkspaceSubmoduleRow } from "./workspace-submodules.js";
import { cloudV2RecoverableFailure } from "./failure-retry.js";

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
  /** The project it is created from (ready copies on); a personal project's workspace is its member's alone. */
  projectId?: string;
  /** A project create: every repository of the project in position order, the
   * first equal to repository/branch/baseBranch, each with its folder and verified id. */
  repositories?: readonly CloudV2CreateRepository[];
  /** workspace-layout.ts: the first checkout under /home/user, and the project folder for several repositories. */
  checkoutFolder?: string;
  folder?: string;
  /** A project create with "fetch submodules" on: each repository's submodules as its creator could read them. */
  submodules?: readonly WorkspaceSubmoduleRow[];
};
export type CloudV2CreateRepository = { repository: string; repositoryId: string; folder: string; branch: string; baseBranch: string; baseCommit?: string | null };
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
  /** R2: fixed for this boot at its first hello. */
  authorityMode?: "message-authority-v1";
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
  /** Failed for a recoverable reason after it had run, with its machine or a backup left: recovery may start it
   * again (failure-retry.ts). Absent otherwise, so other documents are unchanged. */
  recoverable?: true;
  /** A personal project's workspace: its member's alone, never shared or reassigned. */
  privateOwnerUserId?: string;
  /** The project it was created from; none for workspaces made before projects. */
  projectId?: string;
  /** workspace-layout.ts: the first checkout under /home/user, and the project folder when it holds several repositories. */
  checkoutFolder?: string;
  folder?: string;
  /** Retention: a lost VM came back without the work of the stop at `stoppedAt`: nothing of it
   * (rebuilt from GitHub) or an earlier backup instead. Until dismissed or the next backup. */
  lostWork?: { restored: "none" | "earlier"; stoppedAt: string };
  /** C4B: submodules a restore could not put back, held on the machine until a later open can: each one's folder, why
   * (a closed reason) and since when. Absent when there are none. */
  unrestoredSubmodules?: { path: string; reason: CloudV2UnrestoredReason; since: string }[];
  /** Ready copies: created while its organization's base was being prepared, and waiting for it. */
  preparing?: "computer";
  /** Retention S3: exempt from automatic archive; never true while archived. The serializer always sends it from
   * this release; optional in the type so documents and fixtures built elsewhere stay valid. */
  keep?: boolean;
  /** Why it is archived; only while archivedAt is set. */
  archiveReason?: "manual" | "inactive" | "member_left";
  /** While archived and its machine is recorded: when Boat removes the machine. `estimate` unless Boat said so. */
  machineExpectedGoneAt?: { at: string; estimate: boolean };
  /** While archived with a backup, once retention applies: greatest(archive, retention's start) + 60 days. */
  backupRemovalAt?: string;
  /** While archived: what opening it now would bring back, by the server's best knowledge (cloudV2Restores). */
  restores?: "all" | "pushed";
};

/** What a checkpoint is compared by at the next stop: the fingerprint of what
 * it holds and the base commit whose objects it left out. */
export type CloudV2CheckpointReuse = { fingerprint: string; base: string | null };
/** The last confirmed checkpoint; the key is still sealed. `reuse` is present
 * only when it was recorded for this exact object. */
export type CloudV2Checkpoint = { object: string; key: unknown; sha256: string; bytes: number; savedAt: string; stopGeneration: string | null;
  reuse?: CloudV2CheckpointReuse;
  /** C4B: it left out a planned submodule folder holding a person's own clone, so it does not hold everything. */
  partial?: boolean };
/** A fork of a stopped VM that a checkpoint retry requested, recorded before
 * the request. `sandboxId` is null until Boat's reply arrives. */
export type CloudV2CheckpointFork = { attempt: string; name: string; source: string; requestedAt: string; sandboxId: string | null };
/** Which stop a checkpoint write belongs to: the one still stopping the VM,
 * or a retry of the latest stop while that VM is stopped or woken again. */
export type CloudV2CheckpointScope = "stop" | "retry";
export type CloudV2CheckpointRetry = { generation: string; attempts: number; stoppedAt: string; exhaustedAt: string | null };

/** Internal lifecycle metadata is never included in public workspace documents. */
/** Why a restore could not put a submodule back. */
export type CloudV2UnrestoredReason = "repository_unavailable" | "commits_unavailable" | "archive_corrupt" | "restore_failed";
/** One submodule a restore could not put back, as recorded: its place in the plan, its folder, why and since when. */
export type CloudV2UnrestoredSubmodule = { position: number; path: string; folder: string; reason: CloudV2UnrestoredReason; since: string };
const UNRESTORED_REASONS: readonly CloudV2UnrestoredReason[] = ["repository_unavailable", "commits_unavailable", "archive_corrupt", "restore_failed"];
/** The record as stored, validated: anything malformed is dropped, never thrown. */
function unrestoredSubmodules(value: unknown): CloudV2UnrestoredSubmodule[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(entry => {
    const e = entry as Partial<Record<keyof CloudV2UnrestoredSubmodule, unknown>> | null;
    return e && Number.isInteger(e.position) && typeof e.path === "string" && typeof e.folder === "string" && e.folder.startsWith("/home/user/")
      && UNRESTORED_REASONS.includes(e.reason as CloudV2UnrestoredReason) && typeof e.since === "string" && Number.isFinite(Date.parse(e.since))
      ? [{ position: e.position as number, path: e.path, folder: e.folder, reason: e.reason as CloudV2UnrestoredReason, since: new Date(e.since).toISOString() }] : [];
  });
}

export type CloudV2LifecycleWorkspace = CloudV2Workspace & {
  /** C4B: the recorded unrestored submodules, with their places: a later start puts their held parts back. */
  submodulesUnrestored?: CloudV2UnrestoredSubmodule[];
  /** C4: the submodules it fetched (its 'fetch' rows); absent when none, so its checkouts need no query for them. */
  submoduleFetches?: number;
  /** cloudV2CheckpointLossy: this stop's backup may lack its last writes; a restore from it records lost work. */
  checkpointLossy?: true;
  /** Ready copies: when the base its create waited for went live; its boot deadline counts from then. */
  baseReadyAt?: string;
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
  /** Retention: what the probe of the latest stop reported; absent when it ran for no stop of this generation. */
  stopProbe?: BackupProbe;
  /** Retention: the latest stop could not verify the worker service off, so the machine may resume
   * with it running or enabled; a wake must switch it off before treating the machine as safe. */
  workerOffUnverified?: true;
  /** Retention S2: a maintenance wake in flight. A user wake that finds `stopping` waits for it. */
  maintenance?: { attempt: string; phase: "waking" | "adopting" | "stopping"; startedAt: string };
  /** Retention S3: this stop's machine was scrubbed at its archived wake; 'backup' means an open restores the
   * checkout's environment files from the backup before the worker starts. */
  archiveScrub?: "backup" | "clean" | "partial";
};
/** `from` is null for Boat's stock image; `prune` lists the other recipe
 * checkouts a v3 image starts with. */
export type CloudV2RestoreCreate = { from: string | null; prune?: string[]; name: string; env: Record<string, string>; requestedAt: string;
  /** Retention: the project's ready copy machine this restore forks instead of creating from `from`. */
  fork?: string };
/** `checkout`: the image already holds this workspace's clone, so creation
 * skips hydrating it. Only a source-holding (v3) image ever does. */
export type CloudV2WorkspaceImage = { from: string | null; prune: string[]; checkout: boolean };

/** A v3 image holds every recipe repository, so it starts only a workspace
 * whose immutable source scope covers them all; that workspace removes the
 * other checkouts before its worker starts. Any other starts from Boat's
 * stock image and clones its own repository. A v2 image holds no source. */
export function cloudV2WorkspaceImage(input: { policy: number; snapshot: string; recipe: unknown; scope: readonly string[]; repository: string }): CloudV2WorkspaceImage {
  if (input.policy !== 3) return { from: cloudV2BoatSnapshotName(input.snapshot), prune: [], checkout: false };
  const entries = (input.recipe as { repositories?: { repository?: unknown }[] } | null)?.repositories ?? [];
  const names = entries.flatMap(entry => typeof entry.repository === "string" ? [entry.repository] : []);
  const scope = new Set(input.scope.map(name => name.toLowerCase()));
  if (!names.length || names.length !== entries.length || !names.every(name => scope.has(name.toLowerCase()))) return { from: null, prune: [], checkout: false };
  const own = (name: string) => name.toLowerCase() === input.repository.toLowerCase();
  return { from: input.snapshot, prune: names.filter(name => !own(name)), checkout: names.some(own) };
}

function restoreCreate(value: CloudV2RestoreCreate | null): CloudV2RestoreCreate | null {
  return value && { from: value.from, ...(value.prune?.length ? { prune: value.prune } : {}), name: value.name, env: value.env, requestedAt: value.requestedAt,
    ...(typeof value.fork === "string" && SANDBOX.test(value.fork) ? { fork: value.fork } : {}) };
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
  private_owner_user_id?: string | null;
  project_id?: string | null;
  lost_work_restored?: "none" | "earlier" | null; lost_work_since?: Date | null;
  checkout_path?: string | null;
  folder?: string | null;
  keep_set_at?: Date | null; archive_reason?: "manual" | "inactive" | "member_left" | null;
  stopped_at?: Date | null; machine_stopped_at?: Date | null; machine_data_expired_at?: Date | null;
  archive_wake_done_at?: Date | null; checkpoint_object?: string | null; retention_started_at?: Date | null;
  backup_probe?: BackupProbe | null; backup_probe_generation?: string | null; stop_generation?: string; checkpoint_stop_generation?: string | null;
  changed_since_stop_generation?: string | null; machine_gone_at?: Date | null; waiting_for_base_at?: Date | null;
  stop_archive_failed_generation?: string | null;
  checkpoint_partial?: boolean | null;
  submodules_unrestored?: unknown;
  checkpoint_saved_at?: Date | null; checkpoint_confirmed_at?: Date | null;
};
type Row = CloudV2WorkspaceRow;

const WORKSPACE_COLUMNS_SQL = sql`id, org_id, creator_user_id, name, number, title, repository, branch, base_branch, state, boat_sandbox_id,
  computer_build_id, error_code, active_at, archived_at, created_at, updated_at, source_pending, created_by_session_id, setup_status,
  agent_cost_usd, agent_cost_turns, agent_cost_estimated_turns, private_owner_user_id, project_id, checkout_path, folder,
  lost_work_restored, lost_work_since, keep_set_at, archive_reason, stopped_at, machine_stopped_at, machine_data_expired_at,
  archive_wake_done_at, checkpoint_object, retention_started_at, backup_probe, backup_probe_generation, stop_generation,
  checkpoint_stop_generation, changed_since_stop_generation, machine_gone_at, waiting_for_base_at, stop_archive_failed_generation, checkpoint_partial,
  submodules_unrestored, checkpoint_saved_at, checkpoint_confirmed_at`;
const COLUMNS = WORKSPACE_COLUMNS_SQL.text;
export const CLOUD_V2_WORKSPACE_COLUMNS = COLUMNS.split(",").map(value => value.trim());

type LifecycleRow = Row & {
  /** C4: its 'fetch' submodule rows, counted in the statement that loads it (lifecycleSubmodules). */
  submodule_fetches?: number;
  base_ready_at?: Date | null;
  execution_transition_id: string | null;
  execution_restore_claimed_at: Date | null;
  execution_mode: string; execution_initiator_user_id: string | null; execution_intent_id: string | null;
  execution_intent_authority: ExecutionIntentAuthority | null; access_epoch: string;
  lease_renewed_at: Date | null; base_commit: string | null; restore_pending: boolean; restore_attempt: string | null;
  restore_create: CloudV2RestoreCreate | null; checkpoint_uploads: Record<string, string>;
  stop_generation: string; checkpoint_stop_generation: string | null;
  checkpoint_object: string | null; checkpoint_key: unknown; checkpoint_sha256: string | null; checkpoint_bytes: string | null; checkpoint_saved_at: Date | null;
  checkpoint_reuse: unknown; checkpoint_retry_fork: unknown;
  backup_probe?: BackupProbe | null; backup_probe_generation?: string | null; worker_off_unverified_at?: Date | null;
  worker_off_verified_generation?: string | null;
  maintenance_attempt?: string | null; maintenance_phase?: "waking" | "adopting" | "stopping" | null; maintenance_started_at?: Date | null;
  archive_scrub?: "backup" | "clean" | "partial" | null; archive_scrubbed_generation?: string | null;
};
/** C4: how many submodules a workspace fetched, read inside the statement that loads it for the lifecycle, so its stop,
 * backup and restore read their checkouts only when there are some: a workspace without any costs no query for them.
 * `table` names the workspace row in that statement. */
export const lifecycleSubmodules = (table: string) =>
  `(SELECT count(*)::int FROM cloud_v2_workspace_submodules s WHERE s.workspace_id=${table}.id AND s.status='fetch') AS submodule_fetches`;
const LIFECYCLE_COLUMNS = `${COLUMNS}, lease_renewed_at, base_commit, restore_pending, restore_attempt, restore_create, checkpoint_uploads,
  execution_mode, execution_transition_id, execution_restore_claimed_at, execution_initiator_user_id, execution_intent_id, execution_intent_authority, access_epoch,
  stop_generation, checkpoint_stop_generation,
  checkpoint_object, checkpoint_key, checkpoint_sha256, checkpoint_bytes, checkpoint_reuse, checkpoint_retry_fork,
  backup_probe, backup_probe_generation, worker_off_unverified_at, worker_off_verified_generation,
  maintenance_attempt, maintenance_phase, maintenance_started_at, archive_scrub, archive_scrubbed_generation, base_ready_at`;
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
    // Counted (0 included) by every loader that asks; absent means not known, and the checkouts read asks (hasCheckouts).
    ...(typeof row.submodule_fetches === "number" ? { submoduleFetches: row.submodule_fetches } : {}),
    ...(unrestoredSubmodules(row.submodules_unrestored).length ? { submodulesUnrestored: unrestoredSubmodules(row.submodules_unrestored) } : {}),
    ...(row.base_ready_at ? { baseReadyAt: row.base_ready_at.toISOString() } : {}),
    ...(cloudV2CheckpointLossy(row) ? { checkpointLossy: true as const } : {}),
    stopGeneration: row.stop_generation, checkpointUploadUntil: uploadHorizon(row.checkpoint_uploads),
    checkpointRetryFork: checkpointFork(row.checkpoint_retry_fork),
    ...(cloudV2StopProbe(row) ? { stopProbe: cloudV2StopProbe(row)! } : {}),
    // Unverified unless this generation's stop ran the verified worker-off step: Boat's own stop,
    // a restore-pending stop and one from before retention never did.
    ...(row.worker_off_unverified_at || (row.backup_probe_generation !== undefined && row.backup_probe_generation !== row.stop_generation
        && row.worker_off_verified_generation !== row.stop_generation)
      ? { workerOffUnverified: true as const } : {}),
    ...(row.maintenance_attempt && row.maintenance_phase && row.maintenance_started_at
      ? { maintenance: { attempt: row.maintenance_attempt, phase: row.maintenance_phase, startedAt: row.maintenance_started_at.toISOString() } } : {}),
    ...(row.archive_scrub && row.archive_scrubbed_generation === row.stop_generation ? { archiveScrub: row.archive_scrub } : {}) };
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
    ...(cloudV2RecoverableFailure(row) ? { recoverable: true as const } : {}),
    ...(row.private_owner_user_id ? { privateOwnerUserId: row.private_owner_user_id } : {}),
    ...(row.project_id ? { projectId: row.project_id } : {}),
    ...(row.checkout_path ? { checkoutFolder: row.checkout_path } : {}),
    ...(row.folder ? { folder: row.folder } : {}),
    ...(row.lost_work_restored && row.lost_work_since ? { lostWork: { restored: row.lost_work_restored, stoppedAt: row.lost_work_since.toISOString() } } : {}),
    ...(row.waiting_for_base_at && row.state === "creating" ? { preparing: "computer" as const } : {}),
    ...(unrestoredSubmodules(row.submodules_unrestored).length ? { unrestoredSubmodules: unrestoredSubmodules(row.submodules_unrestored)
      .map(entry => ({ path: entry.folder, reason: entry.reason, since: entry.since })) } : {}),
    // Retention's fields only where retention runs: with the switch off a document is exactly what it was.
    ...(retentionDocuments ? { keep: Boolean(row.keep_set_at) && !row.archived_at, ...archiveFields(row) } : {}),
  };
}

let retentionDocuments = false;
/** Retention S3: whether workspace documents carry retention's fields (keep, archiveReason, machineExpectedGoneAt,
 * backupRemovalAt). Set once at composition from CLOUD_V2_RETENTION_ENABLED; every path that serves a document
 * (get, list, team views, the composite routes) goes through workspace(), so none can disagree. Off by default. */
export function setCloudV2RetentionDocuments(enabled: boolean): void { retentionDocuments = enabled; }
/** The organization-level signal on the workspace list (both its routes): `retention: true` exactly when documents
 * carry retention's fields, from the same flag, so the desktop can state the rule for an organization with no
 * workspaces. Off, the list reply is what it was. */
export function cloudV2RetentionListSignal(): { retention?: true } { return retentionDocuments ? { retention: true } : {}; }

/** An archived workspace's backup is removed this long after its archive, counted from when retention first
 * applied if that is later: no clock starts from history. S4's removal uses this same expression. */
export const CLOUD_V2_BACKUP_REMOVAL_DAYS = 60;
export const CLOUD_V2_BACKUP_REMOVAL_AT_SQL =
  `greatest(w.archived_at, w.retention_started_at) + make_interval(days => ${CLOUD_V2_BACKUP_REMOVAL_DAYS})`;
/** The same date, in the document; null until both clocks exist. */
export function cloudV2BackupRemovalAt(archivedAt: Date | null | undefined, retentionStartedAt: Date | null | undefined): Date | null {
  if (!(archivedAt instanceof Date) || !(retentionStartedAt instanceof Date)) return null;
  return new Date(Math.max(archivedAt.getTime(), retentionStartedAt.getTime()) + CLOUD_V2_BACKUP_REMOVAL_DAYS * DAY_MS);
}

const DAY_MS = 24 * 60 * 60_000;
/** Retention S3: an archived workspace's final backup is still to be taken. Settled once this stop has a
 * backup (a wake that found the checkout changed takes that cover away), or a clean probe nothing has
 * changed since, or this stop's retries are exhausted, or 12 days after the archive. Over alias w.
 * It reads the raw probe, not a suspect archive's marker (stop_archive_failed_generation): a backup forks that same
 * archive, so it could not add what the archive lacks, and a clean probe already found nothing off GitHub. */
const FINAL_BACKUP_PENDING = `(w.archived_at IS NOT NULL AND w.archived_at > clock_timestamp() - interval '12 days'
  AND w.checkpoint_stop_generation IS DISTINCT FROM w.stop_generation
  AND NOT (w.backup_probe = 'clean' AND w.backup_probe_generation = w.stop_generation
    AND w.changed_since_stop_generation IS DISTINCT FROM w.stop_generation)
  AND NOT (w.checkpoint_retry_generation IS NOT DISTINCT FROM w.stop_generation AND w.checkpoint_retry_exhausted_at IS NOT NULL))`;
/** Retention S3's archive fields. Boat removes a machine about 14 days after its last stop; an archived
 * workspace still owed its one wake has it 10 days later, so 24 days from now's last stop. */
function archiveFields(row: Row): Pick<CloudV2Workspace, "archiveReason" | "machineExpectedGoneAt" | "backupRemovalAt" | "restores"> {
  if (!row.archived_at) return {};
  const lastStop = [row.machine_stopped_at, row.stopped_at].filter((at): at is Date => at instanceof Date)
    .reduce<Date | null>((latest, at) => !latest || at > latest ? at : latest, null);
  const woken = row.archive_wake_done_at instanceof Date && row.archive_wake_done_at >= row.archived_at;
  const estimate = lastStop ? lastStop.getTime() + (woken ? 14 : 24) * DAY_MS : null;
  // An estimate already past (an overdue wake) says nothing true: absent rather than a past date.
  const gone = !row.boat_sandbox_id ? null : row.machine_data_expired_at ? { at: row.machine_data_expired_at.toISOString(), estimate: false }
    : estimate !== null && estimate > Date.now() ? { at: new Date(estimate).toISOString(), estimate: true } : null;
  const removal = row.checkpoint_object ? cloudV2BackupRemovalAt(row.archived_at, row.retention_started_at) : null;
  return {
    ...(row.archive_reason ? { archiveReason: row.archive_reason } : {}),
    ...(gone ? { machineExpectedGoneAt: gone } : {}),
    ...(removal ? { backupRemovalAt: removal.toISOString() } : {}),
    restores: cloudV2Restores(row),
  };
}

/** The latest stop's probe as every restore decision reads it: the probe of this stop generation, and "clean" only
 * while no maintenance wake has found the checkout changed since (S3), when it reads "unknown". The lifecycle's
 * restore path (cleanRestore, unbacked, onlyOnMachine) and the document's `restores` both use this. */
export function cloudV2StopProbe(row: { backup_probe?: BackupProbe | null; backup_probe_generation?: string | null; stop_generation?: string;
  changed_since_stop_generation?: string | null; stop_archive_failed_generation?: string | null }): BackupProbe | undefined {
  if (!row.backup_probe || row.backup_probe_generation !== row.stop_generation) return undefined;
  // A stop whose archive may lack its last writes (a failed snapshot attempt was reported during it) is never clean.
  return row.backup_probe === "clean" && (row.changed_since_stop_generation === row.stop_generation
    || row.stop_archive_failed_generation === row.stop_generation) ? "unknown" : row.backup_probe;
}

/** What opening the workspace now would bring back, as S1's restore path decides it (tested against it):
 * "all" when its machine is still there (resumed as it is), or a backup of this very stop holds everything (restored),
 * or this stop left nothing off GitHub (rebuilt without loss); otherwise "pushed": it is rebuilt from GitHub and
 * work never pushed is gone (the lostWork note). An earlier stop's backup alone is "pushed": it lacks this stop's work. */
/** The build a workspace restores from, for both restore paths (beginRestore, pinRestoreImage): the organization's active
 * Cloud Computer build, locked so activation and cleanup wait for the pin the caller writes in the same transaction.
 * With ready copies on that may be a base that holds no repository (base_only, policy 2), built or the shared one: its
 * image clones every repository, and nothing else is needed (retention.integration.test.ts covers both). */
async function restoreBuild(tx: Tx, organizationId: string): Promise<{ id: string; snapshot_name: string; source_policy_version: number; recipe: unknown } | null> {
  return (await tx.query<{ id: string; snapshot_name: string; source_policy_version: number; recipe: unknown }>(
    `SELECT b.id, c.snapshot_name, b.source_policy_version, b.recipe FROM cloud_v2_computers c
     JOIN cloud_v2_computer_builds b ON b.id=c.active_build_id AND b.org_id=c.org_id
     WHERE c.org_id=$1 AND c.snapshot_name IS NOT NULL AND b.state='succeeded' AND b.source_policy_version IN (2,3) AND b.snapshot_id=c.snapshot_name
       AND b.snapshot_deleted_at IS NULL AND b.cleanup_requested_at IS NULL
     FOR SHARE OF c,b`, [organizationId])).rows[0] ?? null;
}
const restoreImage = (build: { snapshot_name: string; source_policy_version: number; recipe: unknown },
  workspace: { repository: string; source_repositories: string[] | null }) =>
  cloudV2WorkspaceImage({ policy: build.source_policy_version, snapshot: build.snapshot_name, recipe: build.recipe,
    scope: workspace.source_repositories ?? [], repository: workspace.repository });

/** This stop's checkpoint was taken from its archive after the stop (a backup fork), or a backup fork found that archive
 * unchanged since the checkpoint (checkpoint_confirmed_at), and that stop's archive is suspect
 * (stop_archive_failed_generation): it may lack the stop's last writes. A checkpoint taken or confirmed on the running
 * machine before its stop (the stop checkpoint) is not affected. */
export function cloudV2CheckpointLossy(row: { stop_generation?: string; stop_archive_failed_generation?: string | null; checkpoint_stop_generation?: string | null;
  checkpoint_saved_at?: Date | null; checkpoint_confirmed_at?: Date | null; stopped_at?: Date | null }): boolean {
  const covered = [row.checkpoint_saved_at, row.checkpoint_confirmed_at].filter((at): at is Date => at instanceof Date)
    .reduce<Date | null>((latest, at) => !latest || at > latest ? at : latest, null);
  return !!row.stop_archive_failed_generation && row.stop_archive_failed_generation === row.stop_generation
    && row.checkpoint_stop_generation === row.stop_generation && covered !== null
    && (!(row.stopped_at instanceof Date) || covered > row.stopped_at);
}

export function cloudV2Restores(row: Row, now = Date.now()): "all" | "pushed" {
  // C4B: a backup that left out a submodule folder holding a person's own clone does not bring everything back, nor
  // does a backup of a stop whose archive may lack its last writes (cloudV2CheckpointLossy).
  if (row.checkpoint_object && row.checkpoint_stop_generation === row.stop_generation && !row.checkpoint_partial && !cloudV2CheckpointLossy(row)) return "all";
  if (cloudV2StopProbe(row) === "clean") return "all";
  const lastStop = [row.machine_stopped_at, row.stopped_at].filter((at): at is Date => at instanceof Date)
    .reduce<Date | null>((latest, at) => !latest || at > latest ? at : latest, null);
  const woken = row.archived_at instanceof Date && row.archive_wake_done_at instanceof Date && row.archive_wake_done_at >= row.archived_at;
  // Boat's word on this machine, never an earlier one's: both are later than the stop they describe.
  const after = (at: Date | null | undefined) => at instanceof Date && !!lastStop && at >= lastStop;
  const gone = !row.boat_sandbox_id || !lastStop || after(row.machine_gone_at)
    || (after(row.machine_data_expired_at) && row.machine_data_expired_at!.getTime() <= now)
    || lastStop.getTime() + (woken ? 14 : 24) * DAY_MS <= now;
  return gone ? "pushed" : "all";
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

/** `recover`: only a recoverable failed workspace (failure-retry.ts) may start (store.recoverFailedWorkspace). */
type LifecycleOptions = { recover?: boolean };

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
  // Tell a creator on Hold why their own workspace is unavailable, and the owner
  // of a Personal organization whose Pro ended (only with the switch on).
  const reason = (await tx.query<{ held: boolean; pro_required: boolean }>(
    `SELECT ${CLOUD_V2_CREATOR_ON_HOLD} AS held, ${CLOUD_V2_PERSONAL_PRO_ENDED} AS pro_required
     FROM cloud_v2_workspaces w WHERE w.id = $1 AND w.creator_user_id = $2 AND w.state <> 'deleted'`,
    [id, userId],
  )).rows[0];
  if (reason?.held) throw organizationMemberOnHold();
  if (reason?.pro_required) throw new HttpError(403, "pro_required", "Cloud workspaces need Pro. This workspace opens again when Pro is active.");
  throw notFound();
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

export type CloudV2ProviderStopBinding = { workspaceId: string; sandboxId: string; bootId: string; workerTokenHash: string; accessEpoch: string };
export type CloudV2ProviderStopOutcome = "observed" | "contradicted" | "braked" | "stopped" | "rewake" | "capped" | "stale";
export const PROVIDER_STOP_WAKES_PER_HOUR = 2;
export const PROVIDER_STOP_WAKES_PER_10_MINUTES = 20;
export const PROVIDER_STOP_BRAKE_PER_10_MINUTES = 20;
/** Our own activity this long after Boat's stop time contradicts it. */
export const PROVIDER_STOP_ACTIVITY_MARGIN_MS = 10_000;

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
  private async admitCreator(tx: Tx, organizationId: string, creatorUserId: string, serializeCreates = false): Promise<{ personal: boolean }> {
    const member = await tx.query<{ pro: boolean; held: boolean; personal: boolean }>(
      `SELECT account_pro_active(m.user_id) AS pro, ${memberOnHoldSql("m.org_id", "m.user_id")} AS held, o.is_personal AS personal
       FROM organization_members m JOIN organizations o ON o.id = m.org_id AND o.deleted_at IS NULL
       WHERE m.org_id = $1 AND m.user_id = $2 AND cloud_organization_enabled(o)
       FOR SHARE OF o ${serializeCreates ? "FOR UPDATE OF m" : "FOR SHARE OF m"}`,
      [organizationId, creatorUserId],
    );
    if (!member.rows[0]) throw new HttpError(404, "not_found", "Organization not found");
    if (member.rows[0].held) throw organizationMemberOnHold();
    if (!member.rows[0].pro) throw new HttpError(403, "pro_required", "Creating a cloud workspace requires Pro");
    return { personal: member.rows[0].personal };
  }

  /** The build's ID for this repository, and the scope a v3 image needs. */
  private async computerScope(tx: Tx, organizationId: string, computerBuildId: string, repository: string,
    sourceRepositoryId?: string, readableRepositoryIds?: readonly string[]) {
    // Activation waits for this lock, so cleanup observes the new workspace
    // pin before it can retire an inactive source snapshot.
    const selected = await tx.query<{ recipe: { repositories: { repository: string }[] }; source_targets: unknown; source_policy_version: number }>(
      `SELECT b.recipe,b.source_targets,b.source_policy_version FROM cloud_v2_computers c
       JOIN cloud_v2_computer_builds b ON b.id=$2 AND b.org_id=c.org_id
       WHERE c.org_id=$1 AND b.state='succeeded' AND b.source_policy_version IN (2,3) AND b.snapshot_deleted_at IS NULL AND b.cleanup_requested_at IS NULL
         -- The live build, or (ready copies turned off again) the legacy build its base replaced, which is kept for this.
         AND ((c.active_build_id=$2 AND c.snapshot_name IS NOT NULL AND b.snapshot_id=c.snapshot_name)
           OR (c.legacy_build_id=$2 AND b.snapshot_id IS NOT NULL AND NOT b.base_only))
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
    const { personal } = await this.admitCreator(tx, input.organizationId, input.creatorUserId, input.workspaceTokenCreate);
    // A Personal organization runs cloud on the creator path only: shared
    // execution is refused there, so the deployment's default never applies.
    const executionRuntime = personal ? undefined : input.executionRuntime;
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
    let privateOwner: string | null = null, projectId: string | null = null;
    if (input.projectId) {
      // Checked under the create's own transaction: a project the creator may use
      // (the organization's, or their own while personal projects are allowed),
      // holding exactly these repositories in this order, and a live base that holds no repository's source.
      const requested = input.repositories ?? [];
      const project = (await tx.query<{ level: "organization" | "personal"; repositories: { repository: string; repositoryId: string }[] }>(`SELECT p.level,
          (SELECT jsonb_agg(jsonb_build_object('repository', r.repository, 'repositoryId', r.repository_id) ORDER BY r.position)
             FROM cloud_project_repositories r WHERE r.project_id=p.id) AS repositories
        FROM cloud_projects p JOIN organizations o ON o.id=p.org_id
        -- The live base, or the base being prepared that this workspace waits for (the lifecycle defers until it is live,
        -- or, if it failed since the create's check, re-binds or fails plainly: cloud_computer_preparation_failed).
        JOIN cloud_v2_computer_builds b ON b.id=$4 AND b.org_id=p.org_id AND b.base_only AND (b.state IN ('queued','building','failed','cancelled')
          OR (b.state='succeeded' AND EXISTS (SELECT 1 FROM cloud_v2_computers c WHERE c.org_id=p.org_id AND c.active_build_id=b.id)))
        WHERE p.id=$1 AND p.org_id=$2 AND (p.level='organization' OR (p.owner_user_id=$3 AND o.cloud_personal_projects_allowed))
        FOR SHARE OF p`, [input.projectId, input.organizationId, input.creatorUserId, input.computerBuildId])).rows[0];
      const matches = !!project?.repositories && project.repositories.length === requested.length && requested.length > 0
        && requested.every((entry, index) => entry.repositoryId === project.repositories[index]!.repositoryId
          && entry.repository.toLowerCase() === project.repositories[index]!.repository)
        && requested[0]!.repository.toLowerCase() === input.repository.toLowerCase();
      if (!project || !matches || pending || (input.sourceRepositoryId !== undefined && input.sourceRepositoryId !== requested[0]!.repositoryId))
        throw new HttpError(409, "project_unavailable", "This project is no longer available to you in the cloud.");
      sourceRepositoryId = requested[0]!.repositoryId;
      scope = requested.map(entry => ({ repository: entry.repository.toLowerCase(), repositoryId: entry.repositoryId }));
      projectId = input.projectId;
      // Private for good: sharing the project later never shares this workspace.
      if (project.level === "personal") privateOwner = input.creatorUserId;
    } else if (input.computerBuildId)
      ({ sourceRepositoryId, scope } = await this.computerScope(tx, input.organizationId, input.computerBuildId, input.repository,
        input.sourceRepositoryId, input.readableRepositoryIds));
    if (Object.keys(input.env ?? {}).length && sourceRepositoryId === undefined)
      throw new HttpError(409, "cloud_source_review_required", "A workspace environment requires a verified repository identity.");
    const row = (await tx.query<Row>(
      `INSERT INTO cloud_v2_workspaces (id, org_id, creator_user_id, name, repository, branch, base_branch, state, computer_build_id, source_repositories, source_pending, api_access, created_by_session_id, execution_initiator_user_id, execution_intent_id, execution_mode, private_owner_user_id, project_id, checkout_path, folder, base_commit, waiting_for_base_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'creating', $8, $9::text[], $10,
         coalesce((SELECT workspace_api_access FROM cloud_api_access_settings WHERE org_id=$2 AND user_id=$3),true), $11, $3, gen_random_uuid(), $12, $13, $14,
         $15, $16, $17, CASE WHEN $14::uuid IS NOT NULL AND EXISTS (SELECT 1 FROM cloud_v2_computer_builds b WHERE b.id=$8 AND b.state IN ('queued','building','failed','cancelled'))
           THEN clock_timestamp() END) RETURNING ${COLUMNS}`,
      [input.id, input.organizationId, input.creatorUserId, input.name, input.repository, input.branch,
        input.baseBranch, input.computerBuildId,
        pending ? null : (scope ?? [{ repository: input.repository }]).map(source => source.repository.toLowerCase()), pending, input.createdBySessionId ?? null,
        executionRuntime ? "active" : "legacy", privateOwner, projectId,
        projectId ? input.checkoutFolder ?? null : null, projectId && (input.repositories?.length ?? 0) > 1 ? input.folder ?? null : null,
        projectId ? input.repositories?.[0]?.baseCommit ?? null : null],
    )).rows[0]!;
    if (!pending && sourceRepositoryId !== undefined) await this.bindSources(tx, workspace(row), sourceRepositoryId, scope, input.env);
    // The trigger made the first repository's row from the workspace's; it gets
    // its folder and id here, and the project's others follow it.
    if (projectId) for (const [position, entry] of (input.repositories ?? []).entries()) {
      if (position === 0) await tx.query("UPDATE cloud_v2_workspace_repositories SET folder=$2, repository_id=$3 WHERE workspace_id=$1 AND position=0",
        [row.id, entry.folder, entry.repositoryId]);
      else await tx.query(`INSERT INTO cloud_v2_workspace_repositories (workspace_id, position, repository, repository_id, folder, branch, base_branch, base_commit)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [row.id, position, entry.repository, entry.repositoryId, entry.folder, entry.branch, entry.baseBranch, entry.baseCommit ?? null]);
    }
    if (projectId && input.submodules?.length) await insertWorkspaceSubmodules(tx, row.id, input.submodules);
    // Creator path: each later repository's environment files are pinned like the first's. Shared execution has none for them yet.
    if (projectId && !executionRuntime && (input.repositories?.length ?? 0) > 1)
      await pinCloudRepositoryEnvironments(tx, workspace(row), input.repositories!.slice(1).map(entry => entry.repositoryId));
    if (input.runtimeCanary) await consumeRuntimeCanary(tx, workspace(row), input.runtimeCanary, sourceRepositoryId, createKey);
    let promptAdmission;
    if (executionRuntime) {
      if (!this.prompts.execution) throw new HttpError(503, "execution_unavailable", "Shared execution is unavailable");
      const authority = await this.prompts.execution.deps.authority.creation(tx, row.id, input.creatorUserId);
      await tx.query("UPDATE cloud_v2_workspaces SET execution_intent_authority=$2 WHERE id=$1", [row.id, executionIntentAuthority(authority)]);
      await recordExecutionCreation(tx, row.id, executionRuntime);
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
         WHERE o.slug = $1 AND o.deleted_at IS NULL AND (NOT o.is_personal OR cloud_organization_enabled(o)) AND w.number = $2`,
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
  async requestLifecycle(id: string, userId: string, action: "start" | "stop" | "archive" | "restart", options: LifecycleOptions = {}):
    Promise<{ workspace: CloudV2Workspace; moved: boolean }> {
    const execution = this.prompts.execution;
    if (execution && await execution.active(id, undefined, userId)) {
      const proof = action === "stop" ? undefined : await execution.deps.authority.admit(id, userId);
      return this.requestExecutionLifecycle(id, userId, action, proof, undefined, false, true, options);
    }
    return withSystemTx(this.pool, async tx => {
      const current = await ownedRow(tx, id, userId, true);
      await ownedRow(tx, id, userId);
      const result = await this.lifecycleIntent(tx,id,current,action,undefined,undefined,options);
      if (action === "stop" || action === "archive") await clearStoppedExecutionTransition(tx, id);
      return result;
    });
  }

  async requestExecutionLifecycle(id: string, userId: string, action: "start" | "stop" | "archive" | "restart", proof?: ExecutionAdmission,
    user?: AuthedUser, unarchived = false, ownership = true, options: LifecycleOptions = {}): Promise<{ workspace: CloudV2Workspace; moved: boolean }> {
    const authority = this.prompts.execution!.deps.authority;
    return withSystemTx(this.pool, async tx => {
      const row = (await tx.query<Row>(`SELECT ${COLUMNS} FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE`, [id])).rows[0];
      if (!row) throw notFound();
      // Ordinary lifecycle admission is database-only. Read its authority after
      // the row lock, then fence again after the intent mutation in this transaction.
      const admission = proof ?? (action !== "stop" && user ? await authority.admit(id, userId, { user, transaction: tx }) : undefined);
      if (user && (proof || !admission)) await authority.session(tx, user, userId);
      const before = proof ? await authority.assert(proof, tx) : admission?.person ?? await authority.snapshot(tx, id, userId);
      if (!admission && action !== "stop") throw new HttpError(409, "actor_changed", "Execution authority changed");
      if (!ownership && row.creator_user_id === null) throw teamOwnershipRequired();
      if (action === "archive" && before.role === "member" && row.creator_user_id !== userId) throw new HttpError(403, "workspace_management_denied", "Only the Creator or an administrator may archive this workspace");
      if (unarchived && row.archived_at) throw new HttpError(409, "cloud_workspace_not_running", "This cloud workspace is not ready for a connection");
      const result = await this.lifecycleIntent(tx, id, row, action, userId, admission ? executionIntentAuthority(admission) : undefined, options);
      if (admission) await authority.assert(admission, tx, true);
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

  /** Starts a failed workspace that can still run (failure-retry.ts) as an ordinary start would: straight to starting,
   * in the same stop generation, so what that generation recorded (an archive scrub to undo, the checkpoint it saved,
   * a pending restore) still applies. Shared workspaces go through the caller's execution authority. Refused with 409
   * workspace_not_recoverable otherwise. */
  async recoverFailedWorkspace(id: string, userId: string, options: { user?: AuthedUser; ownership?: boolean } = {}):
    Promise<{ workspace: CloudV2Workspace; moved: boolean }> {
    const execution = this.prompts.execution;
    if (options.user && execution && await execution.active(id, undefined, userId))
      return this.requestExecutionLifecycle(id, userId, "start", undefined, options.user, false, options.ownership ?? true, { recover: true });
    return this.requestLifecycle(id, userId, "start", { recover: true });
  }

  private async lifecycleIntent(tx: Tx, id: string, current: Row, action: "start" | "stop" | "archive" | "restart", initiator?: string,
    executionAuthority?: ExecutionIntentAuthority, options: LifecycleOptions = {}) {
      // Decided on the locked row before anything changes. Its first error stays until a boot is running.
      if (options.recover && !cloudV2RecoverableFailure(current))
        throw new HttpError(409, "workspace_not_recoverable", "This cloud workspace cannot be recovered. Delete it and create a new one.");
      // A Stop that failed before Boat confirmed it left its turns open: only that stop's completion retires them, and a
      // new boot's cleanup reaches only its own generation. Finish that stop, in its generation, then start.
      const interruptedStop = !!options.recover && (await tx.query(`SELECT 1 FROM cloud_v2_execution_contexts
        WHERE workspace_id=$1 AND state<>'retired' AND stop_generation<$2::bigint LIMIT 1`, [id, current.stop_generation])).rowCount === 1;
      if (action === "stop" || action === "archive") await cancelExecutionActivation(tx, id);
      else await assertNoExecutionTransition(tx, id);
      // A create still waiting for its organization's base has no machine to stop: stop ends it, plainly, with none made.
      if (action === "stop" && current.state === "creating" && current.boat_sandbox_id === null && current.waiting_for_base_at) {
        const stopped = (await tx.query<Row>(`UPDATE cloud_v2_workspaces SET state='failed', error_code='cloud_create_stopped',
            waiting_for_base_at=NULL, attempts=0, next_attempt_at=NULL, updated_at=clock_timestamp()
          WHERE id=$1 AND state='creating' AND boat_sandbox_id IS NULL AND waiting_for_base_at IS NOT NULL RETURNING ${COLUMNS}`, [id])).rows[0];
        if (stopped) return { workspace: workspace(stopped), moved: true };
      }
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
      const state = interruptedStop ? "stopping" : starts
        ? current.state === "stopped" || current.state === "failed" ? "starting" : current.state
        : current.state === "running" || current.state === "starting" || configuring || reconfirm ? "stopping" : current.state;
      const moved = state !== current.state;
      const archived = action === "archive" || (action === "stop" && current.archived_at !== null);
      const restart = interruptedStop ? intent.stop_generation
        : state === "stopping" && action === "restart" ? (BigInt(intent.stop_generation) + (moved ? 1n : 0n)).toString()
        : state === "stopping" && action === "start" && priorRestart === intent.stop_generation ? priorRestart : null;
      if (!moved && archived === (current.archived_at !== null) && restart === priorRestart) return { workspace: workspace(current), moved };
      const { rows } = await tx.query<Row>(
        `UPDATE cloud_v2_workspaces SET
           archived_at = CASE WHEN $3::boolean THEN coalesce(archived_at, clock_timestamp()) ELSE NULL END,
           archive_reason = CASE WHEN NOT $3::boolean THEN NULL WHEN archived_at IS NULL THEN 'manual' ELSE archive_reason END,
           keep_set_at = CASE WHEN $3::boolean THEN NULL ELSE keep_set_at END,
           keep_set_by = CASE WHEN $3::boolean THEN NULL ELSE keep_set_by END,
           restart_stop_generation = $4::bigint,
           execution_initiator_user_id = CASE WHEN $5::uuid IS NOT NULL AND $6::boolean THEN $5 ELSE execution_initiator_user_id END,
           execution_intent_id = CASE WHEN $5::uuid IS NOT NULL AND $6::boolean THEN gen_random_uuid() ELSE execution_intent_id END,
           execution_intent_authority = CASE WHEN $5::uuid IS NOT NULL AND $6::boolean THEN $7::jsonb ELSE execution_intent_authority END,
           attempts = CASE WHEN state <> $2 THEN 0 ELSE attempts END,
           next_attempt_at = CASE WHEN state <> $2 THEN NULL ELSE next_attempt_at END,
           worker_token_hash = CASE WHEN state <> $2 AND $2 = 'starting' THEN NULL ELSE worker_token_hash END,
           worker_boot_id = CASE WHEN state <> $2 AND $2 = 'starting' THEN NULL ELSE worker_boot_id END,
           stop_generation = stop_generation + CASE WHEN state <> $2 AND $2 = 'stopping' AND NOT $8::boolean THEN 1 ELSE 0 END,
           updated_at = clock_timestamp(),
           state = $2
         WHERE id = $1 RETURNING ${COLUMNS}`,
        [id, state, archived, restart, initiator ?? null, action === "start" || action === "restart", executionAuthority ?? null, interruptedStop],
      );
      return { workspace: workspace(rows[0]!), moved };
  }

  /** Compare-and-set. Returns null when the workspace was not in `from`, or,
   * with `stopGeneration`, when another stop has begun since. `revoke` drops
   * the worker's credentials in the same transaction, only if it moved, so a
   * late step can never revoke a worker that a newer wake started.
   * `expectedSandboxId: null` fences an observed empty allocation slot. */
  async transition(id: string, from: readonly CloudV2WorkspaceState[], to: CloudV2WorkspaceState,
    patch: { boatSandboxId?: string | null; expectedSandboxId?: string | null; errorCode?: string | null; stopGeneration?: string; revoke?: boolean; unarchived?: boolean;
      /** Retention: Boat's own stoppedAt, read once the machine is archived. */
      stoppedAt?: Date;
      /** A failed snapshot attempt was reported during this stop: its archive may lack the machine's last writes. */
      archiveFailed?: boolean } = {}): Promise<CloudV2Workspace | null> {
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
         stopped_at = CASE WHEN $3 = 'stopped' THEN coalesce($13::timestamptz, clock_timestamp()) ELSE stopped_at END,
         restore_pending = restore_pending AND $3 <> 'deleted',
         attempts = 0, next_attempt_at = NULL, updated_at = clock_timestamp()
       WHERE id = $1 AND state = ANY($2::text[]) AND ($8::bigint IS NULL OR stop_generation = $8::bigint)
         AND (NOT $9::boolean OR archived_at IS NULL)
         AND (NOT $10::boolean OR boat_sandbox_id IS NOT DISTINCT FROM $11::text) RETURNING ${COLUMNS}`,
      [id, from, to, patch.boatSandboxId !== undefined, patch.boatSandboxId ?? null,
        patch.errorCode !== undefined, patch.errorCode ?? null, patch.stopGeneration ?? null, patch.unarchived ?? false,
        patch.expectedSandboxId !== undefined, patch.expectedSandboxId ?? null, patch.revoke ?? false, patch.stoppedAt ?? null],
    );
    if (!rows[0]) return null;
    if (patch.archiveFailed && to === "stopped")
      await tx.query("UPDATE cloud_v2_workspaces SET stop_archive_failed_generation = stop_generation WHERE id = $1", [id]);
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

  /** Boat archived this running VM on its own (provider-stop.ts). Under the workspace lock, and only for the exact boot
   * that was observed, the stop is finished without the VM: running -> stopped directly (a `stopping` state would
   * cancel the waiting messages), credentials and execution contexts end, turns in flight are interrupted, and waiting
   * messages from people who still have access ask for one wake. Boat's answer is evidence only when it says the VM
   * stopped after our last resume and our own row shows no activity since; anything else is recorded, not acted on.
   * One row per boot and outcome; `observe` records only. */
  async providerStopped(binding: CloudV2ProviderStopBinding, evidence: { trigger: "dial" | "suspect" | "wake_check"; state: string; stoppedAt: Date | null;
    /** The provider did not report the stop's snapshot attempt completed: marked like a suspect stop of ours (stop_archive_failed_generation). */
    archiveSuspect?: boolean },
    mode: "observe" | "on"): Promise<CloudV2ProviderStopOutcome> {
    return withSystemTx(this.pool, async tx => {
      const row = (await tx.query<{ state: string; boat_sandbox_id: string | null; worker_boot_id: string | null; token_hash: string | null;
        access_epoch: string; stop_generation: string; recovery_attempt_id: string | null; execution_transition_id: string | null;
        archived_at: Date | null; active_at: Date | null; lease_renewed_at: Date | null }>(`SELECT state,boat_sandbox_id,worker_boot_id,
          encode(worker_token_hash,'hex') AS token_hash,access_epoch::text,stop_generation::text,recovery_attempt_id,execution_transition_id,
          archived_at,active_at,lease_renewed_at FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE`, [binding.workspaceId])).rows[0];
      if (!row || row.state !== "running" || row.recovery_attempt_id || row.execution_transition_id || row.archived_at ||
          row.boat_sandbox_id !== binding.sandboxId || row.worker_boot_id !== binding.bootId ||
          row.token_hash !== binding.workerTokenHash || row.access_epoch !== binding.accessEpoch) return "stale";
      // Read after the lock: a statement that waited on the row would have run this on its older snapshot.
      if ((await tx.query(`SELECT 1 FROM cloud_worker_runtime_handoffs WHERE workspace_id=$1 AND state IN ('committed','activating','rolling_back')`,
        [binding.workspaceId])).rowCount) return "stale";
      const record = async (outcome: CloudV2ProviderStopOutcome, generation: string, rewake = false) => {
        await tx.query(`INSERT INTO cloud_v2_provider_stops (workspace_id,sandbox_id,worker_boot_id,stop_generation,trigger,mode,provider_state,
            provider_stopped_at,rewake,outcome,active_at,lease_renewed_at)
          SELECT $1,$2,$3,$4::bigint,$5,$6,$7,$8,$9,$10,$11,$12 WHERE NOT EXISTS (SELECT 1 FROM cloud_v2_provider_stops
            WHERE workspace_id=$1 AND worker_boot_id=$3 AND outcome=$10)`, [binding.workspaceId, binding.sandboxId, binding.bootId, generation,
          evidence.trigger, mode, evidence.state.slice(0, 32), evidence.stoppedAt, rewake, outcome, row.active_at, row.lease_renewed_at]);
        return outcome;
      };
      // Boat said archived, but not after our resume, or our worker reported activity after Boat's stop time.
      const resumedAt = row.lease_renewed_at?.getTime() ?? -Infinity;
      if (evidence.state === "archived" && (!evidence.stoppedAt || evidence.stoppedAt.getTime() <= resumedAt ||
          row.active_at && row.active_at.getTime() > evidence.stoppedAt.getTime() + PROVIDER_STOP_ACTIVITY_MARGIN_MS))
        return record("contradicted", row.stop_generation);
      if (mode === "observe") return record("observed", row.stop_generation);
      const recent = (await tx.query<{ stops: number; wakes: number; global_wakes: number }>(`SELECT
          count(*) FILTER (WHERE outcome IN ('stopped','rewake') AND detected_at>clock_timestamp()-interval '10 minutes')::int AS stops,
          count(*) FILTER (WHERE outcome='rewake' AND workspace_id=$1 AND detected_at>clock_timestamp()-interval '1 hour')::int AS wakes,
          count(*) FILTER (WHERE outcome='rewake' AND detected_at>clock_timestamp()-interval '10 minutes')::int AS global_wakes
        FROM cloud_v2_provider_stops WHERE detected_at>clock_timestamp()-interval '1 hour'`, [binding.workspaceId])).rows[0]!;
      // Many at once across workspaces means a Boat incident, not this bug: stop nothing more until it passes.
      if (recent.stops >= PROVIDER_STOP_BRAKE_PER_10_MINUTES) return record("braked", row.stop_generation);
      const generation = (await tx.query<{ stop_generation: string }>(`UPDATE cloud_v2_workspaces SET state='stopped',
          stop_generation=stop_generation+1,stopped_at=clock_timestamp(),restart_stop_generation=NULL,
          stop_archive_failed_generation=CASE WHEN $2 THEN stop_generation+1 ELSE stop_archive_failed_generation END,
          error_code=CASE WHEN error_code='live_connection_unavailable' THEN NULL ELSE error_code END,
          worker_token_hash=NULL,worker_boot_id=NULL,attempts=0,next_attempt_at=NULL,updated_at=clock_timestamp()
        WHERE id=$1 RETURNING stop_generation::text`, [binding.workspaceId, evidence.archiveSuspect === true])).rows[0]!.stop_generation;
      await tx.query(`DELETE FROM cloud_v2_tokens WHERE workspace_id=$1`, [binding.workspaceId]);
      // Boat confirmed the shutdown, which is what releases these barriers on an ordinary stop too.
      await tx.query(`UPDATE cloud_v2_execution_contexts SET state='retired',retired_at=clock_timestamp(),
        reason=coalesce(reason,'cancelled'),revoked_at=coalesce(revoked_at,clock_timestamp()),material=NULL,environment_version_id=NULL
        WHERE workspace_id=$1 AND state<>'retired'`, [binding.workspaceId]);
      await confirmExecutionStop(tx, binding.workspaceId, generation);
      // The worker may already have passed these to its provider: never replayed, as when a new boot pulls.
      await tx.query(`UPDATE cloud_v2_prompt_outbox SET state=CASE WHEN cancel_requested THEN 'cancelled' ELSE 'interrupted' END,
        terminal_at=clock_timestamp(),updated_at=clock_timestamp() WHERE workspace_id=$1 AND state IN ('dispatching','accepted')`, [binding.workspaceId]);
      // Only a message whose sender still has access may carry the wake: wakePending takes the intent from the oldest one.
      const waking = `workspace_id=$1 AND state IN ('queued','inboxed') AND access_epoch=$2::bigint AND NOT cancel_requested AND payload IS NOT NULL
        AND EXISTS (SELECT 1 FROM cloud_v2_workspaces w WHERE w.id=$1
          AND (w.private_owner_user_id IS NULL OR w.private_owner_user_id=cloud_v2_prompt_outbox.creator_user_id)
          AND (cloud_v2_prompt_outbox.creator_user_id=w.creator_user_id OR w.execution_mode='active' AND EXISTS (
          SELECT 1 FROM organization_members m JOIN users u ON u.id=m.user_id WHERE m.org_id=w.org_id AND m.user_id=cloud_v2_prompt_outbox.creator_user_id
            AND u.auth_status='active' AND u.deleted_at IS NULL AND NOT ${memberOnHoldSql("m.org_id", "m.user_id")})))`;
      const waiting = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM cloud_v2_prompt_outbox WHERE ${waking}`,
        [binding.workspaceId, row.access_epoch])).rows[0]!.n;
      const rewake = waiting > 0 && recent.wakes < PROVIDER_STOP_WAKES_PER_HOUR && recent.global_wakes < PROVIDER_STOP_WAKES_PER_10_MINUTES;
      if (rewake) await tx.query(`UPDATE cloud_v2_prompt_outbox SET wake_after_stop=true WHERE ${waking}`, [binding.workspaceId, row.access_epoch]);
      return record(rewake ? "rewake" : waiting > 0 ? "capped" : "stopped", generation, rewake);
    });
  }

  /** Running workspaces holding a message that pull would deliver now but has not for 90 s: their VM may have stopped
   * without telling us. Oldest waiting message first. Database only. */
  async providerStopSuspects(limit = 16): Promise<CloudV2ProviderStopBinding[]> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<{ id: string; boat_sandbox_id: string; worker_boot_id: string; token_hash: string; access_epoch: string }>(
      `SELECT w.id,w.boat_sandbox_id,w.worker_boot_id,encode(w.worker_token_hash,'hex') AS token_hash,w.access_epoch::text,min(p.updated_at) AS waiting_since
       FROM cloud_v2_workspaces w JOIN cloud_v2_prompt_outbox p ON p.workspace_id=w.id
       JOIN cloud_v2_prompt_chats c ON c.workspace_id=p.workspace_id AND c.chat_id=p.chat_id
       WHERE w.state='running' AND w.archived_at IS NULL AND w.boat_sandbox_id IS NOT NULL AND w.worker_boot_id IS NOT NULL
         AND w.worker_token_hash IS NOT NULL AND p.state IN ('queued','inboxed') AND p.epoch=c.epoch AND p.access_epoch=w.access_epoch
         AND NOT p.cancel_requested AND p.payload IS NOT NULL AND (p.lease_until IS NULL OR p.lease_until<=clock_timestamp())
         AND p.updated_at<clock_timestamp()-interval '90 seconds'
         AND NOT EXISTS (SELECT 1 FROM cloud_v2_prompt_outbox older WHERE older.workspace_id=p.workspace_id AND older.chat_id=p.chat_id
           AND older.sequence<p.sequence AND older.state IN ('queued','inboxed','dispatching','accepted'))
       GROUP BY w.id ORDER BY waiting_since LIMIT $1`, [limit]));
    return rows.map(row => ({ workspaceId: row.id, sandboxId: row.boat_sandbox_id, bootId: row.worker_boot_id, workerTokenHash: row.token_hash, accessEpoch: row.access_epoch }));
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

  /** A running workspace's route asked for again came back different: kept only while it still runs on that machine. */
  async replaceWorkerRoute(id: string, sandboxId: string, url: string, portToken: unknown): Promise<boolean> {
    const result = await withSystemTx(this.pool, tx => tx.query(
      `UPDATE cloud_v2_workspaces SET worker_route_url=$3, worker_port_token=$4
       WHERE id=$1 AND boat_sandbox_id=$2 AND state='running'`, [id, sandboxId, url, JSON.stringify(portToken)]));
    return Boolean(result.rowCount);
  }

  async setWorkerRoute(id: string, sandboxId: string, url: string, portToken: unknown): Promise<boolean> {
    const result = await withSystemTx(this.pool, tx => tx.query(
      `UPDATE cloud_v2_workspaces SET worker_route_url=$3, worker_port_token=$4
       WHERE id=$1 AND boat_sandbox_id=$2 AND state IN ('creating','starting')`, [id, sandboxId, url, JSON.stringify(portToken)]));
    return Boolean(result.rowCount);
  }

  /** Refusing a runtime must not retire the workspace's current boot. */
  async workerHelloIdentity(token: string): Promise<CloudV2WorkerSession | null> {
    const { rows } = await withSystemStatement<Row & { execution_mode: "legacy" | "prepared" | "active"; execution_transition_id: string | null; recovery_attempt_id: string | null; access_epoch: string; login_revision: string }>(this.pool,
      sql`SELECT ${WORKSPACE_COLUMNS_SQL}, execution_mode, execution_transition_id, recovery_attempt_id, access_epoch::text, login_revision::text FROM cloud_v2_workspaces w
       WHERE worker_token_hash=decode(${SqlFragment.text(hashCloudV2Token(token).toString("hex"), /^[a-f0-9]{64}$/)}, 'hex')
         AND state IN ('creating','starting','running') AND ${CLOUD_V2_LIVE_ACCESS_SQL}`);
    const row = rows[0];
    return row ? { ...workspace(row), accessEpoch: row.access_epoch, loginRevision: row.login_revision, executionMode: row.execution_mode,
      ...(row.recovery_attempt_id ? { recoveryAttemptId: row.recovery_attempt_id } : {}),
      ...(row.execution_transition_id ? { executionTransitionId: row.execution_transition_id } : {}) } : null;
  }

  /** Bind the boot before configuration I/O, without publishing readiness.
   * Lifecycle delivery must not replace a credential once this boot claims it. */
  async beginWorkerHello(token: string, bootId: string, actingUser = false, runtimeSha256?: string, syncContext = false, recovery = false, bootTimings = false, transaction?: Tx, messageAuthority = false): Promise<CloudV2WorkerSession | null> {
    let authorityMode: "message-authority-v1" | undefined;
    const begin = async (tx: Tx) => {
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
        const bound = await this.prompts.execution.boots.bind(tx, { token, bootId }, current.previous_boot_id, messageAuthority);
        await bindExecutionActivationBoot(tx, bound, runtimeSha256);
        if (bound.authority_mode === "message-authority-v1") authorityMode = "message-authority-v1";
      }
      if (current && current.previous_boot_id !== bootId) await notifyCloudV2WorkerBoot(tx, current.id, bootId, bootTimings ? "hello" : "legacy");
      return result;
    };
    const { rows } = await (transaction ? begin(transaction) : withSystemTx(this.pool, begin));
    const row = rows[0];
    return row ? { ...workspace(row), accessEpoch: row.access_epoch, loginRevision: row.login_revision, executionMode: row.execution_mode,
      ...(row.recovery_attempt_id ? { recoveryAttemptId: row.recovery_attempt_id } : {}), ...(authorityMode ? { authorityMode } : {}) } : null;
  }

  /** A starting workspace whose worker hello was refused for its runtime: the
   * lifecycle steps it now and installs the pin instead of keeping that runtime. */
  async refuseWorkerRuntime(token: string): Promise<void> {
    await withSystemTx(this.pool, tx => tx.query(`WITH refused AS (UPDATE cloud_v2_workspaces
        SET error_code='worker_runtime_mismatch', next_attempt_at=clock_timestamp()
        WHERE worker_token_hash=$1 AND state='starting' AND worker_boot_id IS NULL
          AND error_code IS DISTINCT FROM 'worker_runtime_mismatch' RETURNING id)
      SELECT pg_notify('zeros_cloud_v2_lifecycle', '') FROM refused`, [hashCloudV2Token(token)]));
  }

  async acceptWorkerHello(token: string, bootId: string, proof?: { accessEpoch: string; loginRevision: string }, transaction?: Tx): Promise<CloudV2WorkerSession | null> {
    const accept = async (tx: Tx) => {
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
         -- A boot that reaches running supersedes an earlier boot's failure; a running boot keeps its own condition.
         error_code=CASE WHEN prior.environment_ready AND prior.prior_state<>'running' THEN NULL ELSE error_code END,
         active_at=CASE WHEN state='running' OR NOT prior.environment_ready THEN active_at ELSE clock_timestamp() END,
         updated_at=CASE WHEN state='running' OR (state='starting' AND NOT prior.environment_ready) THEN updated_at ELSE clock_timestamp() END
       FROM prior WHERE w.id=prior.prior_id
       RETURNING ${COLUMNS.replace(/\b(\w+)\b/g, "w.$1")}, execution_mode, access_epoch::text, login_revision::text, prior.prior_state,
         greatest(0, extract(epoch FROM (clock_timestamp()-prior.prior_updated_at))*1000)::float8 AS hello_ms`,
      [hashCloudV2Token(token), bootId, proof?.accessEpoch ?? null, proof?.loginRevision ?? null]);
      const ready = result.rows[0];
      if (ready?.state === "running" && ready.prior_state !== "running") await notifyCloudV2WorkerReady(tx, ready.id);
      return result;
    };
    const { rows } = await (transaction ? accept(transaction) : withSystemTx(this.pool, accept));
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
    await withSystemTx(this.pool, tx => this.applyWorkerHistory(tx, token, bootId, sequence, input, historyDigests));
  }

  /** history-batch-v1: frames that queued together (any chats) commit in one transaction. Frame i takes sequence
   * first + i, so every per-frame rule (replay, gaps, replacement markers) applies exactly as for single frames. */
  /** events (turn-events-v1) run after the frames in the same transaction; a replayed batch (frames already applied)
   * still runs them, since each event is idempotent. */
  async writeWorkerHistoryBatch<T = void>(token: string, bootId: string, first: number, frames: readonly HistoryInput[], historyDigests = false,
    events?: (tx: Tx) => Promise<T>): Promise<T | undefined> {
    return withSystemTx(this.pool, async tx => {
      for (const [index, frame] of frames.entries()) await this.applyWorkerHistory(tx, token, bootId, first + index, frame, historyDigests);
      return events ? events(tx) : undefined;
    });
  }

  private async applyWorkerHistory(tx: Tx, token: string, bootId: string, sequence: number, input: HistoryInput, historyDigests: boolean): Promise<void> {
    const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    {
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
    }
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
         -- Pending work holds the stop only while it can still be reported: without live access the worker is refused.
         AND (NOT ${LIVE_ACCESS} OR NOT EXISTS (SELECT 1 FROM cloud_v2_prompt_outbox p WHERE p.workspace_id=w.id
           AND p.state IN ('queued','inboxed','dispatching','accepted') AND p.access_epoch=w.access_epoch)
         AND NOT EXISTS (SELECT 1 FROM local_command_requests r WHERE r.workspace_id=w.id AND r.phase IN ('pending','claimed')))
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
        AND (NOT ${LIVE_ACCESS} OR NOT EXISTS (SELECT 1 FROM cloud_v2_prompt_outbox p WHERE p.workspace_id=w.id
          AND p.state IN ('queued','inboxed','dispatching','accepted') AND p.access_epoch=w.access_epoch)
        AND NOT EXISTS (SELECT 1 FROM local_command_requests r WHERE r.workspace_id=w.id AND r.phase IN ('pending','claimed')))
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
       RETURNING ${LIFECYCLE_COLUMNS.replace(/\b(\w+)\b/g, "w.$1")}, w.attempts, ${lifecycleSubmodules("w")}`,
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
       RETURNING ${LIFECYCLE_COLUMNS}, attempts, ${lifecycleSubmodules("cloud_v2_workspaces")}`, [id, generation, sandboxId, renewedAt]));
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
           checkpoint_saved_at=clock_timestamp(), checkpoint_confirmed_at=NULL, checkpoint_stop_generation=stop_generation, checkpoint_error=NULL, checkpoint_partial=$7,
           lost_work_restored=NULL, lost_work_since=NULL, lost_work_machine=NULL WHERE id=$1`,
        [id, checkpoint.object, JSON.stringify(checkpoint.key), checkpoint.sha256, checkpoint.bytes, reuse ? JSON.stringify(reuse) : null, !!checkpoint.partial]);
      return { replaced: rows[0].checkpoint_object };
    });
  }

  /** C4B: records the submodules a restore or a held apply could not put back (each kept with the first time it was
   * recorded) and drops the ones whose held part went back. One row, under its lock; nothing when there is nothing to do. */
  async recordUnrestoredSubmodules(id: string, change: { failed: readonly Omit<CloudV2UnrestoredSubmodule, "since">[];
    restored: readonly { position: number; path: string }[] }): Promise<void> {
    if (!change.failed.length && !change.restored.length) return;
    await withSystemTx(this.pool, async tx => {
      const { rows } = await tx.query<{ submodules_unrestored: unknown; now: Date }>(
        "SELECT submodules_unrestored, clock_timestamp() AS now FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE", [id]);
      if (!rows[0]) return;
      const same = (a: { position: number; path: string }, b: { position: number; path: string }) => a.position === b.position && a.path === b.path;
      let entries = unrestoredSubmodules(rows[0].submodules_unrestored).filter(entry => !change.restored.some(done => same(done, entry)));
      for (const failed of change.failed) {
        const known = entries.find(entry => same(entry, failed));
        entries = known ? entries.map(entry => entry === known ? { ...known, reason: failed.reason, folder: failed.folder } : entry)
          : [...entries, { ...failed, since: rows[0].now.toISOString() }];
      }
      await tx.query("UPDATE cloud_v2_workspaces SET submodules_unrestored=$2 WHERE id=$1", [id, entries.length ? JSON.stringify(entries.slice(0, 320)) : null]);
    });
  }

  /** The VM found everything as `object` holds it: that checkpoint now also
   * covers this stop. Refused unless `object` is still the one compared. */
  async checkpointUnchanged(id: string, sandboxId: string, generation: string, object: string, scope: CloudV2CheckpointScope = "stop"): Promise<boolean> {
    const result = await withSystemTx(this.pool, tx => tx.query(
      `UPDATE cloud_v2_workspaces SET checkpoint_stop_generation=stop_generation, checkpoint_confirmed_at=clock_timestamp(), checkpoint_error=NULL
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
  async stopCurrent(id: string, generation: string, state: "stopping" | "stopped" = "stopping"): Promise<boolean> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query(
      `SELECT 1 FROM cloud_v2_workspaces WHERE id=$1 AND state=$3 AND stop_generation=$2::bigint`, [id, generation, state]));
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
  async claimCheckpointRetry(input: { leaseMs: number; firstDelayMs: number; windowMs: number; excludeIds?: readonly string[];
    /** Retention backups: the first waits `firstDelayMs` after the later of the stop and retention's start, a stop whose probe
     * found nothing is never backed up, and no backup is claimed while `forksPerHour` forks began in the last hour. */
    retention?: { forksPerHour: number; maintenance?: { perHour: number; perDay: number } } }):
    Promise<(CloudV2LifecycleWorkspace & { retry: CloudV2CheckpointRetry }) | null> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<RetryRow>(
      `WITH due AS MATERIALIZED (
         SELECT w.id FROM cloud_v2_workspaces w
         WHERE NOT (id = ANY($4::uuid[])) AND (
           (checkpoint_retry_fork IS NOT NULL AND state NOT IN ('deleting','deleted')
             AND coalesce(checkpoint_retry_at, '-infinity') <= clock_timestamp())
           OR (state = 'stopped' AND boat_sandbox_id IS NOT NULL AND NOT restore_pending
             AND checkpoint_stop_generation IS DISTINCT FROM stop_generation
             -- Retention S3: an archive's final backup counts its 12 days from the archive, and goes first.
             AND (coalesce(stopped_at, updated_at) > clock_timestamp() - make_interval(secs => $3::double precision / 1000)
               OR ($5::boolean AND ${FINAL_BACKUP_PENDING}))
             -- Retention S2: not while a maintenance wake has the machine running.
             AND (maintenance_attempt IS NULL OR maintenance_started_at < clock_timestamp() - interval '10 minutes')
             AND (checkpoint_retry_generation IS DISTINCT FROM stop_generation OR checkpoint_retry_exhausted_at IS NULL)
             AND CASE WHEN checkpoint_retry_generation IS NOT DISTINCT FROM stop_generation THEN coalesce(checkpoint_retry_at, '-infinity')
               WHEN $5::boolean AND ${FINAL_BACKUP_PENDING} THEN '-infinity'
               ELSE CASE WHEN $5::boolean THEN greatest(coalesce(stopped_at, updated_at), coalesce(retention_started_at, '-infinity'))
                 ELSE coalesce(stopped_at, updated_at) END + make_interval(secs => $2::double precision / 1000) END <= clock_timestamp()
             AND (NOT $5::boolean OR backup_probe IS DISTINCT FROM 'clean' OR backup_probe_generation IS DISTINCT FROM stop_generation
               OR ${FINAL_BACKUP_PENDING})
             AND (NOT $5::boolean OR (SELECT count(*) FROM cloud_v2_workspaces f
               WHERE f.backup_forked_at > clock_timestamp() - interval '1 hour') < $6::integer)
             AND ($7::integer IS NULL OR ((SELECT count(*) FROM cloud_v2_maintenance_wakes m WHERE m.started_at > clock_timestamp() - interval '1 hour') < $7::integer
               AND (SELECT count(*) FROM cloud_v2_maintenance_wakes m WHERE m.started_at > clock_timestamp() - interval '1 day') < $8::integer))))
         ORDER BY CASE WHEN $5::boolean AND ${FINAL_BACKUP_PENDING} THEN 0 ELSE 1 END, coalesce(checkpoint_retry_at, stopped_at, updated_at)
         LIMIT 1 FOR UPDATE SKIP LOCKED)
       UPDATE cloud_v2_workspaces w SET
         checkpoint_retry_attempts = CASE WHEN w.checkpoint_retry_generation IS NOT DISTINCT FROM w.stop_generation THEN w.checkpoint_retry_attempts ELSE 0 END,
         checkpoint_retry_exhausted_at = CASE WHEN w.checkpoint_retry_generation IS NOT DISTINCT FROM w.stop_generation THEN w.checkpoint_retry_exhausted_at END,
         checkpoint_retry_generation = w.stop_generation,
         checkpoint_retry_at = clock_timestamp() + make_interval(secs => $1::double precision / 1000)
       FROM due WHERE w.id = due.id
       RETURNING ${LIFECYCLE_COLUMNS.replace(/\b(\w+)\b/g, "w.$1")},
         CASE WHEN $5::boolean AND ${FINAL_BACKUP_PENDING} THEN greatest(coalesce(w.stopped_at, w.updated_at), w.archived_at)
           ELSE coalesce(w.stopped_at, w.updated_at) END AS retry_stopped_at,
         w.checkpoint_retry_generation, w.checkpoint_retry_attempts, w.checkpoint_retry_exhausted_at, ${lifecycleSubmodules("w")}`,
      [input.leaseMs, input.firstDelayMs, input.windowMs, input.excludeIds ?? [], input.retention !== undefined, input.retention?.forksPerHour ?? 0,
        input.retention?.maintenance?.perHour ?? null, input.retention?.maintenance?.perDay ?? null]));
    const row = rows[0];
    return row ? { ...lifecycleWorkspace(row), retry: { generation: row.checkpoint_retry_generation, attempts: row.checkpoint_retry_attempts,
      stoppedAt: row.retry_stopped_at.toISOString(), exhaustedAt: row.checkpoint_retry_exhausted_at?.toISOString() ?? null } } : null;
  }

  /** Records a retry's fork before it is requested, while the latest stop of
   * `source` still lacks a checkpoint and no other fork is recorded. */
  async beginCheckpointFork(id: string, generation: string, fork: Pick<CloudV2CheckpointFork, "attempt" | "name" | "source">, retention = false): Promise<CloudV2CheckpointFork | null> {
    const { rows } = await withSystemTx(this.pool, async tx => {
      const begun = await tx.query<{ checkpoint_retry_fork: unknown }>(
      `UPDATE cloud_v2_workspaces SET checkpoint_retry_attempts = checkpoint_retry_attempts + 1,
         backup_forked_at = CASE WHEN $6::boolean THEN clock_timestamp() ELSE backup_forked_at END,
         checkpoint_retry_fork = jsonb_build_object('attempt',$3::text,'name',$4::text,'source',$2::text,'requestedAt',clock_timestamp())
       WHERE id=$1 AND state='stopped' AND boat_sandbox_id=$2 AND NOT restore_pending AND stop_generation=$5::bigint
         AND checkpoint_stop_generation IS DISTINCT FROM stop_generation AND checkpoint_retry_generation=$5::bigint
         AND checkpoint_retry_fork IS NULL
       RETURNING checkpoint_retry_fork`, [id, fork.source, fork.attempt, fork.name, generation, retention]);
      // Retention counts each backup fork in the shared maintenance budget, as a machine start.
      if (begun.rows[0] && retention) await tx.query(
        "INSERT INTO cloud_v2_maintenance_wakes (workspace_id, attempt, kind) VALUES ($1, $2, 'backup_fork') ON CONFLICT (attempt) DO NOTHING", [id, fork.attempt]);
      return begun;
    });
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
    await withSystemTx(this.pool, async tx => {
      await tx.query(`UPDATE cloud_v2_workspaces SET checkpoint_retry_fork=NULL WHERE id=$1 AND checkpoint_retry_fork->>'attempt'=$2`, [id, attempt]);
      // Retention's record of that fork's machine time (beginCheckpointFork counted it) ends with it: "stopped" when the
      // workspace now has this stop's backup, "failed" otherwise. Only once, and only for this fork's own row.
      await tx.query(`UPDATE cloud_v2_maintenance_wakes m SET finished_at=clock_timestamp(),
          outcome=CASE WHEN w.checkpoint_stop_generation IS NOT DISTINCT FROM w.stop_generation THEN 'stopped' ELSE 'failed' END
        FROM cloud_v2_workspaces w WHERE w.id=m.workspace_id AND m.workspace_id=$1 AND m.attempt::text=$2 AND m.kind='backup_fork'
          AND m.finished_at IS NULL`, [id, attempt]);
    });
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
    const extra = request.fork && SANDBOX.test(request.fork) ? { fork: request.fork } : {};
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
      const active = await restoreBuild(tx, rows[0].org_id);
      if (!active) return "no_computer";
      const setup = originalSetupBuild(rows[0].computer_build_id, rows[0].restore_create);
      const image = restoreImage(active, rows[0]);
      const recorded = await tx.query<{ restore_attempt: string; restore_create: CloudV2RestoreCreate }>(
        `UPDATE cloud_v2_workspaces SET restore_pending=true, restore_attempt=$3, boat_sandbox_id=NULL, computer_build_id=$2, execution_restore_claimed_at=NULL,
           restore_create=jsonb_build_object('from',$4::text,'name',$5::text,'env',$6::jsonb,'requestedAt',clock_timestamp(),'prune',$8::jsonb) || $7::jsonb || $9::jsonb,
           worker_route_url=NULL, worker_port_token=NULL, worker_token_hash=NULL, worker_boot_id=NULL
         WHERE id=$1 RETURNING restore_attempt, restore_create`,
        [id, active.id, request.attempt, image.from, request.name, JSON.stringify(request.env), JSON.stringify(setup), JSON.stringify(image.prune), JSON.stringify(extra)]);
      return { attempt: recorded.rows[0]!.restore_attempt, create: restoreCreate(recorded.rows[0]!.restore_create)! };
    });
  }

  /** Retention's clean rebuild of a lost VM (lifecycle.ts cleanReplacement) takes its image as beginRestore does: from
   * the organization's active Cloud Computer build, re-pinning the workspace to it in the same transaction. Never the
   * workspace's own earlier pin: cleanup deletes a replaced build's snapshot as soon as a newer one is live, and the
   * rebuild needs nothing from it (its checkout and branches come from GitHub). Null with no active build. */
  async pinRestoreImage(id: string): Promise<CloudV2WorkspaceImage | null> {
    return withSystemTx(this.pool, async tx => {
      const row = (await tx.query<{ org_id: string; repository: string; source_repositories: string[] | null }>(
        "SELECT org_id, repository, source_repositories FROM cloud_v2_workspaces WHERE id=$1 AND state='starting' FOR UPDATE", [id])).rows[0];
      if (!row) return null;
      const active = await restoreBuild(tx, row.org_id);
      if (!active) return null;
      await tx.query("UPDATE cloud_v2_workspaces SET computer_build_id=$2 WHERE id=$1", [id, active.id]);
      return restoreImage(active, row);
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

  /** Retention: Boat refused this attempt's ready copy fork before making anything; it creates from the Cloud Computer instead. */
  async restoreForkRefused(id: string, attempt: string): Promise<void> {
    await withSystemTx(this.pool, tx => tx.query(
      `UPDATE cloud_v2_workspaces SET restore_create = restore_create - 'fork' WHERE id=$1 AND restore_attempt=$2 AND restore_pending`, [id, attempt]));
  }

  /** Retention: what this stop's probe found and whether it verified the worker off, recorded only
   * while that stop is the latest. Retention's clocks start at the first. */
  async recordStopProbe(id: string, stopGeneration: string, probe: BackupProbe, workerOff: boolean): Promise<boolean> {
    const result = await withSystemTx(this.pool, tx => tx.query(
      `UPDATE cloud_v2_workspaces SET backup_probe=$3, backup_probe_generation=$2::bigint,
         worker_off_unverified_at=CASE WHEN $4::boolean THEN NULL ELSE coalesce(worker_off_unverified_at, clock_timestamp()) END,
         retention_started_at=coalesce(retention_started_at, clock_timestamp())
       WHERE id=$1 AND state='stopping' AND stop_generation=$2::bigint`, [id, stopGeneration, probe, workerOff]));
    return Boolean(result.rowCount);
  }

  /** Retention S2: the next due maintenance wake, deadline-first, within the shared budget of machine
   * starts (wakes and backup forks). Due: a sleeping workspace 10 days (plus a stable 0–12 h spread)
   * after its machine last stopped (a person's stop or a wake's, whichever is later; greatest() skips
   * a null); an archived one on the same schedule, once per archive.
   * A wake whose mark went stale (its step died) is taken over. Serialized so the budget is exact. */
  async claimMaintenanceWake(input: { attempt: string; perHour: number; perDay: number; staleMs: number; excludeIds?: readonly string[] }):
    Promise<(CloudV2LifecycleWorkspace & { maintenanceWake: { attempt: string; archived: boolean; scrub?: ArchiveScrubMode } }) | null> {
    return withSystemTx(this.pool, async tx => {
      await tx.query("/* lock_purpose='cloud-v2-maintenance-claim' */ SELECT pg_advisory_xact_lock(hashtextextended('cloud-v2-maintenance-claim',0))");
      const budget = (await tx.query<{ hour: number; day: number }>(`SELECT
        count(*) FILTER (WHERE started_at > clock_timestamp() - interval '1 hour')::int AS hour, count(*)::int AS day
        FROM cloud_v2_maintenance_wakes WHERE started_at > clock_timestamp() - interval '1 day'`)).rows[0]!;
      if (budget.hour >= input.perHour || budget.day >= input.perDay) return null;
      const due = (await tx.query<{ id: string; maintenance_attempt: string | null }>(
        `SELECT id, maintenance_attempt FROM cloud_v2_workspaces
         WHERE state='stopped' AND boat_sandbox_id IS NOT NULL AND NOT restore_pending AND checkpoint_retry_fork IS NULL
           AND NOT (id = ANY($1::uuid[]))
           AND (maintenance_attempt IS NULL OR maintenance_started_at < clock_timestamp() - make_interval(secs => $2::double precision / 1000))
           AND greatest(machine_stopped_at, stopped_at) IS NOT NULL
           -- A failed wake backs off an hour; one that found the machine gone is not repeated for this stop.
           AND NOT EXISTS (SELECT 1 FROM cloud_v2_maintenance_wakes m WHERE m.workspace_id=cloud_v2_workspaces.id AND m.kind='wake'
             AND (m.started_at > clock_timestamp() - interval '1 hour'
               OR (m.outcome='gone' AND m.started_at > greatest(cloud_v2_workspaces.machine_stopped_at, cloud_v2_workspaces.stopped_at))))
           AND greatest(machine_stopped_at, stopped_at) + interval '10 days' + make_interval(secs => abs(hashtext(id::text)) % 43200) <= clock_timestamp()
           -- Archived: one more wake on the machine's own schedule, then none. It scrubs the machine, so it
           -- waits for the archive's final backup, but never past 12 days since the machine's stop: then
           -- it runs as an ordinary wake (no scrub) and the next one, 10 days later, is the archived wake.
           AND (archived_at IS NULL OR archive_wake_done_at IS NULL OR archive_wake_done_at < archived_at)
           AND (archived_at IS NULL OR NOT ${FINAL_BACKUP_PENDING.replace(/\bw\./g, "cloud_v2_workspaces.")}
             OR greatest(machine_stopped_at, stopped_at) + interval '12 days' <= clock_timestamp())
         ORDER BY greatest(machine_stopped_at, stopped_at) LIMIT 1 FOR UPDATE SKIP LOCKED`, [input.excludeIds ?? [], input.staleMs])).rows[0];
      if (!due) return null;
      if (due.maintenance_attempt) await tx.query(`UPDATE cloud_v2_maintenance_wakes SET outcome='failed', finished_at=clock_timestamp()
        WHERE attempt=$1 AND finished_at IS NULL`, [due.maintenance_attempt]);
      const { rows } = await tx.query<LifecycleRow & { scrub_mode: ArchiveScrubMode | null }>(`UPDATE cloud_v2_workspaces w SET maintenance_attempt=$2, maintenance_phase='waking',
          maintenance_started_at=clock_timestamp() WHERE w.id=$1 RETURNING ${LIFECYCLE_COLUMNS.replace(/\b(\w+)\b/g, "w.$1")},
          CASE WHEN w.archived_at IS NULL OR (w.archive_wake_done_at IS NOT NULL AND w.archive_wake_done_at >= w.archived_at) OR ${FINAL_BACKUP_PENDING} THEN NULL
            WHEN w.checkpoint_stop_generation IS NOT DISTINCT FROM w.stop_generation THEN 'backup'
            -- Raw probe: after a suspect archive too, reseeding from GitHub (which a clean probe says holds it all) beats keeping its files.
            WHEN w.backup_probe = 'clean' AND w.backup_probe_generation = w.stop_generation
              AND w.changed_since_stop_generation IS DISTINCT FROM w.stop_generation THEN 'reseed' ELSE 'keep' END AS scrub_mode,
          ${lifecycleSubmodules("w")}`, [due.id, input.attempt]);
      await tx.query(`INSERT INTO cloud_v2_maintenance_wakes (workspace_id, attempt, kind, deadline_at)
        SELECT id, $2, 'wake', greatest(machine_stopped_at, stopped_at) + interval '14 days' FROM cloud_v2_workspaces WHERE id=$1`, [due.id, input.attempt]);
      const row = rows[0]!;
      return { ...lifecycleWorkspace(row), maintenanceWake: { attempt: input.attempt, archived: row.archived_at !== null,
        ...(row.scrub_mode ? { scrub: row.scrub_mode } : {}) } };
    });
  }

  /** The fence a user wake honors: 'stopping' is set only while the workspace is still stopped and
   * this wake still owns it, in the same statement that checks both. */
  async beginMaintenanceStop(id: string, attempt: string): Promise<boolean> {
    const result = await withSystemTx(this.pool, tx => tx.query(
      `UPDATE cloud_v2_workspaces SET maintenance_phase='stopping' WHERE id=$1 AND state='stopped' AND maintenance_attempt=$2
         AND maintenance_phase='waking'`, [id, attempt]));
    return Boolean(result.rowCount);
  }

  /** Retention S3: a person's own call on the workspace that does not already stamp active_at, for the
   * 30-day clock. At most every 30 seconds; inside that window it takes no lock at all, and outside it
   * never waits for a row another transaction holds (that call simply goes unrecorded). */
  async personActivity(id: string): Promise<void> {
    await withSystemTx(this.pool, tx => tx.query(
      `WITH due AS (SELECT id FROM cloud_v2_workspaces WHERE id=$1
          AND coalesce(person_activity_at, '-infinity') < clock_timestamp() - interval '30 seconds' FOR NO KEY UPDATE SKIP LOCKED)
       UPDATE cloud_v2_workspaces w SET person_activity_at=clock_timestamp() FROM due WHERE w.id=due.id`, [id]));
  }

  /** Retention S3: Keep, set or cleared by anyone who can use the workspace (its creator in legacy mode,
   * any eligible member in shared execution, a personal project's member only). Counts as activity. Keep
   * exists only for a workspace that is not archived (owner decision, 2026-11-22): setting it on an archived
   * one is refused, clearing it there changes nothing, and every archive clears it. */
  async setKeep(id: string, userId: string, keep: boolean): Promise<CloudV2Workspace> {
    return withSystemTx(this.pool, async tx => {
      const current = (await tx.query<Row>(`SELECT ${COLUMNS} FROM cloud_v2_workspaces w
        WHERE w.id=$1 AND w.state <> 'deleted' AND ${cloudV2ActorAccess("$2")} AND ${LIVE_ACCESS} FOR UPDATE`, [id, userId])).rows[0];
      if (!current) throw notFound();
      if (current.state === "deleting") throw new HttpError(409, "workspace_deleting", "This cloud workspace is being deleted");
      if (current.archived_at) {
        if (keep) throw new HttpError(409, "keep_refused_archived", "Keep is only for a workspace that is not archived. Open it first.");
        return workspace(current);
      }
      const { rows } = await tx.query<Row>(
        `UPDATE cloud_v2_workspaces w SET keep_set_at = CASE WHEN $2::boolean THEN coalesce(keep_set_at, clock_timestamp()) END,
           keep_set_by = CASE WHEN NOT $2::boolean THEN NULL WHEN keep_set_at IS NULL THEN $3::uuid ELSE keep_set_by END,
           person_activity_at = clock_timestamp()
         WHERE w.id=$1 RETURNING ${COLUMNS}`, [id, keep, userId]);
      return workspace(rows[0]!);
    });
  }

  /** Retention S3: the 30-day clock starts the first time retention applies to a workspace, never from
   * its history. Bounded per call; a later start only ever archives later. */
  async startRetentionClocks(limit: number): Promise<number> {
    const result = await withSystemTx(this.pool, tx => tx.query(
      `UPDATE cloud_v2_workspaces w SET retention_started_at=clock_timestamp()
       WHERE w.id IN (SELECT id FROM cloud_v2_workspaces WHERE retention_started_at IS NULL AND state NOT IN ('deleting','deleted')
         LIMIT $1 FOR UPDATE SKIP LOCKED)`, [limit]));
    return result.rowCount ?? 0;
  }

  /** Retention S3's automatic archive: up to `limit` sleeping workspaces, oldest clock first, with no
   * activity by anyone for `inactiveMs` since the later of their last activity and retention's start, not
   * kept, with no wake, queued prompt, maintenance wake or live execution context, all rechecked in the
   * same statement. No mail (owner decision, 2026-11-22): the document's archiveReason and dates say it. */
  async archiveInactive(input: { inactiveMs: number; limit: number }): Promise<{ archived: { id: string; creatorUserId: string | null }[] }> {
    return withSystemTx(this.pool, async tx => {
      const { rows } = await tx.query<{ id: string; creator_user_id: string | null }>(
        `WITH due AS MATERIALIZED (
           SELECT w.id FROM cloud_v2_workspaces w
           WHERE w.archived_at IS NULL AND w.keep_set_at IS NULL AND w.state IN ('stopped','failed') AND w.retention_started_at IS NOT NULL
             AND greatest(w.active_at, w.person_activity_at, w.retention_started_at) < clock_timestamp() - make_interval(secs => $1::double precision / 1000)
             AND w.maintenance_attempt IS NULL AND NOT w.restore_pending
             AND NOT ${PENDING_WORKER_PROMPTS_SQL.text}
             AND NOT EXISTS (SELECT 1 FROM cloud_v2_execution_contexts e WHERE e.workspace_id=w.id AND e.state='active' AND e.expires_at > clock_timestamp())
           ORDER BY greatest(w.active_at, w.person_activity_at, w.retention_started_at) LIMIT $2 FOR UPDATE SKIP LOCKED)
         UPDATE cloud_v2_workspaces w SET archived_at=clock_timestamp(), archive_reason='inactive', keep_set_at=NULL, keep_set_by=NULL FROM due
         WHERE w.id=due.id AND w.archived_at IS NULL AND w.keep_set_at IS NULL AND w.state IN ('stopped','failed')
         RETURNING w.id, w.creator_user_id`, [input.inactiveMs, input.limit]);
      return { archived: rows.map(row => ({ id: row.id, creatorUserId: row.creator_user_id })) };
    });
  }

  /** Retention S3: a departed member's personal-project workspaces, archived at once. The membership
   * trigger does this in the removal's own transaction but skips a row another transaction holds; this
   * sweep archives anything it skipped, and returns those still running or starting, for a stop. */
  async archiveDepartedPrivate(limit: number): Promise<string[]> {
    return withSystemTx(this.pool, async tx => {
      const departed = `w.private_owner_user_id IS NOT NULL AND w.state NOT IN ('deleting','deleted')
        AND NOT EXISTS (SELECT 1 FROM organization_members m WHERE m.org_id=w.org_id AND m.user_id=w.private_owner_user_id)`;
      await tx.query(`UPDATE cloud_v2_workspaces SET archived_at=clock_timestamp(), archive_reason='member_left', keep_set_at=NULL, keep_set_by=NULL
        WHERE id IN (SELECT w.id FROM cloud_v2_workspaces w WHERE w.archived_at IS NULL AND ${departed} LIMIT $1 FOR UPDATE SKIP LOCKED)`, [limit]);
      return (await tx.query<{ id: string }>(`SELECT w.id FROM cloud_v2_workspaces w
        WHERE w.archived_at IS NOT NULL AND w.state IN ('running','starting') AND ${departed} LIMIT $1`, [limit])).rows.map(row => row.id);
    });
  }

  /** Retention S3: a member re-added gets their personal-project workspaces back (the trigger does it at
   * once and skips a held row; this sweeps what it skipped). Only that member's own private rows. */
  async restoreReturningPrivate(limit: number): Promise<number> {
    return withSystemTx(this.pool, async tx => {
      // As the membership trigger: under the team-ownership switch that cleared it, for an eligible member only.
      await tx.query("SELECT set_config('app.cloud_team_ownership','1',true)");
      const result = await tx.query(
        `UPDATE cloud_v2_workspaces SET creator_user_id=private_owner_user_id
         WHERE id IN (SELECT w.id FROM cloud_v2_workspaces w WHERE w.private_owner_user_id IS NOT NULL AND w.creator_user_id IS NULL
           AND w.creator_absent_reason='left' AND w.state NOT IN ('deleting','deleted')
           AND EXISTS (SELECT 1 FROM organization_members m JOIN users u ON u.id=m.user_id AND u.auth_status='active' AND u.deleted_at IS NULL
             WHERE m.org_id=w.org_id AND m.user_id=w.private_owner_user_id AND NOT ${memberOnHoldSql("m.org_id", "m.user_id")})
           LIMIT $1 FOR UPDATE SKIP LOCKED)`, [limit]);
      return result.rowCount ?? 0;
    });
  }

  /** Stops an archived workspace that is still running or starting, through the ordinary archive path
   * (the same intent a manual archive records). Never waits for a held row: the next sweep retries. */
  async archiveForSystem(id: string): Promise<boolean> {
    return withSystemTx(this.pool, async tx => {
      const row = (await tx.query<Row>(`SELECT ${COLUMNS} FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE SKIP LOCKED`, [id])).rows[0];
      if (!row?.archived_at || (row.state !== "running" && row.state !== "starting")) return false;
      const { moved } = await this.lifecycleIntent(tx, id, row, "archive");
      await clearStoppedExecutionTransition(tx, id);
      return moved;
    });
  }

  /** Retention S4, phase one of a backup's removal: for up to `limit` archived, sleeping workspaces whose removal
   * date has come, one statement clears the row's backup (object, sealed key, digest) and records the object for
   * deletion. Rechecks the archive and the sleeping state in that statement, so an open in flight keeps its backup. */
  async claimBackupRemovals(limit: number): Promise<{ id: string; workspaceId: string; object: string }[]> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<{ id: string; workspace_id: string; object: string }>(
      `WITH due AS MATERIALIZED (
         SELECT w.id, w.checkpoint_object AS object FROM cloud_v2_workspaces w
         WHERE w.archived_at IS NOT NULL AND w.state IN ('stopped','failed') AND w.checkpoint_object IS NOT NULL
           AND w.retention_started_at IS NOT NULL AND ${CLOUD_V2_BACKUP_REMOVAL_AT_SQL} <= clock_timestamp()
           AND w.maintenance_attempt IS NULL AND NOT w.restore_pending AND w.checkpoint_retry_fork IS NULL
         ORDER BY ${CLOUD_V2_BACKUP_REMOVAL_AT_SQL} LIMIT $1 FOR UPDATE SKIP LOCKED
       ), cleared AS (
         UPDATE cloud_v2_workspaces w SET checkpoint_object=NULL, checkpoint_key=NULL, checkpoint_sha256=NULL, checkpoint_bytes=NULL,
             checkpoint_saved_at=NULL, checkpoint_confirmed_at=NULL, checkpoint_reuse=NULL, checkpoint_stop_generation=NULL
           FROM due WHERE w.id=due.id AND w.archived_at IS NOT NULL AND w.state IN ('stopped','failed') AND w.checkpoint_object=due.object
           AND NOT w.restore_pending
           RETURNING w.id, due.object
       )
       INSERT INTO cloud_v2_backup_removals (workspace_id, object) SELECT id, object FROM cleared
       RETURNING id, workspace_id, object`, [limit]));
    return rows.map(row => ({ id: row.id, workspaceId: row.workspace_id, object: row.object }));
  }

  /** Phase two's work list: recorded removals not yet done, with the object the row holds now (a later stop's,
   * which the prune must keep) and the upload horizon (an upload in flight waits). */
  async pendingBackupRemovals(limit: number): Promise<{ id: string; workspaceId: string; object: string; current: string | null; uploadsUntil: string | null;
    requestedAt: Date }[]> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<{ id: string; workspace_id: string; object: string; current: string | null; checkpoint_uploads: Record<string, string>; requested_at: Date }>(
      `SELECT r.id, r.workspace_id, r.object, w.checkpoint_object AS current, w.checkpoint_uploads, r.requested_at
       FROM cloud_v2_backup_removals r JOIN cloud_v2_workspaces w ON w.id=r.workspace_id
       WHERE r.done_at IS NULL ORDER BY r.requested_at LIMIT $1`, [limit]));
    return rows.map(row => ({ id: row.id, workspaceId: row.workspace_id, object: row.object, current: row.current,
      uploadsUntil: uploadHorizon(row.checkpoint_uploads), requestedAt: row.requested_at }));
  }

  /** Retention S4: the copies of a project whose GitHub connection was removed, for any the removal's trigger skipped
   * (a copy another transaction held). Never waits; a record goes once its project has no copy building or ready. */
  async retireDisconnectedCopies(limit: number): Promise<number> {
    return withSystemTx(this.pool, async tx => {
      const retired = await tx.query(`UPDATE cloud_v2_ready_copies SET state=CASE WHEN state='building' THEN 'failed' ELSE 'retired' END,
          failure_reason=CASE WHEN state='building' THEN 'connection_removed' ELSE failure_reason END, updated_at=clock_timestamp()
        WHERE id IN (SELECT c.id FROM cloud_v2_ready_copies c JOIN cloud_v2_disconnected_projects d ON d.project_id=c.project_id
          WHERE c.state IN ('building','ready') ORDER BY c.id LIMIT $1 FOR UPDATE OF c SKIP LOCKED)`, [limit]);
      await tx.query(`DELETE FROM cloud_v2_disconnected_projects d WHERE NOT EXISTS (SELECT 1 FROM cloud_v2_ready_copies c
        WHERE c.project_id=d.project_id AND c.state IN ('building','ready'))`);
      return retired.rowCount ?? 0;
    });
  }

  async finishBackupRemoval(id: string): Promise<void> {
    await withSystemTx(this.pool, tx => tx.query("UPDATE cloud_v2_backup_removals SET done_at=clock_timestamp() WHERE id=$1 AND done_at IS NULL", [id]));
  }

  /** Retention S4: a departed member's personal projects in an organization, as the membership trigger leaves them
   * (their build secrets deleted, the project stamped), for any the trigger skipped; and a returned member's, the
   * stamp cleared. Only that member's own personal projects. */
  async sweepDepartedProjects(limit: number): Promise<void> {
    await withSystemTx(this.pool, async tx => {
      const away = `p.level='personal' AND NOT EXISTS (SELECT 1 FROM organization_members m WHERE m.org_id=p.org_id AND m.user_id=p.owner_user_id)`;
      await tx.query(`DELETE FROM cloud_v2_ready_copy_secrets s WHERE s.project_id IN (SELECT p.id FROM cloud_projects p WHERE ${away} LIMIT $1)`, [limit]);
      await tx.query(`UPDATE cloud_projects SET owner_left_at=clock_timestamp()
        WHERE id IN (SELECT p.id FROM cloud_projects p WHERE p.owner_left_at IS NULL AND ${away} LIMIT $1 FOR UPDATE SKIP LOCKED)`, [limit]);
      await tx.query(`UPDATE cloud_projects SET owner_left_at=NULL, retention_started_at=NULL
        WHERE id IN (SELECT p.id FROM cloud_projects p WHERE p.owner_left_at IS NOT NULL AND p.level='personal'
          AND EXISTS (SELECT 1 FROM organization_members m WHERE m.org_id=p.org_id AND m.user_id=p.owner_user_id) LIMIT $1 FOR UPDATE SKIP LOCKED)`, [limit]);
    });
  }

  /** Retention S4: a departed member's personal project is deleted 60 days after the later of their departure and
   * retention's first look at it (no clock from history). Its workspaces keep running without it, as when a
   * project is removed; its copy was retired at the departure. */
  async deleteDepartedProjects(limit: number): Promise<string[]> {
    return withSystemTx(this.pool, async tx => {
      await tx.query(`UPDATE cloud_projects SET retention_started_at=clock_timestamp()
        WHERE id IN (SELECT id FROM cloud_projects WHERE owner_left_at IS NOT NULL AND retention_started_at IS NULL LIMIT $1 FOR UPDATE SKIP LOCKED)`, [limit]);
      const { rows } = await tx.query<{ id: string }>(`SELECT p.id FROM cloud_projects p
        WHERE p.owner_left_at IS NOT NULL AND p.retention_started_at IS NOT NULL
          AND greatest(p.owner_left_at, p.retention_started_at) + make_interval(days => ${CLOUD_V2_BACKUP_REMOVAL_DAYS}) <= clock_timestamp()
          AND NOT EXISTS (SELECT 1 FROM organization_members m WHERE m.org_id=p.org_id AND m.user_id=p.owner_user_id)
        LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit]);
      const ids = rows.map(row => row.id);
      if (!ids.length) return [];
      await tx.query("UPDATE cloud_v2_workspaces SET project_id=NULL WHERE project_id = ANY($1::uuid[])", [ids]);
      await tx.query("DELETE FROM cloud_projects WHERE id = ANY($1::uuid[])", [ids]);
      return ids;
    });
  }

  /** Retention S4's missed-wake alert: sleeping machines more than 12 days past their last stop, with no wake that
   * found them gone since, alerted once per stop. Returns those newly alerted (at most `limit`) and how many are due. */
  async missedWakes(limit: number): Promise<{ ids: string[]; total: number }> {
    return withSystemTx(this.pool, async tx => {
      const due = `w.state='stopped' AND w.boat_sandbox_id IS NOT NULL AND w.retention_started_at IS NOT NULL
        AND greatest(w.machine_stopped_at, w.stopped_at) + interval '12 days' < clock_timestamp()
        AND w.machine_data_expired_at IS NULL
        AND NOT (w.archived_at IS NOT NULL AND w.archive_wake_done_at IS NOT NULL AND w.archive_wake_done_at >= w.archived_at)
        AND NOT EXISTS (SELECT 1 FROM cloud_v2_maintenance_wakes m WHERE m.workspace_id=w.id AND m.kind='wake' AND m.outcome='gone'
          AND m.started_at > greatest(w.machine_stopped_at, w.stopped_at))
        AND (w.missed_wake_alerted_at IS NULL OR w.missed_wake_alerted_at < greatest(w.machine_stopped_at, w.stopped_at))`;
      const total = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM cloud_v2_workspaces w WHERE ${due}`)).rows[0]!.n;
      const { rows } = await tx.query<{ id: string }>(`UPDATE cloud_v2_workspaces SET missed_wake_alerted_at=clock_timestamp()
        WHERE id IN (SELECT w.id FROM cloud_v2_workspaces w WHERE ${due} ORDER BY greatest(w.machine_stopped_at, w.stopped_at) LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING id`, [limit]);
      return { ids: rows.map(row => row.id), total };
    });
  }

  /** Retention S4's orphan sweep: of these listed prefixes, which may be pruned (their workspace row exists and has
   * been deleted for 7 days) and which have no row at all (never touched; reported). `empty`: the workspaces table
   * has no row, so a listing must not be trusted at all. */
  async accountCheckpointPrefixes(ids: readonly string[]): Promise<{ prunable: string[]; missing: string[]; empty: boolean }> {
    return withSystemTx(this.pool, async tx => {
      const empty = !(await tx.query("SELECT 1 FROM cloud_v2_workspaces LIMIT 1")).rowCount;
      const { rows } = await tx.query<{ id: string; state: string; old: boolean }>(
        `SELECT id::text, state, updated_at < clock_timestamp() - interval '7 days' AS old FROM cloud_v2_workspaces WHERE id = ANY($1::uuid[])`, [ids]);
      const known = new Map(rows.map(row => [row.id, row]));
      return { empty, prunable: ids.filter(id => known.get(id)?.state === "deleted" && known.get(id)?.old),
        missing: ids.filter(id => !known.has(id)) };
    });
  }

  /** Retention S3: the scrub's environment files are back on the machine; a later start restores nothing. */
  async clearArchiveScrub(id: string, generation: string): Promise<void> {
    await withSystemTx(this.pool, tx => tx.query(
      "UPDATE cloud_v2_workspaces SET archive_scrub='clean' WHERE id=$1 AND archive_scrubbed_generation=$2::bigint AND archive_scrub='backup'", [id, generation]));
  }

  /** A person's start takes a running maintenance wake over, in one statement: the wake lets go at its
   * next check and makes no further call to the machine. Restamped, so a takeover whose wake died
   * expires on its own, shorter clock. */
  async adoptMaintenance(id: string, attempt: string): Promise<boolean> {
    const result = await withSystemTx(this.pool, tx => tx.query(
      `UPDATE cloud_v2_workspaces SET maintenance_phase='adopting', maintenance_started_at=clock_timestamp()
       WHERE id=$1 AND maintenance_attempt=$2 AND maintenance_phase='waking'`, [id, attempt]));
    return Boolean(result.rowCount);
  }

  /** Whether a maintenance wake may still act on the machine: still its mark, still waking, and the
   * workspace still asleep. Checked after every call to the machine. */
  async maintenanceHeld(id: string, attempt: string): Promise<boolean> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query(
      `SELECT 1 FROM cloud_v2_workspaces WHERE id=$1 AND maintenance_attempt=$2 AND maintenance_phase='waking' AND state='stopped'`, [id, attempt]));
    return rows.length > 0;
  }

  /** Ends a maintenance wake on every path: clears its mark and records what Boat reported. */
  async finishMaintenance(id: string, attempt: string, result: { outcome: "stopped" | "adopted" | "gone" | "failed"; machineStoppedAt?: Date | null;
    workerFoundRunning?: boolean; workerOff?: boolean; snapshotAvailable?: boolean; dataExpiredAt?: Date | null;
    /** Retention S3: a file under a checkout is newer than the stop's marker (or the check could not tell). */
    changedSinceStop?: boolean;
    /** Retention S3: the archived wake's scrub result; its presence makes this the archived workspace's one wake. */
    scrub?: ArchiveScrubResult;
    /** Its stop left the archive suspect (boat-disk.ts archiveSuspect): recorded on its own, and an archived wake is not
     * done, so it scrubs again. */
    archiveSuspect?: boolean }): Promise<void> {
    await withSystemTx(this.pool, async tx => {
      await tx.query(`UPDATE cloud_v2_workspaces SET maintenance_attempt=NULL, maintenance_phase=NULL, maintenance_started_at=NULL,
          machine_stopped_at=coalesce($3::timestamptz, machine_stopped_at),
          archive_wake_done_at=CASE WHEN archived_at IS NOT NULL AND ($4 = 'gone' OR $4 = 'stopped' AND $7::text IS NOT NULL AND NOT $9::boolean) THEN clock_timestamp() ELSE archive_wake_done_at END,
          maintenance_archive_suspect_at=CASE WHEN $9::boolean THEN clock_timestamp() ELSE maintenance_archive_suspect_at END,
          -- A later wake's scrub of the same stop never replaces 'backup': an open still owes those files back (clearArchiveScrub).
          archive_scrub=CASE WHEN $7::text IS NOT NULL AND archive_scrub='backup' AND archive_scrubbed_generation=stop_generation THEN 'backup'
            WHEN $7::text IS NOT NULL THEN $7::text ELSE archive_scrub END,
          archive_scrubbed_at=CASE WHEN $7::text IS NOT NULL THEN clock_timestamp() ELSE archive_scrubbed_at END,
          archive_scrubbed_generation=CASE WHEN $7::text IS NOT NULL THEN stop_generation ELSE archive_scrubbed_generation END,
          -- The machine now holds what this stop's backup may not: that backup is an earlier one from here on.
          changed_since_stop_at=CASE WHEN $6::boolean THEN clock_timestamp() ELSE changed_since_stop_at END,
          changed_since_stop_generation=CASE WHEN $6::boolean THEN stop_generation ELSE changed_since_stop_generation END,
          checkpoint_stop_generation=CASE WHEN $6::boolean AND checkpoint_stop_generation = stop_generation THEN NULL ELSE checkpoint_stop_generation END,
          machine_data_expired_at=coalesce($8::timestamptz, machine_data_expired_at),
          machine_gone_at=CASE WHEN $4 = 'gone' THEN coalesce(machine_gone_at, clock_timestamp()) ELSE machine_gone_at END,
          worker_off_verified_generation=CASE WHEN $5::boolean THEN stop_generation ELSE worker_off_verified_generation END,
          worker_off_unverified_at=CASE WHEN $5::boolean THEN NULL WHEN $5::boolean IS FALSE THEN coalesce(worker_off_unverified_at, clock_timestamp())
            ELSE worker_off_unverified_at END
        WHERE id=$1 AND maintenance_attempt=$2`, [id, attempt, result.machineStoppedAt ?? null, result.outcome, result.workerOff ?? null,
          result.changedSinceStop === true, result.scrub ?? null, result.dataExpiredAt ?? null, result.archiveSuspect === true]);
      await tx.query(`UPDATE cloud_v2_maintenance_wakes SET finished_at=clock_timestamp(), outcome=$2, worker_found_running=$3,
          changed_since_stop=coalesce($7, changed_since_stop), scrub=coalesce($8, scrub),
          snapshot_available=coalesce($4, snapshot_available), data_expired_at=coalesce($5, data_expired_at),
          deadline_at=coalesce($5, CASE WHEN $6::timestamptz IS NOT NULL THEN $6::timestamptz + interval '14 days' END, deadline_at)
        WHERE attempt=$1 AND finished_at IS NULL`,
        [attempt, result.outcome, result.workerFoundRunning ?? false, result.snapshotAvailable ?? null, result.dataExpiredAt ?? null, result.machineStoppedAt ?? null,
          result.changedSinceStop ?? null, result.scrub ?? null]);
    });
  }

  /** A user wake takes over a maintenance mark whose step died (older than `staleMs`). */
  async clearStaleMaintenance(id: string, staleMs: number): Promise<boolean> {
    return withSystemTx(this.pool, async tx => {
      const { rows } = await tx.query<{ attempt: string }>(`UPDATE cloud_v2_workspaces w SET maintenance_attempt=NULL, maintenance_phase=NULL, maintenance_started_at=NULL
        FROM (SELECT maintenance_attempt AS attempt FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE) prior
        WHERE w.id=$1 AND w.maintenance_attempt IS NOT NULL
          AND w.maintenance_started_at < clock_timestamp() - make_interval(secs => $2::double precision / 1000) RETURNING prior.attempt`, [id, staleMs]);
      if (rows[0]) await tx.query(`UPDATE cloud_v2_maintenance_wakes SET outcome='failed', finished_at=clock_timestamp()
        WHERE attempt=$1 AND finished_at IS NULL`, [rows[0].attempt]);
      return rows.length > 0;
    });
  }

  /** Retention S2's health, for its summary and S4's alert: sleeping workspaces due a wake, those past
   * due by 2 days, those whose last wake found Boat had expired the disk, and the Boat deletion
   * estimates (oldest first) of everything due, which the lifecycle compares with its budget. */
  async maintenanceBacklog(): Promise<{ due: number; overdue: number; expired: number; usedToday: number; deadlines: Date[] }> {
    return withSystemTx(this.pool, async tx => {
      const due = (await tx.query<{ deadline: Date; overdue: boolean }>(`SELECT greatest(machine_stopped_at, stopped_at) + interval '14 days' AS deadline,
          greatest(machine_stopped_at, stopped_at) + interval '12 days' < clock_timestamp() AS overdue
        FROM cloud_v2_workspaces WHERE state='stopped' AND boat_sandbox_id IS NOT NULL AND maintenance_attempt IS NULL
          AND (archived_at IS NULL OR archive_wake_done_at IS NULL OR archive_wake_done_at < archived_at)
          AND greatest(machine_stopped_at, stopped_at) + interval '10 days' <= clock_timestamp()
        ORDER BY 1 LIMIT 20000`)).rows;
      const expired = (await tx.query<{ n: number }>(`SELECT count(DISTINCT workspace_id)::int AS n FROM cloud_v2_maintenance_wakes m
        WHERE m.kind='wake' AND m.snapshot_available IS FALSE AND m.started_at > clock_timestamp() - interval '30 days'`)).rows[0]!.n;
      const usedToday = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM cloud_v2_maintenance_wakes
        WHERE started_at > clock_timestamp() - interval '1 day'`)).rows[0]!.n;
      return { due: due.length, overdue: due.filter(entry => entry.overdue).length, expired, usedToday, deadlines: due.map(entry => entry.deadline) };
    });
  }

  /** Retention: a lost VM's replacement for a workspace whose latest stop left nothing off GitHub, or
   * that has no backup at all (then it records that the latest stop's work did not come back). It
   * needs no checkpoint and no pending restore: it is recorded only once it holds the workspace. It reads the raw probe:
   * the lost machine took its archive with it, suspect or not, and lost work means work off GitHub, which a clean probe
   * found none of. */
  async replaceLostSandbox(id: string, lostSandboxId: string | null, sandboxId: string, renewedAt: Date): Promise<boolean> {
    const result = await withSystemTx(this.pool, tx => tx.query(
      `UPDATE cloud_v2_workspaces SET boat_sandbox_id=$3, lease_renewed_at=$4,
         lost_work_machine=CASE WHEN backup_probe='clean' AND backup_probe_generation=stop_generation THEN lost_work_machine ELSE coalesce($2::text, lost_work_machine) END,
         lost_work_restored=CASE WHEN backup_probe='clean' AND backup_probe_generation=stop_generation THEN lost_work_restored ELSE 'none' END,
         lost_work_since=CASE WHEN backup_probe='clean' AND backup_probe_generation=stop_generation THEN lost_work_since ELSE coalesce(stopped_at, updated_at) END
       WHERE id=$1 AND state='starting' AND boat_sandbox_id IS NOT DISTINCT FROM $2::text AND NOT restore_pending
         AND ((backup_probe='clean' AND backup_probe_generation=stop_generation) OR checkpoint_object IS NULL)`, [id, lostSandboxId, sandboxId, renewedAt]));
    return Boolean(result.rowCount);
  }

  /** A stop made again for the same stop generation (a checkpoint retry's) left its archive suspect: recorded for that
   * stop generation only. */
  async recordStopArchiveSuspect(id: string, stopGeneration: string): Promise<void> {
    await withSystemTx(this.pool, tx => tx.query(
      "UPDATE cloud_v2_workspaces SET stop_archive_failed_generation = stop_generation WHERE id = $1 AND stop_generation = $2::bigint", [id, stopGeneration]));
  }

  /** Retention: a restore brought back an earlier backup or checkpoint, not the latest stop's work. */
  async recordLostWork(id: string, restored: "earlier"): Promise<void> {
    await withSystemTx(this.pool, tx => tx.query(
      "UPDATE cloud_v2_workspaces SET lost_work_restored=$2, lost_work_since=coalesce(stopped_at, updated_at) WHERE id=$1", [id, restored]));
  }

  /** A machine Boat reported gone that may still hold work: kept on the row, never deleted by us. */
  async keepLostMachine(id: string, machine: string): Promise<void> {
    await withSystemTx(this.pool, tx => tx.query("UPDATE cloud_v2_workspaces SET lost_work_machine=$2 WHERE id=$1", [id, machine]));
  }

  /** The person has seen that a restore came back without some work. */
  async dismissLostWork(id: string, userId: string): Promise<CloudV2Workspace> {
    await this.get(id, userId);
    const { rows } = await withSystemTx(this.pool, tx => tx.query<Row>(
      `UPDATE cloud_v2_workspaces SET lost_work_restored=NULL, lost_work_since=NULL WHERE id=$1 RETURNING ${COLUMNS}`, [id]));
    if (!rows[0]) throw notFound();
    return workspace(rows[0]);
  }

  /** One workspace's lifecycle row, as the lifecycle reads it. */
  async lifecycleWorkspace(id: string): Promise<CloudV2LifecycleWorkspace | null> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<LifecycleRow>(`SELECT ${LIFECYCLE_COLUMNS}, ${lifecycleSubmodules("cloud_v2_workspaces")}
      FROM cloud_v2_workspaces WHERE id=$1`, [id]));
    return rows[0] ? lifecycleWorkspace(rows[0]) : null;
  }

  /** Every repository's workspace branch, first repository first, for a restore that starts without a checkpoint. */
  async workspaceBranches(id: string): Promise<{ position: number; repository: string; branch: string; folder: string | null }[]> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<{ position: number; repository: string; branch: string; folder: string | null }>(
      "SELECT position, repository, branch, folder FROM cloud_v2_workspace_repositories WHERE workspace_id=$1 ORDER BY position", [id]));
    return rows;
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

  /** The build a creating workspace is bound to, while it may still be on its way (an organization's base being prepared). */
  async workspaceBuildWait(workspaceId: string): Promise<{ buildId: string; state: string; finishedAt: Date | null } | null> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<{ id: string; state: string; finished_at: Date | null }>(
      `SELECT b.id, b.state, b.finished_at FROM cloud_v2_workspaces w JOIN cloud_v2_computer_builds b ON b.id=w.computer_build_id AND b.org_id=w.org_id
       WHERE w.id=$1`, [workspaceId]));
    return rows[0] ? { buildId: rows[0].id, state: rows[0].state, finishedAt: rows[0].finished_at } : null;
  }

  /** A create that waited for its base may go on only while it is not archived (a member who left has theirs archived)
   * and its creator (or, in shared execution, its organization) still has cloud: what changed, or null. */
  async deferredCreateChange(workspaceId: string): Promise<"archived" | "access" | null> {
    const row = (await withSystemTx(this.pool, tx => tx.query<{ archived: boolean; live: boolean }>(
      `SELECT w.archived_at IS NOT NULL AS archived, ${LIVE_ACCESS} AS live FROM cloud_v2_workspaces w WHERE w.id=$1`, [workspaceId]))).rows[0];
    return !row ? null : row.archived ? "archived" : row.live ? null : "access";
  }

  /** Its base is live (or gone): it no longer says it is waiting, and keeps when this tick saw that, which its boot
   * deadline counts from on every later tick (never the base's finish: a lifecycle that was down sees it late). */
  async baseWaitOver(workspaceId: string): Promise<void> {
    await withSystemTx(this.pool, tx => tx.query(`UPDATE cloud_v2_workspaces SET waiting_for_base_at=NULL, base_ready_at=clock_timestamp()
      WHERE id=$1 AND waiting_for_base_at IS NOT NULL`, [workspaceId]));
  }

  /** A creating workspace whose base failed moves to the organization's live base, in one statement, so the build it
   * leaves and the one it takes are never both unpinned. False when there is none (or it already moved). */
  async rebindToBase(workspaceId: string, fromBuildId: string): Promise<boolean> {
    const { rowCount } = await withSystemTx(this.pool, tx => tx.query(
      `UPDATE cloud_v2_workspaces w SET computer_build_id=b.id, updated_at=clock_timestamp()
       FROM cloud_v2_computers c JOIN cloud_v2_computer_builds b ON b.id=c.active_build_id AND b.org_id=c.org_id AND b.state='succeeded' AND b.base_only
       WHERE w.id=$1 AND w.computer_build_id=$2 AND w.state='creating' AND w.boat_sandbox_id IS NULL AND c.org_id=w.org_id AND b.id<>$2`,
      [workspaceId, fromBuildId]));
    return (rowCount ?? 0) > 0;
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
    return rows[0]?.snapshot_name ? cloudV2BoatSnapshotName(rows[0].snapshot_name) : null;
  }

  /** One selection supplies the build pin and its installed repositories. */
  async activeComputer(organizationId: string): Promise<{ buildId: string; repositories: CloudV2InstalledRepository[]; baseOnly?: true } | null> {
    return this.computerBuild(organizationId, "active");
  }

  /** With ready copies off, an organization whose live build is a base still creates as before the switch: from the
   * legacy build that base replaced, while it is kept. Null without one. */
  async legacyComputer(organizationId: string): Promise<{ buildId: string; repositories: CloudV2InstalledRepository[]; baseOnly?: true } | null> {
    return this.computerBuild(organizationId, "legacy");
  }

  private async computerBuild(organizationId: string, which: "active" | "legacy"): Promise<{ buildId: string; repositories: CloudV2InstalledRepository[]; baseOnly?: true } | null> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<{ id: string; base_only: boolean; recipe: { repositories?: { repository?: unknown; branch?: unknown }[] } }>(
      which === "active" ? `SELECT build.id, build.base_only, build.recipe FROM cloud_v2_computers computer
       JOIN cloud_v2_computer_builds build ON build.id = computer.active_build_id AND build.org_id = computer.org_id
       WHERE computer.org_id = $1 AND computer.snapshot_name IS NOT NULL AND build.state = 'succeeded' AND build.source_policy_version IN (2,3)`
      : `SELECT build.id, build.base_only, build.recipe FROM cloud_v2_computers computer
       JOIN cloud_v2_computer_builds live ON live.id = computer.active_build_id AND live.org_id = computer.org_id AND live.base_only
       JOIN cloud_v2_computer_builds build ON build.id = computer.legacy_build_id AND build.org_id = computer.org_id
       WHERE computer.org_id = $1 AND build.state = 'succeeded' AND build.source_policy_version IN (2,3) AND NOT build.base_only
         AND build.snapshot_id IS NOT NULL AND build.snapshot_deleted_at IS NULL AND build.cleanup_requested_at IS NULL`,
      [organizationId],
    ));
    if (!rows[0]) return null;
    return { buildId: rows[0].id, ...(rows[0].base_only ? { baseOnly: true as const } : {}),
      repositories: (rows[0].recipe.repositories ?? []).flatMap(entry => typeof entry.repository === "string" ? [{
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

  messageRange(workspaceId: string, chatId: string, fromIndex: number, toIndex: number, includeSenders = false) {
    return withSystemTx(this.pool, tx => mirrorMessageRange(tx, workspaceId, chatId, fromIndex, toIndex, includeSenders), { consistentRead: true });
  }

  messageSince(workspaceId: string, chatId: string, revision: number, includeSenders = false) {
    return withSystemTx(this.pool, tx => mirrorMessageDelta(tx, workspaceId, chatId, revision, includeSenders), { consistentRead: true });
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

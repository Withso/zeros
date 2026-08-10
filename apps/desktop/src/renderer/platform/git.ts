// ──────────────────────────────────────────────────────────
// Native bindings — Git, GitHub, detach, and cross-tool IPC
// ──────────────────────────────────────────────────────────
//
// Renderer-side typed façade for git/GitHub/detach/cross-tool ops. Most ops
// are now bridge-routed through the engine WorkspaceService; only a handful
// (~6) of native IPC commands remain. The native-bound calls here route
// through `nativeInvoke()`. Engine-backed reads never synthesize empty success:
// a disconnected transport is not proof that a repository has no data.
//
// Engine source-of-truth: apps/desktop/src/engine/git/index.ts. The types below
// mirror that module's exports — copying them into the renderer keeps
// the IPC boundary explicit and avoids importing the engine into the
// React bundle.
// ──────────────────────────────────────────────────────────

import { isNativeRuntime, nativeInvoke, nativeListen } from "./runtime";
import type {
  GithubAuthMethod,
  GithubAuthSnapshot,
} from "@zeros/protocol/github-auth";
import { refreshDetectedOpenApps } from "./open-apps";
import { getActiveBridge } from "./bridge/active-bridge";
import type { WorkingDirectoriesWire } from "./bridge/workspace-bridge";
import {
  bridgeFileTree,
  bridgeIgnoredEntries,
  bridgeListWorkingDirectories,
  bridgeSetWorkingDirectories,
  bridgeGitStatus,
  bridgeGitChangeCounts,
  bridgeGitChangeLineCounts,
  bridgeGitHasChanges,
  bridgeGitDiff,
  bridgeGitShow,
  bridgeGitBranches,
  bridgeGitRemoteBranches,
  bridgeGitStage,
  bridgeGitDiscard,
  bridgeGitUnstage,
  bridgeGitClean,
  bridgeGitCommit,
  bridgeGitPush,
  bridgeGitPull,
  bridgeGitRenameBranch,
  bridgeGitChangeTargetBranch,
  bridgeGhPrGet,
  bridgeGhAuthStatus,
  bridgeGhPrSync,
  bridgeGhPrChecks,
  bridgeGhPrCommits,
  bridgeGhPrReviews,
  bridgeGhPrCreate,
  bridgeGhRepoAccess,
  bridgeGhRepositoryOwnerAvatar,
  bridgeGhListOwners,
  bridgeGhCheckRepoName,
  bridgeGhPublishRepo,
  bridgeGitInitInPlace,
  type GithubOwner,
  type GithubRepoAccess,
  type GithubRepositoryOwnerAvatar,
  type PublishRepoResult,
  type InitRepoInPlaceResult,
  bridgeGhPrMarkReady,
  bridgeGhPrMerge,
  bridgeGhPrComment,
  bridgeGhPrList,
  bridgeWorkspaceCreate,
  bridgeWorkspaceGet,
  bridgeWorkspaceLifecycleStatus,
  bridgeWorkspaceCreateFromBranchStatus,
  bridgeWorkspacePrepareCreate,
  bridgeWorkspaceList,
  bridgeWorkspaceDelete,
  bridgeWorkspaceArchive,
  bridgeWorkspaceSetStatus,
  bridgeWorkspaceReassignLocalOrganization,
  bridgeWorkspaceRestore,
  bridgeWorkspaceContinueOnNewBranch,
  bridgeWorkspaceAdoptExisting,
  bridgeWorkspaceCreateFromBranch,
  bridgeWorkspaceSetupInfo,
  bridgeWorkspaceRerunSetup,
  bridgeWorkspaceStopSetup,
  bridgeWorkspaceRunInfo,
  bridgeWorkspaceStartRun,
  bridgeWorkspaceStopRun,
  bridgeWorkspaceRunLog,
  type RunActionStatusWire,
  type RunStartReply,
  bridgeGitListAllBranches,
  bridgeGitRepoBranchCatalog,
  bridgeGitLog,
} from "./bridge/workspace-bridge";
import { resolveBridgeWorkspaceIdForCwd } from "./bridge/workspace-id-resolver";
import { isKnownProjectRoot } from "../state/projects-store";
import {
  bridgeDesignCreateFrame,
  bridgeDesignApplyTransaction,
  bridgeDesignDeleteFrame,
  bridgeDesignDuplicateFrame,
  bridgeDesignFrame,
  bridgeDesignFrames,
  bridgeDesignFoundationOpen,
  bridgeDesignHistory,
  bridgeDesignLint,
  bridgeDesignRenameFrame,
  bridgeDesignProvenance,
  bridgeDesignSave,
  bridgeDesignSetText,
  bridgeDesignSetScreenshot,
  bridgeDesignSetRuntimeAudit,
  bridgeDesignSetSelection,
  bridgeDesignSnapshot,
  bridgeDesignTokens,
  bridgeDesignUpdateToken,
  bridgeDesignUpdateCanvas,
  bridgeDesignUpdateStyles,
  bridgeDesignWriteHtml,
  bridgeDesignInsertAsset,
  type DesignFrameDocumentWire,
  type DesignFoundationOpenWire,
  type DesignApiMutationReplyWire,
  type DesignFrameGeometryWire,
  type DesignFrameSummaryWire,
  type DesignLintReportWire,
  type DesignMutationReplyWire,
  type DesignScreenshotInputWire,
  type DesignRuntimeWarningWire,
  type DesignSelectionInputWire,
  type DesignTokenWire,
  type DesignTokenMutationWire,
  type DesignWorkspaceSnapshotWire,
} from "./bridge/design-bridge";
import type { DesignTransaction } from "@zeros/design-core";
import type { DesignStyleProvenance } from "@zeros/design-web";
import type { DesignRuntimeMatchedDeclaration } from "@zeros/protocol/design-runtime";

// Re-export the publish types so the publish dialog consumes them via the
// native/git façade rather than reaching into the bridge module.
export type {
  GithubOwner,
  GithubRepoAccess,
  GithubRepositoryOwnerAvatar,
  InitRepoInPlaceResult,
  PublishRepoResult,
  WorkingDirectoriesWire,
  WorkingDirectoriesUnsupportedReason,
} from "./bridge/workspace-bridge";
export type {
  DesignAssetWire,
  DesignCanvasFrameWire,
  DesignFrameDocumentWire,
  DesignFrameGeometryWire,
  DesignFrameSummaryWire,
  DesignFoundationOpenWire,
  DesignApiMutationReplyWire,
  DesignFrameTreeNodeWire,
  DesignLintReportWire,
  DesignLintViolationWire,
  DesignMutationReplyWire,
  DesignMutationResultWire,
  DesignScreenshotInputWire,
  DesignSelectionInputWire,
  DesignTokenWire,
  DesignTokenMutationWire,
  DesignWorkspaceSnapshotWire,
} from "./bridge/design-bridge";
export { WORKING_DIRECTORIES_UNSUPPORTED_COPY } from "./bridge/workspace-bridge";

// ── Types ────────────────────────────────────────────────

export type WorkspaceStatus =
  | "backlog"
  | "in-progress"
  | "in-review"
  | "done"
  | "cancelled";

export type PrState = "draft" | "ready" | "merged" | "closed";

export type DetectedTool =
  | "zeros"
  | "cursor"
  | "conductor"
  | "superset"
  | "workmux"
  | "unknown";

export type FileChangeStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflicted";

export type ConflictState =
  | "merge"
  | "rebase"
  | "cherry-pick"
  | "revert"
  | null;

export interface Workspace {
  id: string;
  /** Optional for rolling compatibility with an older engine. Missing means
   * code; current engines always return an explicit kind. */
  kind?: "code" | "design";
  /** Semantic tenant owner. Null/missing rows predate organizations and belong
   * to Personal; current engines always return an explicit nullable value. */
  organizationId?: string | null;
  /** Where execution is provisioned. Optional only for rolling compatibility;
   * legacy rows are local. */
  placement?: "local" | "cloud";
  repoSlug: string;
  repoRoot: string;
  branch: string;
  baseBranch: string;
  path: string;
  status: WorkspaceStatus;
  createdAt: number;
  archivedAt: number | null;
  stashRef: string | null;
  /** Exact branch-tip recovery anchor captured by archive. Optional only for
   * rolling compatibility with engines predating the lifecycle journal. */
  archivedHead?: string | null;
  /** Durable whole-tree archive checkpoint ref target. Optional only for older
   * engine rows; current engines return null or a commit OID. */
  archiveSnapshot?: string | null;
  prNumber: number | null;
  prState: PrState | null;
  prUrl: string | null;
  agentId: string | null;
  lastActiveAt: number | null;
  /** Background setup-script state: "running" while the setup PTY is live, then
   *  "passed"/"failed" on exit — or "stopped" when the run ended without a
   *  result (Stop setup, or an engine quit mid-run). Null/undefined when no
   *  setup is configured or it never ran. Surfaced in the Setup tab. */
  setupState?: "running" | "passed" | "failed" | "stopped" | null;
  /** Stamped by the engine at list/get time — `false` means the
   *  worktree folder at `path` is gone from disk and the renderer
   *  should swap in the "Worktree missing" placeholder. */
  present?: boolean;
  /** Exact "anything worth a PR?" flag from the All Changes net comparison.
   *  Present ONLY when the list was fetched with `withChanges` (Dashboard);
   *  undefined otherwise. Gates Create PR on cards + the PR status row. */
  hasChanges?: boolean;
}

/** Setup tab payload from `workspace.setupInfo`. */
export interface WorkspaceSetupInfo {
  /** Does the repo have a setup command configured (even if it never ran)? */
  hasCommand: boolean;
  /** The command (most-recent run's, else the configured one), or null. */
  command: string | null;
  /** Last-run state (persisted for a real workspace; in-memory for the trunk). */
  state: "running" | "passed" | "failed" | "stopped" | null;
  /** Accumulated ANSI output of the most-recent run (empty after restart). */
  log: string;
  /** True when older output was dropped from the head of `log`. */
  truncated: boolean;
}

export interface FileChange {
  path: string;
  status: FileChangeStatus;
  oldPath?: string;
}

export interface Hunk {
  filePath: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  body: string;
}

export interface Commit {
  sha: string;
  abbreviatedSha: string;
  message: string;
  authorName: string;
  authorEmail: string;
  authorDate: number;
  parents: string[];
}

export interface Branch {
  name: string;
  tipSha: string;
  isCheckedOut: boolean;
  worktreePath: string | null;
  origin: DetectedTool;
  lastCommitDate: number;
  prUrl: string | null;
}

export interface PR {
  number: number;
  url: string;
  state: PrState;
  title: string;
  body: string;
  authorLogin: string;
  baseBranch: string;
  headBranch: string;
  /** Absent when connected to an older engine build. */
  headSha?: string;
  mergeableState: string;
  isMergeable: boolean | null;
  /** Commits the BASE has that this PR's head doesn't (GitHub compare).
   *  Populated only when `mergeableState` is "behind"; null/undefined =
   *  unknown. Powers the island's "Require branch to be up to date" count. */
  behindBy?: number | null;
  createdAt: number;
  updatedAt: number;
  mergedAt: number | null;
  /** Absent when connected to an older engine build. */
  mergeCommitSha?: string | null;
}

export interface CreatedWorkspace {
  workspaceId: string;
  branch: string;
  path: string;
  status: WorkspaceStatus;
}

export type CreateWorkspaceArgs = {
  repoRoot: string;
  kind?: "code" | "design";
  organizationId?: string | null;
  placement?: "local" | "cloud";
  repoSlug?: string;
  baseBranch?: string;
  prompt?: string;
  setupScript?: string;
  copyPaths?: string[];
  symlinkPaths?: string[];
  agentId?: string;
  /** Id reserved by workspacePrepareCreate — the engine reuses it instead of
   *  generating a fresh identity. Must be paired with preparedBranch. */
  preparedId?: string;
  /** Branch reserved by workspacePrepareCreate — shown as the workspace name
   *  from frame one, so the create must reuse it verbatim. */
  preparedBranch?: string;
  /** Exact optimistic chat created for the prepared destination. Local-only;
   * engine rollback deletes it if provisioning never publishes. */
  optimisticChatId?: string;
};

export interface AuthStatusResult {
  authenticated: boolean;
  login?: string;
}

// ── Engine bridge (single-writer) ────────────────────────
//
// After the single-writer migration, every DB-touching git/GitHub/workspace op
// runs on the engine over the bridge — on DESKTOP too (BridgeProvider registers
// the local client; the agents connection is always present once connected).
// Both reads and writes require the installed RuntimeClient. It queues requests
// while the local engine is connecting; if the provider is genuinely absent,
// rejecting preserves the caller's last confirmed exact-key snapshot instead
// of publishing a false empty repository. DB-FREE ops (clone/inspectFolder,
// worktree file listing, gh auth) keep using native IPC.
function requireBridge(action: string) {
  const bridge = getActiveBridge();
  if (!bridge) {
    throw new Error(
      `Can't ${action}: not connected to the Zeros engine yet — try again in a moment.`,
    );
  }
  return bridge;
}

// ── Workspace lifecycle ──────────────────────────────────

export interface PreparedWorkspaceCreate {
  workspaceId: string;
  path: string;
  repoSlug: string;
  /** The reserved branch name — the workspace's display name from frame one. */
  branch: string;
}

/** Reserve the new workspace's identity and final path without touching disk,
 *  so the UI can navigate immediately without leaking an empty directory when
 *  a request disconnects. Pass both identity fields to workspaceCreate. */
export async function workspacePrepareCreate(args: {
  repoRoot: string;
  kind?: "code" | "design";
  repoSlug?: string;
  prompt?: string;
}): Promise<PreparedWorkspaceCreate> {
  return bridgeWorkspacePrepareCreate(
    requireBridge("create a workspace"),
    args,
  );
}

export async function workspaceCreate(
  args: CreateWorkspaceArgs,
): Promise<CreatedWorkspace> {
  const created = (await bridgeWorkspaceCreate(
    requireBridge("create a workspace"),
    args as unknown as Record<string, unknown>,
  )) as CreatedWorkspace;
  // Workspace creation is the designated re-probe point for the topbar
  // "Open in…" IDE list. This is fire-and-forget so create latency
  // is unaffected. Sits here (not in the 5 UI call sites) so every
  // create path hits it.
  void refreshDetectedOpenApps();
  return created;
}

export async function workspaceReassignLocalOrganization(args: {
  fromOrganizationId: string;
  toOrganizationId: string;
}): Promise<{ changes: number; repoSlugs: string[] }> {
  return bridgeWorkspaceReassignLocalOrganization(
    requireBridge("repair local workspace ownership"),
    args,
  );
}

export async function designFrames(
  workspaceId: string,
): Promise<DesignFrameSummaryWire[]> {
  return bridgeDesignFrames(requireBridge("load design frames"), workspaceId);
}

export async function designFoundationOpen(
  workspaceId: string,
  frame: string,
): Promise<DesignFoundationOpenWire> {
  return bridgeDesignFoundationOpen(
    requireBridge("open the design foundation"),
    workspaceId,
    frame,
  );
}

export async function designProvenance(
  workspaceId: string,
  input: {
    frame: string;
    nodeId: string;
    property: string;
    expectedRevision?: string;
    computedValue?: string | null;
    matched?: DesignRuntimeMatchedDeclaration[];
  },
): Promise<DesignStyleProvenance> {
  return bridgeDesignProvenance(
    requireBridge("inspect authored design provenance"),
    workspaceId,
    input,
  );
}

export async function designApplyTransaction(
  workspaceId: string,
  frame: string,
  transaction: DesignTransaction,
  dryRun = false,
): Promise<DesignApiMutationReplyWire> {
  return bridgeDesignApplyTransaction(
    requireBridge("apply a design transaction"),
    workspaceId,
    frame,
    transaction,
    dryRun,
  );
}

export async function designHistory(
  workspaceId: string,
  frame: string,
  direction: "undo" | "redo",
): Promise<DesignApiMutationReplyWire> {
  return bridgeDesignHistory(
    requireBridge(`${direction} a design edit`),
    workspaceId,
    frame,
    direction,
  );
}

export async function designFrame(
  workspaceId: string,
  frame: string,
  depth = 4,
): Promise<DesignFrameDocumentWire> {
  return bridgeDesignFrame(
    requireBridge("load a design frame"),
    workspaceId,
    frame,
    depth,
  );
}

export async function designSnapshot(
  workspaceId: string,
): Promise<DesignWorkspaceSnapshotWire> {
  return bridgeDesignSnapshot(
    requireBridge("load the design workspace"),
    workspaceId,
  );
}

export async function designTokens(
  workspaceId: string,
): Promise<DesignTokenWire[]> {
  return bridgeDesignTokens(requireBridge("load design tokens"), workspaceId);
}

export async function designUpdateToken(
  workspaceId: string,
  input: {
    frame: string;
    name: string;
    theme: string | null;
    value: string;
    sourceVersion: string;
  },
): Promise<{
  mutation: DesignTokenMutationWire;
  snapshot: DesignWorkspaceSnapshotWire;
}> {
  return bridgeDesignUpdateToken(
    requireBridge("update a design token"),
    workspaceId,
    input,
  );
}

export async function designLint(
  workspaceId: string,
  frame?: string,
): Promise<DesignLintReportWire> {
  return bridgeDesignLint(requireBridge("lint the design"), workspaceId, frame);
}

export async function designSetSelection(
  workspaceId: string,
  selection: DesignSelectionInputWire | null,
  selectionVersion: number,
): Promise<void> {
  await bridgeDesignSetSelection(
    requireBridge("update design selection"),
    workspaceId,
    selection,
    selectionVersion,
  );
}

export async function designSetScreenshot(
  workspaceId: string,
  screenshot: DesignScreenshotInputWire,
): Promise<void> {
  await bridgeDesignSetScreenshot(
    requireBridge("publish a design screenshot"),
    workspaceId,
    screenshot,
  );
}

export async function designSetRuntimeAudit(
  workspaceId: string,
  input: {
    frame: string;
    sourceVersion: string;
    warnings: DesignRuntimeWarningWire[];
  },
): Promise<void> {
  return bridgeDesignSetRuntimeAudit(
    requireBridge("publish design runtime audit"),
    workspaceId,
    input,
  );
}

export async function designCreateFrame(
  workspaceId: string,
  title?: string,
): Promise<{
  frame: DesignFrameSummaryWire;
  snapshot: DesignWorkspaceSnapshotWire;
}> {
  return bridgeDesignCreateFrame(
    requireBridge("create a design frame"),
    workspaceId,
    title,
  );
}

export async function designRenameFrame(
  workspaceId: string,
  frame: string,
  title: string,
): Promise<{
  frame: DesignFrameSummaryWire;
  snapshot: DesignWorkspaceSnapshotWire;
}> {
  return bridgeDesignRenameFrame(
    requireBridge("rename a design frame"),
    workspaceId,
    frame,
    title,
  );
}

export async function designUpdateCanvas(
  workspaceId: string,
  frame: string,
  geometry: DesignFrameGeometryWire,
): Promise<{
  geometry: DesignFrameGeometryWire;
  snapshot: DesignWorkspaceSnapshotWire;
}> {
  return bridgeDesignUpdateCanvas(
    requireBridge("move a design frame"),
    workspaceId,
    frame,
    geometry,
  );
}

export async function designDuplicateFrame(
  workspaceId: string,
  frame: string,
): Promise<{
  frame: DesignFrameSummaryWire;
  snapshot: DesignWorkspaceSnapshotWire;
}> {
  return bridgeDesignDuplicateFrame(
    requireBridge("duplicate a design frame"),
    workspaceId,
    frame,
  );
}

export async function designDeleteFrame(
  workspaceId: string,
  frame: string,
): Promise<{
  deleted: { file: string };
  snapshot: DesignWorkspaceSnapshotWire;
}> {
  return bridgeDesignDeleteFrame(
    requireBridge("delete a design frame"),
    workspaceId,
    frame,
  );
}

export async function designUpdateStyles(
  workspaceId: string,
  input: {
    frame: string;
    nodeId: string;
    sourceVersion: string;
    styles: Record<string, string | null>;
  },
): Promise<DesignMutationReplyWire> {
  return bridgeDesignUpdateStyles(
    requireBridge("update design styles"),
    workspaceId,
    input,
  );
}

export async function designSetText(
  workspaceId: string,
  input: {
    frame: string;
    nodeId: string;
    sourceVersion: string;
    text: string;
  },
): Promise<DesignMutationReplyWire> {
  return bridgeDesignSetText(
    requireBridge("edit design text"),
    workspaceId,
    input,
  );
}

export async function designWriteHtml(
  workspaceId: string,
  input: {
    frame: string;
    nodeId: string;
    sourceVersion: string;
    html: string;
    mode: "append" | "replace-inner";
  },
): Promise<DesignMutationReplyWire> {
  return bridgeDesignWriteHtml(
    requireBridge("write design HTML"),
    workspaceId,
    input,
  );
}

export async function designInsertAsset(
  workspaceId: string,
  input: {
    frame: string;
    sourceVersion: string;
    assetPath: string;
    x: number;
    y: number;
  },
): Promise<DesignMutationReplyWire> {
  return bridgeDesignInsertAsset(
    requireBridge("insert a design asset"),
    workspaceId,
    input,
  );
}

export async function designSave(
  workspaceId: string,
  message?: string,
): Promise<{ sha: string; branch: string }> {
  return bridgeDesignSave(requireBridge("save designs"), workspaceId, message);
}

export async function workspaceList(
  args: {
    repoSlug?: string;
    status?: WorkspaceStatus;
    /** true → archived only (History); false → non-archived (sidebar + Dashboard);
     *  omit → all. */
    archived?: boolean;
    /** true → engine stamps `hasChanges` per live row (git probes). The Dashboard
     *  opts in; the sidebar does not, to keep its refetches git-free. */
    withChanges?: boolean;
    /** Local façade option. Existing/code-only consumers stay isolated from
     *  Design rows; the shared workspace store opts in and applies its Internal
     *  runtime gate at each Design-capable surface. Never sent to the engine. */
    includeDesign?: boolean;
  } = {},
): Promise<Workspace[]> {
  const bridge = requireBridge("list workspaces");
  const { includeDesign = false, ...bridgeArgs } = args;
  const list = await bridgeWorkspaceList(bridge, bridgeArgs);
  // The engine prepends the synthetic `local-main` entry (the web list needs
  // it); the desktop list returned real worktrees only, so strip it to preserve
  // behavior — it's the sole entry with an empty repoSlug.
  return list.filter(
    (workspace) =>
      workspace.repoSlug !== "" &&
      (includeDesign || workspace.kind !== "design"),
  );
}

/** Exact local-engine workspace lookup. Unlike workspace.list, this can see a
 * create-journal row that is deliberately hidden from live collections, which
 * lets timeout recovery distinguish "still provisioning" from "rolled back". */
export async function workspaceGet(workspaceId: string): Promise<Workspace> {
  return bridgeWorkspaceGet(requireBridge("read the workspace"), workspaceId);
}

export type WorkspaceLifecycleOperation =
  | "create"
  | "archive"
  | "restore"
  | "delete";

export interface WorkspaceLifecycleStatus {
  active: boolean;
  operation: WorkspaceLifecycleOperation | null;
  phase: string | null;
  startedAt: number | null;
}

/** Exact local lifecycle observation used after a request timeout. It exposes
 * both pre-journal in-flight work and any durable recovery phase, so callers
 * never infer completion or rollback from elapsed time. */
export async function workspaceLifecycleStatus(
  workspaceId: string,
): Promise<WorkspaceLifecycleStatus> {
  return bridgeWorkspaceLifecycleStatus(
    requireBridge("check the workspace operation"),
    workspaceId,
  );
}

export interface CreateWorkspaceFromBranchStatus extends WorkspaceLifecycleStatus {
  workspace: Workspace | null;
}

/** Exact repo+branch timeout observation for creation flows that do not know
 * the engine-generated workspace id until the original response succeeds. */
export async function workspaceCreateFromBranchStatus(args: {
  repoRoot: string;
  repoSlug: string;
  branchName: string;
}): Promise<CreateWorkspaceFromBranchStatus> {
  return bridgeWorkspaceCreateFromBranchStatus(
    requireBridge("check branch workspace creation"),
    args,
  );
}

export async function workspaceDelete(args: {
  workspaceId: string;
  includeBranch: boolean;
}): Promise<void> {
  await bridgeWorkspaceDelete(requireBridge("delete the workspace"), args);
}

export interface ArchiveResult {
  archivedAt: number;
  stashRef: string | null;
  /** Present on current engines; optional during a rolling dev-engine reload. */
  archiveSnapshot?: string | null;
  /** Present on current engines; optional while a renderer reconnects across a
   * dev hot-reload to an older compatible engine. */
  workspace?: Workspace;
}

export interface RestoreResult {
  restoredAt: number;
  /** Files left with conflict markers by checkpoint application. Empty when clean. */
  conflicts: string[];
  /** Where the worktree was restored to — differs from the original when the
   *  folder was occupied and restore adapted to a fresh sibling. */
  path: string;
  /** The branch checked out after restore — differs from the original when it
   *  was checked out elsewhere and restore forked a new branch. */
  branch: string;
  /** User-facing notes about any adaptation restore made (occupied folder,
   *  branch taken/missing). Empty on a clean restore to the original path+branch. */
  adaptations: string[];
  /** Present on current engines; optional for rolling-upgrade compatibility. */
  workspace?: Workspace;
}

/** Archive a workspace: durably checkpoint tracked + untracked work, remove the
 *  worktree folder, and keep the branch + recovery anchor. The legacy
 *  `stashUncommitted` wire flag remains forced on so an older compatible engine
 *  can never silently discard agent-created files. */
export async function workspaceArchive(args: {
  workspaceId: string;
  stashUncommitted?: boolean;
}): Promise<ArchiveResult> {
  return bridgeWorkspaceArchive(requireBridge("archive the workspace"), {
    stashUncommitted: true,
    ...args,
  });
}

/** Manually set a workspace's lifecycle status (right-click → Set status). Any of
 *  the five kanban states; the engine writes it directly (a manual set bypasses
 *  the auto-transition guards). */
export async function workspaceSetStatus(args: {
  workspaceId: string;
  status: WorkspaceStatus;
}): Promise<void> {
  await bridgeWorkspaceSetStatus(
    requireBridge("set the workspace status"),
    args,
  );
}

/** Restore (unarchive) a workspace. The engine adapts the path/branch when the
 *  originals are taken or missing. `adaptations` carries user-facing notes;
 *  `conflicts` reports any checkpoint-application conflict markers. */
export async function workspaceRestore(args: {
  workspaceId: string;
}): Promise<RestoreResult> {
  return bridgeWorkspaceRestore(requireBridge("restore the workspace"), args);
}

/** "Continue" after a merged PR (the island's Continue button): create + check
 *  out a fresh generated branch from the target branch in the SAME worktree
 *  and clear the workspace's PR fields. `mergedSha` is GitHub's exact merge
 *  generation and is used when the target cannot be fetched. */
export async function workspaceContinueOnNewBranch(args: {
  workspaceId: string;
  baseBranch?: string;
  mergedSha?: string;
}): Promise<{ branch: string }> {
  return bridgeWorkspaceContinueOnNewBranch(
    requireBridge("continue on a new branch"),
    args,
  );
}

export async function workspaceCreateFromBranch(args: {
  repoRoot: string;
  repoSlug?: string;
  organizationId: string | null;
  branchName: string;
  sourceTool?: DetectedTool;
  /** Attach an existing PR when opening it by its head branch (so the Review
   *  tab loads it and "Create draft PR" can't fire a duplicate). */
  prNumber?: number;
  prUrl?: string | null;
}): Promise<CreatedWorkspace> {
  const created = await bridgeWorkspaceCreateFromBranch(
    requireBridge("create a workspace"),
    args,
  );
  void refreshDetectedOpenApps();
  return created;
}

/** Adopt an existing foreign worktree (at `worktreePath`) as a workspace of the
 *  project rooted at `repoRoot` (the primary checkout). No `git worktree add` —
 *  the worktree already exists; the engine just records a DB row for it. */
export async function workspaceAdoptExisting(args: {
  repoRoot: string;
  worktreePath: string;
  branchName: string;
  repoSlug?: string;
  organizationId: string | null;
  sourceTool?: DetectedTool;
}): Promise<CreatedWorkspace> {
  const created = await bridgeWorkspaceAdoptExisting(
    requireBridge("adopt the worktree"),
    args,
  );
  void refreshDetectedOpenApps();
  return created;
}

/** Read a workspace's background-setup output + state (for the Setup tab).
 *  The trunk / "main" (synthetic `local:` workspace, no engine row) must pass
 *  `repoRoot` so the engine can resolve the repo's setup command. `statusOnly`
 *  returns just `state` (log/command placeholders) — for the tab-dot poller. */
export async function workspaceSetupInfo(args: {
  workspaceId: string;
  repoRoot?: string;
  statusOnly?: boolean;
  /** Keep `hasCommand`/`state` but drop the log payload — for pollers that
   *  need to distinguish "no setup configured" from "setup ran" and never
   *  render the output. */
  omitLog?: boolean;
}): Promise<WorkspaceSetupInfo> {
  return bridgeWorkspaceSetupInfo(
    requireBridge("read setup output"),
    args,
  ) as Promise<WorkspaceSetupInfo>;
}

/** (Re)run a workspace's setup command in the background (Setup tab). Returns
 *  `{ ok, hasCommand }` — `hasCommand:false` means the repo has no setup to run.
 *  The trunk passes `repoRoot` (see workspaceSetupInfo). */
export async function workspaceRerunSetup(args: {
  workspaceId: string;
  repoRoot?: string;
}): Promise<{ ok: boolean; hasCommand: boolean }> {
  return bridgeWorkspaceRerunSetup(
    requireBridge("run setup"),
    args,
  ) as Promise<{ ok: boolean; hasCommand: boolean }>;
}

/** Stop a live setup run — records "stopped", not "failed" (Setup tab). */
export async function workspaceStopSetup(args: {
  workspaceId: string;
  repoRoot?: string;
}): Promise<{ ok: boolean }> {
  return bridgeWorkspaceStopSetup(
    requireBridge("stop setup"),
    args,
  ) as Promise<{ ok: boolean }>;
}

// ── Run actions (Run tab — the Setup trio, applied to run) ──

/** One run action's engine-reported status (see RunManager). */
export type WorkspaceRunActionStatus = RunActionStatusWire;

/** Per-action run statuses (live + durable last-run), keyed by actionId. The
 *  caller passes the deterministic per-action session ids (runSessionId); the
 *  trunk passes `repoRoot` like the setup ops. */
export async function workspaceRunInfo(args: {
  workspaceId: string;
  repoRoot?: string;
  sessionIds: string[];
}): Promise<{ actions: Record<string, WorkspaceRunActionStatus> }> {
  return bridgeWorkspaceRunInfo(requireBridge("read run status"), args);
}

/** Start (or focus) a run action. The engine resolves the command from the
 *  repo settings by actionId — the renderer never sends a command string.
 *  `alreadyRunning:true` = the action's PTY is still live; just focus it. */
export async function workspaceStartRun(args: {
  workspaceId: string;
  repoRoot?: string;
  actionId: string;
  sessionId: string;
}): Promise<RunStartReply> {
  return bridgeWorkspaceStartRun(requireBridge("start run"), args);
}

/** Stop a live run action — records "stopped", not "failed" (Run tab). */
export async function workspaceStopRun(args: {
  sessionId: string;
}): Promise<{ ok: boolean }> {
  return bridgeWorkspaceStopRun(requireBridge("stop run"), args);
}

/** Read a run action's buffered output. The terminal replays this when it
 *  mounts too late to attach to a fast-exiting run PTY (Run tab). */
export async function workspaceRunLog(args: {
  sessionId: string;
}): Promise<{ log: string; truncated: boolean }> {
  return bridgeWorkspaceRunLog(requireBridge("read run output"), args);
}

// ── Repository initialization and clone dialogs ─────────

export type InitTemplate = "empty";

export type InitRepoArgs = {
  name: string;
  parentFolder: string;
  template?: InitTemplate;
  initialCommitMessage?: string;
};

export interface InitRepoResult {
  repoRoot: string;
  initialSha: string;
}

export async function workspaceInitRepo(
  args: InitRepoArgs,
): Promise<InitRepoResult> {
  // Creating a local project is a desktop-host operation; remote relay clients
  // have no direct host filesystem. Guard here so a stray non-native call fails
  // with a clear message instead of the raw nativeInvoke error.
  if (!isNativeRuntime()) {
    throw new Error(
      "Creating a project is only available in the Zeros desktop app.",
    );
  }
  return nativeInvoke<InitRepoResult>("workspace_init_repo", args);
}

export type CloneRepoArgs = {
  url: string;
  parentFolder: string;
  directoryName?: string;
};

export interface CloneRepoResult {
  repoRoot: string;
  defaultBranch: string;
}

export async function workspaceClone(
  args: CloneRepoArgs,
): Promise<CloneRepoResult> {
  // Cloning targets the host filesystem — desktop-only (see workspaceInitRepo).
  if (!isNativeRuntime()) {
    throw new Error(
      "Cloning a repository is only available in the Zeros desktop app.",
    );
  }
  return nativeInvoke<CloneRepoResult>("workspace_clone", args);
}

export interface InspectFolderResult {
  isRepo: boolean;
  isWorktree: boolean;
  originUrl: string | null;
  branch: string | null;
  sourceTool: DetectedTool;
  /** Primary checkout (main working tree) of the repo — the parent repo for a
   *  linked worktree, or the folder itself for a primary checkout. Null when
   *  not a repo / unresolvable. */
  mainRoot: string | null;
  /** True when HEAD resolves to a commit. False for a non-repo OR a repo with
   *  zero commits (unborn HEAD) — both need initializing before a worktree. */
  hasCommits: boolean;
}

export async function workspaceInspectFolder(
  folderPath: string,
): Promise<InspectFolderResult> {
  return nativeInvoke<InspectFolderResult>("workspace_inspect_folder", {
    path: folderPath,
  });
}

export async function dialogPickFolder(
  args: {
    title?: string;
    defaultPath?: string;
  } = {},
): Promise<string | null> {
  if (!isNativeRuntime()) return null;
  return nativeInvoke<string | null>("dialog_pick_folder", args);
}

// ── Git ops (read + write) ───────────────────────────────

export interface StatusResult {
  staged: FileChange[];
  unstaged: FileChange[];
  untracked: string[];
  conflicted: FileChange[];
  conflictState: ConflictState;
  /** Local commits ahead of the upstream (unpushed); null when no upstream.
   *  Optional so older engine builds (which don't emit it) degrade gracefully. */
  ahead?: number | null;
  /** Commits the upstream has that we don't (unpulled); null when no upstream. */
  behind?: number | null;
  /** Upstream tracking ref (e.g. `origin/zeros/foo`), or null when unset. */
  upstream?: string | null;
}

export interface ChangeCounts {
  all: number;
  uncommitted: number;
  staged: number;
  unstaged: number;
}

/** ± line totals for the same All Changes comparison `ChangeCounts.all`
 *  counts files for. Binary and conflicted paths contribute nothing. */
export interface ChangeLineCounts {
  additions: number;
  deletions: number;
}

export async function gitStatus(workspaceId: string): Promise<StatusResult> {
  return bridgeGitStatus(requireBridge("read Git status"), workspaceId);
}

export async function gitChangeCounts(
  workspaceId: string,
): Promise<ChangeCounts> {
  return bridgeGitChangeCounts(
    requireBridge("read Git change counts"),
    workspaceId,
  );
}

/** ± line totals for the All Changes net comparison — the workspace tabs' pair. */
export async function gitChangeLineCounts(
  workspaceId: string,
): Promise<ChangeLineCounts> {
  return bridgeGitChangeLineCounts(
    requireBridge("read Git change line counts"),
    workspaceId,
  );
}

/** Exact "anything worth a PR?" boolean from the All Changes net comparison. */
export async function gitHasChanges(workspaceId: string): Promise<boolean> {
  return bridgeGitHasChanges(requireBridge("read Git changes"), workspaceId);
}

/** Resolve `cwd` to the opaque workspace id the engine expects, falling back to
 *  the raw path (which the engine accepts from a local client addressing a repo
 *  root it already knows). Shared by the working-directory ops below. */
async function bridgeWorkspaceIdFor(
  bridge: ReturnType<typeof requireBridge>,
  cwd: string,
): Promise<string> {
  try {
    return (await resolveBridgeWorkspaceIdForCwd(bridge, cwd)) ?? cwd;
  } catch {
    return cwd;
  }
}

/** Which top-level tracked folders are materialized in this worktree.
 *  Engine-only (no native IPC fast path) — an on-demand popover read. */
export async function listWorkingDirectories(
  cwd: string,
): Promise<WorkingDirectoriesWire> {
  const bridge = requireBridge("read working folders");
  return bridgeListWorkingDirectories(
    bridge,
    await bridgeWorkspaceIdFor(bridge, cwd),
  );
}

/** Apply a folder selection, rewriting the worktree via sparse-checkout. */
export async function setWorkingDirectories(
  cwd: string,
  directories: string[],
): Promise<WorkingDirectoriesWire> {
  const bridge = requireBridge("update working folders");
  return bridgeSetWorkingDirectories(
    bridge,
    await bridgeWorkspaceIdFor(bridge, cwd),
    directories,
  );
}

/** Repo-relative file paths under `cwd`, for Files and the composer @ picker.
 * Gitignore-respecting (tracked + untracked-not-ignored). Native IPC remains
 * the fast path for a desktop worktree, but a missing/late preload or IPC fault
 * falls through to the engine instead of becoming an authoritative empty list. */
export async function listWorkspaceFiles(
  cwd: string,
  limit?: number,
): Promise<string[]> {
  if (!cwd) return [];
  const listViaBridge = async (): Promise<string[]> => {
    const bridge = requireBridge("list repository files");
    let workspaceId = cwd;
    try {
      workspaceId = (await resolveBridgeWorkspaceIdForCwd(bridge, cwd)) ?? cwd;
    } catch {
      /* Fall back to the local raw-root bridge path below. */
    }
    return bridgeFileTree(bridge, workspaceId, limit);
  };
  // Local main is outside Electron's trusted worktree roots. Browser development,
  // optional relay clients, and a renderer whose preload has not appeared yet
  // also use the bridge.
  if (isKnownProjectRoot(cwd) || !isNativeRuntime()) return listViaBridge();
  try {
    const res = await nativeInvoke<{ files: string[] }>("git_list_files", {
      cwd,
      ...(limit != null ? { limit } : {}),
    });
    if (!Array.isArray(res?.files)) {
      throw new Error("Native file listing returned an invalid response");
    }
    return res.files;
  } catch {
    return listViaBridge();
  }
}

/** The .gitignore'd entries listWorkspaceFiles omits — what the Files tab needs
 *  to show `node_modules/`, `dist/`, `.env`. Without `dir`: the collapsed
 *  ignored roots. With `dir`: one level inside one of them. Directories carry a
 *  trailing "/". Bridge-only (no native fast path): it is called once per
 *  workspace plus once per directory the user actually opens, so the extra
 *  round-trip is invisible and there is no second code path to keep in sync.
 *
 *  DESKTOP ONLY, and short-circuited here rather than left to fail at the
 *  engine: `file.ignored` is refused for relay clients (it is a one-level
 *  directory enumerator, and .gitignore is the boundary it stops honouring —
 *  see its handler). Without this check a remote client would fire a
 *  guaranteed-REMOTE_OP_NOT_ALLOWED round-trip on every workspace open and
 *  every refresh signal. Returning [] is the same thing the caller does with
 *  the rejection, minus the traffic. */
export async function listIgnoredEntries(
  cwd: string,
  dir?: string,
): Promise<string[]> {
  if (!cwd || !isNativeRuntime()) return [];
  const bridge = requireBridge("list ignored files");
  let workspaceId = cwd;
  try {
    workspaceId = (await resolveBridgeWorkspaceIdForCwd(bridge, cwd)) ?? cwd;
  } catch {
    /* not a managed workspace — the engine resolves a known repo root too */
  }
  return bridgeIgnoredEntries(bridge, workspaceId, dir);
}

export type DiffMode =
  | "worktree-vs-index"
  | "index-vs-head"
  | "worktree-vs-head"
  | "worktree-vs-base"
  | "base"
  | "refs";

export async function gitDiff(args: {
  workspaceId: string;
  filePath?: string;
  against?: "index" | "HEAD" | "main";
  mode?: DiffMode;
  base?: string;
  head?: string;
  rawPatch?: boolean;
}): Promise<{ hunks: Hunk[]; patch?: string }> {
  return bridgeGitDiff(requireBridge("read the Git diff"), args);
}

export interface ShowCommitResult {
  files: FileChange[];
  patch: string;
}

export async function gitShowCommit(args: {
  workspaceId: string;
  sha: string;
}): Promise<ShowCommitResult> {
  return bridgeGitShow(requireBridge("read the commit"), args);
}

/** Commit log for the workspace (HEAD history, newest first). Powers the
 *  Changes-tab scope picker. */
export async function gitLog(args: {
  workspaceId: string;
  limit?: number;
  since?: number;
  ref?: string;
  base?: string;
}): Promise<Commit[]> {
  return bridgeGitLog(requireBridge("read Git history"), args);
}

export async function gitListBranches(workspaceId: string): Promise<Branch[]> {
  return bridgeGitBranches(requireBridge("list Git branches"), workspaceId);
}

/** Remote branches (`refs/remotes/origin/*`, plain names) — the valid PR/merge
 *  targets for the target-branch picker. See listRemoteBranches (engine). */
export async function gitListRemoteBranches(
  workspaceId: string,
): Promise<Branch[]> {
  return bridgeGitRemoteBranches(
    requireBridge("list remote Git branches"),
    workspaceId,
  );
}

export async function gitListAllBranches(args: {
  repoSlug: string;
  repoRoot: string;
}): Promise<Branch[]> {
  return bridgeGitListAllBranches(requireBridge("list all Git branches"), args);
}

// ── Repo branch catalog (repo page Git dropdowns) ────────

export interface RepoRemote {
  name: string;
  url: string;
  /** True when the URL parses as a github.com remote. */
  isGitHub: boolean;
}

export interface CatalogBranch {
  /** Plain branch name (no remote prefix). */
  name: string;
  lastCommitDate: number;
}

/** Everything the repo page's "Branch new workspaces from" / "Remote origin"
 *  pickers need in one read. See repoBranchCatalog (engine). */
export interface RepoBranchCatalog {
  remotes: RepoRemote[];
  /** Settings-effective `git.remote` (default "origin"). */
  effectiveRemote: string;
  /** The listed remote is configured on the repo (its remote-tracking
   *  namespace may still be empty — never fetched). */
  remoteExists: boolean;
  /** True when `git.base_branch` is set by a real settings layer. */
  baseExplicit: boolean;
  /** The branch a new workspace would fork from right now. */
  effectiveBase: string;
  /** The remote's default branch (HEAD), when detectable. */
  detectedDefault: string | null;
  /** Remote the branches were listed from, or null → `branches` are local. */
  listedRemote: string | null;
  branchSource: "remote" | "local";
  branches: CatalogBranch[];
}

/** Remotes + forkable branches for one repo (no workspace needed). `remote`
 *  previews a different remote's branches; `fetch` freshens from the network
 *  first (bounded, best-effort). Throws GitError NOT_A_REPO / WORKSPACE_NOT_FOUND. */
export async function gitRepoBranchCatalog(args: {
  repoRoot: string;
  remote?: string;
  fetch?: boolean;
}): Promise<RepoBranchCatalog | null> {
  return bridgeGitRepoBranchCatalog(
    requireBridge("read the repository branch catalog"),
    args,
  );
}

/** Resolves to the RESULTING branch (prefix included), or null when the engine
 *  didn't report one. Don't rebuild it from `newName` — see renameBranch. */
export async function gitRenameBranch(args: {
  workspaceId: string;
  newName: string;
}): Promise<string | null> {
  return bridgeGitRenameBranch(requireBridge("rename the Git branch"), args);
}

export async function gitStage(args: {
  workspaceId: string;
  paths: string[];
}): Promise<void> {
  await bridgeGitStage(requireBridge("stage files"), args);
}

export async function gitUnstage(args: {
  workspaceId: string;
  paths: string[];
}): Promise<void> {
  await bridgeGitUnstage(requireBridge("unstage files"), args);
}

export async function gitCommit(args: {
  workspaceId: string;
  message: string;
  files?: string[];
  amend?: boolean;
}): Promise<{ sha: string; branch: string }> {
  return bridgeGitCommit(requireBridge("create the Git commit"), args);
}

export async function gitPush(args: {
  workspaceId: string;
  setUpstream?: boolean;
  force?: boolean;
  remote?: string;
}): Promise<{ remoteRef: string; ahead: number; behind: number }> {
  return bridgeGitPush(requireBridge("push Git changes"), args);
}

export async function gitPull(args: {
  workspaceId: string;
  strategy: "rebase" | "merge";
  autoStash?: boolean;
  remote?: string;
}): Promise<{ applied: number; conflicts: string[] }> {
  return bridgeGitPull(requireBridge("pull Git changes"), args);
}

export async function gitChangeTargetBranch(args: {
  workspaceId: string;
  newTarget: string;
  rebase?: boolean;
}): Promise<{ baseBranch: string; conflicts: string[] }> {
  return bridgeGitChangeTargetBranch(
    requireBridge("change the target branch"),
    args,
  );
}

/** Fully discard uncommitted changes to the given TRACKED paths, reverting the
 *  index and working tree to HEAD (`git restore --staged --worktree`). For
 *  untracked / staged-new files there's nothing in HEAD to restore — delete
 *  them with {@link gitClean} instead. */
export async function gitDiscard(args: {
  workspaceId: string;
  paths: string[];
}): Promise<void> {
  await bridgeGitDiscard(requireBridge("discard Git changes"), args);
}

/** Permanently delete untracked files (`git clean -f`). Discard on an untracked
 *  file routes here — there's nothing in git to restore, so discard == delete.
 *  IRREVERSIBLE; callers MUST confirm with the user first. */
export async function gitClean(args: {
  workspaceId: string;
  paths: string[];
}): Promise<{ removed: string[] }> {
  return bridgeGitClean(requireBridge("remove untracked files"), {
    workspaceId: args.workspaceId,
    paths: args.paths,
    confirm: true,
  });
}

// ── GitHub ───────────────────────────────────────────────

export async function ghAuthStatus(): Promise<AuthStatusResult> {
  const bridge = getActiveBridge();
  if (!bridge) return { authenticated: false };
  return bridgeGhAuthStatus(bridge);
}

/** Load the user/organization avatar for an open repository's GitHub owner.
 *  Missing bridge/origin/auth/network/avatar is an expected automatic-icon
 *  miss, so this façade degrades to null. */
export async function ghRepositoryOwnerAvatar(
  repoRoot: string,
): Promise<GithubRepositoryOwnerAvatar | null> {
  const bridge = getActiveBridge();
  if (!bridge || !repoRoot) return null;
  try {
    return await bridgeGhRepositoryOwnerAvatar(bridge, repoRoot);
  } catch {
    return null;
  }
}

export async function ghAuthSnapshot(options?: {
  refreshApp?: boolean;
}): Promise<GithubAuthSnapshot> {
  if (!isNativeRuntime()) {
    return {
      selectedMethod: "gh-cli",
      methods: {
        "gh-cli": {
          method: "gh-cli",
          health: "unavailable",
          configured: false,
          available: false,
        },
        "github-app": {
          method: "github-app",
          health: "unavailable",
          configured: false,
        },
        pat: { method: "pat", health: "unavailable", configured: false },
      },
    };
  }
  return nativeInvoke<GithubAuthSnapshot>("gh_auth_snapshot", {
    refreshApp: options?.refreshApp === true,
  });
}

export async function ghMethodSelect(
  method: GithubAuthMethod,
): Promise<GithubAuthSnapshot> {
  return nativeInvoke("gh_method_select", { method });
}

export async function ghPatConnect(token: string): Promise<{
  login: string;
  snapshot: GithubAuthSnapshot;
}> {
  return nativeInvoke("gh_pat_connect", { token });
}

export async function ghPatRestore(
  undoId: string,
): Promise<GithubAuthSnapshot> {
  return nativeInvoke("gh_pat_restore", { undoId });
}

/** Begin the browser-owned GitHub App authorization/install flow. */
export async function ghAppConnect(options?: {
  installFlow?: boolean;
  forceInstall?: boolean;
}): Promise<{ flowKind: "oauth" | "install" } | null> {
  return nativeInvoke("gh_app_connect", {
    installFlow: options?.installFlow !== false,
    forceInstall: options?.forceInstall === true,
  });
}

export async function ghAppCancel(): Promise<void> {
  await nativeInvoke("gh_app_cancel", {});
}

export async function ghMethodDisconnect(method: GithubAuthMethod): Promise<{
  snapshot: GithubAuthSnapshot;
  undoId?: string;
  undoExpiresAtMs?: number;
}> {
  return nativeInvoke("gh_method_disconnect", { method });
}

export interface GithubAppConnectedPayload {
  login: string;
  installationCount: number;
}

/** Keep in sync with `GithubAppConnectionErrorReason` in
 *  apps/desktop/electron/github-app-controller.ts — main emits these on the
 *  `github-app-error` event AND tags `gh_app_connect` rejections with them. */
const GITHUB_APP_ERROR_REASONS = [
  "access_denied",
  "authorization_expired",
  "github_unavailable",
  "handoff_expired",
  "invalid_callback",
  "nonce_mismatch",
  "not_configured",
  "oauth_failed",
  "signed_out",
  "storage_failed",
] as const;

export type GithubAppErrorReason = (typeof GITHUB_APP_ERROR_REASONS)[number];

const GITHUB_APP_ERROR_REASON_SET = new Set<string>(GITHUB_APP_ERROR_REASONS);

/** Recover the reason main tagged onto a rejected GitHub App command. Returns
 *  null for errors that carry no reason (a bug, a keychain fault), so the caller
 *  can fall back to the error's own sentence. */
export function githubAppErrorReason(
  error: unknown,
): GithubAppErrorReason | null {
  const code =
    error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : null;
  return typeof code === "string" && GITHUB_APP_ERROR_REASON_SET.has(code)
    ? (code as GithubAppErrorReason)
    : null;
}

export function onGithubAppConnected(
  handler: (payload: GithubAppConnectedPayload) => void,
): Promise<() => void> {
  return nativeListen("github-app-connected", handler);
}

export function onGithubAppError(
  handler: (payload: { reason: GithubAppErrorReason }) => void,
): Promise<() => void> {
  return nativeListen("github-app-error", handler);
}

export function onGithubCredentialStoreChanged(
  handler: () => void,
): Promise<() => void> {
  return nativeListen("github-credential-store-changed", handler);
}

export async function ghPrCreate(args: {
  workspaceId: string;
  title: string;
  body: string;
  draft?: boolean;
}): Promise<PR> {
  return bridgeGhPrCreate(requireBridge("create the pull request"), args);
}

/** Can the selected GitHub connection open a pull request on this workspace's
 *  remote? The Create PR control runs this BEFORE it refuses for any other
 *  reason and before it spends an agent turn.
 *
 *  Deliberately never rejects: this exists to pick the right message, so a
 *  missing bridge or a failed request resolves to `unknown` — "we could not
 *  find out", which callers must treat as "carry on", never as "blocked". */
export async function ghRepoAccess(
  workspaceId: string,
): Promise<GithubRepoAccess> {
  const bridge = getActiveBridge();
  if (!bridge) return { state: "unknown" };
  try {
    return await bridgeGhRepoAccess(bridge, workspaceId);
  } catch {
    return { state: "unknown" };
  }
}

// ── Publish to GitHub (desktop-only) ─────────────────────

/** Owners (authed user + orgs) for the publish dialog's dropdown. */
export async function ghListOwners(): Promise<GithubOwner[]> {
  return bridgeGhListOwners(requireBridge("list GitHub owners"));
}

/** Is `<owner>/<name>` available to create? */
export async function ghCheckRepoName(args: {
  owner: string;
  name: string;
}): Promise<{ available: boolean }> {
  return bridgeGhCheckRepoName(
    requireBridge("check the repository name"),
    args,
  );
}

/** Create a private GitHub repo for a local project + push. Returns the new
 *  origin/browser URLs. Throws (surfaced to the dialog) on failure. */
export async function ghPublishRepo(args: {
  repoRoot: string;
  name: string;
  owner?: string;
  private?: boolean;
}): Promise<PublishRepoResult> {
  return bridgeGhPublishRepo(requireBridge("publish the repository"), args);
}

/** Local-only "Initialize Git": `git init` + an initial commit on an EXISTING
 *  folder, no remote. Desktop path; throws (surfaced to the caller) if the
 *  engine bridge isn't connected. */
export async function gitInitInPlace(
  repoRoot: string,
): Promise<InitRepoInPlaceResult> {
  return bridgeGitInitInPlace(
    requireBridge("initialize the repository"),
    repoRoot,
  );
}

export async function ghPrMarkReady(args: {
  workspaceId: string;
  prNumber: number;
}): Promise<PR> {
  return bridgeGhPrMarkReady(
    requireBridge("mark the pull request ready"),
    args,
  );
}

// The PR-status island and the Review tab both read the same PR on the same
// refresh signal. Sharing one in-flight promise per key halves those GitHub
// calls without any staleness risk — entries are removed the moment they
// settle, so this is concurrency coalescing, never a cache.
const inflightPrGets = new Map<string, Promise<PR>>();
const inflightPrChecks = new Map<string, Promise<PrChecksResult>>();
const inflightPrSyncs = new Map<string, Promise<PR | null>>();

export async function ghPrGet(args: {
  workspaceId: string;
  prNumber: number;
}): Promise<PR> {
  const bridge = requireBridge("read the pull request");
  const key = `${args.workspaceId}#${args.prNumber}`;
  const pending = inflightPrGets.get(key);
  if (pending) return pending;
  const request = bridgeGhPrGet(bridge, args).finally(() => {
    if (inflightPrGets.get(key) === request) inflightPrGets.delete(key);
  });
  inflightPrGets.set(key, request);
  return request;
}

/** Detect/reconcile the workspace branch's PR on GitHub, including external
 * draft/ready/closed/merged transitions. This is the durable workspace-row and
 * lifecycle path for activity that bypasses {@link ghPrCreate}. Concurrent
 * discovery/status callers share one request per workspace. */
export async function ghPrSync(workspaceId: string): Promise<PR | null> {
  const pending = inflightPrSyncs.get(workspaceId);
  if (pending) return pending;
  const request = bridgeGhPrSync(
    requireBridge("sync the pull request"),
    workspaceId,
  ).finally(() => {
    if (inflightPrSyncs.get(workspaceId) === request) {
      inflightPrSyncs.delete(workspaceId);
    }
  });
  inflightPrSyncs.set(workspaceId, request);
  return request;
}

export async function ghPrList(args: {
  owner?: string;
  repo?: string;
  originUrl?: string;
  state?: "open" | "closed" | "all";
}): Promise<PR[]> {
  return bridgeGhPrList(requireBridge("list pull requests"), args);
}

export async function ghPrMerge(args: {
  workspaceId: string;
  prNumber: number;
  method: "squash" | "merge" | "rebase";
  commitTitle?: string;
  commitMessage?: string;
}): Promise<{ sha: string }> {
  return bridgeGhPrMerge(requireBridge("merge the pull request"), args);
}

// ── Pull-request review data ─────────────────────────────

export interface PrCheck {
  name: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
  /** Epoch ms — check-run timing (null for commit statuses). */
  startedAt: number | null;
  completedAt: number | null;
}

export interface PrDeployment {
  environment: string;
  state: string;
  description: string | null;
  url: string | null;
}

export interface PrChecksResult {
  checks: PrCheck[];
  deployments: PrDeployment[];
  total: number;
  passed: number;
  failed: number;
  pending: number;
}

export interface PrCommitAuthor {
  name: string;
  avatarUrl: string | null;
}

export interface PrCommitSummary {
  sha: string;
  abbreviatedSha: string;
  message: string;
  authorName: string;
  authorLogin: string | null;
  authorAvatarUrl: string | null;
  date: number;
  /** Additional authors (Co-authored-by) beyond the primary one. */
  coAuthors: PrCommitAuthor[];
  /** Diff stats. Null when the stats lookup fails — the UI hides them. */
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
}

export interface PrTimelineItem {
  kind: "review" | "comment";
  id: number;
  author: string;
  authorAvatarUrl: string | null;
  state: string;
  body: string;
  url: string | null;
  createdAt: number;
}

export async function ghPrChecks(args: {
  workspaceId: string;
  prNumber: number;
}): Promise<PrChecksResult> {
  const bridge = requireBridge("read pull-request checks");
  const key = `${args.workspaceId}#${args.prNumber}`;
  const pending = inflightPrChecks.get(key);
  if (pending) return pending;
  const request = bridgeGhPrChecks(bridge, args).finally(() => {
    if (inflightPrChecks.get(key) === request) inflightPrChecks.delete(key);
  });
  inflightPrChecks.set(key, request);
  return request;
}

export async function ghPrCommits(args: {
  workspaceId: string;
  prNumber: number;
}): Promise<PrCommitSummary[]> {
  return bridgeGhPrCommits(requireBridge("read pull-request commits"), args);
}

export async function ghPrReviews(args: {
  workspaceId: string;
  prNumber: number;
}): Promise<PrTimelineItem[]> {
  return bridgeGhPrReviews(requireBridge("read pull-request reviews"), args);
}

export async function ghPrComment(args: {
  workspaceId: string;
  prNumber: number;
  body: string;
}): Promise<{ id: number; url: string }> {
  return bridgeGhPrComment(
    requireBridge("post the pull-request comment"),
    args,
  );
}

// ── GitError shape (from apps/desktop/src/engine/git/errors.ts) ──────

export interface GitErrorShape {
  name: "GitError";
  code: string;
  message: string;
  remediation?: string;
  context?: Record<string, unknown>;
  causeMessage?: string;
}

/** Best-effort: does this error look like a structured GitError from
 *  the engine? The IPC bridge serializes via toJSON() so the renderer
 *  sees a plain object with `code` + `remediation`. */
export function isGitErrorShape(err: unknown): err is GitErrorShape {
  return (
    !!err &&
    typeof err === "object" &&
    "code" in err &&
    typeof (err as GitErrorShape).code === "string"
  );
}

/** The one human-readable line for a failed git/GitHub op — the engine's
 *  remediation when it sent one, else its message, else the raw error. The
 *  shared toast-description mapping (PR island & friends). */
export function gitErrorDescription(err: unknown): string {
  if (isGitErrorShape(err)) return err.remediation ?? err.message;
  return err instanceof Error ? err.message : String(err);
}

/** True when a sent workspace lifecycle request lost only its response.
 *
 * A bare WORKSPACE_REQUEST timeout leaves the engine transaction running. An
 * `engine disconnected` rejection comes from the in-flight request map when the
 * watchdog replaces that engine; its journal may complete during restart
 * recovery. Neither is an archive/delete outcome, so callers observe the exact
 * workspace row + lifecycle status before publishing success or failure.
 *
 * Deliberately excludes queue-full/reconnecting variants: those requests were
 * never sent and therefore cannot be progressing in the background. */
export function isWorkspaceOpStillRunning(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.message === "Request timeout: WORKSPACE_REQUEST" ||
    err.message === "Request timeout: engine disconnected"
  );
}

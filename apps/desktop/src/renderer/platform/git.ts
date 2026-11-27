import type { ChangesHistory } from "@zeros/protocol/changes-history";

import { isNativeRuntime, nativeInvoke, nativeListen } from "./runtime";
import type {
  GithubAuthMethod,
  GithubAuthSnapshot,
} from "@zeros/protocol/github-auth";
import { refreshDetectedOpenApps } from "./open-apps";
import { getActiveBridge } from "./bridge/active-bridge";
import { isCloudWorkspace } from "./bridge/cloud-workspace-key";
import { requestCloudGithubPrFor } from "./cloud-github-pr";
import type { DesignCanvasItemInput } from "./bridge/design-bridge";
import type {
  WorkingDirectoriesWire,
  WorkspaceFileListing,
} from "./bridge/workspace-bridge";
import {
  bridgeFileTree,
  bridgeWorkspaceFileListing,
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
  bridgeGitFetch,
  bridgeGitRenameBranch,
  bridgeGitChangeTargetBranch,
  bridgeGhPrGet,
  bridgeGhAuthStatus,
  bridgeGhPrSync,
  bridgeGhPrChecks,
  bridgeGhPrRerunFailed,
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
  bridgeGhPrUpdate,
  bridgeGhPrMerge,
  bridgeGhPrComment,
  bridgeGhPrList,
  bridgeGhBranchList,
  bridgeWorkspaceCreate,
  bridgeWorkspaceGet,
  bridgeWorkspaceLifecycleStatus,
  bridgeWorkspaceCreateFromBranchStatus,
  bridgeWorkspacePrepareCreate,
  bridgeWorkspaceListSnapshot,
  type WorkspaceListSnapshot,
  bridgeWorkspaceDelete,
  bridgeWorkspaceArchive,
  bridgeWorkspaceSetMode,
  bridgeWorkspaceSetStatus,
  bridgeWorkspaceReassignLocalOrganization,
  bridgeWorkspaceRestore,
  bridgeWorkspaceRecover,
  bridgeWorkspaceRecoveryInfo,
  bridgeWorkspaceLocate,
  bridgeWorkspaceDeleteSnapshot,
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
  bridgeDesignCreatePage,
  bridgeDesignRenamePage,
  bridgeDesignPutCanvasItem,
  bridgeDesignDeleteCanvasItem,
  bridgeDesignUpdateTheme,
  bridgeDesignMoveComponent,
  bridgeDesignDeletePage,
  bridgeDesignSelectPage,
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
  bridgeDesignCommit,
  bridgeDesignSave,
  bridgeDesignStage,
  bridgeDesignSetText,
  bridgeDesignSetScreenshot,
  bridgeDesignSetRuntimeAudit,
  bridgeDesignSetSelection,
  bridgeDesignStyleBuildPresence,
  bridgeDesignRefreshStyles,
  bridgeDesignSnapshot,
  bridgeDesignPrepareFrames,
  bridgeDesignLintFrames,
  bridgeDesignPreview,
  bridgeDesignMoveFrames,
  bridgeDesignTokens,
  bridgeDesignUpdateToken,
  bridgeDesignUpdateCanvas,
  bridgeDesignUpdateStyles,
  bridgeDesignTransferNode,
  type DesignNodeTransferInput,
  bridgeDesignWriteHtml,
  bridgeDesignInsertAsset,
  isDesignWorkspaceSnapshotWire,
  type DesignFrameDocumentWire,
  type DesignFoundationRevisionWire,
  type DesignFoundationOpenWire,
  type DesignApiMutationReplyWire,
  type DesignFrameGeometryWire,
  type DesignFrameInUseWire,
  type DesignTextFrameSeedWire,
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
  DesignFrameInUseWire,
  DesignTextFrameSeedWire,
  DesignFrameSummaryWire,
  DesignFoundationRevisionWire,
  DesignFoundationOpenWire,
  DesignApiMutationReplyWire,
  DesignFrameTreeNodeWire,
  DesignLintReportWire,
  DesignLintViolationWire,
  DesignMutationReplyWire,
  DesignMutationResultWire,
  DesignScreenshotInputWire,
  DesignSelectionInputWire,
  DesignStyleSourceWire,
  DesignThemeWire,
  DesignTokenWire,
  DesignTokenMutationWire,
  DesignWorkspaceSnapshotWire,
} from "./bridge/design-bridge";
export { WORKING_DIRECTORIES_UNSUPPORTED_COPY } from "./bridge/workspace-bridge";

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
  /** Missing kind from an older engine means Code. */
  kind?: "code" | "design";
  /** Null or omitted owner means Personal. */
  organizationId?: string | null;
  /** Omitted placement on a legacy row means Local. */
  placement?: "local" | "cloud";
  /** Permanent within the owner; older engines and control planes omit it. */
  number?: number | null;
  /** Null means Untitled; omission from an older engine keeps the branch label. */
  title?: string | null;
  repoSlug: string;
  repoRoot: string;
  branch: string;
  baseBranch: string;
  path: string;
  status: WorkspaceStatus;
  createdAt: number;
  archivedAt: number | null;
  stashRef: string | null;
  /** Branch-tip recovery anchor; absent before the lifecycle journal. */
  archivedHead?: string | null;
  /** Durable whole-tree snapshot; older engines can omit it. */
  archiveSnapshot?: string | null;
  prNumber: number | null;
  prState: PrState | null;
  prUrl: string | null;
  agentId: string | null;
  lastActiveAt: number | null;
  /** Stopped means the run ended without a result; null or omitted means no known run. */
  setupState?: "running" | "passed" | "failed" | "stopped" | null;
  /** False confirms the checkout is missing; an omitted probe is not proof. */
  present?: boolean;
  /** Known only for withChanges reads; counts the All Changes net comparison. */
  hasChanges?: boolean;
  /** Local only: the workspace whose agent created this one (`zeros local`). */
  parentWorkspaceId?: string | null;
  /** The cloud project it was created from, by its current name. */
  project?: { id: string; name: string };
  /** A cloud workspace of several repositories, the first being this row's own
   * branch and pull request; absent with one (a Local workspace always has
   * one). Read through `workspaceRepositories()`. */
  repositories?: readonly WorkspaceRepository[];
}

/** One repository of a workspace. */
export interface WorkspaceRepository {
  /** `owner/name`, as GitHub names it. */
  repository: string;
  /** Its folder's name inside the workspace's project folder. */
  folder: string;
  /** What Git, pull request and file requests for this repository target: its
   * folder's key inside the workspace (`<workspace key>/<folder>`), or the
   * workspace's own key when the workspace has one repository. */
  target: string;
  branch: string;
  baseBranch: string;
  prNumber: number | null;
  prState: PrState | null;
  prUrl: string | null;
  /** A later repository of a cloud workspace of several: whether its environment files could be added. */
  environment?: "failed" | "unavailable";
}

export interface WorkspaceSetupInfo {
  hasCommand: boolean;
  /** Prefer the most recent run's command over today's settings. */
  command: string | null;
  /** Last-run state (persisted for a real workspace; in-memory for the trunk). */
  state: "running" | "passed" | "failed" | "stopped" | null;
  /** Output is in memory and is lost on engine restart. */
  log: string;
  truncated: boolean;
}

export interface FileChange {
  path: string;
  status: FileChangeStatus;
  oldPath?: string;
}

/** An oversized tree diff still returns file metadata so the exact selected patch can load separately. */
export interface DiffFileSummary extends FileChange {
  additions: number;
  deletions: number;
  binary: boolean;
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
  /** Forks use their head repository; null means unavailable, omission means an older engine. */
  headRepository?: string | null;
  mergeableState: string;
  isMergeable: boolean | null;
  /** Only populated for a behind PR; null or omission means unknown. */
  behindBy?: number | null;
  createdAt: number;
  updatedAt: number;
  mergedAt: number | null;
  /** Absent when connected to an older engine build. */
  mergeCommitSha?: string | null;
  /** If totals are absent, Review counts the published diff. */
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  authorAvatarUrl?: string | null;
  /** Distinguish missing metadata on older engines from a confirmed empty list. */
  requestedReviewers?: PrPerson[];
  assignees?: PrPerson[];
  labels?: PrLabel[];
}

export interface PrPerson {
  login: string;
  avatarUrl: string | null;
}

export interface PrLabel {
  name: string;
  /** Six-digit hex without the #. */
  color: string | null;
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
  /** Reuse the prepared ID only with its matching preparedBranch. */
  preparedId?: string;
  /** Reuse the reserved branch verbatim; the destination is already visible. */
  preparedBranch?: string;
  /** Local rollback removes only this optimistic chat if creation never publishes. */
  optimisticChatId?: string;
};

export interface AuthStatusResult {
  authenticated: boolean;
  login?: string;
  /** The avatar URL is optional and HTTPS-only. */
  avatarUrl?: string;
}

// Reject an absent bridge so callers keep the last confirmed snapshot, not a false empty result.
function requireBridge(action: string) {
  const bridge = getActiveBridge();
  if (!bridge) {
    throw new Error(
      `Can't ${action}: not connected to the Zeros engine yet — try again in a moment.`,
    );
  }
  return bridge;
}

export interface PreparedWorkspaceCreate {
  workspaceId: string;
  path: string;
  repoSlug: string;
  branch: string;
  /** Older engines omit the reserved workspace number. */
  number?: number;
}

/** Reserve identity and path without touching disk so early navigation cannot leak an empty checkout. */
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
  // Refresh detected apps after creation without delaying navigation.
  void refreshDetectedOpenApps();
  return created;
}

export async function workspaceReassignLocalOrganization(args: {
  fromOrganizationId: string;
  toOrganizationId: string | null;
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
  movementGuard?: import("@zeros/protocol/design-relocation").DesignMovementGuard,
): Promise<DesignApiMutationReplyWire> {
  return bridgeDesignApplyTransaction(
    requireBridge("apply a design transaction"),
    workspaceId,
    frame,
    transaction,
    dryRun,
    movementGuard,
  );
}

export async function designHistory(
  workspaceId: string,
  frame: string | null,
  direction: "undo" | "redo",
  expectedSourceVersions?: Record<string, string>,
): Promise<DesignApiMutationReplyWire> {
  return bridgeDesignHistory(
    requireBridge(`${direction} a design edit`),
    workspaceId,
    frame,
    direction,
    expectedSourceVersions,
  );
}

export async function designFrame(
  workspaceId: string,
  frame: string,
  depth = 4,
  variant?: string,
): Promise<DesignFrameDocumentWire> {
  return bridgeDesignFrame(
    requireBridge("load a design frame"),
    workspaceId,
    frame,
    depth,
    variant,
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

export async function designPrepareFrames(workspaceId: string, directoryId: string, catalogRevision: string, files: readonly string[],
  lintFiles?: readonly string[]) {
  const bridge = requireBridge("prepare design frames");
  const result = await bridgeDesignPrepareFrames(bridge, { workspaceId, directoryId, catalogRevision, files, ...(lintFiles ? { lintFiles } : {}) });
  if (getActiveBridge() !== bridge) throw new Error("Design preparation owner was retired.");
  return result;
}

export async function designLintFrames(workspaceId: string, directoryId: string,
  frames: ReadonlyArray<{ file: string; sourceVersion: string }>) {
  const bridge = requireBridge("lint design frames");
  const result = await bridgeDesignLintFrames(bridge, { workspaceId, directoryId, frames });
  if (getActiveBridge() !== bridge) throw new Error("Design lint owner was retired.");
  return result;
}

export async function designPreview(
  workspaceId: string,
  input: Parameters<typeof bridgeDesignPreview>[2],
  options?: Parameters<typeof bridgeDesignPreview>[3],
): ReturnType<typeof bridgeDesignPreview> {
  return bridgeDesignPreview(requireBridge("preview a design frame"), workspaceId, input, options);
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
  foundationRevision?: DesignFoundationRevisionWire;
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

export async function designRefreshStyles(workspaceId: string): Promise<void> {
  await bridgeDesignRefreshStyles(requireBridge("update design styles"), workspaceId);
}

export async function designStyleBuildPresence(
  workspaceId: string,
  present: boolean,
): Promise<void> {
  await bridgeDesignStyleBuildPresence(
    requireBridge("report Design presence"),
    workspaceId,
    present,
  );
}

export async function designSetRuntimeAudit(
  workspaceId: string,
  input: {
    frame: string;
    sourceVersion: string;
    warnings: DesignRuntimeWarningWire[];
  },
) {
  return bridgeDesignSetRuntimeAudit(
    requireBridge("publish design runtime audit"),
    workspaceId,
    input,
  );
}

export async function designCreatePage(workspaceId: string, title?: string) {
  return bridgeDesignCreatePage(requireBridge("create a design page"), workspaceId, title);
}

export async function designRenamePage(workspaceId: string, pageId: string, title: string) {
  return bridgeDesignRenamePage(requireBridge("rename a design page"), workspaceId, pageId, title);
}

export async function designPutCanvasItem(workspaceId: string, pageId: string, item: DesignCanvasItemInput) {
  return bridgeDesignPutCanvasItem(requireBridge("place a canvas item"), workspaceId, pageId, item);
}

export async function designDeleteCanvasItem(workspaceId: string, pageId: string, itemId: string) {
  return bridgeDesignDeleteCanvasItem(requireBridge("delete a canvas item"), workspaceId, pageId, itemId);
}

export async function designUpdateTheme(workspaceId: string, theme: { id: string; label: string; base?: boolean }) {
  return bridgeDesignUpdateTheme(requireBridge("name a design theme"), workspaceId, theme);
}

export async function designMoveComponent(workspaceId: string, component: string, pageId?: string) {
  return bridgeDesignMoveComponent(requireBridge("move a component onto the canvas"), workspaceId, component, pageId);
}

export async function designDeletePage(workspaceId: string, pageId: string, expectedFrameIds: readonly string[]) {
  return bridgeDesignDeletePage(requireBridge("delete a design page"), workspaceId, pageId, expectedFrameIds);
}

export async function designSelectPage(workspaceId: string, directoryId: string, pageId: string): Promise<void> {
  return bridgeDesignSelectPage(requireBridge("select a design page"), workspaceId, directoryId, pageId);
}

export async function designCreateFrame(
  workspaceId: string,
  title?: string,
  geometry?: DesignFrameGeometryWire,
  seed?: DesignTextFrameSeedWire,
  pageId?: string,
): Promise<{
  frame: DesignFrameSummaryWire;
  snapshot: DesignWorkspaceSnapshotWire;
}> {
  return bridgeDesignCreateFrame(
    requireBridge("create a design frame"),
    workspaceId,
    title,
    geometry,
    seed,
    pageId,
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
  foundationRevision?: DesignFoundationRevisionWire;
}> {
  return bridgeDesignUpdateCanvas(
    requireBridge("move a design frame"),
    workspaceId,
    frame,
    geometry,
  );
}

export async function designMoveFrames(
  workspaceId: string,
  moves: Parameters<typeof bridgeDesignMoveFrames>[2],
): Promise<DesignWorkspaceSnapshotWire> {
  return bridgeDesignMoveFrames(requireBridge("move design frames"), workspaceId, moves);
}

export async function designDuplicateFrame(
  workspaceId: string,
  frame: string,
  pageId?: string,
  placement?: Parameters<typeof bridgeDesignDuplicateFrame>[4],
): Promise<{
  frame: DesignFrameSummaryWire;
  snapshot: DesignWorkspaceSnapshotWire;
}> {
  return bridgeDesignDuplicateFrame(
    requireBridge("duplicate a design frame"),
    workspaceId,
    frame,
    pageId,
    placement,
  );
}

export async function designDeleteFrame(
  workspaceId: string,
  frame: string,
  options?: { ifUnused?: boolean },
): Promise<{
  deleted: { file: string };
  snapshot: DesignWorkspaceSnapshotWire;
} | DesignFrameInUseWire> {
  return bridgeDesignDeleteFrame(
    requireBridge("delete a design frame"),
    workspaceId,
    frame,
    options,
  );
}

export async function designTransferNode(
  workspaceId: string,
  input: DesignNodeTransferInput,
) {
  return bridgeDesignTransferNode(
    requireBridge("move a design layer"),
    workspaceId,
    input,
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

export async function designStage(workspaceId: string): Promise<{ ok: true }> {
  return bridgeDesignStage(requireBridge("stage designs"), workspaceId);
}

export async function designSave(workspaceId: string): Promise<{ ok: true }> {
  return bridgeDesignSave(requireBridge("validate designs"), workspaceId);
}

export async function designCommit(
  workspaceId: string,
  message?: string,
): Promise<{ sha: string; branch: string }> {
  return bridgeDesignCommit(
    requireBridge("commit designs"),
    workspaceId,
    message,
  );
}

export async function workspaceList(
  args: {
    repoSlug?: string;
    status?: WorkspaceStatus;
    /** Omit archive filtering entirely to observe both live and archived rows. */
    archived?: boolean;
    /** Opt in only where exact change flags justify a Git probe per live workspace. */
    withChanges?: boolean;
    /** Filter Design rows locally; do not send this option to the engine. */
    includeDesign?: boolean;
  } = {},
): Promise<Workspace[]> {
  return (await workspaceListSnapshot(args)).workspaces;
}

/** Preserve backend completeness alongside the desktop's filtered rows. */
export async function workspaceListSnapshot(
  args: Exclude<Parameters<typeof workspaceList>[0], undefined> = {},
): Promise<WorkspaceListSnapshot> {
  const bridge = requireBridge("list workspaces");
  const { includeDesign = false, ...bridgeArgs } = args;
  const snapshot = await bridgeWorkspaceListSnapshot(bridge, bridgeArgs);
  // An empty repoSlug identifies the synthetic trunk row used by the web list, not a managed worktree.
  return { ...snapshot, workspaces: snapshot.workspaces.filter(
    (workspace) =>
      workspace.repoSlug !== "" &&
      (includeDesign || workspace.kind !== "design"),
  ) };
}

/** See create-journal rows hidden from lists to distinguish provisioning from rollback. */
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

/** After timeout, observe both pre-journal and durable work instead of inferring an outcome from elapsed time. */
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

/** Recover by repo and branch when the lost create reply had the generated ID. */
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
  return bridgeWorkspaceDelete(requireBridge("delete the workspace"), args);
}

export async function workspaceRecover(args: {
  workspaceId: string;
}): Promise<RestoreResult> {
  return bridgeWorkspaceRecover(requireBridge("recover the workspace"), args);
}

export interface WorkspaceRecoveryInfo {
  action: "restore" | "locate" | "none";
  snapshotAt: number | null;
}

export function workspaceRecoveryInfo(
  workspaceId: string,
): Promise<WorkspaceRecoveryInfo> {
  return bridgeWorkspaceRecoveryInfo(
    requireBridge("check workspace recovery"),
    workspaceId,
  );
}

export function workspaceLocate(args: {
  workspaceId: string;
  path: string;
}): Promise<RestoreResult> {
  return bridgeWorkspaceLocate(requireBridge("locate the workspace"), args);
}

export async function workspaceDeleteSnapshot(args: {
  workspaceId: string;
  archiveSnapshot: string;
  archivedAt: number;
}): Promise<Workspace> {
  return bridgeWorkspaceDeleteSnapshot(
    requireBridge("delete the saved snapshot"),
    args,
  );
}

export interface ArchiveResult {
  archivedAt: number;
  stashRef: string | null;
  /** Older engines can omit the snapshot target. */
  archiveSnapshot?: string | null;
  /** Older engines can omit the row; the caller updates its existing row from these fields. */
  workspace?: Workspace;
}

export interface RestoreResult {
  restoredAt: number;
  /** Checkpoint conflicts are reported as paths even when restore succeeds. */
  conflicts: string[];
  /** Use the returned path; an occupied destination can force a sibling checkout. */
  path: string;
  /** Use the returned branch; restore can fork when the original is already checked out. */
  branch: string;
  /** User-facing recovery notes when restore changed the path or branch. */
  adaptations: string[];
  /** Older engines can omit the restored row. */
  workspace?: Workspace;
}

/** Default the legacy stashUncommitted wire flag on so older engines preserve uncommitted files. */
export async function workspaceArchive(args: {
  workspaceId: string;
  stashUncommitted?: boolean;
}): Promise<ArchiveResult> {
  return bridgeWorkspaceArchive(requireBridge("archive the workspace"), {
    stashUncommitted: true,
    ...args,
  });
}

/** Manual changes bypass automatic status transition guards. */
export async function workspaceSetStatus(args: {
  workspaceId: string;
  status: WorkspaceStatus;
}): Promise<void> {
  await bridgeWorkspaceSetStatus(
    requireBridge("set the workspace status"),
    args,
  );
}

/** First Design entry retires earlier code-agent sessions on the same checkout, not Setup, runs, or human terminals. */
export async function workspaceSetMode(args: {
  workspaceId: string;
  mode: "code" | "design";
}): Promise<{
  ok: true;
  mode: "code" | "design";
  snapshot?: DesignWorkspaceSnapshotWire;
}> {
  const result = await bridgeWorkspaceSetMode(
    requireBridge("switch the workspace mode"),
    args,
  );
  if (
    result.ok !== true ||
    (result.mode !== "code" && result.mode !== "design") ||
    (result.snapshot !== undefined &&
      !isDesignWorkspaceSnapshotWire(result.snapshot))
  ) {
    throw new Error("workspace.setMode: malformed engine response");
  }
  return {
    ok: true,
    mode: result.mode,
    ...(result.snapshot ? { snapshot: result.snapshot } : {}),
  };
}

export async function workspaceRestore(args: {
  workspaceId: string;
}): Promise<RestoreResult> {
  return bridgeWorkspaceRestore(requireBridge("restore the workspace"), args);
}

/** Continue in the same worktree; the exact mergedSha is the fallback when the target cannot be fetched. */
export async function workspaceContinueOnNewBranch(args: {
  workspaceId: string;
  baseBranch?: string;
  mergedSha?: string;
}): Promise<{ branch: string; conflicts?: string[] }> {
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
  /** Attach the existing PR so the imported workspace cannot create a duplicate. */
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

/** Adopt the existing checkout without issuing git worktree add. */
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

/** Pass repoRoot for rowless trunk setup; statusOnly skips command resolution and returns only meaningful state. */
export async function workspaceSetupInfo(args: {
  workspaceId: string;
  repoRoot?: string;
  statusOnly?: boolean;
  /** For readers that need hasCommand but never render the log, use omitLog rather than statusOnly. */
  omitLog?: boolean;
}): Promise<WorkspaceSetupInfo> {
  return bridgeWorkspaceSetupInfo(
    requireBridge("read setup output"),
    args,
  ) as Promise<WorkspaceSetupInfo>;
}

/** Pass repoRoot for rowless trunk setup; hasCommand=false means no configured command ran. */
export async function workspaceRerunSetup(args: {
  workspaceId: string;
  repoRoot?: string;
}): Promise<{ ok: boolean; hasCommand: boolean }> {
  return bridgeWorkspaceRerunSetup(
    requireBridge("run setup"),
    args,
  ) as Promise<{ ok: boolean; hasCommand: boolean }>;
}

/** A user stop is recorded as stopped, not failed. */
export async function workspaceStopSetup(args: {
  workspaceId: string;
  repoRoot?: string;
}): Promise<{ ok: boolean }> {
  return bridgeWorkspaceStopSetup(
    requireBridge("stop setup"),
    args,
  ) as Promise<{ ok: boolean }>;
}

export type WorkspaceRunActionStatus = RunActionStatusWire;

/** Use deterministic run session IDs to join live and persisted state; rowless trunk also needs repoRoot. */
export async function workspaceRunInfo(args: {
  workspaceId: string;
  repoRoot?: string;
  sessionIds: string[];
}): Promise<{ actions: Record<string, WorkspaceRunActionStatus> }> {
  return bridgeWorkspaceRunInfo(requireBridge("read run status"), args);
}

/** Pass actionId, never a shell command; the engine resolves the command from repo settings. */
export async function workspaceStartRun(args: {
  workspaceId: string;
  repoRoot?: string;
  actionId: string;
  sessionId: string;
}): Promise<RunStartReply> {
  return bridgeWorkspaceStartRun(requireBridge("start run"), args);
}

/** A user stop is recorded as stopped, not failed. */
export async function workspaceStopRun(args: {
  workspaceId: string;
  sessionId: string;
}): Promise<{ ok: boolean }> {
  return bridgeWorkspaceStopRun(requireBridge("stop run"), args);
}

/** Replay the buffer when a run finishes before the terminal can attach. */
export async function workspaceRunLog(args: {
  workspaceId?: string;
  sessionId: string;
}): Promise<{ log: string; truncated: boolean }> {
  return bridgeWorkspaceRunLog(requireBridge("read run output"), args);
}

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
  /** A linked worktree reports its primary checkout, not its own folder. */
  mainRoot: string | null;
  /** An unborn HEAD cannot provision a worktree, even if the folder is already a repo. */
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

export interface StatusResult {
  staged: FileChange[];
  unstaged: FileChange[];
  untracked: string[];
  conflicted: FileChange[];
  conflictState: ConflictState;
  /** Null means no upstream; older engines can omit tracking data. */
  ahead?: number | null;
  behind?: number | null;
  upstream?: string | null;
  /** Only cloud workers with bounded-history support report this flag. */
  shallow?: boolean;
  /** Local-only, opt-in branch/base facts; older engines omit this field. */
  summary?: {
    branch: string | null;
    base: { ref: string; behind: number } | null;
  };
}

export interface ChangeCounts {
  all: number;
  uncommitted: number;
  staged: number;
  unstaged: number;
}

/** Use the All Changes comparison; binary and conflicted paths do not add line totals. */
export interface ChangeLineCounts {
  additions: number;
  deletions: number;
}

export async function gitStatus(
  workspaceId: string,
  options: { paths?: string[]; includeTracking?: boolean; includeSummary?: boolean } = {},
): Promise<StatusResult> {
  return bridgeGitStatus(
    requireBridge("read Git status"),
    workspaceId,
    options,
  );
}

export async function gitChangeCounts(
  workspaceId: string,
): Promise<ChangeCounts> {
  return bridgeGitChangeCounts(
    requireBridge("read Git change counts"),
    workspaceId,
  );
}

export async function gitChangeLineCounts(
  workspaceId: string,
): Promise<ChangeLineCounts> {
  return bridgeGitChangeLineCounts(
    requireBridge("read Git change line counts"),
    workspaceId,
  );
}

/** Use the All Changes net comparison, not the worktree dirty bit. */
export async function gitHasChanges(workspaceId: string): Promise<boolean> {
  return bridgeGitHasChanges(requireBridge("read Git changes"), workspaceId);
}

/** The fallback raw path is valid only for a Local client naming a registered root. */
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

/** Use the known workspace ID on cold reads to skip resolving it through the workspace list. */
export async function listWorkingDirectories(
  cwd: string,
  workspaceId?: string | null,
): Promise<WorkingDirectoriesWire> {
  const bridge = requireBridge("read working folders");
  return bridgeListWorkingDirectories(
    bridge,
    workspaceId?.trim() || (await bridgeWorkspaceIdFor(bridge, cwd)),
  );
}

export async function setWorkingDirectories(
  cwd: string,
  directories: string[],
  workspaceId?: string | null,
): Promise<WorkingDirectoriesWire> {
  const bridge = requireBridge("update working folders");
  return bridgeSetWorkingDirectories(
    bridge,
    workspaceId?.trim() || (await bridgeWorkspaceIdFor(bridge, cwd)),
    directories,
  );
}

/** Return tracked and non-ignored untracked files; fall back to the engine after native failure, not to empty. */
export async function listWorkspaceFiles(
  cwd: string,
  limit?: number,
): Promise<string[]> {
  return (await readWorkspaceFileListing(cwd, limit, false)).files;
}

/** Directories end in a slash; the Local engine refuses ignored entries over relay. */
export async function listWorkspaceMentionPaths(
  cwd: string,
  query: string,
  mentionRevision?: string,
): Promise<string[]> {
  try {
    return (
      await readWorkspaceFileListing(cwd, 64, false, {
        includeIgnored: true,
        query,
        ...(mentionRevision ? { mentionRevision } : {}),
      })
    ).files;
  } catch (error) {
    // Only explicit relay denial allows a filtered fallback; other failures must retain the last confirmed inclusive list.
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "REMOTE_RESTRICTED"
    )
      return listWorkspaceFiles(cwd);
    throw error;
  }
}

export async function listWorkspaceFileListing(
  cwd: string,
  limit?: number,
): Promise<WorkspaceFileListing> {
  if (isCloudWorkspace(cwd)) {
    return bridgeWorkspaceFileListing(requireBridge("list repository files"), cwd, limit, true);
  }
  return readWorkspaceFileListing(cwd, limit, true);
}

async function readWorkspaceFileListing(
  cwd: string,
  limit: number | undefined,
  includeDesignDirectories: boolean,
  options: {
    includeIgnored?: boolean;
    query?: string;
    mentionRevision?: string;
  } = {},
): Promise<WorkspaceFileListing> {
  if (!cwd) return { files: [] };
  const listViaBridge = async (): Promise<WorkspaceFileListing> => {
    const bridge = requireBridge("list repository files");
    let workspaceId = cwd;
    try {
      workspaceId = (await resolveBridgeWorkspaceIdForCwd(bridge, cwd)) ?? cwd;
    } catch {
      /* Fall back to the local raw-root bridge path below. */
    }
    return includeDesignDirectories
      ? bridgeWorkspaceFileListing(bridge, workspaceId, limit)
      : { files: await bridgeFileTree(bridge, workspaceId, limit, options) };
  };
  // Registered primary checkouts use engine authorization instead of Electron's worktree allowlist.
  if (isCloudWorkspace(cwd) || isKnownProjectRoot(cwd) || !isNativeRuntime()) return listViaBridge();
  try {
    const res = await nativeInvoke<WorkspaceFileListing>("git_list_files", {
      cwd,
      ...(limit != null ? { limit } : {}),
      ...(includeDesignDirectories ? { includeDesignDirectories: true } : {}),
      ...options,
    });
    if (!Array.isArray(res?.files)) {
      throw new Error("Native file listing returned an invalid response");
    }
    return res;
  } catch {
    return listViaBridge();
  }
}

/** Return collapsed ignored roots, or one level under dir; non-native clients receive no ignored entries. */
export async function listIgnoredEntries(
  cwd: string,
  dir?: string,
): Promise<string[]> {
  if (!cwd || !isNativeRuntime()) return [];
  const bridge = requireBridge("list ignored files");
  if (isCloudWorkspace(cwd)) return bridgeIgnoredEntries(bridge, cwd, dir, true);
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
  oldFilePath?: string;
  against?: "index" | "HEAD" | "main";
  mode?: DiffMode;
  base?: string;
  head?: string;
  rawPatch?: boolean;
  fullContext?: boolean;
  summaryLimit?: number;
  history?: ChangesHistory;
}): Promise<{
  hunks: Hunk[];
  patch?: string;
  files?: DiffFileSummary[];
  summary?: boolean;
}> {
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

export async function gitLog(args: {
  workspaceId: string;
  limit?: number;
  skip?: number;
  since?: number;
  ref?: string;
  base?: string;
}): Promise<Commit[]> {
  return bridgeGitLog(requireBridge("read Git history"), args);
}

export async function gitListBranches(workspaceId: string): Promise<Branch[]> {
  return bridgeGitBranches(requireBridge("list Git branches"), workspaceId);
}

/** Remote branch names omit refs/remotes/origin/. */
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

export interface RepoRemote {
  name: string;
  url: string;
  isGitHub: boolean;
}

export interface CatalogBranch {
  /** Unqualified branch name, not a remote ref. */
  name: string;
  lastCommitDate: number;
}

export interface RepoBranchCatalog {
  remotes: RepoRemote[];
  /** Effective git.remote setting, defaulting to origin. */
  effectiveRemote: string;
  /** A configured remote can exist before any branches are fetched. */
  remoteExists: boolean;
  /** True only when a settings layer supplies git.base_branch. */
  baseExplicit: boolean;
  effectiveBase: string;
  detectedDefault: string | null;
  /** Null means the catalog lists local branches. */
  listedRemote: string | null;
  branchSource: "remote" | "local";
  branches: CatalogBranch[];
}

/** Fetch, when requested, is bounded and best effort; selecting a remote here does not save it. */
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

/** Use the returned branch rather than rebuilding it; the engine may add a prefix. */
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

export async function gitFetch(args: {
  workspaceId: string;
  unshallow?: boolean;
}): Promise<{ summary: string; historyLimited?: true }> {
  return bridgeGitFetch(requireBridge("fetch Git history"), args);
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

/** Restore tracked paths to HEAD; paths with no HEAD entry need gitClean instead. */
export async function gitDiscard(args: {
  workspaceId: string;
  paths: string[];
}): Promise<void> {
  await bridgeGitDiscard(requireBridge("discard Git changes"), args);
}

/** Untracked deletion is irreversible; the caller must confirm with the user. */
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

export async function ghAuthStatus(workspaceId?: string): Promise<AuthStatusResult> {
  const cloud = requestCloudGithubPrFor(workspaceId, "gh.authStatus");
  if (cloud) {
    try { return await cloud as AuthStatusResult; }
    catch (error) {
      if (isGitErrorShape(error) && error.code === "NOT_AUTHENTICATED") return { authenticated: false };
      throw error;
    }
  }
  const bridge = getActiveBridge();
  if (!bridge) return { authenticated: false };
  return bridgeGhAuthStatus(bridge, workspaceId);
}

/** An unavailable avatar is an expected optional-icon miss, not a failed repository read. */
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
  userId?: string;
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
    ...(options?.userId ? { userId: options.userId } : {}),
    refreshApp: options?.refreshApp === true,
  });
}

export async function ghMethodSelect(
  method: GithubAuthMethod,
  userId?: string,
): Promise<GithubAuthSnapshot> {
  return nativeInvoke("gh_method_select", { method, ...(userId ? { userId } : {}) });
}

export async function ghPatConnect(token: string, userId?: string): Promise<{
  login: string;
  snapshot: GithubAuthSnapshot;
}> {
  return nativeInvoke("gh_pat_connect", { token, ...(userId ? { userId } : {}) });
}

export async function ghPatRestore(
  undoId: string,
): Promise<GithubAuthSnapshot> {
  return nativeInvoke("gh_pat_restore", { undoId });
}

/** The browser owns GitHub App authorization. */
export async function ghAppConnect(options?: {
  installFlow?: boolean;
  forceInstall?: boolean;
  preserveSelectedMethod?: boolean;
  cloudOnly?: boolean;
  shared?: { userId: string; organizationId: string; expected: string };
}): Promise<{ flowKind: "oauth" | "install" } | null> {
  return nativeInvoke("gh_app_connect", {
    installFlow: options?.installFlow !== false,
    forceInstall: options?.forceInstall === true,
    ...(options?.cloudOnly ? { cloudOnly: true } : {}),
    ...(options?.preserveSelectedMethod ? { preserveSelectedMethod: true } : {}),
    ...(options?.shared ? { shared: options.shared } : {}),
  });
}

export async function ghAppCancel(): Promise<boolean> {
  return (await nativeInvoke<boolean | null>("gh_app_cancel", {})) !== false;
}

export async function ghMethodDisconnect(method: GithubAuthMethod, userId?: string): Promise<{
  snapshot: GithubAuthSnapshot;
  undoId?: string;
  undoExpiresAtMs?: number;
}> {
  return nativeInvoke("gh_method_disconnect", { method, ...(userId ? { userId } : {}) });
}

export interface GithubAppConnectedPayload {
  login: string;
  installationCount: number;
}

/** Match main's GithubAppConnectionErrorReason for both github-app-error events and gh_app_connect rejections. */
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

/** Return null for untagged errors so the caller can display the original message. */
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

/** Unknown is not a denial; probe before other gates or starting a Create PR agent turn. */
export async function ghRepoAccess(
  workspaceId: string,
): Promise<GithubRepoAccess> {
  const cloud = requestCloudGithubPrFor(workspaceId, "gh.repoAccess");
  if (cloud) return cloud.catch(() => ({ state: "unknown" })) as Promise<GithubRepoAccess>;
  const bridge = getActiveBridge();
  if (!bridge) return { state: "unknown" };
  try {
    return await bridgeGhRepoAccess(bridge, workspaceId);
  } catch {
    return { state: "unknown" };
  }
}

export async function ghListOwners(): Promise<GithubOwner[]> {
  return bridgeGhListOwners(requireBridge("list GitHub owners"));
}

export async function ghCheckRepoName(args: {
  owner: string;
  name: string;
}): Promise<{ available: boolean }> {
  return bridgeGhCheckRepoName(
    requireBridge("check the repository name"),
    args,
  );
}

export async function ghPublishRepo(args: {
  repoRoot: string;
  name: string;
  owner?: string;
  private?: boolean;
}): Promise<PublishRepoResult> {
  return bridgeGhPublishRepo(requireBridge("publish the repository"), args);
}

/** Initialize an existing Local folder and commit without creating a remote. */
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
  const cloud = requestCloudGithubPrFor(args.workspaceId, "gh.prMarkReady", args);
  if (cloud) return cloud as Promise<PR>;
  return bridgeGhPrMarkReady(
    requireBridge("mark the pull request ready"),
    args,
  );
}

export async function ghPrUpdate(args: {
  workspaceId: string;
  prNumber: number;
  body: string;
}): Promise<PR> {
  const cloud = requestCloudGithubPrFor(args.workspaceId, "gh.prUpdate", args);
  if (cloud) return cloud as Promise<PR>;
  return bridgeGhPrUpdate(requireBridge("update the pull request"), args);
}

// Coalesce concurrent PR reads per key, never reuse a settled result.
const inflightPrGets = new Map<string, Promise<PR>>();
const inflightPrChecks = new Map<string, Promise<PrChecksResult>>();
const inflightPrSyncs = new Map<string, Promise<PR | null>>();

export async function ghPrGet(args: {
  workspaceId: string;
  prNumber: number;
}): Promise<PR> {
  const cloud = requestCloudGithubPrFor(args.workspaceId, "gh.prGet", args);
  if (cloud) return cloud as Promise<PR>;
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

/** Reconcile external PR transitions into durable workspace state, including activity outside ghPrCreate. */
export async function ghPrSync(workspaceId: string): Promise<PR | null> {
  const cloud = requestCloudGithubPrFor(workspaceId, "gh.prSync");
  if (cloud) return cloud as Promise<PR | null>;
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

export interface GithubBranch { name: string; isDefault: boolean }
export async function ghBranchList(args: { owner: string; repo: string }): Promise<GithubBranch[]> {
  return bridgeGhBranchList(requireBridge("list GitHub branches"), args);
}

export async function ghPrList(args: {
  workspaceId?: string;
  owner?: string;
  repo?: string;
  originUrl?: string;
  state?: "open" | "closed" | "all";
}): Promise<PR[]> {
  const cloud = requestCloudGithubPrFor(args.workspaceId, "gh.prList", args);
  if (cloud) return cloud as Promise<PR[]>;
  return bridgeGhPrList(requireBridge("list pull requests"), args);
}

export async function ghPrMerge(args: {
  workspaceId: string;
  prNumber: number;
  method: "squash" | "merge" | "rebase";
  commitTitle?: string;
  commitMessage?: string;
}): Promise<{ sha: string }> {
  const cloud = requestCloudGithubPrFor(args.workspaceId, "gh.prMerge", args);
  if (cloud) return cloud as Promise<{ sha: string }>;
  return bridgeGhPrMerge(requireBridge("merge the pull request"), args);
}

export interface PrCheck {
  name: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
  /** Epoch milliseconds; commit statuses do not have check-run timing. */
  startedAt: number | null;
  completedAt: number | null;
  /** Omitted means branch requirements are unknown, not false. */
  required?: boolean;
  rerunnable?: boolean;
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
  /** Required checks that have not reported for the head commit yet. */
  expected?: Array<{ name: string }>;
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
  coAuthors: PrCommitAuthor[];
  /** Null means unavailable stats, not zero changes. */
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
  /** Missing or null status does not prove that checks passed. */
  checks?: PrCommitChecks | null;
}

export type PrCommitChecks = "passed" | "failed" | "pending";

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
  const cloud = requestCloudGithubPrFor(args.workspaceId, "gh.prChecks", args);
  if (cloud) return cloud as Promise<PrChecksResult>;
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

/** Refuse to rerun failures if the pull request no longer points at the displayed head. */
export async function ghPrRerunFailed(args: {
  workspaceId: string;
  prNumber: number;
  headSha: string;
}): Promise<{ rerun: number }> {
  const cloud = requestCloudGithubPrFor(args.workspaceId, "gh.prRerunFailed", args);
  if (cloud) return cloud as Promise<{ rerun: number }>;
  return bridgeGhPrRerunFailed(requireBridge("re-run the failed checks"), args);
}

export async function ghPrCommits(args: {
  workspaceId: string;
  prNumber: number;
}): Promise<PrCommitSummary[]> {
  const cloud = requestCloudGithubPrFor(args.workspaceId, "gh.prCommits", args);
  if (cloud) return cloud as Promise<PrCommitSummary[]>;
  return bridgeGhPrCommits(requireBridge("read pull-request commits"), args);
}

export async function ghPrReviews(args: {
  workspaceId: string;
  prNumber: number;
}): Promise<PrTimelineItem[]> {
  const cloud = requestCloudGithubPrFor(args.workspaceId, "gh.prReviews", args);
  if (cloud) return cloud as Promise<PrTimelineItem[]>;
  return bridgeGhPrReviews(requireBridge("read pull-request reviews"), args);
}

export async function ghPrComment(args: {
  workspaceId: string;
  prNumber: number;
  body: string;
}): Promise<{ id: number; url: string }> {
  const cloud = requestCloudGithubPrFor(args.workspaceId, "gh.prComment", args);
  if (cloud) return cloud as Promise<{ id: number; url: string }>;
  return bridgeGhPrComment(
    requireBridge("post the pull-request comment"),
    args,
  );
}


export interface GitErrorShape {
  name: "GitError";
  code: string;
  message: string;
  remediation?: string;
  context?: Record<string, unknown>;
  causeMessage?: string;
}

/** The bridge serializes GitError as a plain object, not an Error instance. */
export function isGitErrorShape(err: unknown): err is GitErrorShape {
  return (
    !!err &&
    typeof err === "object" &&
    "code" in err &&
    typeof (err as GitErrorShape).code === "string"
  );
}

export function gitErrorDescription(err: unknown): string {
  if (isGitErrorShape(err)) return err.remediation ?? err.message;
  return err instanceof Error ? err.message : String(err);
}

/** A sent lifecycle request can finish in the engine or its journal after timeout; observe exact state. Queue-full and reconnecting requests were never sent. */
export function isWorkspaceOpStillRunning(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.message === "Request timeout: WORKSPACE_REQUEST" ||
    err.message === "Request timeout: engine disconnected"
  );
}

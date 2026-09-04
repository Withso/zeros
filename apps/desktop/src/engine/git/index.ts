// Public API barrel for the git + GitHub integration layer.
//
// Imports from apps/desktop/electron/ipc/commands/*.ts should always go through this
// barrel rather than reaching into submodule files directly. That keeps
// the engine module's surface area small and lets us re-organize the
// internals without breaking callers.

export { GitError, isGitError } from "./errors";
export type { GitErrorCode, GitErrorOptions } from "./errors";

export type {
  ArchiveOptions,
  ArchiveResult,
  Branch,
  Commit,
  CreatedWorkspace,
  CreateWorkspaceOptions,
  DeleteOptions,
  DetectedTool,
  FileChange,
  FileChangeStatus,
  Hunk,
  PR,
  PrState,
  RestoreResult,
  SetupState,
  Workspace,
  WorkspaceKind,
  WorkspaceMode,
  WorkspaceStatus,
} from "./types";

// ── Design mode (one workspace, two modes) ────────────────
export {
  enterDesignMode,
  exitDesignMode,
  reconcileDesignModeTransition,
  ensureDesignDocumentInitialized,
  renameDesignDirectory,
} from "./design-mode";

export {
  deriveBranchNameFromPrompt,
  colourDictionary,
  generateWorkspaceId,
  isValidBranchName,
} from "./naming";

export { proposeBranchRename } from "./rename-hook";
export type {
  ProposeBranchRenameOptions,
  ProposeBranchRenameResult,
} from "./rename-hook";

export {
  getInProgressState,
  isRepo,
  readOriginUrl,
  repoSlugFromOriginUrl,
  resolveGitdir,
} from "./repo";

export {
  closeState,
  designWorktreesRoot,
  detachLockPath,
  seedFromDisk,
  setStateRootForTesting,
  stateDbPath,
  worktreesRoot,
  zerosStateRoot,
  setWorkspaceRemoteRestricted,
  listRemoteRestrictedWorkspaceIds,
  getWorkspaceById,
  reassignLocalWorkspaceOrganization,
  updateWorkspace,
} from "./state";

// ── Background setup runner (Setup tab) ──────────────────
export { SetupManager, setupSessionId, isSetupSession } from "./setup-runner";
export type { SetupInfo, SetupTarget } from "./setup-runner";
export { resolveSetupCommand, buildSetupCommandEnv } from "./setup-hooks";

export { previewFilesToCopy, resolveFilesToCopy } from "./files-to-copy";
export type {
  FilesToCopyPattern,
  FilesToCopyPatternStat,
  FilesToCopyPreview,
  FilesToCopyPreviewFile,
  FilesToCopyResult,
  FilesToCopySource,
} from "./files-to-copy";

export {
  archiveWorkspace,
  createWorkspace,
  prepareWorkspaceCreate,
  deleteWorkspace,
  getWorkspace,
  getWorkspaceLifecycleStatus,
  listWorkspaces,
  pruneOrphanArchiveSnapshots,
  pruneOrphanWorkspaceBranchOwnershipRefs,
  reconcileInterruptedWorkspaceLifecycles,
  restoreWorkspace,
  setSyntheticGitWorkspaceResolver,
  setWorkspaceStatus,
  migrateWorktreesToNewRoot,
  whenSeedingSettled,
  workspaceOwnsManagedCheckout,
} from "./worktree";
export type {
  CreateWorkspaceInput,
  ListWorkspacesOptions,
  PreparedWorkspaceCreate,
  WorkspaceLifecycleStatus,
  WorkspaceLifecycleRecoveryResult,
} from "./worktree";

// ── Git operations, branches, diffs, staging, and fetch ─

export {
  abortOperation,
  assertGitCheckpointReady,
  changeTargetBranch,
  cherryPick,
  commit,
  continueOperation,
  createTag,
  deleteTag,
  dropStash,
  listStashes,
  listTags,
  merge,
  applyStash,
  pull,
  push,
  rebase,
  revert,
  stashPop,
  stashSave,
} from "./ops";
export type {
  ChangeTargetBranchOptions,
  ChangeTargetBranchResult,
  CherryPickOptions,
  CommitOptions,
  CommitResult,
  MergeOptions,
  MergeResult,
  PullOptions,
  PullResult,
  PushOptions,
  PushResult,
  RebaseOptions,
  RebaseResult,
  StashEntry,
  StashPopOptions,
  StashPopResult,
  StashSaveOptions,
  StashSaveResult,
} from "./ops";

export {
  checkoutBranch,
  continueOnNewBranch,
  createBranchFrom,
  deleteBranch,
  listBranches,
  listRemoteBranches,
  renameBranch,
} from "./branch";
export type {
  CheckoutBranchOptions,
  ContinueOnNewBranchOptions,
  CreateBranchFromOptions,
  DeleteBranchOptions,
  RenameBranchOptions,
} from "./branch";

export { listWorkspaceFiles, listIgnoredEntries } from "./workspace-files";

export {
  getWorkingDirectories,
  setWorkingDirectories,
} from "./sparse-checkout";
export type {
  SetWorkingDirectoriesResult,
  WorkingDirectoriesState,
} from "./sparse-checkout";

export {
  changeCounts,
  changeLineCounts,
  diff,
  hasWorkspaceChanges,
  log,
  showCommit,
  stampChangeState,
  status,
} from "./diff";
export type {
  ChangeCounts,
  ChangeLineCounts,
  ChangePathFilter,
  ConflictState,
  DiffFileSummary,
  DiffMode,
  DiffOptions,
  DiffResult,
  LogOptions,
  ShowCommitResult,
  StatusOptions,
  StatusResult,
} from "./diff";

export { clean, discardFiles, reset, restoreFrom } from "./restore";
export type {
  CleanOptions,
  CleanResult,
  DiscardOptions,
  ResetMode,
  ResetOptions,
  RestoreFromOptions,
} from "./restore";

export {
  discardHunk,
  inspectApplyPatchPaths,
  stageHunk,
  stagePaths,
  unstageHunk,
  unstagePaths,
} from "./stage";
export type { ApplyHunkOptions, StageOptions } from "./stage";

export { fetch } from "./fetch";
export type { FetchOptions, FetchResult } from "./fetch";

// ── Repository initialization and clone dialogs ──────────

export { cloneRepo, initRepo } from "./init-clone";
export type {
  CloneRepoOptions,
  CloneRepoResult,
  InitRepoOptions,
  InitRepoResult,
  InitTemplate,
} from "./init-clone";

// ── Cross-tool interoperability ──────────────────────────

export {
  adoptExistingWorktree,
  createWorkspaceFromBranch,
  getCreateWorkspaceFromBranchStatus,
  listAllBranches,
} from "./cross-tool";
export type { CreateWorkspaceFromBranchStatus } from "./cross-tool";
export { repoBranchCatalog } from "./branch-catalog";
export type {
  CatalogBranch,
  RepoBranchCatalog,
  RepoBranchCatalogOptions,
  RepoRemote,
} from "./branch-catalog";
export type {
  AdoptExistingWorktreeOptions,
  CreateWorkspaceFromBranchOptions,
  CreateWorkspaceFromBranchResult,
  ListAllBranchesOptions,
} from "./cross-tool";

// ── Detach mode ──────────────────────────────────────────

export { detachStart, detachStatus, detachStop } from "./detach";
export type {
  DetachStartOptions,
  DetachStartResult,
  DetachStatusResult,
  DetachStopResult,
} from "./detach";

// ── GitHub integration ───────────────────────────────────

export {
  addPrComment,
  checkRepoNameAvailable,
  createPr,
  detectGhCli,
  getAuthStatus,
  getPr,
  getPrChecks,
  getPrCommits,
  getPrReviews,
  getRepositoryOwnerAvatar,
  getWorkspaceRepoAccess,
  listGithubOwners,
  listPrs,
  markPrReady,
  initRepoInPlace,
  mergePr,
  parseGitHubRemote,
  publishRepoToGithub,
  readGhCliCredential,
  resetBehindByCacheForTesting,
  setOctokitFactoryForTesting,
  setPushForTesting,
  setRunFileForTesting,
  setTokenStoreForTesting,
  syncWorkspacePr,
  updatePr,
  verifyGithubToken,
} from "./github";

// Provider-neutral hosted-review boundary. GitHub is the only production
// adapter today; future forges implement this same app-owned contract without
// changing workspace identity.
export { githubForgeAdapter, GithubForgeAdapter } from "./github-forge";
export type { GithubForgeOperations } from "./github-forge";
export {
  assertForgeRepositoryIdentity,
  changeRequestIdentity,
  changeRequestToLegacyPr,
  ForgeContractError,
} from "./forge";
export type {
  ChangeRequest,
  ChangeRequestCommentInput,
  ChangeRequestCommentResult,
  ChangeRequestCreateInput,
  ChangeRequestIdentity,
  ChangeRequestMergeInput,
  ChangeRequestMergeResult,
  ChangeRequestUpdateInput,
  ForgeAdapter,
  ForgeId,
  ForgeRepositoryIdentity,
  GitObjectId,
} from "./forge";
export type {
  AuthStatusResult,
  CreatePrOptions,
  InitRepoInPlaceResult,
  GetPrOptions,
  GhCliResult,
  GithubRepoAccess,
  GithubRepositoryOwnerAvatar,
  ListPrsOptions,
  MarkReadyOptions,
  MergePrOptions,
  PrCheck,
  PrChecksResult,
  PrCommitAuthor,
  PrCommitSummary,
  PrDeployment,
  PrTimelineItem,
  UpdatePrOptions,
} from "./github";

// Public API barrel for the git + GitHub integration layer.
//
// Imports from electron/ipc/commands/*.ts should always go through this
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
  WorkspaceStatus,
} from "./types";

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
  detachLockPath,
  seedFromDisk,
  setStateRootForTesting,
  stateDbPath,
  worktreesRoot,
  zerosStateRoot,
  setWorkspaceRemoteRestricted,
  isWorkspaceRemoteRestricted,
  listRemoteRestrictedWorkspaceIds,
  getWorkspaceById,
  updateWorkspace,
} from "./state";

// ── Background setup runner (Setup tab) ──────────────────
export { SetupManager, setupSessionId, isSetupSession } from "./setup-runner";
export type { SetupInfo, SetupTarget } from "./setup-runner";
export { resolveSetupCommand, buildSetupCommandEnv } from "./setup-hooks";

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

// ── Phase 2: git ops, branches, diffs, staging, fetch ────

export {
  abortOperation,
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
  DiffMode,
  DiffOptions,
  DiffResult,
  LogOptions,
  ShowCommitResult,
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
  stageHunk,
  stagePaths,
  unstageHunk,
  unstagePaths,
} from "./stage";
export type { ApplyHunkOptions, StageOptions } from "./stage";

export { fetch } from "./fetch";
export type { FetchOptions, FetchResult } from "./fetch";

// ── Phase 1A modals (2026-05-20) — repo init + clone ─────

export { cloneRepo, initRepo } from "./init-clone";
export type {
  CloneRepoOptions,
  CloneRepoResult,
  InitRepoOptions,
  InitRepoResult,
  InitTemplate,
} from "./init-clone";

// ── Phase 5: Cross-tool interop ──────────────────────────

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

// ── Phase 4: Detach mode ─────────────────────────────────

export { detachStart, detachStatus, detachStop } from "./detach";
export type {
  DetachStartOptions,
  DetachStartResult,
  DetachStatusResult,
  DetachStopResult,
} from "./detach";

// ── Phase 3: GitHub ──────────────────────────────────────

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
  listGithubOwners,
  listPrs,
  markPrReady,
  initRepoInPlace,
  mergePr,
  parseGitHubRemote,
  publishRepoToGithub,
  resetBehindByCacheForTesting,
  setClientIdForTesting,
  setOctokitFactoryForTesting,
  setPushForTesting,
  setToken,
  setTokenStoreForTesting,
  signOut,
  startDeviceFlow,
  syncWorkspacePr,
  updatePr,
} from "./github";
export type {
  AuthStatusResult,
  CreatePrOptions,
  InitRepoInPlaceResult,
  DeviceVerification,
  GetPrOptions,
  GhCliResult,
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
  StartDeviceFlowOptions,
  UpdatePrOptions,
} from "./github";

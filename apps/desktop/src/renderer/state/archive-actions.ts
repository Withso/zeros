// Shared archive / unarchive actions with visible success/error feedback.
// Centralized so the
// sidebar, the PR island, and the Dashboard (cards + Archived column) all behave
// identically — and so the audit's edge cases are handled in ONE place:
//   • Archiving the ACTIVE workspace strands the open chat on a deleted folder
//     (the row leaves the live list, so the active workspace resolves to null —
//     NOT present:false — and the "worktree missing" placeholder never fires).
//     We repoint to the nearest surviving workspace on the left, then Local main.
//   • Concurrent restore controls share renderer busy state; the engine also
//     single-flights by id so other windows/devices cannot race `worktree add`.
//   • Restore adapts the path/branch (occupied / checked-out-elsewhere / deleted)
//     and can leave checkpoint conflicts — both are surfaced.

import { useCallback } from "react";
import { unstable_batchedUpdates } from "react-dom";

import {
  isGitErrorShape,
  isWorkspaceOpStillRunning,
  workspaceArchive,
  workspaceDelete,
  workspaceGet,
  workspaceLifecycleStatus,
  workspaceRestore,
  type RestoreResult,
  type Workspace,
  type WorkspaceLifecycleStatus,
} from "../platform/git";
import { clearChangesFilters } from "../shell/workbench/tabs/changes-filter-store";
import { forgetChangesSnapshots } from "../shell/workbench/tabs/changes-snapshot-cache";
import { forgetPrCachesForWorkspace } from "../shell/pr/pr-cache-forget";
import { clearTerminalFolders } from "../shell/terminal/terminal-store";
import { useSessionsStore } from "../features/agent/sessions-store";
import { branchDisplayName } from "../shared/lib/branch-name";
import { trackGitOp } from "../platform/observability/analytics/agent-events";
import { toast } from "../shared/ui/primitives/elements";
import { clearChatPaneFolders, moveChatPaneFolder } from "./chat-panes-store";
import { forgetDesignWorkspaceView } from "../features/design-workspace/state/design-workspace-ui";
import { forgetDesignRuntimeWorkspace } from "../features/design-workspace/state/design-runtime-store";
import { isLocalMainWorkspace } from "./local-main-workspace";
import { loadProjects, type Project } from "./projects-store";
import {
  clearWorkspaceArchiving,
  isWorkspaceArchiving,
  markWorkspaceArchiving,
  usePendingWorkspacesStore,
} from "./pending-workspaces";
import {
  commitWorkspaceArchived,
  commitWorkspaceDeleted,
  commitWorkspaceRestored,
  notifyWorkspacesChanged,
  peekWorkspacesFor,
} from "./use-projects";
import {
  selectActiveFolder,
  selectChatToRestoreForFolder,
  useWorkspaceDispatch,
  useWorkspaceStore,
} from "./store";
import {
  findProjectForFolder,
  folderIsOwnedByProject,
  folderIsWithinRoot,
} from "./workspace-resolution";
import { previousWorkspaceInOrder } from "./archive-navigation";
import { isInternalFeatureActive } from "../features/settings/internal-features";

type Dispatch = ReturnType<typeof useWorkspaceDispatch>;

/** Does `folder` belong to this workspace's semantic path owner? Descendant
 * chat cwd values count, but a separately registered nested repository wins
 * over the outer worktree and must not be repointed or scrubbed with it. */
function workspaceOwnsFolder(
  workspace: Workspace,
  folder: string,
  projects: Project[] = loadProjects(),
): boolean {
  if (!folderIsWithinRoot(folder, workspace.path)) return false;
  const project = findProjectForFolder(workspace.repoRoot, projects);
  return (
    !project ||
    folderIsOwnedByProject(folder, project.id, projects, [workspace.path])
  );
}

/** Where should the view land after `leaving` goes away (archive / delete)?
 * The user-visible tab order is creation order, with Local main pinned at the
 * left. Choose the nearest surviving worktree to the left; if none exists,
 * Local main is the exact fallback. Reads the cached exact-key list — no engine
 * round-trip or later repair effect on the navigation path. */
function pickRepointTarget(leaving: Workspace): {
  folder: string;
  repoRoot: string;
} {
  const cached = peekWorkspacesFor(leaving.repoSlug) ?? [];
  // Exclude rows whose confirmed mutation is pending — a burst-archive must
  // never repoint onto a workspace that is itself on its way out.
  const archivingIds = usePendingWorkspacesStore.getState().archivingIds;
  const previous = previousWorkspaceInOrder(leaving, cached, archivingIds, {
    allowDesignWorkspaces: isInternalFeatureActive("designWorkspaces"),
  });
  return previous
    ? { folder: previous.path, repoRoot: previous.repoRoot }
    : { folder: leaving.repoRoot, repoRoot: leaving.repoRoot };
}

/** Detach renderer runtime slots once removal is authoritatively confirmed.
 * The engine remains authoritative for stopping processes across windows/devices;
 * this local half prevents stale "ready" agent slots and terminal tabs from
 * surviving a successful archive/delete.
 * Chat metadata, transcript ids, drafts, and pane layouts are retained so a
 * later restore resumes with full fidelity. */
function detachWorkspaceRuntimeState(
  workspace: Workspace,
  dispatch: Dispatch,
): void {
  const projects = loadProjects();
  const project = findProjectForFolder(workspace.repoRoot, projects);
  const state = useWorkspaceStore.getState();
  const sessions = useSessionsStore.getState();
  for (const chat of state.chats) {
    if (!workspaceOwnsFolder(workspace, chat.folder, projects)) continue;
    sessions.detachSession(chat.id);
    if (state.pendingAutoSend[chat.id]) {
      dispatch({ type: "CONSUME_AUTO_SEND", chatId: chat.id });
    }
  }
  clearTerminalFolders([workspace.path], project?.id);
  forgetDesignRuntimeWorkspace(workspace.id);
}

/** If we just archived/deleted the workspace whose chat is the active target,
 *  its worktree is going away — repoint the active selection to the most
 *  recently active OTHER workspace in the repo (Local main only when none is
 *  left; see pickRepointTarget) so the (possibly hidden) open chat isn't
 *  stranded on a deleted folder. Lands on a REAL chat at the target when one
 *  exists (last-viewed, else most-recent) — a null selection renders a dead
 *  Conversation pane. When the target has no live chat, pin the scope; the tab strip's
 *  selection keeper auto-spawns a default chat.
 *
 *  `preservePage: true` is essential: archiving is also driven from full-window
 *  Home pages (the Dashboard cards + Repo hub rows), where the archived
 *  workspace can still be the active target even though the workspace view isn't
 *  showing. A plain OPEN_WORKSPACE would force `activePage: "workspace"` and yank
 *  the user off the Dashboard; preserving the page fixes the underlying target
 *  while leaving them where they are. From the workspace view (top-bar tab / PR
 *  island) `activePage` is already "workspace", so preserving it is a no-op
 *  there — the repoint still happens. */
function repointViewIfActive(workspace: Workspace, dispatch: Dispatch): void {
  const state = useWorkspaceStore.getState();
  const activeFolder = selectActiveFolder(state);
  if (
    !activeFolder ||
    !workspaceOwnsFolder(workspace, activeFolder, loadProjects())
  )
    return;
  const target = pickRepointTarget(workspace);
  const restoreId = selectChatToRestoreForFolder(state, target.folder);
  dispatch({
    type: "OPEN_WORKSPACE",
    folder: target.folder,
    repoRoot: target.repoRoot,
    chatId: restoreId,
    preservePage: true,
  });
}

/** Apply the renderer half of an already-confirmed deletion. The row and active
 * destination remain intact while the request runs; only this confirmed commit
 * detaches runtime state, publishes the fallback route, and removes membership.
 * Deliberately idempotent because success can arrive through the original
 * response, a timeout observer, or a concurrent WORKSPACE_NOT_FOUND response. */
function commitConfirmedDeletion(
  workspace: Workspace,
  dispatch: Dispatch,
): void {
  unstable_batchedUpdates(() => {
    detachWorkspaceRuntimeState(workspace, dispatch);
    repointViewIfActive(workspace, dispatch);
    commitWorkspaceDeleted(workspace);
    clearWorkspaceArchiving(workspace.id);
  });
  clearChangesFilters([workspace.id]);
  forgetChangesSnapshots([workspace.id]);
  // PR-scoped caches (island batches, published kinds, persisted last states,
  // stability masks, Review snapshots, PR-sync probes) are keyed by this id
  // and can never be read again after a permanent deletion — purge them with
  // the Changes snapshots. Archive intentionally does NOT purge: restore
  // reuses the id, and the retained caches repaint the restored PR instantly.
  forgetPrCachesForWorkspace(workspace.id);
  forgetDesignWorkspaceView(workspace.id);
  const project = findProjectForFolder(workspace.repoRoot, loadProjects());
  clearTerminalFolders([workspace.path], project?.id);
  clearChatPaneFolders([workspace.path], project?.id);
  dispatch({
    type: "REMOVE_WORKSPACE_UI_STATE",
    folder: workspace.path,
    repoRoot: workspace.repoRoot,
  });
  notifyWorkspacesChanged(workspace.repoSlug);
}

/** A request timeout is not a deletion outcome. Follow the exact row and the
 * engine-owned lifecycle flight until the row is gone or the operation has
 * definitively stopped; never clear busy state merely because a minute passed. */
function watchTimedOutWorkspaceDeletion(
  workspace: Workspace,
  dispatch: Dispatch,
): void {
  let settled = false;
  let timer: number | null = null;
  const schedule = () => {
    if (settled) return;
    timer = window.setTimeout(() => void check(), 3_000);
  };
  const finishDeleted = () => {
    if (settled) return;
    settled = true;
    if (timer !== null) window.clearTimeout(timer);
    commitConfirmedDeletion(workspace, dispatch);
    toast.success("Workspace deleted");
  };
  const fail = (description: string) => {
    if (settled) return;
    settled = true;
    if (timer !== null) window.clearTimeout(timer);
    clearWorkspaceArchiving(workspace.id);
    notifyWorkspacesChanged(workspace.repoSlug);
    toast.error("Couldn't finish deleting workspace", { description });
  };
  const readExact = async (): Promise<Workspace | null | undefined> => {
    try {
      return await workspaceGet(workspace.id);
    } catch (error) {
      if (isGitErrorShape(error) && error.code === "WORKSPACE_NOT_FOUND") {
        return null;
      }
      return undefined;
    }
  };
  const check = async () => {
    if (settled) return;
    const current = await readExact();
    if (current === null) {
      finishDeleted();
      return;
    }
    if (current === undefined) {
      schedule();
      return;
    }
    let status: WorkspaceLifecycleStatus;
    try {
      status = await workspaceLifecycleStatus(workspace.id);
    } catch {
      schedule();
      return;
    }
    if (status.active) {
      schedule();
      return;
    }
    // Close the read/status race: the row can disappear after the first read but
    // before the flight's finally block clears `active`.
    const latest = await readExact();
    if (latest === null) {
      finishDeleted();
      return;
    }
    if (latest === undefined) {
      schedule();
      return;
    }
    fail(
      status.operation === "delete"
        ? "Deletion stopped in a recoverable phase. Restart Zeros to finish recovery."
        : "The engine stopped before deleting the workspace. It remains unchanged; try again.",
    );
  };
  void check();
}

/** Permanently delete a workspace: drop its engine row + worktree folder (the
 *  branch is kept, `includeBranch:false`), scrub every renderer surface keyed on
 *  it (Changes filters/snapshots, terminals, chat panes, per-workspace UI
 *  state), and — when it was the active view — repoint to the project's Local
 *  main so the open chat isn't stranded. Shared by the worktree-missing panel's
 *  "Delete workspace" button and the corrupted-workspace archive-failure toast
 *  so both do the exact same cleanup. Renderer state is scrubbed only after an
 *  authoritative success or WORKSPACE_NOT_FOUND result. */
export async function deleteWorkspacePermanently(
  workspace: Workspace,
  dispatch: Dispatch,
): Promise<"deleted" | "pending" | "failed"> {
  if (isLocalMainWorkspace(workspace)) return "failed";
  // Keep the row and active surface in place, visibly busy, until the engine
  // confirms deletion. A concrete failure then has nothing to visually restore.
  markWorkspaceArchiving(workspace.id);
  try {
    await workspaceDelete({ workspaceId: workspace.id, includeBranch: false });
  } catch (err) {
    // "Already gone" (row deleted concurrently) is the desired end state → fall
    // through and scrub idempotently. Any other concrete engine error keeps the
    // row and renderer state intact.
    if (isWorkspaceOpStillRunning(err)) {
      toast.info("Deletion is taking longer than usual", {
        description: "It's still being deleted safely in the background.",
      });
      watchTimedOutWorkspaceDeletion(workspace, dispatch);
      return "pending";
    }
    if (!(isGitErrorShape(err) && err.code === "WORKSPACE_NOT_FOUND")) {
      clearWorkspaceArchiving(workspace.id);
      notifyWorkspacesChanged(workspace.repoSlug);
      return "failed";
    }
  }
  // Success (or already-gone): safe to repoint off it + scrub renderer state.
  commitConfirmedDeletion(workspace, dispatch);
  return "deleted";
}

/** Archiving a worktree whose folder is gone from disk is refused (engine
 *  WORKTREE_MISSING; see archiveWorkspace): checkpointing/removing a missing folder
 *  is a no-op and a later restore would fabricate a phantom worktree with the
 *  same name — the "unarchive made a new worktree" bug. Surface that as a
 *  persistent error toast naming the workspace, offering the only safe recovery:
 *  permanent deletion. */
function showCorruptedWorkspaceToast(
  workspace: Workspace,
  dispatch: Dispatch,
): void {
  // Match the tab's label (strip the branch-name prefix).
  const label = branchDisplayName(workspace.branch);
  toast.error(
    "Archiving failed. This workspace might be corrupted. Delete permanently?",
    {
      description: `${workspace.repoSlug} · ${label}`,
      // Persist until acted on — this is a decision, not a status blip.
      duration: Infinity,
      // One slot per workspace: repeated archive clicks replace rather than
      // stack identical infinite toasts.
      id: `archive-corrupt-${workspace.id}`,
      action: {
        label: "Delete permanently",
        onClick: () => void deleteWorkspacePermanently(workspace, dispatch),
      },
    },
  );
}

interface ArchiveFeedbackOptions {
  label?: string;
  /** Runs in the same React batch that moves the confirmed row into Archived. */
  onArchived?: (workspace: Workspace) => void;
}

function commitConfirmedArchive(
  original: Workspace,
  archived: Workspace,
  dispatch: Dispatch,
  opts?: ArchiveFeedbackOptions,
): void {
  const label = opts?.label ?? original.branch;
  trackGitOp({ op: "workspace_archive", outcome: "ok" });
  unstable_batchedUpdates(() => {
    // Resolve the destination while the live cache still contains `original`;
    // commitWorkspaceArchived removes it synchronously. React batching prevents
    // that ordering from producing an intermediate visual frame.
    detachWorkspaceRuntimeState(original, dispatch);
    repointViewIfActive(original, dispatch);
    commitWorkspaceArchived(archived);
    clearWorkspaceArchiving(original.id);
    opts?.onArchived?.(archived);
  });
  notifyWorkspacesChanged(original.repoSlug);
  toast.success("Workspace archived", {
    description: "Find it in the Dashboard's Archived column to restore it.",
    action: {
      label: "Undo",
      onClick: () => {
        void restoreWorkspaceWithFeedback(archived, {
          label,
          // Bring the restored workspace back into view. Restore can adapt the
          // path, so navigate to the confirmed result rather than the old path.
          onRestored: (res) => {
            const restoreId = selectChatToRestoreForFolder(
              useWorkspaceStore.getState(),
              res.path,
            );
            dispatch({
              type: "OPEN_WORKSPACE",
              folder: res.path,
              repoRoot: original.repoRoot,
              chatId: restoreId,
              preservePage: true,
            });
          },
        });
      },
    },
  });
}

/** Follow a timed-out archive through exact engine state. The live row remains
 * inert in its original surface until `archivedAt` is authoritative; a concrete
 * failure only clears its busy affordance, so there is no disappearance/bounce. */
function watchTimedOutWorkspaceArchive(
  workspace: Workspace,
  dispatch: Dispatch,
  opts?: ArchiveFeedbackOptions,
): void {
  let settled = false;
  let timer: number | null = null;
  const schedule = () => {
    if (settled) return;
    timer = window.setTimeout(() => void check(), 3_000);
  };
  const fail = (description: string) => {
    if (settled) return;
    settled = true;
    if (timer !== null) window.clearTimeout(timer);
    clearWorkspaceArchiving(workspace.id);
    notifyWorkspacesChanged(workspace.repoSlug);
    trackGitOp({
      op: "workspace_archive",
      outcome: "error",
      error: new Error(description),
    });
    toast.error("Couldn't finish archiving workspace", { description });
  };
  const readExact = async (): Promise<Workspace | null | undefined> => {
    try {
      return await workspaceGet(workspace.id);
    } catch (error) {
      if (isGitErrorShape(error) && error.code === "WORKSPACE_NOT_FOUND") {
        return null;
      }
      return undefined;
    }
  };
  const accept = (current: Workspace): boolean => {
    if (current.archivedAt == null) return false;
    settled = true;
    if (timer !== null) window.clearTimeout(timer);
    commitConfirmedArchive(workspace, current, dispatch, opts);
    return true;
  };
  const check = async () => {
    if (settled) return;
    const current = await readExact();
    if (current === null) {
      settled = true;
      commitConfirmedDeletion(workspace, dispatch);
      toast.info("The workspace was deleted while archiving");
      return;
    }
    if (current === undefined) {
      schedule();
      return;
    }
    if (accept(current)) return;
    let status: WorkspaceLifecycleStatus;
    try {
      status = await workspaceLifecycleStatus(workspace.id);
    } catch {
      schedule();
      return;
    }
    if (status.active) {
      schedule();
      return;
    }
    // Close the row/status race before declaring a stopped operation.
    const latest = await readExact();
    if (latest === null) {
      settled = true;
      commitConfirmedDeletion(workspace, dispatch);
      toast.info("The workspace was deleted while archiving");
      return;
    }
    if (latest === undefined) {
      schedule();
      return;
    }
    if (accept(latest)) return;
    fail(
      status.operation === "archive"
        ? "Archiving stopped in a recoverable phase. Restart Zeros to finish recovery."
        : "The engine stopped before archiving the workspace. It remains live; try again.",
    );
  };
  void check();
}

/** Archive a workspace with an Undo toast. Durably checkpoints tracked,
 *  untracked, and configured ignored work, removes the worktree, and keeps the
 *  branch + lifecycle status. Never called for the synthetic Local main. */
export async function archiveWorkspaceWithFeedback(
  workspace: Workspace,
  dispatch: Dispatch,
  opts?: ArchiveFeedbackOptions,
): Promise<void> {
  if (isLocalMainWorkspace(workspace)) return; // defensive — UI hides it anyway
  // Confirmed-only transition: retain the tab/card in its current location and
  // show its spinner until the engine has durably checkpointed + removed it.
  // A failure therefore never makes the workspace disappear and bounce back.
  markWorkspaceArchiving(workspace.id);
  try {
    const result = await workspaceArchive({
      workspaceId: workspace.id,
      stashUncommitted: true,
    });
    const archivedWorkspace: Workspace = result.workspace ?? {
      ...workspace,
      archivedAt: result.archivedAt,
      stashRef: result.stashRef,
      archiveSnapshot:
        result.archiveSnapshot ?? workspace.archiveSnapshot ?? null,
      present: false,
    };
    commitConfirmedArchive(workspace, archivedWorkspace, dispatch, opts);
  } catch (err) {
    // A concurrent device permanently deleted the row after this renderer
    // started archiving it. That is already a terminal removed state; scrub the
    // stale cache/UI instead of leaving a ghost row behind.
    if (isGitErrorShape(err) && err.code === "WORKSPACE_NOT_FOUND") {
      commitConfirmedDeletion(workspace, dispatch);
      toast.info("The workspace was deleted while archiving");
      return;
    }
    // The worktree folder is gone from disk — the engine refuses to archive it
    // (WORKTREE_MISSING) rather than mark it archived and let a later restore
    // fabricate a phantom worktree with the same name. We re-check on the ENGINE
    // (not the renderer's possibly-stale `present`) so the corrupted-workspace
    // recovery — including its irreversible "Delete permanently" — only fires on
    // an authoritative miss, never on a flag that lagged the folder coming back.
    if (isGitErrorShape(err) && err.code === "WORKTREE_MISSING") {
      clearWorkspaceArchiving(workspace.id);
      showCorruptedWorkspaceToast(workspace, dispatch);
      return;
    }
    // A client timeout does not mean the engine transaction failed. Keep the row
    // live; a confirming exact-key read is the only thing allowed to repoint it.
    if (isWorkspaceOpStillRunning(err)) {
      toast.info("Archiving is taking longer than usual", {
        description:
          "It's still checkpointing safely in the background and will remain marked Archiving until confirmed.",
      });
      watchTimedOutWorkspaceArchive(workspace, dispatch, opts);
      return;
    }
    trackGitOp({ op: "workspace_archive", outcome: "error", error: err });
    // The archive genuinely failed; the row never left the live view.
    clearWorkspaceArchiving(workspace.id);
    const remediation = isGitErrorShape(err) ? err.remediation : undefined;
    toast.error("Couldn't archive workspace", {
      description:
        remediation ?? (err instanceof Error ? err.message : String(err)),
    });
  }
}

/** THE archive entry point for UI surfaces. The engine lifecycle stops running
 * agents/PTYs after proving exact checkout ownership; this hook owns renderer
 * busy-state guarding and delegates the confirmed cache/navigation transition
 * to archiveWorkspaceWithFeedback. */
export function useArchiveWorkspace(): (
  workspace: Workspace,
  opts?: ArchiveFeedbackOptions,
) => Promise<void> {
  const dispatch = useWorkspaceDispatch();
  return useCallback(
    async (workspace, opts) => {
      if (isWorkspaceArchiving(workspace.id)) return;
      // Agent prompts and every workspace PTY are cancelled by the engine
      // inside the lifecycle single-flight. Keeping that authority server-side
      // covers other windows/devices and prevents a renderer cancel request
      // from hanging before archive is even submitted.
      await archiveWorkspaceWithFeedback(workspace, dispatch, opts);
    },
    [dispatch],
  );
}

type ConfirmedRestoreResult = Omit<RestoreResult, "workspace"> & {
  workspace: Workspace;
};

interface RestoreFeedbackOptions {
  label?: string;
  onSettled?: () => void;
  onRestored?: (res: ConfirmedRestoreResult) => void;
}

/** Atomically move all renderer state keyed by an adapted path before publishing
 * the confirmed live row and invoking navigation callbacks. */
function commitConfirmedRestore(
  original: Workspace,
  result: ConfirmedRestoreResult,
  opts?: RestoreFeedbackOptions,
): void {
  const restored = result.workspace;
  const mayPublishNavigation =
    restored.kind !== "design" ||
    isInternalFeatureActive("designWorkspaces");
  unstable_batchedUpdates(() => {
    if (restored.path !== original.path) {
      moveChatPaneFolder(original.path, restored.path, original.repoRoot);
      useWorkspaceStore.getState().dispatch({
        type: "MOVE_WORKSPACE_UI_STATE",
        fromFolder: original.path,
        toFolder: restored.path,
        repoRoot: original.repoRoot,
      });
    }
    commitWorkspaceRestored(restored);
    if (mayPublishNavigation) opts?.onRestored?.(result);
  });
  notifyWorkspacesChanged(original.repoSlug);
}

function inferredRestoreResult(
  original: Workspace,
  restored: Workspace,
): ConfirmedRestoreResult {
  const adaptations: string[] = [];
  if (restored.path !== original.path) {
    adaptations.push(
      `The original folder was occupied, so the workspace was restored to "${restored.path}".`,
    );
  }
  if (restored.branch !== original.branch) {
    adaptations.push(
      `The original branch was unavailable, so the workspace was restored on "${restored.branch}".`,
    );
  }
  return {
    restoredAt: restored.lastActiveAt ?? Date.now(),
    conflicts: [],
    path: restored.path,
    branch: restored.branch,
    adaptations,
    workspace: restored,
  };
}

/** Follow a timed-out restore until the exact row is live or the engine reports
 * that no operation remains. This keeps archived controls inert for the real
 * operation lifetime, not an arbitrary 60-second approximation. */
function watchTimedOutWorkspaceRestore(
  workspace: Workspace,
  label: string,
  opts: RestoreFeedbackOptions | undefined,
  settle: () => void,
): void {
  let settled = false;
  let timer: number | null = null;
  const schedule = () => {
    if (settled) return;
    timer = window.setTimeout(() => void check(), 3_000);
  };
  const finish = () => {
    if (settled) return;
    settled = true;
    if (timer !== null) window.clearTimeout(timer);
    settle();
  };
  const fail = (description: string) => {
    trackGitOp({
      op: "workspace_restore",
      outcome: "error",
      error: new Error(description),
    });
    toast.error(`Couldn't finish restoring "${label}"`, { description });
    notifyWorkspacesChanged(workspace.repoSlug);
    finish();
  };
  const readExact = async (): Promise<Workspace | null | undefined> => {
    try {
      return await workspaceGet(workspace.id);
    } catch (error) {
      if (isGitErrorShape(error) && error.code === "WORKSPACE_NOT_FOUND") {
        return null;
      }
      return undefined;
    }
  };
  const accept = (current: Workspace): boolean => {
    if (current.archivedAt != null) return false;
    const result = inferredRestoreResult(workspace, current);
    trackGitOp({ op: "workspace_restore", outcome: "ok" });
    if (current.present === false) {
      // Publish the truthful live-but-missing row, but do not navigate callers
      // into a destination that disappeared after the restore commit.
      commitConfirmedRestore(workspace, result);
      toast.error(`Restored "${label}", but its folder is missing`, {
        description:
          "The workspace metadata is live. Restore the folder or delete the workspace safely.",
      });
    } else {
      commitConfirmedRestore(workspace, result, opts);
      toast.success(`Restored "${label}"`, {
        description: result.adaptations.join(" ") || undefined,
      });
    }
    finish();
    return true;
  };
  const check = async () => {
    if (settled) return;
    const current = await readExact();
    if (current === null) {
      commitWorkspaceDeleted(workspace);
      fail("The workspace was deleted while restore was finishing.");
      return;
    }
    if (current === undefined) {
      schedule();
      return;
    }
    if (accept(current)) return;
    let status: WorkspaceLifecycleStatus;
    try {
      status = await workspaceLifecycleStatus(workspace.id);
    } catch {
      schedule();
      return;
    }
    if (status.active) {
      schedule();
      return;
    }
    const latest = await readExact();
    if (latest === null) {
      commitWorkspaceDeleted(workspace);
      fail("The workspace was deleted while restore was finishing.");
      return;
    }
    if (latest === undefined) {
      schedule();
      return;
    }
    if (accept(latest)) return;
    fail(
      status.operation === "restore"
        ? "Restore stopped in a recoverable phase. Restart Zeros to finish recovery."
        : "The engine stopped before restoring the workspace. It remains archived; try again.",
    );
  };
  void check();
}

// Serialize restore per workspace id across renderer surfaces (Dashboard,
// archived picker, and archive Undo). The engine independently single-flights
// by id, so other windows/devices cannot race the same Git lifecycle either.
const restoringIds = new Set<string>();

/** True while a restore of this workspace is in flight — lets surfaces disable
 *  their Unarchive control and dedupe. */
export function isRestoring(workspaceId: string): boolean {
  return restoringIds.has(workspaceId);
}

/** Restore (unarchive) a workspace with feedback: serialized per id, surfaces
 *  path/branch adaptations + checkpoint conflicts, and treats an exact already-
 *  restored-elsewhere ("not archived") error as an idempotent success. `onRestored`
 *  fires only on a successful restore, with the (possibly path/branch-adapted)
 *  result — the archive Undo uses it to navigate back into the workspace. */
export async function restoreWorkspaceWithFeedback(
  workspace: Workspace,
  opts?: RestoreFeedbackOptions,
): Promise<void> {
  if (
    workspace.kind === "design" &&
    !isInternalFeatureActive("designWorkspaces")
  ) {
    opts?.onSettled?.();
    return;
  }
  if (restoringIds.has(workspace.id)) {
    opts?.onSettled?.(); // another restore owns this id — clear the caller's spinner
    return;
  }
  restoringIds.add(workspace.id);
  const label = opts?.label ?? workspace.branch;
  let settlementDeferred = false;
  try {
    const res = await workspaceRestore({ workspaceId: workspace.id });
    const restoredWorkspace: Workspace = res.workspace ?? {
      ...workspace,
      path: res.path,
      branch: res.branch,
      archivedAt: null,
      stashRef: null,
      archivedHead: null,
      archiveSnapshot: null,
      lastActiveAt: res.restoredAt,
      present: true,
    };
    const confirmedResult: ConfirmedRestoreResult = {
      ...res,
      workspace: restoredWorkspace,
    };
    trackGitOp({ op: "workspace_restore", outcome: "ok" });
    commitConfirmedRestore(workspace, confirmedResult, opts);
    if (res.conflicts.length > 0) {
      toast.warning(`Restored "${label}" with conflicts`, {
        description: `${res.conflicts.length} file(s) have conflict markers — resolve them in the worktree.${res.adaptations.length ? " " + res.adaptations.join(" ") : ""}`,
      });
    } else if (res.adaptations.length > 0) {
      toast.success(`Restored "${label}"`, {
        description: res.adaptations.join(" "),
      });
    } else {
      toast.success(`Restored "${label}"`);
    }
  } catch (err) {
    if (isWorkspaceOpStillRunning(err)) {
      settlementDeferred = true;
      toast.info(`Restoring "${label}" is taking longer than usual`, {
        description:
          "It remains archived until the engine confirms the restored worktree.",
      });
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        restoringIds.delete(workspace.id);
        opts?.onSettled?.();
      };
      watchTimedOutWorkspaceRestore(workspace, label, opts, settle);
      return;
    }
    // Already restored from another surface → the row isn't archived anymore.
    // Confirm that exact condition; other VALIDATION_FAILED errors (an
    // interrupted archive/delete, unsafe path, etc.) must stay visible.
    if (
      isGitErrorShape(err) &&
      err.code === "VALIDATION_FAILED" &&
      /\bnot archived\b/i.test(err.message)
    ) {
      try {
        const restored = await workspaceGet(workspace.id);
        if (restored.archivedAt != null || restored.present === false) {
          throw err;
        }
        const confirmed = inferredRestoreResult(workspace, restored);
        trackGitOp({ op: "workspace_restore", outcome: "ok" });
        commitConfirmedRestore(workspace, confirmed, opts);
        toast.success(`"${label}" is already restored`);
      } catch (confirmError) {
        trackGitOp({
          op: "workspace_restore",
          outcome: "error",
          error: confirmError,
        });
        toast.error(`Couldn't restore "${label}"`, {
          description:
            confirmError instanceof Error
              ? confirmError.message
              : String(confirmError),
        });
      }
    } else {
      trackGitOp({ op: "workspace_restore", outcome: "error", error: err });
      toast.error(`Couldn't restore "${label}"`, {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  } finally {
    if (!settlementDeferred) {
      restoringIds.delete(workspace.id);
      opts?.onSettled?.();
    }
  }
}

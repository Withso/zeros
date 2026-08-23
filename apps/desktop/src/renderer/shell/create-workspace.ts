// ──────────────────────────────────────────────────────────
// createWorkspaceForProject — the optimistic create flow, shared
// ──────────────────────────────────────────────────────────
//
// Lifted verbatim out of TopBar.handleCreateWorkspace so the top bar's
// "+" and the repo-add paths (Open project / Open GitHub project /
// Quick start, via AddProjectProvider) run the SAME create. Duplicating
// it was the alternative, and this flow is far too stateful to copy: a
// prepare reservation, a pending token, a settling mark, an optimistic
// chat, three distinct failure shapes, and a post-timeout watcher all
// have to unwind together or the strip is left with a ghost tab.
//
// Optimistic by design: prepareCreate reserves identity + final path in
// milliseconds, the strip paints a "Setting up workspace…" tab and the
// app NAVIGATES to the announced path with a provisional Untitled chat
// in the same beat; the heavy create then runs in the background.
//
// Returns whether the caller was navigated. `false` means the create
// bailed at prepare — nothing was published, so the caller still owns
// deciding where the user lands. Every later failure rolls back its own
// optimistic state and surfaces a toast; the top bar's workspace-list
// validation effect then picks a valid destination.
//
// The Dispatcher's code-workspace create (dispatcher-modal.tsx) is separate
// because it layers a prompt, a base branch, and auto-send onto the same
// skeleton. Its Internal-only Design shortcut intentionally calls this shared
// direct-create flow because Design has no agent prompt.
// ──────────────────────────────────────────────────────────

import { dbDeleteChat } from "../features/agent/agent-history-client";
import { trackWorkspaceOpened } from "../platform/observability/analytics/agent-events";
import {
  isGitErrorShape,
  isWorkspaceOpStillRunning,
  workspaceCreate,
  workspacePrepareCreate,
} from "../platform/git";
import {
  beginPendingCreate,
  clearWorkspaceSettling,
  finishPendingCreate,
  markWorkspaceSettling,
} from "../state/pending-workspaces";
import type { Project } from "../state/projects-store";
import { spawnPreparedDefaultChat } from "../state/spawn-default-chat";
import type { useWorkspaceDispatch } from "../state/store";
import {
  notifyWorkspacesChanged,
  peekWorkspacesFor,
  reloadWorkspacesFor,
  watchTimedOutWorkspaceCreate,
} from "../state/use-projects";
import { toast } from "../shared/ui/primitives/elements";
import { isExpectedElectron, isNativeRuntime } from "../platform/runtime";
import {
  getActiveOrganizationIdSnapshot,
  getActiveOrganizationSnapshot,
} from "../features/team/team-store";
import { localWorkspaceOwner } from "../features/team/organization-capabilities";

type Dispatch = ReturnType<typeof useWorkspaceDispatch>;

export async function createWorkspaceForProject(args: {
  project: Project;
  dispatch: Dispatch;
  kind?: "code" | "design";
}): Promise<boolean> {
  const { project, dispatch } = args;
  const kind = args.kind === "design" ? "design" : "code";
  // Capture semantic ownership at intent time. The user can switch
  // organizations while prepare crosses the bridge; that must not silently
  // move the already-requested workspace to the newly selected owner.
  const owner = localWorkspaceOwner(
    getActiveOrganizationSnapshot(),
    getActiveOrganizationIdSnapshot(),
  );
  // The Design document API is intentionally desktop-local. This is a runtime
  // capability check, not a rollout/access flag: every desktop user gets the
  // Design option without account state or per-channel opt-in.
  const designCreationAllowed = () => isNativeRuntime() || isExpectedElectron();
  if (kind === "design" && !designCreationAllowed()) {
    return false;
  }
  // Every call is an independent exact reservation. Do not serialize even the
  // cheap prepare phase: users intentionally fan out several workspaces while
  // prior creates and archives continue in parallel.
  let prepared: Awaited<ReturnType<typeof workspacePrepareCreate>>;
  try {
    prepared = await workspacePrepareCreate({
      repoRoot: project.repoRoot,
      repoSlug: project.repoSlug,
      ...(kind === "design" ? { kind } : {}),
    });
  } catch (error: unknown) {
    if (isGitErrorShape(error)) {
      toast.error(`Couldn't create workspace: ${error.message}`, {
        description: error.remediation ?? error.causeMessage ?? undefined,
      });
    } else {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(`Couldn't create workspace: ${message}`);
    }
    return false;
  }
  // Native bridge availability can change while prepare crosses the bridge.
  // Prepare is metadata-only, so stop before publishing pending state,
  // navigation, or the filesystem-mutating create request.
  if (kind === "design" && !designCreationAllowed()) {
    return false;
  }
  const pendingToken = beginPendingCreate({
    repoRoot: project.repoRoot,
    repoSlug: project.repoSlug,
    ...owner,
    kind,
    path: prepared.path,
    branch: prepared.branch,
  });
  // Workbench shows its "Setting up workspace" loading rows from the first
  // frame; the flag clears once the row lands and its surface data is in.
  // Marked BEFORE navigation so the workspace-list validation effect knows not
  // to bounce the not-yet-listed folder back to main.
  markWorkspaceSettling(prepared.path);
  // Coding workspaces retain their existing optimistic-chat flow. Design
  // workspaces publish only route + destination identity: their native canvas
  // is usable immediately, while the coding-agent harness remains untouched.
  const chat =
    kind === "code"
      ? spawnPreparedDefaultChat({
          folder: prepared.path,
          repoRoot: project.repoRoot,
          dispatch,
        })
      : null;
  if (!chat) {
    dispatch({
      type: "OPEN_WORKSPACE",
      folder: prepared.path,
      repoRoot: project.repoRoot,
      chatId: null,
      validationPending: true,
    });
  }
  const rollbackOptimisticChat = () => {
    clearWorkspaceSettling(prepared.path);
    if (chat) {
      dispatch({ type: "CONSUME_AUTO_SEND", chatId: chat.id });
      dispatch({ type: "DELETE_CHAT", id: chat.id });
      void dbDeleteChat(chat.id).catch(() => {});
    }
    finishPendingCreate(pendingToken);
  };
  const settleArchivedOptimisticChat = () => {
    // Archive keeps this chat/draft for a later restore; only its queued first
    // turn is no longer runnable because the worktree was removed.
    clearWorkspaceSettling(prepared.path);
    if (chat) dispatch({ type: "CONSUME_AUTO_SEND", chatId: chat.id });
    finishPendingCreate(pendingToken);
  };
  try {
    const created = await workspaceCreate({
      repoRoot: project.repoRoot,
      repoSlug: project.repoSlug,
      ...owner,
      ...(kind === "design" ? { kind } : {}),
      ...(chat?.agentId ? { agentId: chat.agentId } : {}),
      preparedId: prepared.workspaceId,
      preparedBranch: prepared.branch,
      ...(chat ? { optimisticChatId: chat.id } : {}),
    });
    trackWorkspaceOpened({ isWorktree: true, status: created.status });
    notifyWorkspacesChanged(project.repoSlug);
    // Await an authoritative refresh so the real row is committed to the
    // single source BEFORE the pending placeholder drops — otherwise the strip
    // briefly shows NO tab for the workspace the user is sitting in. If
    // ingestion is momentarily disconnected, retain the placeholder and follow
    // the exact lifecycle/row until the complete key can be committed.
    if (
      (await reloadWorkspacesFor(project.repoSlug)) &&
      peekWorkspacesFor(project.repoSlug)?.some(
        (workspace) => workspace.id === prepared.workspaceId,
      )
    ) {
      finishPendingCreate(pendingToken);
    } else {
      watchTimedOutWorkspaceCreate({
        repoSlug: project.repoSlug,
        workspaceId: prepared.workspaceId,
        onReady: () => finishPendingCreate(pendingToken),
        onUnavailable: (reason) => {
          if (reason === "archived") {
            settleArchivedOptimisticChat();
            return;
          }
          rollbackOptimisticChat();
          toast.error("Workspace became unavailable after creation", {
            description:
              reason === "interrupted"
                ? "Creation stopped in a recoverable phase. Restart Zeros to finish recovery."
                : "The workspace was removed before its list row could be loaded.",
          });
        },
      });
    }
  } catch (error: unknown) {
    if (isWorkspaceOpStillRunning(error)) {
      // The engine keeps working past the client budget — retain the announced
      // destination + settling state until exact lifecycle observation settles.
      toast.info("Workspace creation is taking longer than usual", {
        description: "It's still being created in the background.",
      });
      watchTimedOutWorkspaceCreate({
        repoSlug: project.repoSlug,
        workspaceId: prepared.workspaceId,
        onReady: (workspace) => {
          trackWorkspaceOpened({ isWorktree: true, status: workspace.status });
          finishPendingCreate(pendingToken);
        },
        onUnavailable: (reason) => {
          if (reason === "archived") {
            settleArchivedOptimisticChat();
            return;
          }
          rollbackOptimisticChat();
          toast.error("Couldn't finish creating workspace", {
            description:
              reason === "interrupted"
                ? "Creation stopped in a recoverable phase. Restart Zeros to finish recovery, then try again."
                : "The engine rolled the incomplete checkout back safely. Create it again to retry.",
          });
        },
      });
    } else {
      // Hard failure: roll back only this exact provisional chat/path. The
      // validation effect sees the absent row and chooses a valid destination.
      rollbackOptimisticChat();
      notifyWorkspacesChanged(project.repoSlug);
      if (isGitErrorShape(error)) {
        toast.error(`Couldn't create workspace: ${error.message}`, {
          description: error.remediation ?? error.causeMessage ?? undefined,
        });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        toast.error(`Couldn't create workspace: ${message}`);
      }
    }
  }
  return true;
}

/** True only when the repo is KNOWN to have zero live (non-archived)
 *  workspaces — the auto-create-on-add guard.
 *
 *  "Cache not loaded yet" and "repo has no workspaces" are the same shape, and
 *  confusing them forks a second worktree onto a repo that already has one. A
 *  warm list answers synchronously; a cold one is loaded first.
 *
 *  The retry is not paranoia: a `zeros://open` deep link force-reconnects the
 *  bridge (app-shell's project-changed handler) in the same tick this runs, so
 *  the first read genuinely lands mid-reconnect. If the list is STILL unreadable
 *  after that, this answers false — never create on a guess. The cost of being
 *  wrong is asymmetric: a spurious worktree is a real directory and a real
 *  branch the user has to hunt down and delete, whereas a missed auto-create
 *  just means clicking "+". */
export async function repoNeedsFirstWorkspace(
  repoSlug: string,
): Promise<boolean> {
  const noneLive = (rows: readonly { archivedAt: number | null }[]) =>
    !rows.some(
      (row) =>
        row.archivedAt == null &&
        (row as { kind?: "code" | "design" }).kind !== "design",
    );
  const warm = peekWorkspacesFor(repoSlug);
  if (warm) return noneLive(warm);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1_000));
    const loaded = await reloadWorkspacesFor(repoSlug).catch(() => false);
    const rows = peekWorkspacesFor(repoSlug);
    if (loaded && rows) return noneLive(rows);
  }
  return false;
}

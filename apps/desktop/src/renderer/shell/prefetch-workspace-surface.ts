// Intent prefetch for top-bar workspace navigation. Keep this module free of
// React so pointer/focus handlers can warm the exact destination before the
// urgent OPEN_WORKSPACE state change.

import type { Workspace } from "@/renderer/platform/git";
import {
  workbenchScopeForFolder,
  useWorkspaceStore,
} from "@/renderer/state/workspace-store";
import {
  findProjectForFolder,
  resolveWorkspacePresentationKind,
  workspaceIdFromWorktreePath,
} from "@/renderer/state/workspace-resolution";
import { loadProjects } from "@/renderer/state/projects-store";
import { defaultScopeFor } from "./workbench/tab-model";
import { warmWorkspaceFiles } from "./workspace-files-cache";
import {
  prefetchWorkspaceFileDiff,
  prefetchWorkspaceFileRead,
} from "./workspace-file-data-cache";
import { prefetchReviewLiveData } from "./workbench/tabs/review-data";
import { warmIgnoredRoots } from "./workbench/tabs/ignored-entries-cache";
import { resolveReviewProvider } from "./pr/review-provider";
import { parseRemote } from "./pr/github-url";
import { warmDesignWorkspaceSnapshot } from "@/renderer/features/design-workspace/state/design-workspace-cache";
import { pendingWorkspaceMode } from "@/renderer/state/pending-workspaces";

/** Complete identity needed to navigate before an authoritative workspace list
 * is warm. Engine Workspace rows satisfy this shape directly. */
export type WorkspaceNavigationTarget = Pick<Workspace, "path" | "repoRoot"> &
  Partial<Pick<Workspace, "id" | "kind" | "prNumber">> & {
    /** The target came from durable memory while its repo list was cold. */
    validationPending?: boolean;
  };

export function prefetchWorkspaceSurface(
  workspace: WorkspaceNavigationTarget,
): void {
  const folder = workspace.path;
  if (!folder) return;
  const requestedKind = pendingWorkspaceMode(workspace.id);
  if (
    resolveWorkspacePresentationKind({
      confirmedKind: workspace.kind,
      requestedKind,
      folder,
    }) === "design"
  ) {
    // First Design entry has published its surface intent but has not created
    // the document yet. Do not race an eager snapshot read into that gap; the
    // active Design surface starts the exact-key read after setMode confirms.
    if (workspace.kind === "design" && workspace.id) {
      warmDesignWorkspaceSnapshot(workspace.id);
    }
    return;
  }
  warmWorkspaceFiles(folder);
  // Both halves of the Files tree or neither: an ignored listing that lands
  // after the tracked one splices `.env`/`node_modules/` into the middle of the
  // list and shoves every row below it down.
  warmIgnoredRoots(folder);

  const state = useWorkspaceStore.getState();
  const scopeKey = workbenchScopeForFolder(folder);
  const scope = state.workbenchByScope[scopeKey] ?? defaultScopeFor(scopeKey);
  const activeTab =
    scope.tabs.find((tab) => tab.id === scope.activeId) ?? scope.tabs[0];
  if (
    activeTab?.type === "review" &&
    workspace.id &&
    workspace.prNumber != null &&
    workspace.prNumber > 0
  ) {
    // findProjectForFolder, not a raw compare: the renderer strips the /private
    // symlink from a stored repoRoot while the engine reports the realpath'd
    // one, so string equality misses a valid checkout. A blank cached origin
    // means "unknown", so fall back to github.com rather than skipping — a
    // workspace only has a prNumber because a GitHub path stamped it.
    const originUrl =
      findProjectForFolder(workspace.repoRoot, loadProjects())?.originUrl ??
      null;
    const provider = resolveReviewProvider(
      parseRemote(originUrl)?.host ?? "github.com",
    );
    if (provider) {
      void prefetchReviewLiveData(
        provider,
        workspace.id,
        workspace.prNumber,
      ).catch(() => {
        // The retained Review snapshot stays usable; activation retries live.
      });
    }
  }
  if (!activeTab?.filePath) return;

  prefetchWorkspaceFileRead(
    folder,
    activeTab.filePath,
    activeTab.contentRevision ?? 0,
  );
  const workspaceId =
    folder === workspace.repoRoot
      ? workspace.repoRoot
      : (workspace.id ?? workspaceIdFromWorktreePath(folder));
  if (!workspaceId) return;
  prefetchWorkspaceFileDiff({
    workspaceId,
    path: activeTab.filePath,
    diffScope: activeTab.diffScope,
    diffSha: activeTab.diffSha,
    turnChatId: activeTab.turnChatId,
    turnId: activeTab.turnId,
  });
}

// Intent prefetch for top-bar workspace navigation. Keep this module free of
// React so pointer/focus handlers can warm the exact destination before the
// urgent OPEN_WORKSPACE state change.

import type { Workspace } from "@/native/git";
import {
  column3ScopeForFolder,
  useWorkspaceStore,
} from "@/zeros/store/workspace-store";
import {
  findProjectForFolder,
  workspaceIdFromWorktreePath,
} from "@/zeros/store/workspace-resolution";
import { loadProjects } from "@/zeros/store/projects-store";
import { defaultScopeFor } from "./column3-tab-manager";
import { warmWorkspaceFiles } from "./workspace-files-cache";
import {
  prefetchWorkspaceFileDiff,
  prefetchWorkspaceFileRead,
} from "./workspace-file-data-cache";
import { prefetchReviewLiveData } from "./column3-tabs/review-data";
import { resolveReviewProvider } from "./pr/review-provider";
import { parseRemote } from "./pr/github-url";

/** Complete identity needed to navigate before an authoritative workspace list
 * is warm. Engine Workspace rows satisfy this shape directly. */
export type WorkspaceNavigationTarget = Pick<Workspace, "path" | "repoRoot"> &
  Partial<Pick<Workspace, "id" | "prNumber">> & {
    /** The target came from durable memory while its repo list was cold. */
    validationPending?: boolean;
  };

export function prefetchWorkspaceSurface(
  workspace: WorkspaceNavigationTarget,
): void {
  const folder = workspace.path;
  if (!folder) return;
  warmWorkspaceFiles(folder);

  const state = useWorkspaceStore.getState();
  const scopeKey = column3ScopeForFolder(folder);
  const scope = state.column3ByScope[scopeKey] ?? defaultScopeFor(scopeKey);
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

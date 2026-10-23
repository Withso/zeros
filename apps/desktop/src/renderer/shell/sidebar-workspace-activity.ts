import { useLayoutEffect, useMemo, useRef } from "react";
import type { Workspace } from "../platform/git";
import {
  type ChatThread,
  recordWorkspaceActivity,
  useWorkspaceActivityByFolder,
} from "../state/store";
import { folderIsWithinRoot } from "../state/workspace-resolution";
import { isCloudWorkspaceCatalogOnlyRow } from "../state/cloud-workspace-catalog";

/** Read aggregate clocks only. Opening a row, warming a session or receiving an
 * identical catalog snapshot is not activity, and this never reads a VM. */
export function sidebarWorkspaceActivity(
  workspaces: readonly Workspace[],
  chats: readonly Pick<ChatThread, "folder" | "updatedAt">[],
  activityByFolder: Readonly<Record<string, number>>,
): ReadonlyMap<string, number> {
  const result = new Map<string, number>();
  const include = (folder: string | null | undefined, at: number) => {
    if (!folder || !Number.isFinite(at) || at < 0) return;
    // A separately registered nested folder owns its activity even when its
    // parent appears first. The shared containment rule normalizes Mac aliases.
    let workspace: Workspace | undefined;
    for (const candidate of workspaces) {
      if (
        folderIsWithinRoot(folder, candidate.path) &&
        (!workspace || folderIsWithinRoot(candidate.path, workspace.path))
      )
        workspace = candidate;
    }
    if (workspace)
      result.set(workspace.id, Math.max(result.get(workspace.id) ?? 0, at));
  };
  for (const [folder, at] of Object.entries(activityByFolder))
    include(folder, at);
  for (const chat of chats) include(chat.folder, chat.updatedAt);
  return result;
}

/** Metadata has no universal updatedAt wire field. Record a change only after
 * two snapshots of the same identity establish it, ignoring lazy read fields
 * such as hasChanges/present and newly discovered rows. */
export function changedSidebarWorkspaceFolders(
  previous: readonly Workspace[],
  next: readonly Workspace[],
): string[] {
  const byId = new Map(previous.map((workspace) => [workspace.id, workspace]));
  return next.flatMap((workspace) => {
    const prior = byId.get(workspace.id);
    if (
      !prior ||
      prior === workspace ||
      prior.path !== workspace.path ||
      prior.organizationId !== workspace.organizationId ||
      prior.placement !== workspace.placement
    )
      return [];
    const metadataChanged =
      !isCloudWorkspaceCatalogOnlyRow(prior) &&
      !isCloudWorkspaceCatalogOnlyRow(workspace) &&
      (prior.status !== workspace.status ||
        prior.branch !== workspace.branch ||
        prior.baseBranch !== workspace.baseBranch ||
        prior.prNumber !== workspace.prNumber ||
        prior.prState !== workspace.prState ||
        prior.prUrl !== workspace.prUrl ||
        (prior.kind ?? "code") !== (workspace.kind ?? "code"));
    const changed =
      metadataChanged ||
      (prior.setupState ?? null) !== (workspace.setupState ?? null);
    return changed ? [workspace.path] : [];
  });
}

export function useSidebarWorkspaceActivity(
  owner: string,
  workspaces: readonly Workspace[],
  chats: readonly ChatThread[],
  active: boolean,
): ReadonlyMap<string, number> {
  const activityByFolder = useWorkspaceActivityByFolder();
  const previous = useRef<{
    owner: string;
    workspaces: readonly Workspace[];
  } | null>(null);
  useLayoutEffect(() => {
    if (!active) return;
    const before = previous.current;
    previous.current = { owner, workspaces };
    if (before?.owner !== owner) return;
    for (const folder of changedSidebarWorkspaceFolders(
      before.workspaces,
      workspaces,
    )) {
      recordWorkspaceActivity(folder);
    }
  }, [active, owner, workspaces]);
  return useMemo(
    () => sidebarWorkspaceActivity(workspaces, chats, activityByFolder),
    [workspaces, chats, activityByFolder],
  );
}

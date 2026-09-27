// ──────────────────────────────────────────────────────────
// Sidebar workspace list — the pure projection behind AppSidebar
// ──────────────────────────────────────────────────────────
//
// The sidebar lists the same live workspace union the Dashboard and repository
// hub read. This module only decides ORDER and GROUPING, so it stays pure and
// unit-testable:
//
//   Grouped   every registered Git repository is a header (even with no
//             workspaces, so its + remains reachable), followed by its
//             in-flight creates (newest first) and its workspaces (newest
//             first). A legacy plain folder has no header: its folder row is
//             the repository, so painting both would name it twice. Without
//             workspace history, that row opens the folder's settings.
//   Ungrouped one mixed list — in-flight creates first, then every workspace
//             newest first, then unopened folders in registration order.
//             Each workspace row carries its repository icon instead.
//
// A collapsed repository keeps its active row visible, so the selection never
// disappears from the navigation while the rest of the group is folded away.

import type { Workspace } from "../platform/git";
import type { PendingWorkspaceCreate } from "../state/pending-workspaces";
import type { Project } from "../state/projects-store";
import { findProjectForFolder } from "../state/workspace-resolution";
import {
  workspaceTabGroups,
  type WorkspaceListFilter,
} from "../state/workspace-list-filter";

/** The two presentations the sidebar offers. */
export type SidebarWorkspaceListFilter = "grouped" | "ungrouped";

export const SIDEBAR_WORKSPACE_LIST_FILTERS: readonly SidebarWorkspaceListFilter[] =
  ["grouped", "ungrouped"];

/** Fold older persisted presentations into the two the sidebar offers. Active
 * was an activity-ordered mixed list, so it stays mixed; a repository-only
 * filter returns to the default grouping, where that repository is still one
 * of the groups. The store keeps parsing every legacy value. */
export function sidebarWorkspaceListFilter(
  filter: WorkspaceListFilter,
): SidebarWorkspaceListFilter {
  return filter === "ungrouped" || filter === "active"
    ? "ungrouped"
    : "grouped";
}

export type SidebarWorkspaceItem =
  | {
      kind: "workspace";
      key: string;
      project: Project;
      workspace: Workspace;
    }
  | {
      kind: "pending";
      key: string;
      project: Project;
      pending: PendingWorkspaceCreate;
    };

export type SidebarWorkspaceEntry =
  | {
      /** Settings access for a plain folder with no projected workspace. */
      kind: "folder";
      key: string;
      project: Project;
    }
  | {
      kind: "repository";
      key: string;
      project: Project;
      /** Every row owned by the repository, before collapse is applied. */
      items: SidebarWorkspaceItem[];
    }
  | {
      kind: "row";
      key: string;
      item: SidebarWorkspaceItem;
    };

/** The identity a row is selected by: the engine id, or the optimistic
 * create token until that create's real row replaces it. */
export function sidebarItemSelectionKey(item: SidebarWorkspaceItem): string {
  return item.kind === "workspace" ? item.workspace.id : item.pending.token;
}

function projectForPending(
  pending: PendingWorkspaceCreate,
  projects: readonly Project[],
): Project | null {
  return (
    projects.find((candidate) => candidate.repoRoot === pending.repoRoot) ??
    findProjectForFolder(pending.repoRoot, projects)
  );
}

function workspaceItem(
  project: Project,
  workspace: Workspace,
): SidebarWorkspaceItem {
  return {
    kind: "workspace",
    key: `workspace:${workspace.id}`,
    project,
    workspace,
  };
}

function pendingItem(
  project: Project,
  pending: PendingWorkspaceCreate,
): SidebarWorkspaceItem {
  return {
    kind: "pending",
    key: `pending:${pending.token}`,
    project,
    pending,
  };
}

/** Project the live workspace union and in-flight creates into sidebar
 * entries. Inputs are never mutated; ordering is deterministic. */
export function buildSidebarWorkspaceEntries(args: {
  filter: SidebarWorkspaceListFilter;
  projects: readonly Project[];
  workspaces: readonly Workspace[];
  pending: readonly PendingWorkspaceCreate[];
}): SidebarWorkspaceEntry[] {
  const { filter, projects } = args;
  const pendingByProject = new Map<string, PendingWorkspaceCreate[]>();
  for (const pending of args.pending) {
    const project = projectForPending(pending, projects);
    if (!project) continue;
    const rows = pendingByProject.get(project.id);
    if (rows) rows.push(pending);
    else pendingByProject.set(project.id, [pending]);
  }
  for (const rows of pendingByProject.values()) {
    rows.sort((a, b) => b.startedAt - a.startedAt);
  }

  const groups = workspaceTabGroups(filter, projects, args.workspaces);

  if (filter === "ungrouped") {
    const pending = [...pendingByProject.entries()]
      .flatMap(([projectId, rows]) => {
        const project = projects.find((row) => row.id === projectId);
        return project ? rows.map((row) => ({ project, row })) : [];
      })
      .sort((a, b) => b.row.startedAt - a.row.startedAt)
      .map(({ project, row }) => pendingItem(project, row));
    const workspaces: SidebarWorkspaceItem[] = [];
    for (const workspace of groups[0]?.workspaces ?? []) {
      const project = findProjectForFolder(workspace.repoRoot, projects);
      if (project) workspaces.push(workspaceItem(project, workspace));
    }
    const items = [...pending, ...workspaces];
    const representedProjects = new Set(items.map((item) => item.project.id));
    const entries: SidebarWorkspaceEntry[] = items.map((item) => ({
      kind: "row" as const,
      key: item.key,
      item,
    }));
    for (const project of projects) {
      if (
        project.isGitRepository === false &&
        !representedProjects.has(project.id)
      ) {
        entries.push({ kind: "folder", key: `project:${project.id}`, project });
      }
    }
    return entries;
  }

  const workspacesByProject = new Map(
    groups.flatMap((group) =>
      group.project ? [[group.project.id, group.workspaces] as const] : [],
    ),
  );
  return projects.flatMap((project): SidebarWorkspaceEntry[] => {
    const items = [
      ...(pendingByProject.get(project.id) ?? []).map((pending) =>
        pendingItem(project, pending),
      ),
      ...(workspacesByProject.get(project.id) ?? []).map((workspace) =>
        workspaceItem(project, workspace),
      ),
    ];
    if (project.isGitRepository === false) {
      if (items.length === 0) {
        return [{ kind: "folder", key: `project:${project.id}`, project }];
      }
      return items.map((item) => ({
        kind: "row" as const,
        key: item.key,
        item,
      }));
    }
    return [
      {
        kind: "repository" as const,
        key: `project:${project.id}`,
        project,
        items,
      },
    ];
  });
}

/** Every workspace/create row, in painted order, regardless of collapse.
 * Folder settings entries must never be treated as workspace destinations. */
export function sidebarWorkspaceItems(
  entries: readonly SidebarWorkspaceEntry[],
): SidebarWorkspaceItem[] {
  return entries.flatMap((entry) => {
    if (entry.kind === "repository") return entry.items;
    return entry.kind === "row" ? [entry.item] : [];
  });
}

/** The rows a repository paints under its header. Collapsing keeps only the
 * selected row, so the active workspace is always visible in the sidebar. */
export function visibleRepositoryItems(
  items: readonly SidebarWorkspaceItem[],
  collapsed: boolean,
  activeSelectionKey: string | null,
): readonly SidebarWorkspaceItem[] {
  if (!collapsed) return items;
  if (!activeSelectionKey) return [];
  return items.filter(
    (item) => sidebarItemSelectionKey(item) === activeSelectionKey,
  );
}

/** The list scroll offset that brings an item fully into view while moving as
 * little as possible. All geometry shares one (client) coordinate space. An
 * item taller than the viewport aligns its top edge. */
export function sidebarScrollTopToReveal(args: {
  scrollTop: number;
  viewportTop: number;
  viewportBottom: number;
  itemTop: number;
  itemBottom: number;
}): number {
  const { scrollTop, viewportTop, viewportBottom, itemTop, itemBottom } = args;
  if (itemTop < viewportTop) {
    return Math.max(0, scrollTop - (viewportTop - itemTop));
  }
  if (itemBottom > viewportBottom) {
    const tallerThanViewport =
      itemBottom - itemTop > viewportBottom - viewportTop;
    return (
      scrollTop +
      (tallerThanViewport ? itemTop - viewportTop : itemBottom - viewportBottom)
    );
  }
  return scrollTop;
}

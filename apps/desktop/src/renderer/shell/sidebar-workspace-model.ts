// ──────────────────────────────────────────────────────────
// Sidebar workspace list — the pure projection behind AppSidebar
// ──────────────────────────────────────────────────────────
//
// The sidebar lists the same live workspace union the Dashboard and repository
// hub read. This module only decides ORDER and GROUPING, so it stays pure and
// unit-testable:
//
//   Repository every registered Git repository is a header (even with no
//             workspaces, so its + remains reachable), followed by its
//             in-flight creates (newest first) and its workspaces (newest
//             first). A legacy plain folder has no header: its folder row is
//             the repository, so painting both would name it twice. Without
//             workspace history, that row opens the folder's settings.
//   Status    the same five lifecycle groups as Home, without Archive.
//   None      one mixed list with repository icons on its workspace rows.
// All modes filter by repository and sort by latest update (default) or creation.
// Pending creates lead their group; unopened folders retain settings access.
//
// A collapsed repository keeps its active row visible, so the selection never
// disappears from the navigation while the rest of the group is folded away.

import type { Workspace } from "../platform/git";
import type { PendingWorkspaceCreate } from "../state/pending-workspaces";
import type { Project } from "../state/projects-store";
import type { SidebarWorkspaceSort } from "../state/sidebar-list-preferences";
import { selectLiveVisible } from "../state/live-workspace-selectors";
import { LIFECYCLE_STATUSES, statusMeta, type LifecycleStatusMeta } from "../shared/lib/workspace-status";
import { findProjectForFolder } from "../state/workspace-resolution";
import {
  workspaceTabGroups,
  type WorkspaceListFilter,
  type WorkspaceTabActivity,
} from "../state/workspace-list-filter";

/** Keep released preference values; their labels are Repository and None. */
export type SidebarWorkspaceListFilter = "grouped" | "status" | "ungrouped";

export const SIDEBAR_WORKSPACE_LIST_FILTERS: readonly SidebarWorkspaceListFilter[] =
  ["grouped", "status", "ungrouped"];

/** Fold older persisted presentations into the ones the sidebar offers. Active
 * was an activity-ordered mixed list, so it stays mixed; a repository-only
 * filter returns to the default grouping, where that repository is still one
 * of the groups. The store keeps parsing every legacy value. */
export function sidebarWorkspaceListFilter(
  filter: WorkspaceListFilter,
): SidebarWorkspaceListFilter {
  return filter === "status" ? "status" : filter === "ungrouped" || filter === "active"
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
      kind: "status";
      key: string;
      status: LifecycleStatusMeta;
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
    (pending.placement === "cloud" ? projects.find(candidate => candidate.repoSlug === pending.repoSlug) : null) ??
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

function finiteTimestamp(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Project the live workspace union and in-flight creates into sidebar
 * entries. Inputs are never mutated; ordering is deterministic. */
export function buildSidebarWorkspaceEntries(args: {
  filter: SidebarWorkspaceListFilter;
  sort?: SidebarWorkspaceSort;
  repositoryIds?: readonly string[];
  activity?: WorkspaceTabActivity;
  projects: readonly Project[];
  workspaces: readonly Workspace[];
  pending: readonly PendingWorkspaceCreate[];
}): SidebarWorkspaceEntry[] {
  const { filter, sort = "updated", activity } = args;
  const selectedIds = new Set(args.repositoryIds);
  const projects = selectedIds.size
    ? args.projects.filter(project => selectedIds.has(project.id))
    : args.projects;
  const visibleProjectIds = new Set(projects.map(project => project.id));
  const orderWorkspaces = (rows: readonly Workspace[]) => [...rows].sort((a, b) => {
    const timestamp = (workspace: Workspace) => sort === "created"
      ? finiteTimestamp(workspace.createdAt)
      : Math.max(finiteTimestamp(workspace.createdAt), finiteTimestamp(workspace.lastActiveAt),
        finiteTimestamp(activity?.activeAtByWorkspaceId?.get(workspace.id)));
    return timestamp(b) - timestamp(a);
  });
  const pendingByProject = new Map<string, PendingWorkspaceCreate[]>();
  const unregisteredCloudCreates: SidebarWorkspaceItem[] = [];
  for (const pending of args.pending) {
    const project = projectForPending(pending, args.projects);
    if (selectedIds.size && (!project || !selectedIds.has(project.id))) continue;
    if (!project) {
      // A first cloud create has no confirmed repository yet. Its display
      // identity stays in a non-navigable row, never in the project registry.
      if (pending.placement === "cloud" && pending.organizationId && pending.repository) {
        unregisteredCloudCreates.push(pendingItem({ id: `pending-repository:${pending.token}`,
          name: pending.repository.name, repoRoot: pending.repoRoot, repoSlug: pending.repoSlug,
          originUrl: pending.repository.originUrl, isGitRepository: true, addedAt: pending.startedAt }, pending));
      }
      continue;
    }
    const rows = pendingByProject.get(project.id);
    if (rows) rows.push(pending);
    else pendingByProject.set(project.id, [pending]);
  }
  for (const rows of pendingByProject.values()) {
    rows.sort((a, b) => finiteTimestamp(b.startedAt) - finiteTimestamp(a.startedAt));
  }

  const groups = workspaceTabGroups(
    filter === "status" ? "ungrouped" : filter,
    projects,
    selectLiveVisible(args.workspaces),
  );

  if (filter !== "grouped") {
    const pending = [...pendingByProject.entries()]
      .flatMap(([projectId, rows]) => {
        const project = projects.find((row) => row.id === projectId);
        return project ? rows.map((row) => ({ project, row })) : [];
      })
      .sort((a, b) => finiteTimestamp(b.row.startedAt) - finiteTimestamp(a.row.startedAt))
      .map(({ project, row }) => pendingItem(project, row));
    const workspaces: SidebarWorkspaceItem[] = [];
    for (const workspace of orderWorkspaces(groups[0]?.workspaces ?? [])) {
      const project = findProjectForFolder(workspace.repoRoot, projects);
      // Cloud resolution uses the complete catalog. Recheck membership in this
      // projection so a filtered-out cloud repository cannot enter mixed rows.
      if (project && visibleProjectIds.has(project.id)) workspaces.push(workspaceItem(project, workspace));
    }
    const items = [...unregisteredCloudCreates, ...pending]
      .sort((a, b) => (b.kind === "pending" ? finiteTimestamp(b.pending.startedAt) : 0) - (a.kind === "pending" ? finiteTimestamp(a.pending.startedAt) : 0))
      .concat(workspaces);
    const representedProjects = new Set(items.map((item) => item.project.id));
    const entries: SidebarWorkspaceEntry[] = filter === "status"
      ? LIFECYCLE_STATUSES.map(status => ({
          kind: "status" as const,
          key: `status:${status.value}`,
          status,
          items: items.filter(item => (item.kind === "pending" ? "in-progress" : statusMeta(item.workspace.status).value) === status.value),
        }))
      : items.map((item) => ({
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
  const entries = projects.flatMap((project): SidebarWorkspaceEntry[] => {
    const items = [
      ...(pendingByProject.get(project.id) ?? []).map((pending) =>
        pendingItem(project, pending),
      ),
      ...orderWorkspaces(workspacesByProject.get(project.id) ?? []).map((workspace) =>
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
  return [...unregisteredCloudCreates.map(item => ({ kind: "row" as const, key: item.key, item })), ...entries];
}

/** Every workspace/create row, in painted order, regardless of collapse.
 * Folder settings entries must never be treated as workspace destinations. */
export function sidebarWorkspaceItems(
  entries: readonly SidebarWorkspaceEntry[],
): SidebarWorkspaceItem[] {
  return entries.flatMap((entry) => {
    if (entry.kind === "repository" || entry.kind === "status") return entry.items;
    return entry.kind === "row" ? [entry.item] : [];
  });
}

/** Removal follows the painted ordering and filter. A workspace archived from
 * Home may already be outside that filter; then use its first available row.
 * Pathless cloud creates are visible progress, not navigation destinations. */
export function sidebarNeighborAfterRemoval(
  entries: readonly SidebarWorkspaceEntry[],
  leaving: Workspace,
  busyIds: Readonly<Record<string, number>>,
): SidebarWorkspaceItem | null {
  const items = sidebarWorkspaceItems(entries);
  const index = items.findIndex(item => item.kind === "workspace" && item.workspace.id === leaving.id);
  const candidates = index < 0 ? items : [...items.slice(0, index).reverse(), ...items.slice(index + 1)];
  for (const allowBusy of [false, true]) {
    const next = candidates.find(item => item.kind === "pending"
      ? !!item.pending.path && item.pending.path !== leaving.path
      : item.workspace.id !== leaving.id && item.workspace.path !== leaving.path &&
        (allowBusy || !(item.workspace.id in busyIds)));
    if (next) return next;
  }
  return null;
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

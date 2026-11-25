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
import { isCloudWorkspace } from "../platform/bridge/cloud-workspace-key";
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
      /** Child-workspace nesting (`zeros local`): 0 for a top-level row. */
      depth?: number;
      /** Child workspaces listed under this row, shown or not. */
      childCount?: number;
      /** Whether this row's child workspaces are shown. */
      expanded?: boolean;
      /** A child whose parent belongs to the same project: its leading slot
       *  shows a dot instead of repeating the project's logo. */
      sameProjectAsParent?: boolean;
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
      /** A View-menu grouping beyond Repository and Status (placement, owner,
       * recency, pull request state). */
      kind: "group";
      key: string;
      label: string;
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
/** The sidebar's This Mac / Cloud view filter. Returns the same array when nothing is hidden. */
export function rowsShownForPlacements<T extends { placement?: "local" | "cloud"; path?: string | null; organizationId?: string | null }>(
  rows: readonly T[],
  hidden: readonly ("local" | "cloud")[],
): readonly T[] {
  if (hidden.length === 0) return rows;
  const cloud = (row: T) => row.placement === "cloud" || isCloudWorkspace(row.path ?? undefined);
  return rows.filter((row) => !hidden.includes(cloud(row) ? "cloud" : "local"));
}

/** Move each agent-created workspace under the workspace whose chat created
 * it. Children stay hidden until their parent is in `expanded`. */
export function nestChildWorkspaces(
  items: readonly SidebarWorkspaceItem[],
  expanded: ReadonlySet<string>,
): SidebarWorkspaceItem[] {
  const ids = new Set(items.flatMap(item => item.kind === "workspace" ? [item.workspace.id] : []));
  const childrenOf = new Map<string, SidebarWorkspaceItem[]>();
  const top: SidebarWorkspaceItem[] = [];
  for (const item of items) {
    const parent = item.kind === "workspace" ? item.workspace.parentWorkspaceId : null;
    if (item.kind === "workspace" && parent && parent !== item.workspace.id && ids.has(parent)) {
      const rows = childrenOf.get(parent);
      if (rows) rows.push(item);
      else childrenOf.set(parent, [item]);
    } else top.push(item);
  }
  if (childrenOf.size === 0) return [...items];
  const out: SidebarWorkspaceItem[] = [];
  const seen = new Set<string>();
  const visit = (item: SidebarWorkspaceItem, depth: number, parentProjectId: string | null) => {
    if (seen.has(item.key)) return;
    seen.add(item.key);
    if (item.kind !== "workspace") { out.push(item); return; }
    const children = childrenOf.get(item.workspace.id) ?? [];
    const open = children.length > 0 && expanded.has(item.workspace.id);
    out.push(children.length || depth
      ? { ...item, depth, childCount: children.length, expanded: open, ...(depth ? { sameProjectAsParent: item.project.id === parentProjectId } : {}) }
      : item);
    if (open) for (const child of children) visit(child, depth + 1, item.project.id);
  };
  for (const item of top) visit(item, 0, null);
  return out;
}

const NO_EXPANDED: ReadonlySet<string> = new Set();

export function buildSidebarWorkspaceEntries(args: {
  /** Workspaces whose child workspaces are shown; others start collapsed. */
  expandedWorkspaceIds?: ReadonlySet<string>;
  filter: SidebarWorkspaceListFilter;
  sort?: SidebarWorkspaceSort;
  repositoryIds?: readonly string[];
  activity?: WorkspaceTabActivity;
  projects: readonly Project[];
  workspaces: readonly Workspace[];
  pending: readonly PendingWorkspaceCreate[];
  /** unified-workspaces: one group per GitHub repository, holding its local and cloud workspaces. */
  projectGroupOf?: (projectId: string) => readonly Project[] | undefined;
  /** Replaces the sort's order (name, direction, Needs you on top, Then by). */
  compare?: (a: Workspace, b: Workspace) => number;
  /** Groups the mixed list by a View-menu grouping instead of `filter`. */
  extraGroup?: (item: SidebarWorkspaceItem) => { key: string; label: string; order: number };
  /** Drops repository, status and group headers that have no rows. */
  hideEmptyGroups?: boolean;
}): SidebarWorkspaceEntry[] {
  const entries = buildEntries(args);
  return args.hideEmptyGroups
    ? entries.filter(entry => entry.kind === "row" || entry.kind === "folder" || entry.items.length > 0)
    : entries;
}

function buildEntries(args: Parameters<typeof buildSidebarWorkspaceEntries>[0]): SidebarWorkspaceEntry[] {
  const { sort = "updated", activity, projectGroupOf, extraGroup } = args;
  const filter = extraGroup ? "ungrouped" : args.filter;
  const nest = (items: SidebarWorkspaceItem[]) => nestChildWorkspaces(items, args.expandedWorkspaceIds ?? NO_EXPANDED);
  // Selecting any side of a joined project selects the whole project.
  const selectedIds = new Set(projectGroupOf
    ? (args.repositoryIds ?? []).flatMap(id => projectGroupOf(id)?.map(project => project.id) ?? [id])
    : args.repositoryIds);
  const projects = selectedIds.size
    ? args.projects.filter(project => selectedIds.has(project.id))
    : args.projects;
  const visibleProjectIds = new Set(projects.map(project => project.id));
  const orderWorkspaces = (rows: readonly Workspace[]) => [...rows].sort(args.compare ?? ((a, b) => {
    const timestamp = (workspace: Workspace) => sort === "created"
      ? finiteTimestamp(workspace.createdAt)
      : Math.max(finiteTimestamp(workspace.createdAt), finiteTimestamp(workspace.lastActiveAt),
        finiteTimestamp(activity?.activeAtByWorkspaceId?.get(workspace.id)));
    return timestamp(b) - timestamp(a);
  }));
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
    const mixed = [...unregisteredCloudCreates, ...pending]
      .sort((a, b) => (b.kind === "pending" ? finiteTimestamp(b.pending.startedAt) : 0) - (a.kind === "pending" ? finiteTimestamp(a.pending.startedAt) : 0))
      .concat(workspaces);
    if (extraGroup) {
      const groups = new Map<string, { key: string; label: string; order: number; items: SidebarWorkspaceItem[] }>();
      for (const item of mixed) {
        const group = extraGroup(item);
        const existing = groups.get(group.key);
        if (existing) existing.items.push(item);
        else groups.set(group.key, { ...group, items: [item] });
      }
      const grouped: SidebarWorkspaceEntry[] = [...groups.values()]
        .sort((a, b) => a.order - b.order)
        .map(group => ({ kind: "group" as const, key: `group:${group.key}`, label: group.label, items: nest(group.items) }));
      const represented = new Set(mixed.map((item) => item.project.id));
      for (const project of projects) {
        if (project.isGitRepository === false && !represented.has(project.id)) {
          grouped.push({ kind: "folder", key: `project:${project.id}`, project });
        }
      }
      return grouped;
    }
    const items = filter === "status" ? mixed : nest(mixed);
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
  // A joined project paints once, where its first side is listed, under its
  // default local folder (members come default-first). That folder's header
  // key, and so its persisted collapse state, still applies.
  const painted = new Set<string>();
  const entries = projects.flatMap((project): SidebarWorkspaceEntry[] => {
    if (painted.has(project.id)) return [];
    const members = (projectGroupOf?.(project.id) ?? [project]).filter(member => visibleProjectIds.has(member.id));
    if (members.length > 1) {
      for (const member of members) painted.add(member.id);
      const head = members[0];
      const memberOf = new Map<string, Project>();
      for (const member of members)
        for (const workspace of workspacesByProject.get(member.id) ?? []) memberOf.set(workspace.id, member);
      const items = [
        ...members.flatMap(member => (pendingByProject.get(member.id) ?? []).map(pending => ({ member, pending })))
          .sort((a, b) => finiteTimestamp(b.pending.startedAt) - finiteTimestamp(a.pending.startedAt))
          .map(({ member, pending }) => pendingItem(member, pending)),
        ...orderWorkspaces(members.flatMap(member => workspacesByProject.get(member.id) ?? []))
          .map(workspace => workspaceItem(memberOf.get(workspace.id)!, workspace)),
      ];
      return [{ kind: "repository" as const, key: `project:${head.id}`, project: head, items: nest(items) }];
    }
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
        items: nest(items),
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
    if (entry.kind === "repository" || entry.kind === "status" || entry.kind === "group") return entry.items;
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

/** Team sharing's sidebar sections for an organization that shares. */
export type SidebarSharingSection = "pinned" | "mine" | "following";
export interface SidebarSection {
  id: SidebarSharingSection;
  label: string;
  entries: SidebarWorkspaceEntry[];
}
const SECTION_LABELS: Record<SidebarSharingSection, string> = { pinned: "Pinned", mine: "My workspaces", following: "Following" };

/** Pinned, then the viewer's own, then followed teammates' workspaces; a
 * workspace sits in one section (Pinned wins), and a teammate's workspace that
 * is neither pinned nor followed stays on Home. Pending creates are the
 * viewer's own. Only My workspaces keeps empty repositories and plain folders;
 * Pinned and Following show only when they have rows. Keys are prefixed per
 * section so React and the DOM see each entry once. */
export function buildSidebarSharingSections(args: Parameters<typeof buildSidebarWorkspaceEntries>[0] & {
  sectionOf: (workspace: Workspace) => SidebarSharingSection | null;
}): SidebarSection[] {
  const { sectionOf, ...base } = args;
  const bySection: Record<SidebarSharingSection, Workspace[]> = { pinned: [], mine: [], following: [] };
  for (const workspace of base.workspaces) {
    const section = sectionOf(workspace);
    if (section) bySection[section].push(workspace);
  }
  return (["pinned", "mine", "following"] as const).flatMap(id => {
    let entries = buildSidebarWorkspaceEntries({ ...base, workspaces: bySection[id], pending: id === "mine" ? base.pending : [] });
    if (id !== "mine") entries = entries.filter(entry => entry.kind !== "folder" && (entry.kind === "row" || entry.items.length > 0));
    if (id !== "mine" && entries.length === 0) return [];
    return [{ id, label: SECTION_LABELS[id], entries: entries.map(entry => ({ ...entry, key: `${id}:${entry.key}` })) }];
  });
}

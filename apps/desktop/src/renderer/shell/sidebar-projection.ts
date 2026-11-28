// ============================================
// The sidebar's projection: which View options shape the list and how. The
// sidebar renders from it, and removal navigation (archive-actions.ts) picks
// its destination from the same projection, so a workspace the sidebar does
// not list is never where an archive lands.
// ============================================

import type { Workspace } from "../platform/git";
import { projectGroupLookup } from "../state/project-identity";
import type { Project } from "../state/projects-store";
import type {
  SidebarExtraGrouping,
  SidebarGroupingId,
  SidebarOwnerFilter,
  SidebarViewPreferences,
  SidebarWorkspaceSort,
} from "../state/sidebar-list-preferences";
import {
  agentStatusOf,
  extraGroupOf,
  pendingGroupOf,
  sidebarWorkspaceComparator,
  type SidebarWorkspaceSignal,
} from "./sidebar-view-model";
import type { SidebarSubgroupKey, SidebarWorkspaceItem } from "./sidebar-workspace-model";
import { workspaceLabel } from "./workspace-tabs";

/** What the list is grouped by: Repository (the persisted default), Status
 *  and the other View-menu groupings, or None. */
export function sidebarGroupingId(
  view: Pick<SidebarViewPreferences, "grouping">,
  listFilter: string,
): SidebarGroupingId | null {
  return view.grouping ?? (listFilter === "grouped" ? "repository" : listFilter === "status" ? "status" : null);
}

export interface SidebarProjectionContext {
  view: SidebarViewPreferences;
  sort: SidebarWorkspaceSort;
  groupingId: SidebarGroupingId | null;
  projects: readonly Project[];
  /** Joined Local and cloud projects share one header and sub-group. */
  unifiedPlacements: boolean;
  signalOf: (workspace: Workspace) => SidebarWorkspaceSignal;
  activeAt: (workspace: Workspace) => number | undefined;
  ownerOf: (workspace: Workspace) => SidebarOwnerFilter | null;
  islandOf: (workspace: Workspace) => string | null;
  /** The workspace that stays listed even when its group is hidden. */
  keepWorkspaceId: string | null;
}

/** The sort, grouping, sub-grouping, group order and hidden groups the
 *  sidebar's entries are built with (buildSidebarWorkspaceEntries). */
export function sidebarProjectionArgs(ctx: SidebarProjectionContext) {
  const { view, groupingId, projects } = ctx;
  const compare = sidebarWorkspaceComparator({
    sort: ctx.sort,
    direction: view.direction,
    needsYouFirst: view.needsYouFirst,
    label: workspaceLabel,
    activeAt: ctx.activeAt,
    needsYou: (workspace) => agentStatusOf(workspace, ctx.signalOf(workspace)) === "needs-you",
  });
  const groupOf = (grouping: SidebarExtraGrouping | "status", item: SidebarWorkspaceItem) =>
    item.kind === "pending"
      ? pendingGroupOf(grouping, item.pending.placement === "cloud")
      : extraGroupOf(grouping, item.workspace, {
          signal: ctx.signalOf(item.workspace),
          activeAt: ctx.activeAt(item.workspace),
          owner: ctx.ownerOf(item.workspace),
          island: ctx.islandOf(item.workspace),
        });
  const grouping = groupingId === "repository" ? null : groupingId;
  const thenBy = view.thenBy && view.thenBy !== groupingId && groupingId !== null ? view.thenBy : null;
  const projectRank = new Map(projects.map((project, index) => [project.id, index]));
  // Joined Local and cloud projects share one repository sub-group, as they
  // share one header under Group › Repository.
  const headOf = ctx.unifiedPlacements ? projectGroupLookup(projects) : null;
  const repositoryOf = (project: Project) => headOf?.(project.id)?.[0] ?? project;
  return {
    compare,
    hideEmptyGroups: view.hideEmptyGroups,
    groupOrder: groupingId ? view.groupOrder[groupingId] : undefined,
    hiddenGroups: groupingId ? view.hiddenGroups[groupingId] : undefined,
    keepWorkspaceId: ctx.keepWorkspaceId,
    ...(grouping ? { extraGroup: (item: SidebarWorkspaceItem) => groupOf(grouping, item) } : {}),
    ...(thenBy
      ? {
          subGroup: (item: SidebarWorkspaceItem): SidebarSubgroupKey => {
            if (thenBy !== "repository") return groupOf(thenBy, item);
            const project = repositoryOf(item.project);
            return { key: project.id, label: project.name, order: projectRank.get(project.id) ?? projects.length, project };
          },
        }
      : {}),
  };
}

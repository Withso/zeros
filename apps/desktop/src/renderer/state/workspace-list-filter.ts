import type { Workspace } from "../platform/git";
import type { Project } from "./projects-store";
import { findProjectForFolder } from "./workspace-resolution";

export const DEFAULT_WORKSPACE_LIST_FILTER = "grouped" as const;

/** App-wide top-bar presentation. Repository ids are persisted rather than
 * roots so a renamed/moved checkout keeps the same semantic selection. */
export type WorkspaceListFilter =
  | "grouped"
  | "ungrouped"
  | "active"
  | `repo:${string}`;

export interface WorkspaceTabActivity {
  /** Most recent deliberate action by workspace id. Passive navigation and
   * session warm-up never enter this clock. */
  activeAtByWorkspaceId?: ReadonlyMap<string, number>;
}

export interface WorkspaceTabGroup {
  /** Null only for the mixed Ungrouped and Active lanes. */
  project: Project | null;
  workspaces: Workspace[];
}

export function repositoryWorkspaceListFilter(
  projectId: string,
): WorkspaceListFilter {
  return projectId ? `repo:${projectId}` : DEFAULT_WORKSPACE_LIST_FILTER;
}

export function workspaceListFilterProjectId(
  filter: WorkspaceListFilter,
): string | null {
  return filter.startsWith("repo:")
    ? filter.slice("repo:".length) || null
    : null;
}

export function parseWorkspaceListFilter(raw: unknown): WorkspaceListFilter {
  if (raw === "grouped" || raw === "ungrouped" || raw === "active") return raw;
  if (typeof raw !== "string" || !raw.startsWith("repo:")) {
    return DEFAULT_WORKSPACE_LIST_FILTER;
  }
  return raw.slice("repo:".length).length > 0
    ? (raw as WorkspaceListFilter)
    : DEFAULT_WORKSPACE_LIST_FILTER;
}

/** Both mixed modes paint repository identity inside each workspace tab. */
export function isMixedWorkspaceListFilter(
  filter: WorkspaceListFilter,
): boolean {
  return filter === "ungrouped" || filter === "active";
}

/** A deleted/corrupt repository selection paints Grouped immediately; callers
 * may persist the normalized value after the authoritative project list loads. */
export function effectiveWorkspaceListFilter(
  filter: WorkspaceListFilter,
  projects: readonly Project[],
): WorkspaceListFilter {
  const projectId = workspaceListFilterProjectId(filter);
  return projectId && !projects.some((project) => project.id === projectId)
    ? DEFAULT_WORKSPACE_LIST_FILTER
    : filter;
}

/** Normal workspace opens preserve cross-repository presentations. A
 * repository-only presentation follows the semantic owner of the newly opened
 * workspace, keeping route and visible destination consistent in one commit. */
export function workspaceListFilterForOpenedRepo(
  current: WorkspaceListFilter,
  repoRoot: string,
  projects: readonly Project[],
): WorkspaceListFilter {
  if (workspaceListFilterProjectId(current) === null) return current;
  const owner = findProjectForFolder(repoRoot, projects);
  return owner
    ? repositoryWorkspaceListFilter(owner.id)
    : DEFAULT_WORKSPACE_LIST_FILTER;
}

function finiteTimestamp(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : Number.NEGATIVE_INFINITY;
}

export function workspaceActivityTimestamp(
  workspace: Workspace,
  activity: WorkspaceTabActivity = {},
): number {
  return Math.max(
    finiteTimestamp(workspace.createdAt),
    finiteTimestamp(activity.activeAtByWorkspaceId?.get(workspace.id)),
  );
}

/** Static presentation for every non-Active filter. Repository caches are
 * individually creation-ordered but their cross-repository union is keyed by
 * slug; sorting here is what makes Ungrouped genuinely mixed and also prevents
 * optimistic restore/cache refreshes from moving an existing tab. */
export function orderWorkspaceTabsByCreation(
  workspaces: readonly Workspace[],
): Workspace[] {
  return [...workspaces].sort(
    (a, b) => finiteTimestamp(b.createdAt) - finiteTimestamp(a.createdAt),
  );
}

/** Active alone follows the dedicated deliberate-action clock. Creation time
 * gives never-touched workspaces a deterministic initial order. */
export function orderWorkspaceTabsByActivity(
  workspaces: readonly Workspace[],
  activity: WorkspaceTabActivity = {},
): Workspace[] {
  // Array.prototype.sort is stable: equal clocks retain the authoritative
  // source order instead of shuffling by an unrelated random workspace id.
  return [...workspaces].sort(
    (a, b) =>
      workspaceActivityTimestamp(b, activity) -
      workspaceActivityTimestamp(a, activity),
  );
}

function projectForWorkspace(
  workspace: Workspace,
  projects: readonly Project[],
): Project | null {
  return (
    projects.find((project) => project.repoRoot === workspace.repoRoot) ??
    findProjectForFolder(workspace.repoRoot, projects)
  );
}

/** Project the one live workspace set into the supported top-bar modes. Every
 * current filter uses immutable creation order; only Active applies the
 * deliberate-action clock. */
export function workspaceTabGroups(
  requestedFilter: WorkspaceListFilter,
  projects: readonly Project[],
  workspaces: readonly Workspace[],
  activity: WorkspaceTabActivity = {},
): WorkspaceTabGroup[] {
  const filter = effectiveWorkspaceListFilter(requestedFilter, projects);
  const byProjectId = new Map<string, Workspace[]>();
  const registeredRows: Workspace[] = [];
  const seenIds = new Set<string>();
  for (const workspace of workspaces) {
    if (seenIds.has(workspace.id)) continue;
    const project = projectForWorkspace(workspace, projects);
    if (!project) continue;
    seenIds.add(workspace.id);
    registeredRows.push(workspace);
    const rows = byProjectId.get(project.id);
    if (rows) rows.push(workspace);
    else byProjectId.set(project.id, [workspace]);
  }

  if (isMixedWorkspaceListFilter(filter)) {
    return [
      {
        project: null,
        workspaces:
          filter === "active"
            ? orderWorkspaceTabsByActivity(registeredRows, activity)
            : orderWorkspaceTabsByCreation(registeredRows),
      },
    ];
  }

  const filteredProjectId = workspaceListFilterProjectId(filter);
  if (filteredProjectId) {
    const project =
      projects.find((candidate) => candidate.id === filteredProjectId) ?? null;
    return project
      ? [
          {
            project,
            workspaces: orderWorkspaceTabsByCreation(
              byProjectId.get(project.id) ?? [],
            ),
          },
        ]
      : [];
  }

  return projects.flatMap((project) => {
    const rows = orderWorkspaceTabsByCreation(
      byProjectId.get(project.id) ?? [],
    );
    return rows.length > 0 ? [{ project, workspaces: rows }] : [];
  });
}

import type { Workspace } from "../platform/git";
import type { Project } from "./projects-store";
import type { PendingWorkspaceCreate } from "./pending-workspaces";
import { findProjectForFolder } from "./workspace-resolution";
import {
  effectiveWorkspaceListFilter,
  isMixedWorkspaceListFilter,
  workspaceActivityTimestamp,
  workspaceListFilterProjectId,
  workspaceTabGroups,
  type WorkspaceListFilter,
  type WorkspaceTabActivity,
} from "./workspace-list-filter";

/** Resolve the nearest still-visible workspace in the exact order painted by
 * the active top-bar filter. Prefer the item on the left; when the departing
 * item led the lane, use the next item on the right. Null means that filter has
 * no workspace left and the workspace route should move to Create. */
export function workspaceNeighborAfterArchive(args: {
  leaving: Workspace;
  rows: readonly Workspace[];
  projects: readonly Project[];
  filter: WorkspaceListFilter;
  busyIds: Readonly<Record<string, number>>;
  activity?: WorkspaceTabActivity;
  allowDesignWorkspaces?: boolean;
}): Workspace | null {
  const { leaving } = args;
  // A confirmed cache update can remove the row just before the archive
  // continuation chooses its destination. Reinsert only for positioning.
  const rows = args.rows.some((workspace) => workspace.id === leaving.id)
    ? args.rows
    : [...args.rows, leaving];
  const ordered = workspaceTabGroups(
    args.filter,
    args.projects,
    rows,
    args.activity,
  ).flatMap((group) => group.workspaces);
  const leavingIndex = ordered.findIndex(
    (workspace) => workspace.id === leaving.id,
  );
  if (leavingIndex < 0) return null;

  const visible = (candidate: Workspace): boolean =>
    candidate.id !== leaving.id &&
    candidate.path !== leaving.path &&
    candidate.archivedAt == null &&
    candidate.present !== false &&
    (args.allowDesignWorkspaces !== false || candidate.kind !== "design");

  // Prefer a stable destination. If every surviving row is itself archiving,
  // keep the nearest one as a transient target rather than opening Create while
  // a workspace still visibly exists. Its own confirmed removal will run this
  // resolver again; a failed archive leaves the user on the restored row.
  for (const allowBusy of [false, true]) {
    const available = (candidate: Workspace): boolean =>
      visible(candidate) && (allowBusy || !(candidate.id in args.busyIds));
    for (let index = leavingIndex - 1; index >= 0; index -= 1) {
      const candidate = ordered[index];
      if (candidate && available(candidate)) return candidate;
    }
    for (let index = leavingIndex + 1; index < ordered.length; index += 1) {
      const candidate = ordered[index];
      if (candidate && available(candidate)) return candidate;
    }
  }
  return null;
}

/** Pending creates are real painted destinations even before the engine row
 * exists. This is the archive fallback used only after no confirmed workspace
 * neighbor survives: project the pending rows in the same relative order as
 * TopBar, insert the departing confirmed row at its painted position, then
 * choose left before right. A pathless legacy pending row cannot be opened and
 * is intentionally ignored. */
export function pendingWorkspaceNeighborAfterArchive(args: {
  leaving: Workspace;
  pending: readonly PendingWorkspaceCreate[];
  projects: readonly Project[];
  filter: WorkspaceListFilter;
  activity?: WorkspaceTabActivity;
  activeAtByFolder?: ReadonlyMap<string, number>;
}): PendingWorkspaceCreate | null {
  const filter = effectiveWorkspaceListFilter(args.filter, args.projects);
  const leavingProject =
    args.projects.find(
      (project) => project.repoRoot === args.leaving.repoRoot,
    ) ?? findProjectForFolder(args.leaving.repoRoot, args.projects);
  if (!leavingProject) return null;

  const seen = new Set<string>();
  const rows = args.pending
    .flatMap((pending) => {
      const path = pending.path?.trim();
      if (!path || path === args.leaving.path) return [];
      const identity = path;
      if (seen.has(identity)) return [];
      const project =
        args.projects.find(
          (candidate) => candidate.repoRoot === pending.repoRoot,
        ) ?? findProjectForFolder(pending.repoRoot, args.projects);
      if (!project) return [];
      seen.add(identity);
      return [{ kind: "pending" as const, pending, project }];
    })
    .sort((left, right) => right.pending.startedAt - left.pending.startedAt);

  type OrderedRow =
    | (typeof rows)[number]
    | { kind: "leaving"; workspace: Workspace; project: Project };
  const leavingRow: OrderedRow = {
    kind: "leaving",
    workspace: args.leaving,
    project: leavingProject,
  };
  let ordered: OrderedRow[];

  if (isMixedWorkspaceListFilter(filter)) {
    ordered = [...rows, leavingRow];
    if (filter === "active") {
      const timestamp = (row: OrderedRow): number =>
        row.kind === "leaving"
          ? workspaceActivityTimestamp(row.workspace, args.activity)
          : Math.max(
              row.pending.startedAt,
              args.activeAtByFolder?.get(row.pending.path!) ??
                Number.NEGATIVE_INFINITY,
            );
      ordered.sort((left, right) => timestamp(right) - timestamp(left));
    }
  } else {
    const projectId = workspaceListFilterProjectId(filter);
    const visibleProjects = projectId
      ? args.projects.filter((project) => project.id === projectId)
      : args.projects;
    ordered = visibleProjects.flatMap((project): OrderedRow[] => [
      ...rows.filter((row) => row.project.id === project.id),
      ...(leavingProject.id === project.id ? [leavingRow] : []),
    ]);
  }

  const leavingIndex = ordered.findIndex((row) => row.kind === "leaving");
  if (leavingIndex < 0) return null;
  for (let index = leavingIndex - 1; index >= 0; index -= 1) {
    const candidate = ordered[index];
    if (candidate?.kind === "pending") return candidate.pending;
  }
  for (let index = leavingIndex + 1; index < ordered.length; index += 1) {
    const candidate = ordered[index];
    if (candidate?.kind === "pending") return candidate.pending;
  }
  return null;
}

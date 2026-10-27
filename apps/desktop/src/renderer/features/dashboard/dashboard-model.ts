import type { Workspace } from "../../platform/git";
import type { Project } from "../../state/projects-store";
import type { PendingWorkspaceCreate } from "../../state/pending-workspaces";
import type { ChatThread } from "../../state/store";
import { isLocalMainWorkspace } from "../../state/local-main-workspace";
import { branchDisplayName } from "../../shared/lib/branch-name";
import type { DashboardArchive, DashboardSort } from "./preferences";

export interface DashboardRow {
  workspace: Workspace;
  project: Project | null;
  repoName: string;
  title: string;
  branch: string;
  lastActiveAt: number;
  hidden?: boolean;
}

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});
const timestamp = (value: number | null | undefined): number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 8_640_000_000_000_000
    ? value
    : 0;

/** One aggregate join shared by the board and list; no per-row reads. */
export function dashboardRowBuilder(
  projects: readonly Project[],
  chats: readonly Pick<ChatThread, "folder" | "title" | "updatedAt">[],
  activity: ReadonlyMap<string, number>,
): (workspace: Workspace) => DashboardRow {
  const projectBySlug = new Map(
    projects.map((project) => [project.repoSlug, project]),
  );
  const titleByFolder = new Map<string, { title: string; updatedAt: number }>();
  for (const chat of chats) {
    const title = (chat.title ?? "").trim();
    if (!chat.folder || !title || title === "Untitled") continue;
    const previous = titleByFolder.get(chat.folder);
    if (!previous || timestamp(chat.updatedAt) > previous.updatedAt)
      titleByFolder.set(chat.folder, {
        title,
        updatedAt: timestamp(chat.updatedAt),
      });
  }
  return (workspace) => {
    const branch = branchDisplayName(workspace.branch);
    const project = projectBySlug.get(workspace.repoSlug) ?? null;
    return {
      workspace,
      project,
      repoName: project?.name ?? workspace.repoSlug,
      title: isLocalMainWorkspace(workspace)
        ? branch
        : titleByFolder.get(workspace.path)?.title || branch,
      branch,
      lastActiveAt: Math.max(
        timestamp(workspace.createdAt),
        timestamp(workspace.lastActiveAt),
        timestamp(workspace.archivedAt),
        timestamp(activity.get(workspace.id)),
      ),
    };
  };
}

/** Archive is a durable flag. Missing folders and sleeping cloud VMs are not
 * archives, and remain reachable while archived workspaces are hidden. */
export function dashboardRowsForArchive(
  rows: readonly DashboardRow[],
  archive: DashboardArchive,
): DashboardRow[] {
  return rows.filter(
    (row) =>
      archive === "all" ||
      (archive === "archived"
        ? row.workspace.archivedAt != null
        : row.workspace.archivedAt == null),
  );
}

function matchesQuery(
  query: string,
  fields: readonly (string | number | null | undefined)[],
): boolean {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const haystack = fields
    .filter((value) => value != null)
    .join(" ")
    .toLocaleLowerCase();
  return terms.every((term) => haystack.includes(term));
}

export function filterDashboardRows(
  rows: readonly DashboardRow[],
  repoSlug: string | null,
  query: string,
  sort: DashboardSort,
): DashboardRow[] {
  return rows
    .filter(
      (row) =>
        (!repoSlug || row.workspace.repoSlug === repoSlug) &&
        matchesQuery(query, [
          row.title,
          row.branch,
          row.workspace.branch,
          row.repoName,
          row.workspace.repoSlug,
          row.workspace.prNumber == null ? null : `#${row.workspace.prNumber}`,
        ]),
    )
    .sort((a, b) => {
      const byName = () => collator.compare(a.title, b.title);
      const primary =
        sort === "name"
          ? byName()
          : sort === "repository"
            ? collator.compare(a.repoName, b.repoName) || byName()
            : sort === "newest"
              ? timestamp(b.workspace.createdAt) -
                timestamp(a.workspace.createdAt)
              : b.lastActiveAt - a.lastActiveAt;
      return (
        primary ||
        timestamp(b.workspace.createdAt) - timestamp(a.workspace.createdAt) ||
        a.workspace.id.localeCompare(b.workspace.id)
      );
    });
}

export function dashboardPendingLabel(pending: PendingWorkspaceCreate): string {
  return (
    pending.label?.trim() ||
    (pending.branch ? branchDisplayName(pending.branch) : "New workspace")
  );
}

export function filterDashboardPending(
  pending: readonly PendingWorkspaceCreate[],
  projects: ReadonlyMap<string, Project>,
  repoSlug: string | null,
  query: string,
): PendingWorkspaceCreate[] {
  return pending
    .filter(
      (row) =>
        (!repoSlug || row.repoSlug === repoSlug) &&
        matchesQuery(query, [
          dashboardPendingLabel(row),
          row.branch,
          row.repoSlug,
          projects.get(row.repoSlug)?.name,
          row.repository?.name,
        ]),
    )
    .sort(
      (a, b) =>
        timestamp(b.startedAt) - timestamp(a.startedAt) ||
        a.token.localeCompare(b.token),
    );
}

/** Counts only a confirmed full-branch comparison, never porcelain status or
 * the sum of staged and unstaged comparisons (which double-count paths). */
export function dashboardLineChanges(
  sections:
    | readonly { files: readonly { additions: number; deletions: number }[] }[]
    | undefined,
): { additions: number; deletions: number } | null {
  if (!sections) return null;
  let additions = 0;
  let deletions = 0;
  for (const section of sections) {
    for (const file of section.files) {
      if (
        !Number.isSafeInteger(file.additions) ||
        file.additions < 0 ||
        !Number.isSafeInteger(file.deletions) ||
        file.deletions < 0
      )
        return null;
      additions += file.additions;
      deletions += file.deletions;
    }
  }
  return { additions, deletions };
}

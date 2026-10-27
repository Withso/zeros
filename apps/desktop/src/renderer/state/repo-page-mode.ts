import type { RepoPageView } from "./store";
import type { Project } from "./projects-store";

/** A confirmed plain folder has no worktrees or Git preferences. Unknown
 * legacy projects keep their existing navigation until inspected. */
export function isRepoPageViewAvailable(
  project: Project,
  view: RepoPageView,
): boolean {
  return (
    project.isGitRepository !== false ||
    (view !== "workspaces" && view !== "git" && view !== "files")
  );
}

/** Resolve saved tabs and deep links before paint without overwriting the
 * user's preference, so it becomes available again after Git is initialized. */
export function effectiveRepoPageView(
  project: Project,
  view: RepoPageView,
): RepoPageView {
  return isRepoPageViewAvailable(project, view) ? view : "environment";
}

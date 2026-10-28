import type { Project } from "../../state/projects-store";
import { githubReviewAvailable } from "../../platform/bridge/code-review-availability";
import { isGithubDotComRemote } from "../pr/github-url";
import type { WorkbenchTab } from "./tab-model";
import { visibleWorkbenchTabs } from "./terminal-tabs";

/** Older cloud APIs keep Review unavailable until they advertise the service. */
export function isWorkspaceReviewAvailable(
  project: (Pick<Project, "isGitRepository" | "originUrl"> & { repoRoot?: string }) | null,
): boolean {
  return (
    project?.isGitRepository !== false &&
    githubReviewAvailable({ cwd: project?.repoRoot }) &&
    isGithubDotComRemote(project?.originUrl)
  );
}

/** Filter presentation only: keep persisted tab identities and Review choices
 * so they survive repository switches and later Git/GitHub setup. */
export function availableWorkspaceTabs(
  tabs: WorkbenchTab[],
  project: (Pick<Project, "isGitRepository" | "originUrl"> & { repoRoot?: string }) | null,
): WorkbenchTab[] {
  const reviewAvailable = isWorkspaceReviewAvailable(project);
  return visibleWorkbenchTabs(tabs).filter(
    (tab) => tab.type !== "review" || reviewAvailable,
  );
}

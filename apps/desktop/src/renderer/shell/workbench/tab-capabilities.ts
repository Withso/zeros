import type { Project } from "../../state/projects-store";
import { isGithubDotComRemote } from "../pr/github-url";
import type { WorkbenchTab } from "./tab-model";
import { visibleWorkbenchTabs } from "./terminal-tabs";

export function isWorkspaceReviewAvailable(
  project: Pick<Project, "isGitRepository" | "originUrl"> | null,
): boolean {
  return (
    project?.isGitRepository !== false &&
    isGithubDotComRemote(project?.originUrl)
  );
}

/** Filter presentation only: keep persisted tab identities and Review choices
 * so they survive repository switches and later Git/GitHub setup. */
export function availableWorkspaceTabs(
  tabs: WorkbenchTab[],
  project: Pick<Project, "isGitRepository" | "originUrl"> | null,
): WorkbenchTab[] {
  const reviewAvailable = isWorkspaceReviewAvailable(project);
  return visibleWorkbenchTabs(tabs).filter(
    (tab) => tab.type !== "review" || reviewAvailable,
  );
}

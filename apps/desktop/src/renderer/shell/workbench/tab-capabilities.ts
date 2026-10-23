import type { Project } from "../../state/projects-store";
import { isCloudWorkspace } from "../../platform/bridge/cloud-workspace-key";
import { isGithubDotComRemote } from "../pr/github-url";
import type { WorkbenchTab } from "./tab-model";
import { visibleWorkbenchTabs } from "./terminal-tabs";

/** Pull request review is Local-only for now: the cloud v2 worker serves no
 * GitHub review operations. */
export function isWorkspaceReviewAvailable(
  project: (Pick<Project, "isGitRepository" | "originUrl"> & { repoRoot?: string }) | null,
): boolean {
  return (
    project?.isGitRepository !== false &&
    !isCloudWorkspace(project?.repoRoot) &&
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

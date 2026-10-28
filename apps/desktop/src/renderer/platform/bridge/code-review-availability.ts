import { cloudTargetForValue } from "./cloud-workspace-key";
import { hasCloudGithubPrCapability } from "../cloud-github-pr-capability";

/** Cloud v2 has no private workspace-comment service. Keep the same
 * capability at the read, write and presentation boundaries, including while
 * a workspace id and cwd are being reconciled. Malformed cloud ids fail closed. */
export function codeReviewAvailable({
  cwd,
  workspaceId,
}: {
  cwd?: string | null;
  workspaceId?: string | null;
}): boolean {
  try {
    return !cloudTargetForValue(cwd) && !cloudTargetForValue(workspaceId);
  } catch {
    return false;
  }
}

/** Published GitHub discussions are independent of private workspace comments. */
export function githubReviewAvailable({ cwd, workspaceId }: { cwd?: string | null; workspaceId?: string | null }): boolean {
  try {
    const folder = cloudTargetForValue(cwd), workspace = cloudTargetForValue(workspaceId);
    if (folder && workspace && (folder.workspaceId !== workspace.workspaceId || folder.organizationId !== workspace.organizationId)) return false;
    const target = workspace ?? folder;
    return !target || hasCloudGithubPrCapability(target);
  } catch { return false; }
}

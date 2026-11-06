import { isCloudWorkspace, parseCloudScopedId } from "../../../platform/bridge/cloud-workspace-key";

export function reviewRepositoryLabel(workspaceId: string, repoSlug: string | null): string | null {
  if (!isCloudWorkspace(workspaceId) && !parseCloudScopedId(workspaceId)) return repoSlug;
  return repoSlug?.replace(/^cloud-[^:]+:github\.com:/, "") ?? null;
}

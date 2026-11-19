import { useResolvedSettings } from "./use-settings";
import { isCloudWorkspace } from "../../platform/bridge/cloud-workspace-key";

// Match the fallback in engine/settings/repo-git.ts while the local setting is unresolved.
export const DEFAULT_GIT_REMOTE = "origin";

export function useGitRemote(repoRoot: string | undefined): string {
  const cloud = isCloudWorkspace(repoRoot);
  const { resolved } = useResolvedSettings(repoRoot, undefined, !cloud);
  if (cloud) return DEFAULT_GIT_REMOTE;
  const git = resolved?.effective?.git;
  if (git && typeof git === "object" && !Array.isArray(git)) {
    const remote = (git as Record<string, unknown>).remote;
    if (typeof remote === "string" && remote.trim()) return remote.trim();
  }
  return DEFAULT_GIT_REMOTE;
}

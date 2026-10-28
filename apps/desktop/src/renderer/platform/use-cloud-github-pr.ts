import { useCallback, useSyncExternalStore } from "react";
import { cloudTargetForValue } from "./bridge/cloud-workspace-key";
import {
  cloudWorkspaceDocument,
  subscribeCloudWorkspaces,
} from "../state/cloud-workspace-catalog";
export { useCloudGithubPrScope } from "./cloud-github-pr-scope";
export function useCloudGithubPrDocument(
  workspaceId: string | null | undefined,
) {
  const read = useCallback(() => {
    try {
      const target = cloudTargetForValue(workspaceId);
      return target ? cloudWorkspaceDocument(target) : undefined;
    } catch {
      return undefined;
    }
  }, [workspaceId]);
  return useSyncExternalStore(subscribeCloudWorkspaces, read, read);
}

import { useCallback, useSyncExternalStore } from "react";
import { cloudTargetForValue, cloudWorkspaceKey, type CloudWorkspaceTarget } from "./cloud-workspace-key";
import { hasCloudGithubPrCapability } from "../cloud-github-pr-capability";
import { getActiveBridge, onActiveBridgeChange } from "./active-bridge";
import { WorkspaceRuntimeClient } from "./workspace-runtime-client";

type ReviewContext = { cwd?: string | null; workspaceId?: string | null };
/** A native id beside a cloud folder cannot select a Local review store. */
export function codeReviewTarget({ cwd, workspaceId }: ReviewContext): CloudWorkspaceTarget | null | false {
  try {
    const folder = cloudTargetForValue(cwd), workspace = cloudTargetForValue(workspaceId);
    if (folder && workspaceId && !workspace || workspace && cwd && !folder) return false;
    if (folder && workspace && cloudWorkspaceKey(folder) !== cloudWorkspaceKey(workspace)) return false;
    return workspace ?? folder;
  } catch { return false; }
}

export function codeReviewAvailable(context: ReviewContext): boolean {
  const target = codeReviewTarget(context);
  if (target === false) return false;
  return !target || getActiveBridge()?.supportsEngineCapability?.("code-review-v1", cloudWorkspaceKey(target)) === true;
}

export function useCodeReviewAvailable({ cwd, workspaceId }: ReviewContext, active: boolean): boolean {
  const subscribe = useCallback((listener: () => void) => {
    const target = codeReviewTarget({ cwd, workspaceId });
    if (!active || !target) return () => {};
    let stop = () => {};
    const attach = (bridge: ReturnType<typeof getActiveBridge>) => {
      stop();
      const ready = bridge?.on("ENGINE_READY", listener);
      const status = bridge instanceof WorkspaceRuntimeClient
        ? bridge.onWorkspaceStatusChange(cloudWorkspaceKey(target), listener)
        : bridge?.onStatusChange?.(listener);
      stop = () => { ready?.(); status?.(); };
      listener();
    };
    attach(getActiveBridge());
    const changed = onActiveBridgeChange(attach);
    return () => { stop(); changed(); };
  }, [cwd, workspaceId, active]);
  const snapshot = useCallback(() => codeReviewAvailable({ cwd, workspaceId }), [cwd, workspaceId]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
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

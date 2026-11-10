import { useEffect, useState } from "react";
import { CLOUD_WORKSPACE_RESOURCES_CAPABILITY, CloudWorkspaceResourcesSchema, type CloudWorkspaceResources } from "@zeros/protocol/cloud-v2-relay";
import { getActiveBridge } from "./bridge/active-bridge";
import { cloudWorkspaceKey, type CloudWorkspaceTarget } from "./bridge/cloud-workspace-key";

const REFRESH_MS = 5_000;

/** CPU, memory and disk from the workspace's worker. An older worker, a
 * refusal or a malformed reply is "no rows", never an error. Passive: a
 * disconnected or stopped workspace is not reopened to answer. */
export async function readCloudWorkspaceResources(target: CloudWorkspaceTarget): Promise<CloudWorkspaceResources | null> {
  const bridge = getActiveBridge(), workspaceId = cloudWorkspaceKey(target);
  if (!bridge?.supportsEngineCapability?.(CLOUD_WORKSPACE_RESOURCES_CAPABILITY, workspaceId)) return null;
  const response = await bridge.requestConnected({ type: "WORKSPACE_REQUEST", op: "workspace.resources", params: { workspaceId } }, 10_000) as
    { type?: string; op?: string; result?: unknown };
  if (response.type !== "WORKSPACE_RESPONSE" || response.op !== "workspace.resources") return null;
  const parsed = CloudWorkspaceResourcesSchema.safeParse(response.result);
  return parsed.success ? parsed.data : null;
}

/** Sampled only while `active` (the details popup is open on a running
 * workspace); nothing is asked otherwise. Keyed by workspace, so a late reply
 * for another workspace never shows. */
export function useCloudWorkspaceResources(target: CloudWorkspaceTarget | null, active: boolean): CloudWorkspaceResources | null {
  const key = target ? cloudWorkspaceKey(target) : null;
  const [sample, setSample] = useState<{ key: string; value: CloudWorkspaceResources } | null>(null);
  useEffect(() => {
    if (!active || !target || !key) return;
    let cancelled = false, inFlight = false;
    const ask = () => {
      if (inFlight) return;
      inFlight = true;
      void readCloudWorkspaceResources(target).then(value => {
        if (!cancelled && value) setSample({ key, value });
      }, () => {}).finally(() => { inFlight = false; });
    };
    ask();
    const timer = setInterval(ask, REFRESH_MS);
    return () => { cancelled = true; clearInterval(timer); };
    // The target object may be rebuilt each render; its key is its identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, key]);
  return sample && sample.key === key ? sample.value : null;
}

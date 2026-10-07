import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { cloudWorkspaceExecutionRefusal } from "../platform/cloud-workspace-execution";
import { getOrganizationStoreGeneration, getTeamStoreState } from "../features/team/team-store";
import { getCloudWorkspaceResourceUsage } from "../platform/cloud-workspaces";
import { getActiveBridge } from "../platform/bridge/active-bridge";
import { WorkspaceRuntimeClient } from "../platform/bridge/workspace-runtime-client";
import { useBridge, useBridgeStatus } from "../platform/bridge/use-bridge";
import { cloudWorkspaceKey, parseCloudWorkspaceKey } from "../platform/bridge/cloud-workspace-key";
import {
  canReadCloudWorkspace, cloudCatalogGeneration, cloudWorkspaceDocument, subscribeCloudWorkspaces,
} from "./cloud-workspace-catalog";
import { useCachedRead } from "./use-cached-read";
import {
  CloudWorkspaceResourceUsageCache, cloudWorkspaceResourceUsageKey,
  CLOUD_RESOURCE_USAGE_MAX_AGE_MS, CLOUD_RESOURCE_USAGE_POLL_MS,
  canPollCloudWorkspaceResourceUsage, isCloudWorkspaceResourceUsageFresh,
  type CloudWorkspaceResourceUsageOwner,
} from "./cloud-workspace-resource-usage-cache";

function isCurrent(owner: CloudWorkspaceResourceUsageOwner): boolean {
  const doc = cloudWorkspaceDocument(owner);
  const bridge = getActiveBridge();
  const connection = bridge instanceof WorkspaceRuntimeClient ? bridge.cloudResourceUsageConnection(cloudWorkspaceKey(owner)) : null;
  return owner.accountId === getTeamStoreState().me?.user.id && owner.accountGeneration === getOrganizationStoreGeneration() &&
    owner.catalogGeneration === cloudCatalogGeneration() && canReadCloudWorkspace(doc) &&
    doc?.generation.number === owner.generation && !cloudWorkspaceExecutionRefusal(doc) && !doc.recovery?.state &&
    (doc.status === "ready" || doc.status === "busy") && !!connection &&
    connection.engineInstanceId === owner.engineInstanceId && connection.authorityEpoch === owner.authorityEpoch &&
    connection.admissionId === owner.admissionId;
}
export const cloudWorkspaceResourceUsage = new CloudWorkspaceResourceUsageCache({
  isCurrent, read: owner => getCloudWorkspaceResourceUsage(owner, owner),
});
subscribeCloudWorkspaces(() => cloudWorkspaceResourceUsage.prune());

export function useCloudWorkspaceResourceUsage(
  folder: string | null,
  options: { active: boolean; open: boolean; featureActive: boolean },
) {
  const bridge = useBridge();
  const connected = useBridgeStatus(folder) === "connected";
  const target = useMemo(() => parseCloudWorkspaceKey(folder), [folder]);
  const getDocument = useCallback(() => target ? cloudWorkspaceDocument(target) : undefined,
    [target]);
  const doc = useSyncExternalStore(subscribeCloudWorkspaces, getDocument, getDocument);
  const [visible, setVisible] = useState(() => typeof document !== "undefined" && document.visibilityState !== "hidden");
  useEffect(() => {
    if (!options.active || !options.open || !options.featureActive || !target || typeof document === "undefined") return;
    const change = () => setVisible(document.visibilityState !== "hidden");
    change(); document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, [options.active, options.open, options.featureActive, target]);
  const allowed = canPollCloudWorkspaceResourceUsage({ ...options, visible: visible && typeof document !== "undefined" && document.visibilityState !== "hidden", connected, cloud: !!target && !cloudWorkspaceExecutionRefusal(doc),
    status: doc?.status, recovery: !!doc?.recovery?.state });
  const connection = target && bridge instanceof WorkspaceRuntimeClient ? bridge.cloudResourceUsageConnection(cloudWorkspaceKey(target)) : null;
  const accountId = getTeamStoreState().me?.user.id;
  const key = allowed && accountId && connection && connection.generation === doc?.generation.number
    ? cloudWorkspaceResourceUsageKey({ ...connection, accountId, accountGeneration: getOrganizationStoreGeneration(),
      catalogGeneration: cloudCatalogGeneration() }) : null;
  const read = useCachedRead(cloudWorkspaceResourceUsage.snapshots, key,
    requestKey => cloudWorkspaceResourceUsage.fetch(requestKey), { maxAgeMs: CLOUD_RESOURCE_USAGE_MAX_AGE_MS });
  const unavailable = read.data === null;
  useEffect(() => {
    if (!key || !allowed || unavailable) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden") void cloudWorkspaceResourceUsage.load(key).catch(() => {});
    }, CLOUD_RESOURCE_USAGE_POLL_MS);
    return () => clearInterval(timer);
  }, [key, allowed, unavailable]);
  return read.data && !isCloudWorkspaceResourceUsageFresh(read.data) ? { ...read, data: null } : read;
}

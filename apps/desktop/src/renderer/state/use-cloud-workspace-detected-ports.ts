import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { getOrganizationStoreGeneration, getTeamStoreState } from "../features/team/team-store";
import { getCloudWorkspaceDetectedPorts } from "../platform/cloud-workspaces";
import { parseCloudWorkspaceKey } from "../platform/bridge/cloud-workspace-key";
import { canReadCloudWorkspace, cloudCatalogGeneration, cloudWorkspaceDocument, subscribeCloudWorkspaces } from "./cloud-workspace-catalog";
import { useCachedRead } from "./use-cached-read";
import {
  CloudWorkspaceDetectedPortsCache, cloudWorkspaceDetectedPortsKey, CLOUD_DETECTED_PORTS_MAX_AGE_MS,
} from "./cloud-workspace-detected-ports-cache";

export const cloudWorkspaceDetectedPorts = new CloudWorkspaceDetectedPortsCache({
  read: owner => getCloudWorkspaceDetectedPorts(owner, owner.generation),
  isCurrent: owner => owner.accountId === getTeamStoreState().me?.user.id &&
    owner.accountGeneration === getOrganizationStoreGeneration() && owner.catalogGeneration === cloudCatalogGeneration() &&
    canReadCloudWorkspace(cloudWorkspaceDocument(owner)) && cloudWorkspaceDocument(owner)?.generation.number === owner.generation,
});
subscribeCloudWorkspaces(() => cloudWorkspaceDetectedPorts.prune());

/** Persisted heartbeat metadata needs neither an engine connection nor wake. */
export function useCloudWorkspaceDetectedPorts(folder: string | null, options: { active: boolean; open: boolean; featureActive: boolean }) {
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
  const accountId = getTeamStoreState().me?.user.id;
  const enabled = options.active && options.open && options.featureActive && visible &&
    typeof document !== "undefined" && document.visibilityState !== "hidden" && canReadCloudWorkspace(doc);
  const key = enabled && target && accountId && doc ? cloudWorkspaceDetectedPortsKey({
    organizationId: target.organizationId, workspaceId: target.workspaceId, generation: doc.generation.number,
    accountId, accountGeneration: getOrganizationStoreGeneration(), catalogGeneration: cloudCatalogGeneration(),
  }) : null;
  const read = useCachedRead(cloudWorkspaceDetectedPorts.snapshots, key,
    requestKey => cloudWorkspaceDetectedPorts.fetch(requestKey), { maxAgeMs: CLOUD_DETECTED_PORTS_MAX_AGE_MS });
  const running = doc?.status === "ready" || doc?.status === "busy";
  useEffect(() => {
    if (!key || !running) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden") void cloudWorkspaceDetectedPorts.load(key).catch(() => {});
    }, 4_000);
    return () => clearInterval(timer);
  }, [key, running]);
  return read;
}

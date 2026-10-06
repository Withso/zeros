import type { CloudRuntimeUpgradeAvailability } from "@zeros/protocol/cloud-runtime-lifecycle";
import { getCloudRuntimeUpgradeAvailability } from "../platform/cloud-workspaces";
import { parseCloudWorkspaceKey, type CloudWorkspaceTarget } from "../platform/bridge/cloud-workspace-key";
import { getOrganizationStoreGeneration } from "../features/team/team-store";
import { KeyedAsyncCache } from "../shared/lib/keyed-async-cache";
import { cloudCatalogGeneration, cloudWorkspaceDocument, subscribeCloudWorkspaces } from "./cloud-workspace-catalog";

export const cloudRuntimeUpgradeAvailability = new KeyedAsyncCache<CloudRuntimeUpgradeAvailability>({
  maxEntries: 128,
  reconcile: (previous, next) => previous && JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
});

export function cloudRuntimeUpgradeAvailabilityKey(target: CloudWorkspaceTarget, generation: number): string {
  return JSON.stringify([getOrganizationStoreGeneration(), cloudCatalogGeneration(), target.organizationId, target.workspaceId, generation]);
}

export function warmCloudRuntimeUpgrade(target: CloudWorkspaceTarget, generation: number): void {
  const key = cloudRuntimeUpgradeAvailabilityKey(target, generation);
  void cloudRuntimeUpgradeAvailability.load(key, () => loadCloudRuntimeUpgradeAvailability(key), { maxAgeMs: 10_000 }).catch(() => {});
}

function assertOwner(target: CloudWorkspaceTarget, account: number, catalog: number): void {
  if (account !== getOrganizationStoreGeneration() || catalog !== cloudCatalogGeneration())
    throw new Error("Cloud account changed while updating the runtime");
  const workspace = cloudWorkspaceDocument(target);
  if (!workspace || workspace.deletedAt !== null || ["deleting", "deleted"].includes(workspace.status))
    throw new Error("Cloud workspace was removed while updating the runtime");
}

export async function loadCloudRuntimeUpgradeAvailability(key: string): Promise<CloudRuntimeUpgradeAvailability> {
  const [account, catalog, organizationId, workspaceId, generation] = JSON.parse(key) as [number, number, string, string, number];
  const target = { organizationId, workspaceId };
  assertOwner(target, account, catalog);
  const result = await getCloudRuntimeUpgradeAvailability(target);
  assertOwner(target, account, catalog);
  if (result.generation !== generation || cloudWorkspaceDocument(target)!.generation.number !== generation)
    throw new Error("Cloud workspace generation changed while loading runtime details");
  return result;
}

type RuntimeDetailsIntent = CloudWorkspaceTarget & { account: number; catalog: number };
const detailsListeners = new Set<(intent: RuntimeDetailsIntent) => void>();

/** Explicit navigation only. Discovery never starts an upgrade or opens a panel. */
export function requestCloudRuntimeUpgradeDetails(folder: string): void {
  const target = parseCloudWorkspaceKey(folder);
  if (!target) return;
  const account = getOrganizationStoreGeneration(), catalog = cloudCatalogGeneration();
  assertOwner(target, account, catalog);
  for (const listener of detailsListeners) listener({ organizationId: target.organizationId, workspaceId: target.workspaceId, account, catalog });
}

export function subscribeCloudRuntimeUpgradeDetails(listener: (intent: RuntimeDetailsIntent) => void): () => void {
  detailsListeners.add(listener);
  return () => { detailsListeners.delete(listener); };
}

subscribeCloudWorkspaces(() => {
  for (const key of cloudRuntimeUpgradeAvailability.keys()) {
    const [account, catalog, organizationId, workspaceId] = JSON.parse(key) as [number, number, string, string];
    try { assertOwner({ organizationId, workspaceId }, account, catalog); }
    catch { cloudRuntimeUpgradeAvailability.forget(key); }
  }
});

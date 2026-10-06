import type { CloudRuntimeUpgradeAvailability, CloudRuntimeUpgradeResponse } from "@zeros/protocol/cloud-runtime-lifecycle";
import { getCloudRuntimeUpgradeAvailability, upgradeCloudWorkspaceRuntime } from "../platform/cloud-workspaces";
import type { CloudWorkspaceDocument } from "../platform/cloud-workspaces";
import { cloudWorkspaceKey, parseCloudWorkspaceKey, type CloudWorkspaceTarget } from "../platform/bridge/cloud-workspace-key";
import { getOrganizationStoreGeneration } from "../features/team/team-store";
import { ControlPlaneError } from "../features/team/control-plane";
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
  const intentKey = operationKey(target, account, catalog), intent = intents.get(intentKey);
  // A confirmed ready replacement or terminal transition ends an uncertain
  // operation too. Until then, a lost POST response must retain its identity.
  if (intent && (result.transition && intent.receipt?.transitionId === result.transition.id &&
      ["rolled_back", "rollback_failed", "cancelled"].includes(result.transition.state) ||
      cloudWorkspaceDocument(target)!.status === "ready" && generation > intent.expectedGeneration &&
      !["draining", "provisioning", "setting_up", "rolling_back"].includes(result.transition?.state ?? "")))
    intents.delete(intentKey);
  return result;
}

type UpgradeIntent = { target: CloudWorkspaceTarget; operationId: string; expectedGeneration: number; task?: Promise<CloudRuntimeUpgradeResponse>; receipt?: CloudRuntimeUpgradeResponse };
const intents = new Map<string, UpgradeIntent>();
const operationKey = (target: CloudWorkspaceTarget, account = getOrganizationStoreGeneration(), catalog = cloudCatalogGeneration()) =>
  `${account}:${catalog}:${cloudWorkspaceKey(target)}`;

export function requestCloudRuntimeUpgrade(target: CloudWorkspaceTarget, expectedGeneration: number): Promise<CloudRuntimeUpgradeResponse> {
  const account = getOrganizationStoreGeneration(), catalog = cloudCatalogGeneration();
  const key = operationKey(target, account, catalog);
  const intent = intents.get(key) ?? { target: { ...target }, operationId: crypto.randomUUID(), expectedGeneration };
  if (intent.task) return intent.task;
  if (intent.receipt) return Promise.resolve(intent.receipt);
  for (const [retainedKey, retained] of intents) {
    if (!retained.task && (!retainedKey.startsWith(`${account}:${catalog}:`) || intents.size >= 128)) intents.delete(retainedKey);
  }
  const task = (async () => {
    assertOwner(target, account, catalog);
    const receipt = await upgradeCloudWorkspaceRuntime(target, { operationId: intent.operationId, expectedGeneration: intent.expectedGeneration });
    assertOwner(target, account, catalog);
    if (intents.get(key) !== intent) throw new Error("Cloud workspace was removed while updating the runtime");
    intent.receipt = receipt;
    if (receipt.unchanged) intents.delete(key);
    return receipt;
  })().catch(error => {
    // Only an authoritative rejection permits a fresh operation ID. Network
    // failures and 5xx replies may conceal a successfully accepted transition.
    if (error instanceof ControlPlaneError && error.status >= 400 && error.status < 500 && intents.get(key) === intent)
      intents.delete(key);
    throw error;
  }).finally(() => { if (intent.task === task) delete intent.task; });
  intent.task = task;
  intents.set(key, intent);
  return task;
}

export function settleCloudRuntimeUpgrade(target: CloudWorkspaceTarget, receipt: CloudRuntimeUpgradeResponse): void {
  const key = operationKey(target);
  if (intents.get(key)?.operationId === receipt.operationId) intents.delete(key);
}

/** Readiness is authoritative even if another device finished a later upgrade
 * before this client observed its own receipt's terminal transition. */
export function cloudRuntimeUpgradeOutcome(workspace: Pick<CloudWorkspaceDocument, "generation" | "status">,
  runtime: CloudRuntimeUpgradeAvailability, receipt: CloudRuntimeUpgradeResponse): "updated" | "failed" | "superseded" | null {
  if (runtime.generation !== workspace.generation.number) return null;
  const transition = runtime.transition, matching = transition?.id === receipt.transitionId;
  if (matching && ["rolling_back", "rolled_back", "rollback_failed", "cancelled"].includes(transition.state)) return "failed";
  if (workspace.status !== "ready") return null;
  if (matching && transition.state === "succeeded" && workspace.generation.number === receipt.generation &&
    runtime.currentRuntimeId === receipt.runtimeId) return "updated";
  if (workspace.generation.number > receipt.generation && runtime.currentRuntimeId &&
    runtime.unavailableReason !== "cloud_generation_transition_active" &&
    !["draining", "provisioning", "setting_up", "rolling_back"].includes(transition?.state ?? ""))
    return runtime.currentRuntimeId === receipt.runtimeId ? "updated" : "superseded";
  return null;
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
  const prefix = `${getOrganizationStoreGeneration()}:${cloudCatalogGeneration()}:`;
  for (const [key, intent] of intents) {
    const workspace = cloudWorkspaceDocument(intent.target);
    if (!key.startsWith(prefix) || !workspace || workspace.deletedAt !== null || ["deleting", "deleted"].includes(workspace.status))
      intents.delete(key);
  }
});

import { useSyncExternalStore } from "react";
import type { InitializeResponse } from "../../platform/bridge/agent-events";
import { getActiveBridge } from "../../platform/bridge/active-bridge";
import type {
  AgentAgentsListMessage,
  BridgeRegistryAgent,
} from "../../platform/bridge/messages";
import {
  cloudWorkspaceKey,
  parseCloudWorkspaceKey,
} from "../../platform/bridge/cloud-workspace-key";
import { cloudAgentDelegations } from "../../platform/cloud-workspaces";
import { KeyedAsyncCache } from "../../shared/lib/keyed-async-cache";
import { useCachedRead } from "../../state/use-cached-read";
import {
  cloudWorkspaceDocument,
  subscribeCloudWorkspaceRefresh,
  subscribeCloudWorkspaces,
} from "../../state/cloud-workspace-catalog";
import {
  getAgentsSnapshot,
  hasConfirmedAgents,
  useAgentsSnapshot,
} from "./agents-cache";
import { modelsForAgent, type ModelOption } from "./model-catalog";

/** Renderer metadata from exact-workspace consent, never part of the engine registry. */
export type WorkspaceRegistryAgent = BridgeRegistryAgent & {
  cloudModels?: string[];
  runtimeUpgradeRequired?: boolean;
};

/** Selecting a newer model explains the pinned cloud runtime; it never changes
 * authentication or hides a saved model, and Local uses its existing path. */
export function cloudModelRuntimeUpgradeRequired(
  folder: string | undefined,
  agent: WorkspaceRegistryAgent | undefined,
  model: ModelOption | null,
): boolean {
  if (!parseCloudWorkspaceKey(folder)) return false;
  if (agent?.runtimeUpgradeRequired) return true;
  const current = agent?.installedVersion?.match(/^(\d+)\.(\d+)\.(\d+)(?:\s|$)/);
  const minimum = model?.minCliVersion?.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!current || !minimum) return false;
  for (let index = 1; index <= 3; index++) {
    const installed = Number(current[index]), required = Number(minimum[index]);
    if (installed !== required) return installed < required;
  }
  return false;
}

export function modelsForWorkspaceAgent(
  agent: WorkspaceRegistryAgent,
  initialize: InitializeResponse | null,
) {
  const models = modelsForAgent(agent.id, initialize);
  const allowed = agent.cloudModels;
  return allowed === undefined
    ? models
    : models.filter(model => allowed.includes(model.value));
}

const cache = new KeyedAsyncCache<WorkspaceRegistryAgent[]>(32);
// Reuse the catalog cadence for changes from other devices, consent expiry,
// and engine replacement. Only active hook subscribers initiate revalidation.
subscribeCloudWorkspaceRefresh(() => {
  for (const key of cache.keys()) cache.invalidate(key);
});
export const clearCloudAgentRegistry = () => {
  for (const key of cache.keys()) cache.forget(key);
};
export function invalidateCloudOrganizationAgentRegistry(organizationId: string): void {
  for (const key of cache.keys()) {
    if (parseCloudWorkspaceKey(key)?.organizationId === organizationId) cache.invalidate(key);
  }
}
export function invalidateCloudAgentRegistry(folder: string): void {
  const target = parseCloudWorkspaceKey(folder);
  if (target) cache.invalidate(cloudWorkspaceKey(target));
}
/** A closed admission denial is authoritative for this workspace/provider.
 * Publish it before returning the draft, then recheck durable discovery (which
 * can also find another MCP-qualified grant). Local registry state is separate. */
export function reportCloudAgentRuntimeUpgrade(folder: string, agentId: string): void {
  const target = parseCloudWorkspaceKey(folder);
  if (!target) return;
  const key = cloudWorkspaceKey(target), agents = cache.getSnapshot(key).data;
  if (agents) cache.setData(key, agents.map(agent => agent.id === agentId ? {
    ...agent, runtimeUpgradeRequired: true, authenticated: false, cloudModels: [],
    runtimeUnavailableReason: "This workspace gets the new cloud runtime the next time it wakes",
  } : agent));
  cache.invalidate(key);
  void warmCloudAgentRegistry(key).catch(() => { /* Retain the confirmed denial until revalidation succeeds. */ });
}
export function workspaceAgentsSnapshot(
  folder?: string | null,
): WorkspaceRegistryAgent[] | null {
  const target = parseCloudWorkspaceKey(folder);
  return target
    ? (cache.getSnapshot(cloudWorkspaceKey(target)).data ?? null)
    : getAgentsSnapshot();
}
export function hasConfirmedWorkspaceAgents(folder?: string | null): boolean {
  return parseCloudWorkspaceKey(folder)
    ? workspaceAgentsSnapshot(folder) !== null
    : hasConfirmedAgents();
}
async function readCloudAgentRegistry(
  value: string,
): Promise<WorkspaceRegistryAgent[]> {
  const bridge = getActiveBridge();
  if (!bridge) throw new Error("Workspace is disconnected");
  const registryRequest = { type: "AGENT_LIST_AGENTS" as const, cwd: value };
  const [response, delegations] = await Promise.all([
    bridge.request<AgentAgentsListMessage>(registryRequest, 30_000),
    cloudAgentDelegations(parseCloudWorkspaceKey(value)!),
  ]);
  if (response.type !== "AGENT_AGENTS_LIST" || !Array.isArray(response.agents))
    throw new Error("Cloud agent registry is unavailable");
  return response.agents.map((agent) => {
    const grants = delegations.filter(grant => grant.kind.startsWith(`${agent.id}-`));
    const qualified = grants.filter(grant => grant.runtimeQualified !== false);
    const runtimeUpgradeRequired = qualified.length === 0 && grants.some(grant => grant.runtimeUpgradeRequired === true);
    return {
      ...agent,
      runtimeUpgradeRequired,
      cloudModels: [...new Set(qualified.flatMap(grant => grant.models))],
      ...(qualified.length === 0 && grants.length > 0
        ? {runtimeUnavailableReason: runtimeUpgradeRequired ? "This workspace gets the new cloud runtime the next time it wakes" : agent.runtimeUnavailableReason ?? "This workspace's agent runtime needs an update. Your account connection is saved."} : {}),
      authenticated: !agent.runtimeUnavailableReason && qualified.length > 0,
    };
  });
}
export function warmCloudAgentRegistry(
  folder: string,
): Promise<WorkspaceRegistryAgent[]> {
  const target = parseCloudWorkspaceKey(folder);
  if (!target)
    return Promise.reject(new Error("Cloud workspace identity is required"));
  const key = cloudWorkspaceKey(target);
  return cache.load(key, () => readCloudAgentRegistry(key), {
    maxAgeMs: 30_000,
  });
}
export function useWorkspaceAgents(
  folder?: string | null,
  active = true,
): WorkspaceRegistryAgent[] | null {
  const local = useAgentsSnapshot();
  const target = parseCloudWorkspaceKey(folder);
  const key = target ? cloudWorkspaceKey(target) : null;
  const ready = useSyncExternalStore(
    subscribeCloudWorkspaces,
    () =>
      target
        ? ["ready", "busy"].includes(
            cloudWorkspaceDocument(target)?.status ?? "",
          )
        : false,
    () => false,
  );
  const snapshot = useCachedRead(cache, key, readCloudAgentRegistry, {
    enabled: active && ready,
    maxAgeMs: 30_000,
  });
  return key ? (snapshot.data ?? null) : local;
}

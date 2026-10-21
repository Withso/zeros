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
  type CloudWorkspaceTarget,
} from "../../platform/bridge/cloud-workspace-key";
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
/** One entry per workspace: its worker reports which agents have credentials. */
function registryKey(target: CloudWorkspaceTarget): string {
  return `${cloudWorkspaceKey(target)}#v2`;
}
const registryTarget = (key: string) => parseCloudWorkspaceKey(key.slice(0, key.indexOf("#")));
// Catalog reads or the dormant stream fallback cover resource revisions that
// have no dedicated event. Only active hook subscribers initiate revalidation.
subscribeCloudWorkspaceRefresh(organizations => {
  for (const key of cache.keys()) {
    const target = registryTarget(key);
    if (!organizations || target && organizations.has(target.organizationId)) cache.invalidate(key);
  }
});
export const clearCloudAgentRegistry = () => {
  for (const key of cache.keys()) cache.forget(key);
};
export function invalidateCloudOrganizationAgentRegistry(organizationId: string): void {
  for (const key of cache.keys()) {
    if (registryTarget(key)?.organizationId === organizationId) cache.invalidate(key);
  }
}
export function invalidateCloudAgentRegistry(folder: string): void {
  const target = parseCloudWorkspaceKey(folder);
  if (!target) return;
  const workspace = cloudWorkspaceKey(target);
  for (const key of cache.keys()) if (key.startsWith(`${workspace}#`)) cache.invalidate(key);
}
/** A closed admission denial is authoritative for this workspace/provider.
 * Publish it before returning the draft, then recheck durable discovery (which
 * can also find another MCP-qualified grant). Local registry state is separate. */
export function reportCloudAgentRuntimeUpgrade(folder: string, agentId: string): void {
  const target = parseCloudWorkspaceKey(folder);
  if (!target) return;
  const key = registryKey(target), agents = cache.getSnapshot(key).data;
  if (agents) cache.setData(key, agents.map(agent => agent.id === agentId ? {
    ...agent, runtimeUpgradeRequired: true, authenticated: false, cloudModels: [],
    runtimeUnavailableReason: "This workspace gets the new cloud runtime the next time it wakes",
  } : agent));
  cache.invalidate(key);
  void warmCloudAgentRegistry(cloudWorkspaceKey(target)).catch(() => { /* Retain the confirmed denial until revalidation succeeds. */ });
}
export function workspaceAgentsSnapshot(
  folder?: string | null,
): WorkspaceRegistryAgent[] | null {
  const target = parseCloudWorkspaceKey(folder);
  return target
    ? (cache.getSnapshot(registryKey(target)).data ?? null)
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
  const target = registryTarget(value);
  if (!target) throw new Error("Cloud workspace identity is required");
  // The cwd routes this read to the workspace's own worker.
  const registryRequest = { type: "AGENT_LIST_AGENTS" as const, cwd: cloudWorkspaceKey(target) };
  const response = await bridge.request<AgentAgentsListMessage>(registryRequest, 30_000);
  if (response.type !== "AGENT_AGENTS_LIST" || !Array.isArray(response.agents))
    throw new Error("Cloud agent registry is unavailable");
  // The worker reports each agent's credential state on its own VM, exactly as
  // the Local engine does for this Mac.
  return response.agents;
}
export function warmCloudAgentRegistry(
  folder: string,
): Promise<WorkspaceRegistryAgent[]> {
  const target = parseCloudWorkspaceKey(folder);
  if (!target)
    return Promise.reject(new Error("Cloud workspace identity is required"));
  const key = registryKey(target);
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
  // Follows catalog detail publication too, which changes the authority key.
  const key = useSyncExternalStore(subscribeCloudWorkspaces, () => target ? registryKey(target) : null, () => null);
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

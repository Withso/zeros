import { useSyncExternalStore } from "react";
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
  subscribeCloudWorkspaces,
} from "../../state/cloud-workspace-catalog";
import {
  getAgentsSnapshot,
  hasConfirmedAgents,
  useAgentsSnapshot,
} from "./agents-cache";

const cache = new KeyedAsyncCache<BridgeRegistryAgent[]>(32);
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
export function workspaceAgentsSnapshot(
  folder?: string | null,
): BridgeRegistryAgent[] | null {
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
): Promise<BridgeRegistryAgent[]> {
  const bridge = getActiveBridge();
  if (!bridge) throw new Error("Workspace is disconnected");
  const registryRequest = { type: "AGENT_LIST_AGENTS" as const, cwd: value };
  const [response, delegations] = await Promise.all([
    bridge.request<AgentAgentsListMessage>(registryRequest, 30_000),
    cloudAgentDelegations(parseCloudWorkspaceKey(value)!),
  ]);
  if (response.type !== "AGENT_AGENTS_LIST" || !Array.isArray(response.agents))
    throw new Error("Cloud agent registry is unavailable");
  const qualified = delegations.filter(grant => grant.runtimeQualified !== false);
  return response.agents.filter(agent => !delegations.some(grant => grant.kind.startsWith(`${agent.id}-`)) ||
    qualified.some(grant => grant.kind.startsWith(`${agent.id}-`))).map((agent) => ({
    ...agent,
    authenticated:
      !agent.runtimeUnavailableReason &&
      qualified.some((grant) => grant.kind.startsWith(`${agent.id}-`)),
  }));
}
export function warmCloudAgentRegistry(
  folder: string,
): Promise<BridgeRegistryAgent[]> {
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
): BridgeRegistryAgent[] | null {
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

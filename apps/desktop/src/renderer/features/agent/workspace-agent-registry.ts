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
import {
  cloudAgentBootAvailability,
  cloudAgentDelegations,
  type CloudAgentBootAvailability,
} from "../../platform/cloud-workspaces";
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
/** Confirmed and in-flight discovery belongs to the catalog authority it was
 * read under: agent mode, generation, engine, boot, writer, funding owner and
 * epoch, and binding status. When that changes, the workspace selects a new
 * cache entry at once, so no earlier picker or late reply can carry over. */
function registryKey(target: CloudWorkspaceTarget): string {
  const document = cloudWorkspaceDocument(target), binding = document?.agentCredentials;
  const authority = binding
    ? ["boot", binding.generation, binding.engineInstanceId, binding.bootId, binding.writerEpoch,
        binding.fundingOwnerUserId, binding.fundingOwnerEpoch, binding.status]
    : ["legacy", document?.generation?.number ?? 0];
  return `${cloudWorkspaceKey(target)}#${authority.join(":")}`;
}
const registryTarget = (key: string) => parseCloudWorkspaceKey(key.slice(0, key.indexOf("#")));
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
const UPGRADE_ON_WAKE = "This workspace gets the new cloud runtime the next time it wakes";
/** An activated boot runs only the funding owner's slots, so its picker shows
 * exactly those, never this actor's own grants. */
function bootRegistryAgents(agents: BridgeRegistryAgent[],
  availability: Extract<CloudAgentBootAvailability, { mode: "boot-owner-v1" }>): WorkspaceRegistryAgent[] {
  const unavailable = availability.status === "ready" ? null
    : ["runtime_upgrade_required", "owner_changed", "retired"].includes(availability.status) ? UPGRADE_ON_WAKE
      : availability.status === "funding_unavailable" ? "The workspace owner hasn't shared agent access with you"
        : "Agents can't run on this workspace's compute";
  return agents.map((agent) => {
    const slot = unavailable ? undefined : availability.providers.find(value => value.provider === agent.id);
    const ready = slot?.status === "ready" && Array.isArray(slot.models);
    const runtimeUpgradeRequired = unavailable === UPGRADE_ON_WAKE || slot?.code === "cloud_runtime_upgrade_required";
    const reason = unavailable ?? (slot?.code === "cloud_runtime_upgrade_required" ? UPGRADE_ON_WAKE : null);
    return {
      ...agent,
      runtimeUpgradeRequired,
      cloudModels: ready ? [...new Set(slot.models)] : [],
      ...(reason ? { runtimeUnavailableReason: reason } : {}),
      authenticated: !agent.runtimeUnavailableReason && !reason && ready,
    };
  });
}
async function readCloudAgentRegistry(
  value: string,
): Promise<WorkspaceRegistryAgent[]> {
  const bridge = getActiveBridge();
  if (!bridge) throw new Error("Workspace is disconnected");
  const target = registryTarget(value);
  if (!target) throw new Error("Cloud workspace identity is required");
  // Publish nothing read under an authority the catalog has since replaced.
  const current = () => {
    if (registryKey(target) !== value) throw new Error("Cloud agent availability changed while loading");
  };
  current();
  const registryRequest = { type: "AGENT_LIST_AGENTS" as const, cwd: cloudWorkspaceKey(target) };
  // The passive boot read is bound to the exact activated boot the catalog
  // shows. Legacy workspaces and older servers keep per-actor discovery.
  const discovery = cloudWorkspaceDocument(target)?.agentCredentials
    ? cloudAgentBootAvailability(target).then(availability => ({ availability }))
    : cloudAgentDelegations(target).then(delegations => ({ delegations }));
  const [response, found] = await Promise.all([
    bridge.request<AgentAgentsListMessage>(registryRequest, 30_000),
    discovery,
  ]);
  if (response.type !== "AGENT_AGENTS_LIST" || !Array.isArray(response.agents))
    throw new Error("Cloud agent registry is unavailable");
  current();
  if ("availability" in found && found.availability?.mode === "boot-owner-v1") {
    const { availability } = found, binding = cloudWorkspaceDocument(target)?.agentCredentials;
    if (!binding || (["generation", "bootId", "writerEpoch", "fundingOwnerUserId", "fundingOwnerEpoch"] as const)
      .some(key => binding[key] !== availability.scope[key]))
      throw new Error("Cloud agent availability changed while loading");
    return bootRegistryAgents(response.agents, availability);
  }
  // The server reports legacy mode or predates passive discovery.
  const delegations = "delegations" in found ? found.delegations : await cloudAgentDelegations(target);
  current();
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

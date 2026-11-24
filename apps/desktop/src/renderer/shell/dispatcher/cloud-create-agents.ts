// The agents a cloud create offers: what the organization's cloud can run, i.e. its connected cloud logins. This Mac's
// registry only names and draws them; its own CLI logins say nothing about the cloud. A created workspace lists its own
// agents from its worker (workspace-agent-registry.ts); before it exists, the organization's logins are the truth.
import { useMemo } from "react";
import type { BridgeRegistryAgent } from "../../platform/bridge/messages";
import { cloudOrganizationConnectionsCache, readCloudOrganizationConnections } from "../../features/settings/cloud-provider-connection";
import { settingsOwnerKey } from "../../features/settings/settings-scope";
import { useRecoveringRead } from "../../state/use-recovering-read";

/** The agents a cloud workspace runs, in the order the menu groups them. */
const CLOUD_AGENTS = [["claude", "Claude"], ["codex", "Codex"], ["cursor", "Cursor"]] as const;
type Connection = { provider: string; connected: boolean };

/** Null while the organization's logins are unknown. */
export function cloudCreateAgents(local: readonly BridgeRegistryAgent[] | null, connections: readonly Connection[] | undefined): BridgeRegistryAgent[] | null {
  if (!connections) return null;
  return CLOUD_AGENTS.map(([id, name]) => {
    const entry = local?.find(agent => agent.id === id) ?? { id, name, version: "", description: "", distribution: {} };
    return { ...entry, authenticated: connections.some(connection => connection.provider === id && connection.connected) };
  });
}

/** The organization's cloud logins through Settings' own keyed read, so connecting one there re-lists them here. */
export function useCloudCreateAgents(userId: string | null, organizationId: string | null, active: boolean,
  local: readonly BridgeRegistryAgent[] | null): BridgeRegistryAgent[] | null {
  const key = userId && organizationId ? settingsOwnerKey(userId, organizationId) : null;
  const read = useRecoveringRead(cloudOrganizationConnectionsCache, key,
    () => readCloudOrganizationConnections(organizationId!), { enabled: active, maxAgeMs: 30_000 });
  const connections = read.data?.connections;
  return useMemo(() => cloudCreateAgents(local, connections), [local, connections]);
}

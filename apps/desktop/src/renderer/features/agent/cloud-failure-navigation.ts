import { CloudMcpFailureSchema, type CloudMcpFailure } from "@zeros/protocol/cloud-v2-relay";
import { parseCloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";
import { subscribeActiveTeam } from "../team/active-team";
import { getActiveOrganizationIdSnapshot, getOrganizationStoreGeneration, getTeamStoreState, subscribeOrganizationSnapshots } from "../team/team-store";
import { requestProviderSettings } from "../settings/settings-navigation";

let selection = 0;
interface McpRecovery { id: string; owner: string; folder: string; organizationId: string; serverId: string }
let pending: McpRecovery | null = null;
const listeners = new Set<() => void>();
const publish = () => { for (const listener of listeners) listener(); };
let observing = false;
function observeOwner(): void {
  if (observing) return;
  observing = true;
  // The team/store import graph can still be initializing on a cold mount.
  subscribeActiveTeam(() => { selection++; pending = null; publish(); });
  subscribeOrganizationSnapshots(() => {
    if (pending && pending.owner !== captureCloudFailureOwner(pending.folder)) { pending = null; publish(); }
  });
}

/** A restored owner selection cannot revive an action from its previous visit. */
export function captureCloudFailureOwner(folder: string | null | undefined): string | null {
  observeOwner();
  const target = parseCloudWorkspaceKey(folder), userId = getTeamStoreState().me?.user.id;
  if (!target || !userId || getActiveOrganizationIdSnapshot() !== target.organizationId) return null;
  return JSON.stringify([userId, getOrganizationStoreGeneration(), selection, folder]);
}

export function requestCloudProviderRecovery(folder: string, provider: string, owner: string | null): boolean {
  if (!owner || owner !== captureCloudFailureOwner(folder) || !["claude", "codex", "cursor"].includes(provider)) return false;
  requestProviderSettings(provider);
  return true;
}

export function requestCloudMcpRecovery(folder: string, failure: CloudMcpFailure, owner: string | null): boolean {
  const target = parseCloudWorkspaceKey(folder), parsed = CloudMcpFailureSchema.safeParse(failure);
  if (!target || !parsed.success || !owner || owner !== captureCloudFailureOwner(folder)) return false;
  pending = { id: crypto.randomUUID(), owner, folder, organizationId: target.organizationId, serverId: parsed.data.serverId };
  publish();
  return true;
}

export function cloudMcpRecoverySnapshot(organizationId: string): McpRecovery | null {
  return pending?.organizationId === organizationId && pending.owner === captureCloudFailureOwner(pending.folder) ? pending : null;
}
export function subscribeCloudMcpRecovery(listener: () => void): () => void { observeOwner(); listeners.add(listener); return () => listeners.delete(listener); }
export function consumeCloudMcpRecovery(request: McpRecovery): void { if (pending === request) { pending = null; publish(); } }

import { cloudWorkspaceKey, type CloudWorkspaceTarget } from "./cloud-workspace-key";

/** R1 relay-presence-v1: while a workspace has a live relay connection that the control plane admitted with this
 * feature (POST connect's reply), that connection itself counts as presence for idle stop, so the focused-window
 * ping is not needed. Counted per exact workspace; each connection ends its own share. */
const live = new Map<string, number>();

export function setRelayPresence(target: CloudWorkspaceTarget): () => void {
  const key = cloudWorkspaceKey(target);
  live.set(key, (live.get(key) ?? 0) + 1);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const left = (live.get(key) ?? 1) - 1;
    if (left > 0) live.set(key, left); else live.delete(key);
  };
}

export function relayPresenceActive(target: CloudWorkspaceTarget): boolean {
  return (live.get(cloudWorkspaceKey(target)) ?? 0) > 0;
}

export function resetRelayPresenceForTests(): void { live.clear(); }

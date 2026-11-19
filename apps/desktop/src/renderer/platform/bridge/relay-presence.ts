import { cloudWorkspaceKey, type CloudWorkspaceTarget } from "./cloud-workspace-key";

/** Idle stop counts relay-presence-v1 connections, replacing focus pings until the workspace's last such connection closes. */
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

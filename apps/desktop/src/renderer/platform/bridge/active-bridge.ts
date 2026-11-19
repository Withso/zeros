
import type {
  RuntimeClient,
  RuntimeConnectionTarget,
} from "./ws-client";

import { WorkspaceRuntimeClient } from "./workspace-runtime-client";

// Non-React engine readers share the client installed by BridgeProvider.
let active: RuntimeClient | null = null;
type ActiveBridgeListener = (client: RuntimeClient | null) => void;
const changeListeners = new Set<ActiveBridgeListener>();

export function setActiveBridge(client: RuntimeClient | null): void {
  active = client;
  for (const fn of changeListeners) {
    try {
      fn(client);
    } catch {
      /* a listener shouldn't throw, but keep notifying the rest */
    }
  }
}

export function getActiveBridge(): RuntimeClient | null {
  return active;
}

/** Connection descriptors live only in the client; never persist them or put them in URLs. */
export async function installActiveRuntimeConnectionTarget(
  target: RuntimeConnectionTarget,
): Promise<void> {
  const client = active;
  if (!client) throw new Error("No active runtime bridge is available");
  await client.setConnectionTarget(target);
}

/** Revalidate on a real connection boundary because offline clients may have missed broadcasts. */
export function bridgeConnectionCacheMaxAge(
  initial: boolean,
  ordinaryMaxAgeMs: number,
): number {
  return initial ? ordinaryMaxAgeMs : -1;
}

/** This only reports swaps; read the initial client before subscribing. */
export function onActiveBridgeChange(fn: ActiveBridgeListener): () => void {
  changeListeners.add(fn);
  return () => {
    changeListeners.delete(fn);
  };
}

/** Only a connected-at-subscribe callback is initial; pass a folder to follow that workspace instead of the Local sidecar. */
export function onActiveBridgeConnected(
  fn: (client: RuntimeClient, info: { initial: boolean }) => void,
  folder?: string,
): () => void {
  let stopStatusListener: (() => void) | undefined;
  let subscribing = true;

  const attach = (client: RuntimeClient | null) => {
    stopStatusListener?.();
    stopStatusListener = undefined;
    if (!client) return;

    const workspaceClient =
      folder && client instanceof WorkspaceRuntimeClient ? client : null;
    const status = () => workspaceClient
      ? workspaceClient.statusForWorkspace(folder)
      : client.status;
    let connected = status() === "connected";
    if (connected) fn(client, { initial: subscribing });
    const changed = () => {
      const nextConnected = status() === "connected";
      const becameConnected = nextConnected && !connected;
      connected = nextConnected;
      if (becameConnected) fn(client, { initial: false });
    };
    stopStatusListener = workspaceClient
      ? workspaceClient.onWorkspaceStatusChange(folder!, changed)
      : client.onStatusChange(changed);
  };

  attach(active);
  subscribing = false;
  const stopBridgeListener = onActiveBridgeChange(attach);
  return () => {
    stopStatusListener?.();
    stopBridgeListener();
  };
}

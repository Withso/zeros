// ──────────────────────────────────────────────────────────
// active-bridge — module-level handle to the live RuntimeClient
// ──────────────────────────────────────────────────────────
//
// The RuntimeClient is created once in BridgeProvider (a React context). But
// the renderer's data façades (native/git.ts, native/files.ts, native/pty.ts)
// are plain async functions called from non-React code (stores, helpers), so
// they can't read the context. This singleton is how they reach the client.
// BridgeProvider registers it on mount and clears it on unmount.
//
// Post single-writer migration BOTH builds read this for engine data ops: the
// engine is the sole zeros.db owner, so desktop routes workspace/git/file/pty
// ops over the bridge (a local WS to the engine) too — native IPC is reserved
// for host-only ops (engine-port resolution, gh auth, safeStorage, dialogs).
// BridgeProvider installs the client in its root layout phase, before any
// descendant passive data effect can run. The socket can still be connecting;
// RuntimeClient queues those requests until the engine is ready. Use
// onActiveBridgeConnected when work must run at each connection boundary, or
// onActiveBridgeChange when it only needs the client instance.
// ──────────────────────────────────────────────────────────

import type { RuntimeClient } from "./ws-client";

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

/** Translate a bridge connection callback into a keyed-cache freshness policy.
 * An ordinary subscribe-time fire may reuse a recent snapshot; every real
 * connection boundary forces revalidation because broadcasts may have been
 * missed while the bridge was unavailable. */
export function bridgeConnectionCacheMaxAge(
  initial: boolean,
  ordinaryMaxAgeMs: number,
): number {
  return initial ? ordinaryMaxAgeMs : -1;
}

/** Subscribe to active-bridge swaps. Non-React data hooks use this to reattach
 *  if the provider replaces the client after an engine restart or hot reload.
 *  Does NOT fire immediately — read getActiveBridge() yourself first. */
export function onActiveBridgeChange(fn: ActiveBridgeListener): () => void {
  changeListeners.add(fn);
  return () => {
    changeListeners.delete(fn);
  };
}

/** Run `fn` whenever the active bridge becomes usable, including when a
 *  subscriber mounts after the bridge object was installed but before its
 *  socket finished connecting. Re-attaches across bridge swaps and fires again
 *  after a disconnect/reconnect transition.
 *
 *  `info.initial` is true only for the synchronous fire that happens when the
 *  bridge is ALREADY connected at subscribe time — an ordinary component mount
 *  in a healthy app, where cached data is still trustworthy. Every
 *  asynchronous fire (cold-open connect, engine respawn swap, reconnect after
 *  a drop) reports `initial: false`, because data may have changed while the
 *  bridge was away. Callers that refetch should treat `initial: true` as
 *  "revalidate if stale", not "force" — otherwise every mount becomes a
 *  redundant fetch. */
export function onActiveBridgeConnected(
  fn: (client: RuntimeClient, info: { initial: boolean }) => void,
): () => void {
  let stopStatusListener: (() => void) | undefined;
  let subscribing = true;

  const attach = (client: RuntimeClient | null) => {
    stopStatusListener?.();
    stopStatusListener = undefined;
    if (!client) return;

    let connected = client.status === "connected";
    if (connected) fn(client, { initial: subscribing });
    stopStatusListener = client.onStatusChange((status) => {
      const nextConnected = status === "connected";
      const becameConnected = nextConnected && !connected;
      connected = nextConnected;
      if (becameConnected) fn(client, { initial: false });
    });
  };

  attach(active);
  subscribing = false;
  const stopBridgeListener = onActiveBridgeChange(attach);
  return () => {
    stopStatusListener?.();
    stopBridgeListener();
  };
}

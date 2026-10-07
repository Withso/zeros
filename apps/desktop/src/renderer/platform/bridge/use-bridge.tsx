// ──────────────────────────────────────────────────────────
// React hooks for the Zeros engine connection
// ──────────────────────────────────────────────────────────
//
// Provides:
//   - BridgeProvider       — mounts at root, manages connection lifecycle
//   - useBridge            — access the client instance
//   - useBridgeStatus      — reactive connection status
//   - useExtensionConnected — whether engine is ready
//
// ──────────────────────────────────────────────────────────

import React, {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useCallback,
  useSyncExternalStore,
} from "react";
import { prepareCloudGithubWrite } from "../cloud-github";
import {
  RuntimeClient,
  invalidateEnginePort,
  isRejectionRetryableAfterEngineRestart,
  type ConnectionStatus,
} from "./ws-client";
import { getActiveBridge, setActiveBridge, wireCloudRuntimeRetirement } from "./active-bridge";
import { wireGithubCredentialWriteback } from "./github-token-sync";
import { nativeListen, useNativeRuntime } from "../runtime";
import { WorkspaceRuntimeClient } from "./workspace-runtime-client";
import { openCloudRuntime } from "./open-cloud-runtime";
import { readCloudWorkspaceHistory } from "../cloud-history";
import { canReadCloudWorkspace, cloudCatalogGeneration, cloudWorkspaceCatalogConfirmed, cloudWorkspaceDocument, cloudWorkspaceOperation, cloudWorkspaceStopVersion, getCloudWorkspaceRows, isCloudWorkspaceLifecyclePending } from "../../state/cloud-workspace-catalog";
import { wireWorkbenchConnectionRejection } from "../../state/workbench-availability";

// ── Context ──────────────────────────────────────────────

const BridgeContext = createContext<RuntimeClient | null>(null);

function disposeClientIfEffectWasNotReplayed(
  client: RuntimeClient,
  epochRef: { current: number },
  effectEpoch: number,
): void {
  queueMicrotask(() => {
    if (epochRef.current === effectEpoch) client.dispose();
  });
}

export function BridgeProvider({ children }: { children: React.ReactNode }) {
  // Create the transport before descendants render so their first snapshot is
  // already scoped to the real client. Connection itself remains asynchronous.
  const [client] = useState(
    () =>
      new WorkspaceRuntimeClient({
        open: openCloudRuntime,
        workspaces: () => getCloudWorkspaceRows() as unknown as Record<string, unknown>[],
        workspacesConfirmed: cloudWorkspaceCatalogConfirmed,
        canAccess: target => canReadCloudWorkspace(cloudWorkspaceDocument(target)),
        identity: target => `${cloudCatalogGeneration()}:${cloudWorkspaceDocument(target)?.generation.number ?? "unknown"}`,
        wakeOwner: target => {
          const doc = cloudWorkspaceDocument(target);
          return canReadCloudWorkspace(doc) && doc?.capabilities.canWrite &&
            !["archived", "archiving", "failed", "error"].includes(doc.status)
            ? { account: String(cloudCatalogGeneration()), generation: doc.generation.number, stopVersion: cloudWorkspaceStopVersion(target), lifecyclePending: isCloudWorkspaceLifecyclePending(doc) }
            : undefined;
        },
        manage: cloudWorkspaceOperation,
        readHistory: readCloudWorkspaceHistory,
        checkpointHistory: true,
        prepareGithubWrite: prepareCloudGithubWrite,
      }),
  );
  const nativeRuntime = useNativeRuntime();
  const connectionEffectEpoch = useRef(0);

  // Descendant data reads begin in passive effects. Installing the singleton in
  // the root layout phase closes the old child-effect -> parent-effect gap where
  // Git/settings reads observed `null` and published synthetic empty results.
  useLayoutEffect(() => {
    setActiveBridge(client);
    return () => {
      // A hot replacement may already have installed its successor.
      if (getActiveBridge() === client) setActiveBridge(null);
    };
  }, [client]);

  useEffect(() => {
    const effectEpoch = ++connectionEffectEpoch.current;
    client.connect().catch((err) => {
      console.warn("[Zeros] initial connect failed:", err);
    });

    // Electron main couriers the selected credential over private stdin. The
    // renderer sees only secret-free method-addressed invalidations.
    const offCredentialWriteback = wireGithubCredentialWriteback(client);

    const offConnectionNotice = wireWorkbenchConnectionRejection(client);

    // Watchdog respawn handler: when the Electron sidecar respawns
    // the engine on a NEW port (after detecting unresponsiveness),
    // it fires the `engine-restarted` event. Without this listener,
    // ws-client.ts stayed cached to the OLD port — the renderer
    // kept retrying a now-dead socket and the user saw a permanent
    // "Loading…" spinner on the agent dropdown after a heavy file
    // operation triggered a watchdog respawn. forceReconnect drops
    // the cached port, re-resolves via native IPC, and reconnects
    // to the new engine. The `project-changed` event already uses
    // forceReconnect for in-place project swaps; we reuse the same
    // path for watchdog respawns.
    let offRestart: (() => void) | undefined;
    let offCloudRetired: (() => void) | undefined;
    let restartListenerClosed = false;
    void wireCloudRuntimeRetirement(client).then((off) => {
      if (restartListenerClosed) off();
      else offCloudRetired = off;
    }).catch(() => undefined);
    void nativeListen("engine-restarted", () => {
      console.log("[Zeros] engine restarted by watchdog — reconnecting");
      // A respawn replaces the engine PROCESS, so a rejection latched against
      // the old one may be stale: a stale binary's protocol skew, or an
      // auth-required/desktop-unbound raced against engine startup, can all
      // heal on the fresh process. Clear the latch for those (reconnect: false
      // — forceReconnect below drives the reconnect after re-resolving the
      // port) so a watchdog respawn heals the session without a relaunch.
      // Credential-shaped rejections (auth-invalid / auth-wrong-account) keep
      // the latch: a new process still refuses the same token.
      if (
        isRejectionRetryableAfterEngineRestart(client.lastRejection?.reason)
      ) {
        client.clearRejection({ reconnect: false });
      }
      void client.forceReconnect();
    })
      .then((off) => {
        // nativeListen resolves asynchronously. StrictMode can clean up the first
        // passive-effect pass before that promise settles; immediately release a
        // late registration instead of leaking a duplicate restart listener.
        if (restartListenerClosed) off();
        else offRestart = off;
      })
      .catch((err) => {
        console.warn("[Zeros] engine restart listener failed:", err);
      });

    return () => {
      restartListenerClosed = true;
      if (offRestart) offRestart();
      if (offCloudRetired) offCloudRetired();
      offCredentialWriteback();
      offConnectionNotice();
      // React StrictMode replays passive setup immediately after cleanup. The
      // client is render-owned, so disposing it synchronously would leave that
      // second setup with a permanently dead transport. A real unmount has no
      // successor epoch and disposes in the following microtask.
      disposeClientIfEffectWasNotReplayed(
        client,
        connectionEffectEpoch,
        effectEpoch,
      );
    };
  }, [client]);

  // 2026-05-23: react to a late-arriving native bridge. If the
  // preload bridge wasn't ready when RuntimeClient.connect()
  // first ran, `nativeInvoke("get_engine_port")` was skipped and
  // the client fell back to the DEFAULT_ENGINE_PORT — almost
  // certainly the wrong port for the actual engine. The WS then
  // kept retrying a dead port and the user saw "No workspace
  // selected" / empty workspace listings forever. When the bridge
  // appears we invalidate the cached port and force the client to
  // re-resolve via native IPC and reconnect.
  const lastNativeReadyRef = useRef(nativeRuntime.ready);
  useEffect(() => {
    const prev = lastNativeReadyRef.current;
    lastNativeReadyRef.current = nativeRuntime.ready;
    if (prev || !nativeRuntime.ready) return;
    console.log(
      "[Zeros] native bridge appeared late — forcing engine port re-resolve",
    );
    invalidateEnginePort();
    void client.forceReconnect();
  }, [client, nativeRuntime.ready]);

  return (
    <BridgeContext.Provider value={client}>{children}</BridgeContext.Provider>
  );
}

// ── Hooks ────────────────────────────────────────────────

/** Access the bridge client instance. May be null during initial render. */
export function useBridge(): RuntimeClient | null {
  return useContext(BridgeContext);
}

/** Reactive connection status. */
export function useBridgeStatus(folder?: string | null): ConnectionStatus {
  const bridge = useBridge();
  const read = useCallback(() => bridge instanceof WorkspaceRuntimeClient ? bridge.statusForWorkspace(folder) : bridge?.status ?? "disconnected", [bridge, folder]);
  const subscribe = useCallback((listener: () => void) => {
    if (!bridge) return () => {};
    return bridge instanceof WorkspaceRuntimeClient && folder ? bridge.onWorkspaceStatusChange(folder, listener) : bridge.onStatusChange(listener);
  }, [bridge, folder]);
  return useSyncExternalStore(subscribe, read, read);
}

/** Whether the engine is connected and ready. */
export function useExtensionConnected(): boolean {
  const bridge = useBridge();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!bridge) return;

    const onEngineReady = () => setConnected(true);
    const unsub = bridge.on("ENGINE_READY", onEngineReady);

    // Check current state
    setConnected(bridge.extensionConnected);

    // Also track disconnection via status changes
    const unsubStatus = bridge.onStatusChange((status) => {
      if (status === "disconnected") setConnected(false);
    });

    return () => {
      unsub();
      unsubStatus();
    };
  }, [bridge]);

  return connected;
}

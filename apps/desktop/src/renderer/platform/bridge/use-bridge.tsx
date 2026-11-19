
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
import {
  RuntimeClient,
  invalidateEnginePort,
  isRejectionRetryableAfterEngineRestart,
  type ConnectionStatus,
} from "./ws-client";
import { getActiveBridge, setActiveBridge } from "./active-bridge";
import { wireGithubCredentialWriteback } from "./github-token-sync";
import { nativeListen, useNativeRuntime } from "../runtime";
import { WorkspaceRuntimeClient } from "./workspace-runtime-client";
import { cloudWorkspaceKey } from "./cloud-workspace-key";
import { openCloudV2Runtime } from "./open-cloud-v2-runtime";
import { cloudV2CheckoutPath, readCloudV2History } from "../cloud-v2";
import { keepHistorySenders } from "../chat-senders";
import { canReadCloudWorkspace, cloudCatalogGeneration, cloudWorkspaceCatalogConfirmed, cloudWorkspaceDocument, cloudWorkspaceLifecycleTask, cloudWorkspaceOperation, cloudWorkspaceStopVersion, getCloudWorkspaceRows, isCloudWorkspaceLifecyclePending } from "../../state/cloud-workspace-catalog";
import { getActiveWorkspaceFolder } from "../../state/active-workspace-folder";
import { wireWorkbenchConnectionRejection } from "../../state/workbench-availability";


/** Exported for harnesses that supply their own connected client. */
export const BridgeContext = createContext<RuntimeClient | null>(null);

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
  // Create the real client before descendants render; connection remains asynchronous and early Local requests queue.
  const [client] = useState(
    () =>
      new WorkspaceRuntimeClient({
        open: openCloudV2Runtime,
        workspaces: () => getCloudWorkspaceRows() as unknown as Record<string, unknown>[],
        workspacesConfirmed: cloudWorkspaceCatalogConfirmed,
        canAccess: target => canReadCloudWorkspace(cloudWorkspaceDocument(target)),
        readOnly: target => cloudWorkspaceDocument(target)?.sharing?.readOnly === true,
        liveWork: target => getActiveWorkspaceFolder() === cloudWorkspaceKey(target) ||
          cloudWorkspaceDocument(target)?.status === "busy" || !!cloudWorkspaceLifecycleTask(target, "wake"),
        canReuseForWork: target => {
          const doc = cloudWorkspaceDocument(target);
          return canReadCloudWorkspace(doc) && doc?.capabilities.canWrite === true &&
            (doc.status === "ready" || doc.status === "busy");
        },
        identity: target => `${cloudCatalogGeneration()}:${cloudWorkspaceDocument(target)?.generation.number ?? "unknown"}`,
        wakeOwner: target => {
          const doc = cloudWorkspaceDocument(target);
          return canReadCloudWorkspace(doc) && doc?.capabilities.canWrite &&
            !["archived", "archiving", "failed", "error"].includes(doc.status)
            ? { account: String(cloudCatalogGeneration()), generation: doc.generation.number, stopVersion: cloudWorkspaceStopVersion(target), lifecyclePending: isCloudWorkspaceLifecyclePending(doc) }
            : undefined;
        },
        manage: cloudWorkspaceOperation,
        // Disconnected history reads use the mirror without waking the VM; keep sharing sender metadata.
        readHistory: keepHistorySenders(readCloudV2History),
        historyRoot: target => {
          const doc = cloudWorkspaceDocument(target);
          return doc ? cloudV2CheckoutPath(doc) : undefined;
        },
      }),
  );
  const nativeRuntime = useNativeRuntime();
  const connectionEffectEpoch = useRef(0);

  // Install before descendant passive reads so a missing singleton cannot publish false empty snapshots.
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

    // Main delivers credentials over private stdin; the renderer sees only method-addressed invalidation.
    const offCredentialWriteback = wireGithubCredentialWriteback(client);

    const offConnectionNotice = wireWorkbenchConnectionRejection(client);

    // Watchdog respawn can change the port; reconnect through fresh native resolution.
    let offRestart: (() => void) | undefined;
    let restartListenerClosed = false;
    void nativeListen("engine-restarted", () => {
      console.log("[Zeros] engine restarted by watchdog — reconnecting");
      // Clear process-scoped rejections on respawn, but keep invalid or wrong-account credential rejections latched.
      if (
        isRejectionRetryableAfterEngineRestart(client.lastRejection?.reason)
      ) {
        client.clearRejection({ reconnect: false });
      }
      void client.forceReconnect();
    })
      .then((off) => {
        // StrictMode can clean up before nativeListen resolves; release a late listener immediately.
        if (restartListenerClosed) off();
        else offRestart = off;
      })
      .catch((err) => {
        console.warn("[Zeros] engine restart listener failed:", err);
      });

    return () => {
      restartListenerClosed = true;
      if (offRestart) offRestart();
      offCredentialWriteback();
      offConnectionNotice();
      // Defer disposal to distinguish a real unmount from StrictMode replay of the same render-owned client.
      disposeClientIfEffectWasNotReplayed(
        client,
        connectionEffectEpoch,
        effectEpoch,
      );
    };
  }, [client]);

  // When preload becomes available after the first attempt, discard cached port resolution and reconnect via IPC.
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


export function useBridge(): RuntimeClient | null {
  return useContext(BridgeContext);
}

export function useBridgeStatus(folder?: string | null): ConnectionStatus {
  const bridge = useBridge();
  const read = useCallback(() => bridge instanceof WorkspaceRuntimeClient ? bridge.statusForWorkspace(folder) : bridge?.status ?? "disconnected", [bridge, folder]);
  const subscribe = useCallback((listener: () => void) => {
    if (!bridge) return () => {};
    return bridge instanceof WorkspaceRuntimeClient && folder ? bridge.onWorkspaceStatusChange(folder, listener) : bridge.onStatusChange(listener);
  }, [bridge, folder]);
  return useSyncExternalStore(subscribe, read, read);
}

export function useExtensionConnected(): boolean {
  const bridge = useBridge();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!bridge) return;

    const onEngineReady = () => setConnected(true);
    const unsub = bridge.on("ENGINE_READY", onEngineReady);

    setConnected(bridge.extensionConnected);

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

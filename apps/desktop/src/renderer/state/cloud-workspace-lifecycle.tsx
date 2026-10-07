import { clearCloudComputersV2 } from "../features/settings/cloud-computer-v2-client";
import { cloudServiceAccessCache, cloudServiceContextCache } from "./read-caches";
import { clearCloudGithub } from "../platform/cloud-github";
import { useEffect } from "react";
import { isLocalDevelopment, isElectron, nativeInvoke, nativeListen } from "../platform/runtime";
import { cloudWorkspaceCapability } from "../platform/cloud-workspace-access";
import { getActiveBridge, onActiveBridgeChange } from "../platform/bridge/active-bridge";
import { WorkspaceRuntimeClient } from "../platform/bridge/workspace-runtime-client";
import { wireCloudTranscriptCheckpoints } from "../platform/bridge/cloud-transcript-checkpoints";
import { cloudWorkspaceKey, parseCloudWorkspaceKey } from "../platform/bridge/cloud-workspace-key";
import { hasCloudWorkspaceAccountAccess, useCloudWorkspaceAccountAccess } from "../features/team/cloud-workspace-account-access";
import { subscribeCloudWorkspaceOpens } from "./cloud-workspace-open-intent";
import {
  getSession,
  onAuthStateChange,
  type AuthSessionInfo,
} from "../features/auth/auth-store";
import {
  clearCloudWorkspaceCatalog,
  canReadCloudWorkspace,
  cloudCatalogNeedsFastRefresh,
  cloudCatalogGeneration,
  cloudWorkspaceDocument,
  cloudWorkspaceStopVersion,
  refreshCloudWorkspaceCatalog,
  subscribeCloudWorkspaces,
  subscribeCloudWorkspaceRows,
  subscribeCloudWorkspaceRefresh,
} from "./cloud-workspace-catalog";
import { notifyProjectsChanged, notifyWorkspacesChanged, pruneCloudWorkspaceCollections } from "./use-projects";
import {
  clearWorkspaceSettling,
  usePendingWorkspacesStore,
} from "./pending-workspaces";
import {
  finishCloudDesignCreation,
  pendingCloudDesignCreations,
  setCloudCreationModeOwner,
} from "./cloud-creation-mode";
import { workspaceSetMode } from "../platform/git";
import { selectActiveFolder, useWorkspaceStore } from "./store";
import { completeCloudChatCacheRestore, loadCloudChatCache, persistWorkspaceChatCache, setCloudChatCacheOwner } from "./cloud-chat-cache";
import { CHATS_STORAGE_KEY } from "./chats-local-cache";
import { useSessionsStore } from "../features/agent/sessions-store";
import { clearCloudAgentRegistry } from "../features/agent/workspace-agent-registry";
import { setCloudTranscriptCacheOwner, readCachedCloudTranscriptWindow, forgetRemovedCloudTranscriptWorkspaces, retainAuthorizedCloudTranscriptWorkspaces } from "../platform/cloud-transcript-cache";
import { clearCloudProviderConnections } from "../features/settings/cloud-provider-connection";
import { toast } from "../shared/ui/primitives/elements";
import { warmCloudWorkspaceDestination } from "./cloud-workspace-warmup";
import { clearCloudLatencySpans, pruneCloudLatencySpans } from "./cloud-workspace-latency";
import { clearWorkbenchConnectionFailure, recordWorkbenchConnectionFailure } from "./workbench-availability";
import { CloudWorkspaceInteraction } from "./cloud-workspace-interaction";

function recordCloudOpenFailure(key: string, error: unknown): void {
  const target = parseCloudWorkspaceKey(key), doc = target ? cloudWorkspaceDocument(target) : undefined;
  // Drain/create/setup remain calm server-owned progress, including when the
  // client's fifteen-minute safety wait ends. The shared model owns that copy.
  if (doc && !doc.error && ["stopping", "waking", "provisioning", "setting_up"].includes(doc.status)) return;
  recordWorkbenchConnectionFailure(key, error, "open");
}

/** Account/catalog lifecycle, mounted once beside the existing persistence
 * controller. It never replaces the conversation or workbench renderers. */
export function CloudWorkspaceLifecycle() {
  const folder = useWorkspaceStore(selectActiveFolder);
  const cloudComputerV2 = useCloudWorkspaceAccountAccess();
  useEffect(() => {
    if (isLocalDevelopment() || !isElectron()) return;
    let stop: (() => void) | undefined;
    const install = (bridge: ReturnType<typeof getActiveBridge>) => {
      stop?.();
      stop = bridge instanceof WorkspaceRuntimeClient
        ? wireCloudTranscriptCheckpoints(bridge, useWorkspaceStore) : undefined;
    };
    install(getActiveBridge());
    const offBridge = onActiveBridgeChange(install);
    return () => { offBridge(); stop?.(); };
  }, []);
  useEffect(() => {
    if (isLocalDevelopment()) return;
    let alive = true;
    let enabled = false;
    let lastRefresh = 0;
    let account: string | null = null;
    let authVersion = 0;
    let installed = false;
    let restored = false;
    let cached = loadCloudChatCache();
    const pruneChats = (all: boolean) => {
      const state = useWorkspaceStore.getState();
      const activeFolder = selectActiveFolder(state);
      const candidates = new Set(state.chats.map(chat => chat.folder));
      if (activeFolder) candidates.add(activeFolder);
      const folders = [...candidates].filter((folder) => {
        const target = parseCloudWorkspaceKey(folder);
        return (
          target && (all || !canReadCloudWorkspace(cloudWorkspaceDocument(target)))
        );
      });
      if (!folders.length) return;
      const removed = state.chats.filter(chat => folders.includes(chat.folder));
      for (const chat of removed)
        useSessionsStore.getState().removeSession(chat.id);
      state.dispatch({
        type: "PRUNE_CLOUD_WORKSPACES",
        folders,
      });
    };
    const refresh = () => {
      if (
        !alive ||
        !enabled ||
        !account ||
        document.visibilityState === "hidden"
      )
        return;
      const pending = cloudCatalogNeedsFastRefresh();
      if (Date.now() - lastRefresh < (pending ? 2_000 : 30_000)) return;
      lastRefresh = Date.now();
      const version = authVersion;
      void refreshCloudWorkspaceCatalog()
        .then(async () => {
          if (!alive || version !== authVersion) return;
          retainAuthorizedCloudTranscriptWorkspaces();
          const bridge = getActiveBridge();
          if (bridge instanceof WorkspaceRuntimeClient)
            bridge.pruneCloudConnections();
          pruneChats(false);
          if (restored) return;
          restored = true;
          const authorized = cached.filter((row) => {
            const target = parseCloudWorkspaceKey(row.folder);
            return target && canReadCloudWorkspace(cloudWorkspaceDocument(target));
          });
          // Prime the saved destination before releasing its chat metadata.
          // Initial hydration then paints the window in the same microtask.
          const activeChatId = useWorkspaceStore.getState().activeChatId;
          if (activeChatId && authorized.some(chat => chat.id === activeChatId)) await readCachedCloudTranscriptWindow(activeChatId);
          if (!alive || version !== authVersion) return;
          if (authorized.length)
            useWorkspaceStore
              .getState()
              .dispatch({ type: "MERGE_CHATS", chats: authorized });
          completeCloudChatCacheRestore(account!);
          persistWorkspaceChatCache(CHATS_STORAGE_KEY, useWorkspaceStore.getState().chats);
          cached = [];
        })
        .catch(() => {});
    };
    const offCatalog = subscribeCloudWorkspaceRows((change) => {
      pruneCloudLatencySpans();
      forgetRemovedCloudTranscriptWorkspaces(change.removedWorkspaceIds);
      const bridge = getActiveBridge();
      if (bridge instanceof WorkspaceRuntimeClient) bridge.pruneCloudConnections();
      if (change.removedWorkspaceIds.length) pruneCloudWorkspaceCollections(change.removedWorkspaceIds);
      if (change.projectsChanged) notifyProjectsChanged();
      for (const slug of change.repoSlugs)
        notifyWorkspacesChanged(slug, change.workspaceIds);
    });
    const clear = (preservePendingTarget = false) => {
      clearCloudLatencySpans();
      setCloudTranscriptCacheOwner(null);
      setCloudChatCacheOwner(null);
      setCloudCreationModeOwner(null);
      if (preservePendingTarget) {
        const state = useWorkspaceStore.getState();
        for (const chat of state.chats) {
          if (parseCloudWorkspaceKey(chat.folder)) useSessionsStore.getState().removeSession(chat.id);
        }
        state.dispatch({ type: "REVALIDATE_CLOUD_CHATS" });
      } else {
        pruneChats(true);
      }
      const bridge = getActiveBridge();
      if (bridge instanceof WorkspaceRuntimeClient)
        bridge.clearCloudConnections();
      clearCloudWorkspaceCatalog();
      clearCloudAgentRegistry();
      clearCloudProviderConnections();
      clearCloudGithub();
      clearCloudComputersV2();
      cloudServiceAccessCache.clear();
      cloudServiceContextCache.clear();
    };
    const install = (session: AuthSessionInfo | null) => {
      if (!alive) return;
      const next = session?.user.accountId ?? session?.user.sub ?? null;
      if (installed && next === account) return;
      // The first authenticated snapshot validates the saved identity below.
      // Account changes/sign-out discard it; initial auth must not discard it
      // just because no cloud chat has been released into the store yet.
      clear(!installed && next !== null);
      installed = true;
      account = next;
      lastRefresh = 0;
      restored = false;
      setCloudChatCacheOwner(next);
      setCloudTranscriptCacheOwner(next);
      cached = loadCloudChatCache();
      refresh();
      setCloudCreationModeOwner(next);
    };
    const offAuth = onAuthStateChange((session) => {
      authVersion++;
      install(session);
    });
    const visibility = () => {
      if (document.visibilityState === "hidden") {
        const bridge = getActiveBridge();
        if (bridge instanceof WorkspaceRuntimeClient) bridge.cancelSpeculativeWarmups();
        clearCloudLatencySpans();
      } else refresh();
    };
    const initialVersion = authVersion;
    void getSession()
      .then((session) => {
        if (initialVersion === authVersion) install(session);
      })
      .catch(() => {});
    void cloudWorkspaceCapability()
      .then((capability) => {
        if (!alive) return;
        enabled = capability.enabled;
        refresh();
      })
      .catch(() => {});
    const timer = window.setInterval(refresh, 2_000);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("focus", refresh);
    return () => {
      alive = false;
      offCatalog();
      offAuth();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("focus", refresh);
      setCloudChatCacheOwner(null);
      setCloudTranscriptCacheOwner(null);
      setCloudCreationModeOwner(null);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const flights = new Set<string>();
    const completeModes = () => {
      const bridge = getActiveBridge();
      if (!(bridge instanceof WorkspaceRuntimeClient)) return;
      for (const [key, token] of pendingCloudDesignCreations()) {
        const target = parseCloudWorkspaceKey(key)!;
        const doc = cloudWorkspaceDocument(target);
        if (flights.has(key) || !doc || !["ready", "busy"].includes(doc.status))
          continue;
        flights.add(key);
        void bridge
          .warmWorkspace(target)
          .then(() => {
            if (
              !alive ||
              !pendingCloudDesignCreations().some(
                ([folder, intent]) => folder === key && intent === token,
              )
            )
              throw new Error("Cloud creation owner changed");
            return workspaceSetMode({ workspaceId: key, mode: "design" });
          })
          .then(() => {
            if (alive) {
              finishCloudDesignCreation(key, token);
              notifyWorkspacesChanged("*");
            }
          })
          .catch((error) => {
            if (!alive) return;
            finishCloudDesignCreation(key, token);
            toast.error("Couldn't open Design in the cloud workspace", {
              description:
                error instanceof Error
                  ? error.message
                  : "Use the workspace mode switch to try again.",
            });
          })
          .finally(() => {
            flights.delete(key);
          });
      }
    };
    completeModes();
    const offCatalog = subscribeCloudWorkspaces(completeModes);
    const offPending = usePendingWorkspacesStore.subscribe(completeModes);
    return () => {
      alive = false;
      offCatalog();
      offPending();
    };
  }, []);

  useEffect(() => {
    const target = parseCloudWorkspaceKey(folder);
    if (!target) return;
    const bridge = getActiveBridge();
    if (!(bridge instanceof WorkspaceRuntimeClient)) return;
    let cancelled = false;
    let attaching: string | undefined;
    const identity = () => `${cloudCatalogGeneration()}:${cloudWorkspaceDocument(target)?.generation.number}`;
    const attach = () => {
      if (document.visibilityState === "hidden") {
        bridge.cancelSpeculativeWarmups();
        return;
      }
      const doc = cloudWorkspaceDocument(target);
      bridge.pruneCloudConnections();
      const key = identity();
      if (attaching === key || !canReadCloudWorkspace(doc)) return;
      attaching = key;
      void warmCloudWorkspaceDestination(folder!)
        .then(() => {
          if (!cancelled && identity() === key && folder) {
            clearWorkspaceSettling(folder);
            clearWorkbenchConnectionFailure(folder);
          }
        })
        .catch((error) => {
          if (
            !cancelled && identity() === key && doc && ["ready", "busy"].includes(doc.status)
          )
            recordWorkbenchConnectionFailure(folder!, error, "connect");
        })
        .finally(() => {
          if (attaching === key) attaching = undefined;
        });
    };
    attach();
    const off = subscribeCloudWorkspaces(attach);
    const offRefresh = subscribeCloudWorkspaceRefresh(() => {
      if (cancelled || document.visibilityState === "hidden" ||
          !canReadCloudWorkspace(cloudWorkspaceDocument(target))) return;
      // History has its own revision and remains readable while the VM is
      // stopped. Catalog polling must never acquire runtime admission here.
      void bridge.warmHistoryWorkspace(target).catch(() => {});
    });
    document.addEventListener("visibilitychange", attach);
    return () => {
      cancelled = true;
      off();
      offRefresh();
      document.removeEventListener("visibilitychange", attach);
    };
  }, [folder]);

  useEffect(() => {
    if (!cloudComputerV2) return;
    let pending: { key: string; controller: AbortController } | undefined;
    const cancel = () => { pending?.controller.abort(); pending = undefined; };
    const ownsView = (key: string) => {
      const state = useWorkspaceStore.getState();
      return document.visibilityState !== "hidden" && state.activePage === "workspace" && selectActiveFolder(state) === key;
    };
    const off = subscribeCloudWorkspaceOpens(target => {
      const key = cloudWorkspaceKey(target);
      if (!ownsView(key) || pending?.key === key || !hasCloudWorkspaceAccountAccess(target.organizationId) ||
          !cloudWorkspaceDocument(target)?.capabilities.canWrite) return;
      const bridge = getActiveBridge();
      if (!(bridge instanceof WorkspaceRuntimeClient)) return;
      cancel();
      const intent = { key, controller: new AbortController() };
      pending = intent;
      void bridge.openWorkspace(target, { signal: intent.controller.signal })
        .then(() => {
          if (!intent.controller.signal.aborted && ownsView(key)) clearWorkbenchConnectionFailure(key);
        })
        .catch((error) => {
          if (!intent.controller.signal.aborted && ownsView(key))
            recordCloudOpenFailure(key, error);
        })
        .finally(() => { if (pending === intent) pending = undefined; });
    });
    const changed = () => { if (pending && !ownsView(pending.key)) cancel(); };
    const offSelection = useWorkspaceStore.subscribe(changed);
    document.addEventListener("visibilitychange", changed);
    return () => {
      cancel();
      off();
      offSelection();
      document.removeEventListener("visibilitychange", changed);
    };
  }, [cloudComputerV2]);
  useEffect(() => {
    if (!cloudComputerV2) return;
    let available = !isElectron(), closed = false, nativeVersion = 0, nativeQueried = false;
    const current = () => {
      const state = useWorkspaceStore.getState(), key = selectActiveFolder(state);
      const target = parseCloudWorkspaceKey(key);
      const document = target ? cloudWorkspaceDocument(target) : undefined;
      // Settings and other app actions can use the selected workspace too.
      // Selection is the owner; retained surfaces and hover cannot change it.
      return target && hasCloudWorkspaceAccountAccess(target.organizationId) && document && canReadCloudWorkspace(document) ? {
        key: cloudWorkspaceKey(target), document, stopVersion: cloudWorkspaceStopVersion(target),
      } : null;
    };
    const controller = new CloudWorkspaceInteraction({
      current, visible: () => document.visibilityState === "visible", focused: () => document.hasFocus(), available: () => available,
      presence: (key, present) => {
        const target = parseCloudWorkspaceKey(key), bridge = getActiveBridge();
        return !!target && bridge instanceof WorkspaceRuntimeClient && bridge.sendWorkspacePresence(target, present);
      },
      wake: async (key, signal) => {
        const target = parseCloudWorkspaceKey(key), bridge = getActiveBridge();
        if (!target || !(bridge instanceof WorkspaceRuntimeClient)) return;
        await bridge.openWorkspace(target, { signal, reason: "interaction" });
        if (!signal.aborted && current()?.key === key) clearWorkbenchConnectionFailure(key);
      },
      failed: recordCloudOpenFailure,
    });
    const input = (event: Event) => {
      if (!event.isTrusted) return;
      const element = event.target instanceof Element ? event.target : null;
      // Another sidebar row owns its explicit open. Its capture must not wake
      // the previous selection; actions on this workspace's own row still do.
      const row = element?.closest('[data-workspace-tab="true"]');
      const selected = parseCloudWorkspaceKey(current()?.key);
      controller.interact(!!row && (!selected || row.getAttribute("data-workspace-id") !== cloudWorkspaceKey(selected)));
    };
    let offStatus = () => {}, statusKey: string | undefined, statusBridge: WorkspaceRuntimeClient | undefined;
    const refresh = () => {
      const key = current()?.key, bridge = getActiveBridge();
      // Native presence is only consumed for a selected cloud workspace. Local
      // navigation and typing retain their existing IPC and dispatch paths.
      if (key && isElectron() && !nativeQueried) {
        nativeQueried = true;
        const version = nativeVersion;
        void nativeInvoke<{ available: boolean }>("app_user_presence").then(value => {
          if (!closed && version === nativeVersion) { available = value.available === true; refresh(); }
        }).catch(() => {});
      }
      const runtime = bridge instanceof WorkspaceRuntimeClient ? bridge : undefined;
      if (key !== statusKey || runtime !== statusBridge) {
        offStatus(); statusKey = key; statusBridge = runtime;
        offStatus = key && runtime ? runtime.onWorkspaceStatusChange(key, () => controller.reconnect()) : () => {};
      }
      controller.refresh();
    };
    const offSelection = useWorkspaceStore.subscribe(refresh);
    const offCatalog = subscribeCloudWorkspaces(refresh);
    const offBridge = onActiveBridgeChange(refresh);
    refresh();
    const offNative = nativeListen<{ available: boolean }>("desktop-user-presence", value => {
      nativeVersion++; available = value.available === true; refresh();
    });
    // Programmatic focus and scroll can be trusted DOM events too. A focus
    // reached by click/Tab is already covered by pointerdown/keydown.
    const events = ["keydown", "pointerdown", "wheel", "input"];
    for (const event of events) window.addEventListener(event, input, { capture: true, passive: true });
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh); window.addEventListener("blur", refresh);
    const timer = window.setInterval(refresh, 15_000);
    return () => {
      closed = true; controller.close(); offSelection(); offCatalog(); offBridge(); offStatus(); void offNative.then(off => off());
      window.clearInterval(timer);
      for (const event of events) window.removeEventListener(event, input, true);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh); window.removeEventListener("blur", refresh);
    };
  }, [cloudComputerV2]);
  return null;
}

import { useEffect } from "react";
import { cloudWorkspaceCapability } from "../platform/cloud-workspace-access";
import { getActiveBridge } from "../platform/bridge/active-bridge";
import { WorkspaceRuntimeClient } from "../platform/bridge/workspace-runtime-client";
import { parseCloudWorkspaceKey } from "../platform/bridge/cloud-workspace-key";
import {
  getSession,
  onAuthStateChange,
  type AuthSessionInfo,
} from "../features/auth/auth-store";
import {
  clearCloudWorkspaceCatalog,
  cloudWorkspaceDocument,
  getCloudWorkspaceRows,
  refreshCloudWorkspaceCatalog,
  subscribeCloudWorkspaces,
} from "./cloud-workspace-catalog";
import { notifyProjectsChanged, notifyWorkspacesChanged } from "./use-projects";
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
import { loadCloudChatCache, setCloudChatCacheOwner } from "./cloud-chat-cache";
import { useSessionsStore } from "../features/agent/sessions-store";
import { clearCloudAgentRegistry } from "../features/agent/workspace-agent-registry";
import { clearCloudProviderConnections } from "../features/settings/cloud-provider-connection";
import { toast } from "../shared/ui/primitives/elements";

/** Account/catalog lifecycle, mounted once beside the existing persistence
 * controller. It never replaces the conversation or workbench renderers. */
export function CloudWorkspaceLifecycle() {
  const folder = useWorkspaceStore(selectActiveFolder);
  useEffect(() => {
    let alive = true;
    let enabled = false;
    let lastRefresh = 0;
    let account: string | null = null;
    let authVersion = 0;
    let restored = false;
    let cached = loadCloudChatCache();
    const pruneChats = (all: boolean) => {
      const state = useWorkspaceStore.getState();
      const removed = state.chats.filter((chat) => {
        const target = parseCloudWorkspaceKey(chat.folder);
        return (
          target && (all || cloudWorkspaceDocument(target)?.deletedAt !== null)
        );
      });
      if (!removed.length) return;
      for (const chat of removed)
        useSessionsStore.getState().removeSession(chat.id);
      const ids = new Set(removed.map((chat) => chat.id));
      const activeRemoved = state.activeChatId && ids.has(state.activeChatId);
      for (const folder of new Set(removed.map((chat) => chat.folder)))
        state.dispatch({
          type: "REMOVE_WORKSPACE_UI_STATE",
          folder,
          repoRoot: folder,
        });
      state.dispatch({
        type: "HYDRATE_CHATS",
        chats: state.chats.filter((chat) => !ids.has(chat.id)),
        activeChatId: activeRemoved ? null : state.activeChatId,
      });
      if (activeRemoved)
        state.dispatch({ type: "SET_ACTIVE_PAGE", page: "dashboard" });
    };
    const refresh = () => {
      if (
        !alive ||
        !enabled ||
        !account ||
        document.visibilityState === "hidden"
      )
        return;
      const pending = getCloudWorkspaceRows().some(
        (row) => row.setupState === "running",
      );
      if (Date.now() - lastRefresh < (pending ? 2_000 : 30_000)) return;
      lastRefresh = Date.now();
      const version = authVersion;
      void refreshCloudWorkspaceCatalog()
        .then(() => {
          if (!alive || version !== authVersion) return;
          const bridge = getActiveBridge();
          if (bridge instanceof WorkspaceRuntimeClient)
            bridge.pruneCloudConnections();
          pruneChats(false);
          if (restored) return;
          restored = true;
          const authorized = cached.filter((row) => {
            const target = parseCloudWorkspaceKey(row.folder);
            return target && cloudWorkspaceDocument(target)?.deletedAt === null;
          });
          if (authorized.length)
            useWorkspaceStore
              .getState()
              .dispatch({ type: "MERGE_CHATS", chats: authorized });
          cached = [];
        })
        .catch(() => {});
    };
    const offCatalog = subscribeCloudWorkspaces(() => {
      notifyProjectsChanged();
      notifyWorkspacesChanged("*");
    });
    const clear = () => {
      setCloudChatCacheOwner(null);
      setCloudCreationModeOwner(null);
      const bridge = getActiveBridge();
      if (bridge instanceof WorkspaceRuntimeClient)
        bridge.clearCloudConnections();
      clearCloudWorkspaceCatalog();
      clearCloudAgentRegistry();
      clearCloudProviderConnections();
      pruneChats(true);
    };
    const install = (session: AuthSessionInfo | null) => {
      if (!alive) return;
      const next = session?.user.accountId ?? session?.user.sub ?? null;
      if (next === account) return;
      clear();
      account = next;
      lastRefresh = 0;
      restored = false;
      setCloudChatCacheOwner(next);
      cached = loadCloudChatCache();
      refresh();
      setCloudCreationModeOwner(next);
    };
    const offAuth = onAuthStateChange((session) => {
      authVersion++;
      install(session);
    });
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
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      alive = false;
      offCatalog();
      offAuth();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
      setCloudChatCacheOwner(null);
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
    let attaching = false;
    const attach = () => {
      const doc = cloudWorkspaceDocument(target);
      if (attaching || !doc || !["ready", "busy"].includes(doc.status)) return;
      attaching = true;
      void bridge
        .warmWorkspace(target)
        .then(() => {
          if (!cancelled && folder) clearWorkspaceSettling(folder);
        })
        .catch((error) => {
          if (!cancelled)
            toast.error("Couldn't connect to this cloud workspace", {
              id: `cloud-connect:${folder}`,
              description:
                error instanceof Error
                  ? error.message
                  : "Try opening the workspace again.",
            });
        })
        .finally(() => {
          attaching = false;
        });
    };
    attach();
    const off = subscribeCloudWorkspaces(attach);
    return () => {
      cancelled = true;
      off();
    };
  }, [folder]);
  return null;
}

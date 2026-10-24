import { useEffect } from "react";
import { isFeatureEnabled } from "../config/release-channel";
import { isLocalDevelopment } from "../platform/runtime";
import { cloudWorkspaceCapability } from "../platform/cloud-capability";
import { getActiveBridge } from "../platform/bridge/active-bridge";
import { WorkspaceRuntimeClient } from "../platform/bridge/workspace-runtime-client";
import { cloudWorkspaceKey, parseCloudWorkspaceKey } from "../platform/bridge/cloud-workspace-key";
import { hasCloudWorkspaceAccountAccess } from "../features/team/cloud-workspace-account-access";
import { subscribeCloudWorkspaceOpens } from "./cloud-workspace-open-intent";
import { getSession, getStoredAuthUser, onAuthStateChange, onStoredIdentityChange, type AuthSessionInfo } from "../features/auth/auth-store";
import { getTeamStoreState, subscribeOrganizationSnapshots } from "../features/team/team-store";
import {
  cloudWorkspaceCatalogConfirmed,
  canReadCloudWorkspace,
  cloudCatalogNeedsFastRefresh,
  cloudWorkspaceDocument,
  refreshCloudWorkspaceCatalog,
  subscribeCloudWorkspaces,
  subscribeCloudWorkspaceRows,
} from "./cloud-workspace-catalog";
import { notifyProjectsChanged, notifyWorkspacesChanged, pruneCloudWorkspaceCollections } from "./use-projects";
import { clearWorkspaceSettling } from "./pending-workspaces";
import { selectActiveFolder, useWorkspaceStore } from "./store";
import { useSessionsStore } from "../features/agent/sessions-store";
import { warmCloudWorkspaceDestination } from "./cloud-workspace-warmup";
import { clearWorkbenchConnectionFailure, recordWorkbenchConnectionFailure } from "./workbench-availability";

function recordCloudOpenFailure(key: string, error: unknown): void {
  const target = parseCloudWorkspaceKey(key), doc = target ? cloudWorkspaceDocument(target) : undefined;
  // Starting, stopping and creating are calm server-owned progress.
  if (doc && !doc.error && ["stopping", "waking", "provisioning"].includes(doc.status)) return;
  recordWorkbenchConnectionFailure(key, error, "open");
}

function runtime(): WorkspaceRuntimeClient | null {
  const bridge = getActiveBridge();
  return bridge instanceof WorkspaceRuntimeClient ? bridge : null;
}

/** Account and catalog lifecycle for cloud workspaces, mounted once beside the
 * persistence controller. The conversation and workbench renderers are the
 * Local ones; this only keeps the catalog current and opens what is selected. */
export function CloudWorkspaceLifecycle() {
  return isFeatureEnabled("cloud-workspaces") ? <ActiveCloudWorkspaceLifecycle /> : null;
}

function ActiveCloudWorkspaceLifecycle() {
  const folder = useWorkspaceStore(selectActiveFolder);

  useEffect(() => {
    if (isLocalDevelopment()) return;
    let alive = true, enabled = false;
    const storedAccount = () => getStoredAuthUser()?.accountId ?? getStoredAuthUser()?.sub ?? null;
    let account = storedAccount();
    let authVersion = 0, lastRefresh: number | undefined, refreshing = false;
    let timer: number | undefined;
    const pruneChats = (confirmedRemovals: readonly string[] = []) => {
      const state = useWorkspaceStore.getState();
      const removed = new Set(confirmedRemovals);
      const candidates = new Set([
        ...state.chats.map(chat => chat.folder), ...confirmedRemovals,
        ...Object.keys(state.activeChatByFolder), ...Object.keys(state.workbenchByScope),
        ...Object.keys(state.workspaceActivityByFolder), ...Object.values(state.lastWorkspaceByRepoRoot),
      ]);
      const active = selectActiveFolder(state);
      if (active) candidates.add(active);
      const folders = [...candidates].filter(value => {
        const target = parseCloudWorkspaceKey(value);
        if (!target) return false;
        const doc = cloudWorkspaceDocument(target);
        return removed.has(value) || (doc ? !canReadCloudWorkspace(doc) : cloudWorkspaceCatalogConfirmed());
      });
      if (!folders.length) return;
      for (const chat of state.chats) if (folders.includes(chat.folder)) useSessionsStore.getState().removeSession(chat.id);
      state.dispatch({ type: "PRUNE_CLOUD_WORKSPACES", folders });
    };
    const canRefresh = () => alive && enabled && !!account && !!getTeamStoreState().me && document.visibilityState !== "hidden";
    // Transitional workspaces (creating, starting, stopping) poll quickly.
    const schedule = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
      if (!canRefresh() || refreshing) return;
      const delay = lastRefresh === undefined ? 0
        : Math.max(0, lastRefresh + (cloudCatalogNeedsFastRefresh() ? 2_000 : 30_000) - performance.now());
      timer = window.setTimeout(refresh, Math.ceil(delay));
    };
    const refresh = () => {
      if (!canRefresh() || refreshing) return;
      lastRefresh = performance.now();
      refreshing = true;
      const version = authVersion;
      void refreshCloudWorkspaceCatalog().then(() => {
        if (!alive || version !== authVersion) return;
        runtime()?.pruneCloudConnections();
        pruneChats();
      }).catch(() => {}).finally(() => { refreshing = false; schedule(); });
    };
    const offSchedule = subscribeCloudWorkspaces(schedule);
    const offRows = subscribeCloudWorkspaceRows(change => {
      runtime()?.pruneCloudConnections();
      if (change.removedWorkspaceIds.length) {
        pruneCloudWorkspaceCollections(change.removedWorkspaceIds);
        pruneChats(change.removedWorkspaceIds);
      }
      if (change.projectsChanged) notifyProjectsChanged();
      for (const slug of change.repoSlugs) notifyWorkspacesChanged(slug, change.workspaceIds);
    });
    const install = (session: AuthSessionInfo | null) => {
      if (!alive) return;
      account = session?.user.accountId ?? session?.user.sub ?? storedAccount();
      lastRefresh = undefined;
      refresh();
      schedule();
    };
    const offAuth = onAuthStateChange(session => { authVersion++; install(session); });
    const offIdentity = onStoredIdentityChange(() => { authVersion++; install(null); });
    let memberships = getTeamStoreState().me;
    const offOrganizations = subscribeOrganizationSnapshots(() => {
      const next = getTeamStoreState().me;
      if (next === memberships) return;
      memberships = next;
      lastRefresh = undefined;
      refresh();
      schedule();
    });
    const visibility = () => {
      if (document.visibilityState === "hidden") runtime()?.cancelSpeculativeWarmups();
      refresh();
    };
    const initial = authVersion;
    void getSession().then(session => { if (initial === authVersion) install(session); }).catch(() => {});
    void cloudWorkspaceCapability().then(capability => {
      if (!alive) return;
      enabled = capability.enabled;
      refresh();
    }).catch(() => {});
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("focus", refresh);
    return () => {
      alive = false;
      if (timer !== undefined) window.clearTimeout(timer);
      offSchedule(); offRows(); offAuth(); offIdentity(); offOrganizations();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("focus", refresh);
    };
  }, []);

  // Keep the selected workspace attached. A stopped VM is not woken by this:
  // history comes from the control plane until the user opens it.
  useEffect(() => {
    const target = parseCloudWorkspaceKey(folder);
    const bridge = runtime();
    if (!target || !bridge || !folder) return;
    let cancelled = false, attaching = false;
    const attach = () => {
      if (cancelled || attaching || document.visibilityState === "hidden") return;
      const doc = cloudWorkspaceDocument(target);
      if (!canReadCloudWorkspace(doc)) return;
      void bridge.warmHistoryWorkspace(target).catch(() => {});
      if (!doc || !["ready", "busy"].includes(doc.status)) return;
      attaching = true;
      void warmCloudWorkspaceDestination(folder)
        .then(() => { if (!cancelled) { clearWorkspaceSettling(folder); clearWorkbenchConnectionFailure(folder); } })
        .catch(error => { if (!cancelled) recordWorkbenchConnectionFailure(folder, error, "connect"); })
        .finally(() => { attaching = false; });
    };
    attach();
    const off = subscribeCloudWorkspaces(attach);
    document.addEventListener("visibilitychange", attach);
    return () => { cancelled = true; off(); document.removeEventListener("visibilitychange", attach); };
  }, [folder]);

  // An explicit open (click, keyboard, deep link) starts a stopped workspace.
  useEffect(() => {
    let pending: { key: string; controller: AbortController } | undefined;
    const cancel = () => { pending?.controller.abort(); pending = undefined; };
    const ownsView = (key: string) => {
      const state = useWorkspaceStore.getState();
      return document.visibilityState !== "hidden" && state.activePage === "workspace" && selectActiveFolder(state) === key;
    };
    const off = subscribeCloudWorkspaceOpens((target, wakeIntent) => {
      const key = cloudWorkspaceKey(target), bridge = runtime();
      if (!bridge || !ownsView(key) || pending?.key === key || !hasCloudWorkspaceAccountAccess(target.organizationId) ||
          !cloudWorkspaceDocument(target)?.capabilities.canWrite) return;
      cancel();
      const intent = { key, controller: new AbortController() };
      pending = intent;
      void bridge.openWorkspace(target, { signal: intent.controller.signal, wakeIntent })
        .then(() => { if (!intent.controller.signal.aborted && ownsView(key)) clearWorkbenchConnectionFailure(key); })
        .catch(error => { if (!intent.controller.signal.aborted && ownsView(key)) recordCloudOpenFailure(key, error); })
        .finally(() => { if (pending === intent) pending = undefined; });
    });
    const changed = () => { if (pending && !ownsView(pending.key)) cancel(); };
    const offSelection = useWorkspaceStore.subscribe(changed);
    document.addEventListener("visibilitychange", changed);
    return () => { cancel(); off(); offSelection(); document.removeEventListener("visibilitychange", changed); };
  }, []);
  return null;
}

import { useCallback, useEffect, useMemo, useRef } from "react";
import type {
  BrowserAppearance,
  BrowserRoute,
  BrowserSessionState,
} from "@zeros/protocol/browser-tools";
import type { ComputerUseRoute } from "@zeros/protocol/computer-use-tools";
import type { DeviceToolRoute } from "@zeros/protocol/device-tools";

import { nativeInvoke, nativeListen } from "../../platform/runtime";
import { isCloudWorkspace } from "../../platform/bridge/cloud-workspace-key";
import { useWorkspaceStore } from "../../state/store";
import {
  defaultScopeFor,
  type WorkbenchTab,
} from "../../shell/workbench/tab-model";
import {
  workbenchScopeForFolder,
  type Action,
} from "../../state/workspace-store";
import { useResolvedSettings } from "../settings/use-settings";
import { useAgentControlAvailability } from "../settings/agent-control-rollout";
import { browserRoutesFromEffective } from "../settings/browser-use-settings";
import { computerUseRoutesFromEffective } from "../settings/computer-use-settings";
import { simulatorToolRouteFromEffective } from "../settings/simulator-settings";
import { agentFamily } from "../agent/model-catalog";
import { useAgentSessions } from "../agent/sessions-hooks";
import {
  browserRouteRefreshAction,
  computerRouteRefreshAction,
  deviceRouteRefreshAction,
  providerCapabilityRefreshStillTargetsFamily,
  type CapabilityRefreshFamily,
} from "../agent/session-reload-lifecycle";
import {
  cancelProviderCapabilityRefresh,
  queueProviderCapabilityRefresh,
  type CapabilityRefreshReason,
  type ProviderCapabilityRefreshQueue,
} from "../agent/provider-capability-refresh";
import { useSessionsStore } from "../agent/sessions-store";
import {
  browserSessionDismissedByUser,
  publishBrowserSessionActivity,
} from "./browser-session-activity-store";
import { removeBrowserConfirmationsForSession } from "./browser-confirmation-store";
import {
  browserSessionAppearanceToSync,
  browserSessionEndsAgentOwnership,
  browserSessionShouldExpandWorkbench,
  planBrowserSessionClose,
  planBrowserSessionOpen,
  retainLatestBrowserSession,
  retainPendingBrowserSession,
  shouldRevealBrowserSession,
  unseenBrowserSessionStates,
  validBrowserSessionState,
} from "./browser-session-routing";

interface BrowserSessionControllerProps {
  onRevealBrowser: () => void;
  workbenchCollapsed: boolean;
}

/** Projects main-process browser state into the exact conversation's workbench
 * slice. Background conversations receive their own tab without stealing focus;
 * the first open for the visible conversation can reveal the workbench. */
export function BrowserSessionController({
  onRevealBrowser,
  workbenchCollapsed,
}: BrowserSessionControllerProps) {
  const resolved = useResolvedSettings();
  const sessions = useAgentSessions();
  const availability = useAgentControlAvailability();
  const effective = resolved.resolved?.effective as
    | {
        browser?: {
          auto_open?: unknown;
          show_agent_cursor?: unknown;
          navigation_approval?: unknown;
        };
      }
    | undefined;
  const routes = useMemo(
    () => browserRoutesFromEffective(resolved.resolved?.effective, availability),
    [availability, resolved.resolved?.effective],
  );
  const computerRoutes = useMemo(
    () =>
      computerUseRoutesFromEffective(resolved.resolved?.effective, availability),
    [availability, resolved.resolved?.effective],
  );
  const deviceRoute: DeviceToolRoute = simulatorToolRouteFromEffective(
    resolved.resolved?.effective,
    availability,
  );
  const codexRoute = routes.codex;
  const claudeRoute = routes.claude;
  const cursorRoute = routes.cursor;
  const autoOpen = effective?.browser?.auto_open !== false;
  // Some agent drives the in-app browser. Claude in Chrome does not.
  const browserEnabled =
    codexRoute !== "off" || claudeRoute === "zeros" || cursorRoute === "zeros";
  const codexNativeEnabled = codexRoute === "codex-native";
  const showAgentCursor = effective?.browser?.show_agent_cursor !== false;
  const navigationApproval =
    effective?.browser?.navigation_approval === "always-allow"
      ? "always-allow"
      : "always-ask";
  const autoOpenRef = useRef(autoOpen);
  const browserEnabledRef = useRef(browserEnabled);
  const revealRef = useRef(onRevealBrowser);
  const workbenchCollapsedRef = useRef(workbenchCollapsed);
  const settingsReadyRef = useRef(Boolean(resolved.resolved));
  const previousRoutesRef = useRef<
    Partial<Record<CapabilityRefreshFamily, BrowserRoute>>
  >({});
  const previousComputerRoutesRef = useRef<
    Partial<Record<CapabilityRefreshFamily, ComputerUseRoute>>
  >({});
  const previousDeviceRouteRef = useRef<DeviceToolRoute | null>(null);
  const capabilityRefreshRevisionRef = useRef(0);
  const capabilityRefreshPendingRef = useRef<ProviderCapabilityRefreshQueue>(
    new Map(),
  );
  const capabilityRefreshRunningRef = useRef(new Map<string, number>());
  const drainCapabilityRefreshesRef = useRef<() => void>(() => {});
  const availabilityRevisionRef = useRef(0);
  const availabilityAppliedRef = useRef(false);
  const pendingRoutingRef = useRef(new Map<string, BrowserSessionState>());
  const latestRoutingRef = useRef(new Map<string, BrowserSessionState>());
  const revealedOwnershipSessionIdsRef = useRef(new Set<string>());
  const syncedAppearanceRef = useRef(
    new Map<string, BrowserAppearance | "system">(),
  );
  autoOpenRef.current = autoOpen;
  browserEnabledRef.current = browserEnabled;
  revealRef.current = onRevealBrowser;
  workbenchCollapsedRef.current = workbenchCollapsed;

  const drainCapabilityRefreshes = useCallback(() => {
    if (!settingsReadyRef.current || !availabilityAppliedRef.current) return;
    for (const [chatId, request] of capabilityRefreshPendingRef.current) {
      if (capabilityRefreshRunningRef.current.has(chatId)) continue;
      const slot = useSessionsStore.getState().sessions[chatId];
      if (!slot) {
        capabilityRefreshPendingRef.current.delete(chatId);
        continue;
      }
      if (
        !providerCapabilityRefreshStillTargetsFamily({
          requestedFamily: request.providerFamily,
          currentFamily: agentFamily(slot.agentId),
        })
      ) {
        capabilityRefreshPendingRef.current.delete(chatId);
        continue;
      }
      const activity = sessions.getCloseActivity(chatId);
      if (
        slot.status !== "ready" ||
        activity.running ||
        activity.queuedCount > 0
      ) {
        continue;
      }
      capabilityRefreshRunningRef.current.set(chatId, request.revision);
      void sessions
        .refreshProviderCapabilities(chatId)
        .then((completed) => {
          const pending = capabilityRefreshPendingRef.current.get(chatId);
          if (completed && pending?.revision === request.revision) {
            capabilityRefreshPendingRef.current.delete(chatId);
          }
        })
        .catch(() => {
          // The session action publishes a classified slot failure whenever a
          // refresh transaction started. An early bridge absence remains
          // pending and retries on the next store/settings edge.
        })
        .finally(() => {
          if (
            capabilityRefreshRunningRef.current.get(chatId) === request.revision
          ) {
            capabilityRefreshRunningRef.current.delete(chatId);
          }
          // A second setting edge may have arrived while this refresh was in
          // flight. Its newer revision must not be consumed by the older load.
          const pending = capabilityRefreshPendingRef.current.get(chatId);
          if (pending && pending.revision !== request.revision) {
            drainCapabilityRefreshesRef.current();
          }
        });
    }
  }, [sessions]);
  drainCapabilityRefreshesRef.current = drainCapabilityRefreshes;

  const queueCapabilityRefreshes = useCallback(
    (
      providerFamily: CapabilityRefreshFamily,
      reason: CapabilityRefreshReason,
    ) => {
      const revision = ++capabilityRefreshRevisionRef.current;
      const chatIds: string[] = [];
      for (const [chatId, slot] of Object.entries(
        useSessionsStore.getState().sessions,
      )) {
        if (
          agentFamily(slot.agentId) === providerFamily &&
          // Cloud sessions never get these Local capabilities.
          !isCloudWorkspace(slot.cwd) &&
          slot.providerBinding?.kind === "native" &&
          slot.providerBinding.providerId === slot.agentId &&
          Boolean(slot.executionId ?? slot.sessionId)
        ) {
          chatIds.push(chatId);
        }
      }
      queueProviderCapabilityRefresh(
        capabilityRefreshPendingRef.current,
        chatIds,
        { providerFamily, reason, revision },
        64,
      );
      drainCapabilityRefreshes();
    },
    [drainCapabilityRefreshes],
  );

  const routeBrowserEvent = useCallback((event: BrowserSessionState) => {
    if (!browserEnabledRef.current) return true;
    if (
      event.status !== "closed" &&
      browserSessionDismissedByUser(event.browserSessionId)
    ) {
      return true;
    }

    const workspace = useWorkspaceStore.getState();
    const chat = workspace.chats.find(
      (candidate) => candidate.id === event.conversationId,
    );
    if (!chat) return false;
    const scope = workbenchScopeForFolder(chat.folder || null);
    const scoped = workspace.workbenchByScope[scope] ?? defaultScopeFor(scope);
    if (event.status === "closed") {
      for (const action of planBrowserSessionClose(scoped.tabs, event)) {
        useWorkspaceStore.getState().dispatch(withScope(action, scope));
      }
      return true;
    }
    const reveal = shouldRevealBrowserSession({
      activeConversation: workspace.activeChatId === event.conversationId,
      workspaceSurfaceActive: workspace.activePage === "workspace",
      sessionAlreadyRevealed: revealedOwnershipSessionIdsRef.current.has(
        event.browserSessionId,
      ),
      autoOpen: autoOpenRef.current,
      url: event.url,
      status: event.status,
      actor: event.actor,
      tool: event.tool,
    });
    const actions = planBrowserSessionOpen(scoped.tabs, {
      browserSessionId: event.browserSessionId,
      conversationId: event.conversationId,
      url: event.url,
      title: event.title,
      loading: event.loading,
      activate: reveal,
    });
    if (reveal) {
      // Publish the one-shot before dispatch: Zustand subscriptions are
      // synchronous, and an activation action may immediately reroute the same
      // cached state through this controller.
      rememberBounded(
        revealedOwnershipSessionIdsRef.current,
        event.browserSessionId,
        64,
      );
    }
    for (const action of actions) {
      useWorkspaceStore.getState().dispatch(withScope(action, scope));
    }
    syncBrowserSessionAppearance(
      syncedAppearanceRef.current,
      event,
      (useWorkspaceStore.getState().workbenchByScope[scope] ?? scoped).tabs,
    );
    if (
      browserSessionShouldExpandWorkbench({
        shouldRevealSession: reveal,
        workbenchCollapsed: workbenchCollapsedRef.current,
      })
    ) {
      revealRef.current();
    }
    return true;
  }, []);

  const retainPending = useCallback((event: BrowserSessionState) => {
    pendingRoutingRef.current = retainPendingBrowserSession(
      pendingRoutingRef.current,
      event,
      32,
    );
  }, []);

  // Main applies the rollout to its control bars and hands it to the engine,
  // which admits and routes the tools by it. Declared before the route edges
  // below so a refresh they queue waits until the engine confirms; a resumed
  // agent would otherwise boot with the previous answer.
  useEffect(() => {
    const revision = ++availabilityRevisionRef.current;
    availabilityAppliedRef.current = false;
    void nativeInvoke("agent_control_availability_update", { ...availability })
      .catch(() => {})
      .finally(() => {
        if (availabilityRevisionRef.current !== revision) return;
        availabilityAppliedRef.current = true;
        drainCapabilityRefreshesRef.current();
      });
  }, [availability]);

  useEffect(() => {
    if (!resolved.resolved) return;
    void nativeInvoke("browser_ui_preferences_update", {
      browserEnabled,
      codexNativeEnabled,
      showAgentCursor,
      navigationApproval,
    }).catch(() => {});
  }, [
    browserEnabled,
    codexNativeEnabled,
    navigationApproval,
    resolved.resolved,
    showAgentCursor,
  ]);

  useEffect(() => {
    if (!resolved.resolved) return;
    const next: Record<CapabilityRefreshFamily, BrowserRoute> = {
      codex: codexRoute,
      claude: claudeRoute,
      cursor: cursorRoute,
    };
    for (const providerFamily of ["codex", "claude", "cursor"] as const) {
      const previous = previousRoutesRef.current[providerFamily] ?? null;
      previousRoutesRef.current[providerFamily] = next[providerFamily];
      const action = browserRouteRefreshAction({
        providerFamily,
        previous,
        next: next[providerFamily],
      });
      if (action === "refresh") {
        // A running provider keeps the browser it booted with. Resume its
        // durable conversation once idle so it picks up the new route.
        queueCapabilityRefreshes(providerFamily, "browser");
      } else if (action === "cancel") {
        cancelProviderCapabilityRefresh(capabilityRefreshPendingRef.current, {
          providerFamily,
          reason: "browser",
        });
      }
    }
  }, [
    claudeRoute,
    codexRoute,
    cursorRoute,
    queueCapabilityRefreshes,
    resolved.resolved,
  ]);

  // The same edge rule for Computer use. `zeros_computer` tools are listed
  // only when a provider boots on the "zeros" route, and Codex enables its
  // built-in computer use at boot, so an idle resume carries the change.
  useEffect(() => {
    if (!resolved.resolved) return;
    for (const providerFamily of ["codex", "claude", "cursor"] as const) {
      const previous =
        previousComputerRoutesRef.current[providerFamily] ?? null;
      const next = computerRoutes[providerFamily];
      previousComputerRoutesRef.current[providerFamily] = next;
      const action = computerRouteRefreshAction({
        providerFamily,
        previous,
        next,
      });
      if (action === "refresh") {
        queueCapabilityRefreshes(providerFamily, "computer");
      } else if (action === "cancel") {
        cancelProviderCapabilityRefresh(capabilityRefreshPendingRef.current, {
          providerFamily,
          reason: "computer",
        });
      }
    }
  }, [computerRoutes, queueCapabilityRefreshes, resolved.resolved]);

  // And for simulators, one setting for every agent family.
  useEffect(() => {
    if (!resolved.resolved) return;
    const previous = previousDeviceRouteRef.current;
    previousDeviceRouteRef.current = deviceRoute;
    const action = deviceRouteRefreshAction({ previous, next: deviceRoute });
    for (const providerFamily of ["codex", "claude", "cursor"] as const) {
      if (action === "refresh") {
        queueCapabilityRefreshes(providerFamily, "simulator");
      } else if (action === "cancel") {
        cancelProviderCapabilityRefresh(capabilityRefreshPendingRef.current, {
          providerFamily,
          reason: "simulator",
        });
      }
    }
  }, [deviceRoute, queueCapabilityRefreshes, resolved.resolved]);

  useEffect(() => {
    return useSessionsStore.subscribe((state, previous) => {
      if (
        state.sessions === previous.sessions ||
        capabilityRefreshPendingRef.current.size === 0
      ) {
        return;
      }
      drainCapabilityRefreshes();
    });
  }, [drainCapabilityRefreshes]);

  useEffect(() => {
    if (!resolved.resolved) {
      settingsReadyRef.current = false;
      return;
    }
    settingsReadyRef.current = true;
    const pending = [...pendingRoutingRef.current.values()];
    pendingRoutingRef.current.clear();
    for (const event of pending) {
      if (!routeBrowserEvent(event)) retainPending(event);
    }
  }, [resolved.resolved, retainPending, routeBrowserEvent]);

  useEffect(() => {
    return useWorkspaceStore.subscribe((state, previous) => {
      if (
        (state.chats === previous.chats &&
          state.activeChatId === previous.activeChatId &&
          state.activePage === previous.activePage) ||
        !settingsReadyRef.current ||
        (pendingRoutingRef.current.size === 0 &&
          latestRoutingRef.current.size === 0)
      ) {
        return;
      }
      for (const [conversationId, event] of pendingRoutingRef.current) {
        if (!state.chats.some((chat) => chat.id === conversationId)) continue;
        if (routeBrowserEvent(event)) {
          pendingRoutingRef.current.delete(conversationId);
        }
      }
      const active = state.activeChatId
        ? latestRoutingRef.current.get(state.activeChatId)
        : undefined;
      if (active) routeBrowserEvent(active);
    });
  }, [routeBrowserEvent]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const observedSessionIds = new Set<string>();
    const handleEvent = (event: BrowserSessionState) => {
      if (disposed) return;
      if (!validBrowserSessionState(event)) return;
      observedSessionIds.add(event.browserSessionId);
      publishBrowserSessionActivity(event);
      if (browserSessionEndsAgentOwnership(event)) {
        // The same retained page may be claimed by a later Codex turn. Clear
        // the reveal latch at user handoff so that later ownership interval
        // can activate and reopen its existing Browser tab automatically.
        revealedOwnershipSessionIdsRef.current.delete(event.browserSessionId);
      }
      const latestBefore = latestRoutingRef.current.get(event.conversationId);
      latestRoutingRef.current = retainLatestBrowserSession(
        latestRoutingRef.current,
        event,
        64,
      );
      if (event.status !== "awaiting-confirmation") {
        removeBrowserConfirmationsForSession(event.browserSessionId);
      }
      if (event.status === "closed") {
        syncedAppearanceRef.current.delete(event.browserSessionId);
        // Let the session-aware reducer remove only a matching pending event.
        // Deleting by conversation alone would let a delayed close from an
        // older lease erase a replacement that opened during chat hydration.
        const currentClose =
          !latestBefore ||
          latestBefore.browserSessionId === event.browserSessionId;
        if (
          currentClose &&
          settingsReadyRef.current &&
          routeBrowserEvent(event)
        ) {
          pendingRoutingRef.current.delete(event.conversationId);
        } else {
          retainPending(event);
        }
        return;
      }
      if (!settingsReadyRef.current) {
        retainPending(event);
        return;
      }
      if (routeBrowserEvent(event)) {
        pendingRoutingRef.current.delete(event.conversationId);
      } else {
        retainPending(event);
      }
    };
    void nativeListen<BrowserSessionState>(
      "browser-session-state",
      handleEvent,
    ).then(async (dispose) => {
      if (disposed) {
        dispose();
        return;
      }
      unlisten = dispose;
      try {
        const snapshot = await nativeInvoke<BrowserSessionState[]>(
          "browser_session_states",
        );
        if (disposed) return;
        for (const event of unseenBrowserSessionStates(
          Array.isArray(snapshot) ? snapshot : [],
          observedSessionIds,
        )) {
          handleEvent(event);
        }
      } catch {
        // Old preloads/main processes do not implement snapshot hydration.
        // The live subscription remains authoritative until a full restart.
      }
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [retainPending, routeBrowserEvent]);

  return null;
}

function syncBrowserSessionAppearance(
  synced: Map<string, BrowserAppearance | "system">,
  event: BrowserSessionState,
  tabs: readonly WorkbenchTab[],
) {
  const appearance = browserSessionAppearanceToSync(
    tabs,
    event,
    synced.get(event.browserSessionId),
  );
  if (!appearance) return;
  rememberBoundedMap(synced, event.browserSessionId, appearance, 64);
  void nativeInvoke("browser_session_appearance", {
    browserSessionId: event.browserSessionId,
    appearance,
  }).catch(() => {
    // The session's next state event retries.
    if (synced.get(event.browserSessionId) === appearance) {
      synced.delete(event.browserSessionId);
    }
  });
}

function withScope(action: Action, scope: string): Action {
  if (
    action.type === "ADD_WORKBENCH_TAB" ||
    action.type === "REMOVE_WORKBENCH_TAB" ||
    action.type === "ACTIVATE_WORKBENCH_TAB" ||
    action.type === "UPDATE_WORKBENCH_TAB"
  ) {
    return { ...action, scope };
  }
  return action;
}

function rememberBounded(target: Set<string>, value: string, maximum: number) {
  target.delete(value);
  target.add(value);
  while (target.size > maximum) {
    const oldest = target.values().next().value as string | undefined;
    if (!oldest) break;
    target.delete(oldest);
  }
}

function rememberBoundedMap<K, V>(
  target: Map<K, V>,
  key: K,
  value: V,
  maximum: number,
) {
  target.delete(key);
  target.set(key, value);
  while (target.size > maximum) {
    const oldest = target.keys().next().value as K | undefined;
    if (oldest === undefined) break;
    target.delete(oldest);
  }
}

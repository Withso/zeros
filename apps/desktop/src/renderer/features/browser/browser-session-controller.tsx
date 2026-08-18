import { useCallback, useEffect, useRef } from "react";
import type { BrowserSessionState } from "@zeros/protocol/browser-tools";

import { nativeInvoke, nativeListen } from "../../platform/runtime";
import { useWorkspaceStore } from "../../state/store";
import { defaultScopeFor } from "../../shell/workbench/tab-model";
import {
  workbenchScopeForFolder,
  type Action,
} from "../../state/workspace-store";
import { useResolvedSettings } from "../settings/use-settings";
import { agentFamily } from "../agent/model-catalog";
import { useAgentSessions } from "../agent/sessions-hooks";
import {
  providerCapabilityRefreshNeeded,
  providerCapabilityRefreshStillTargetsFamily,
} from "../agent/session-reload-lifecycle";
import { useSessionsStore } from "../agent/sessions-store";
import {
  browserSessionDismissedByUser,
  publishBrowserSessionActivity,
} from "./browser-session-activity-store";
import { removeBrowserConfirmationsForSession } from "./browser-confirmation-store";
import {
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

interface ProviderCapabilityRefreshRequest {
  revision: number;
  providerFamily: "codex" | "claude";
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
  const effective = resolved.resolved?.effective as
    | {
        browser?: {
          enabled?: unknown;
          codex_enabled?: unknown;
          claude_enabled?: unknown;
          auto_open?: unknown;
          show_agent_cursor?: unknown;
          navigation_approval?: unknown;
        };
      }
    | undefined;
  const autoOpen = effective?.browser?.auto_open !== false;
  const browserEnabled =
    typeof effective?.browser?.codex_enabled === "boolean"
      ? effective.browser.codex_enabled
      : effective?.browser?.enabled !== false;
  const claudeBrowserEnabled =
    typeof effective?.browser?.claude_enabled === "boolean"
      ? effective.browser.claude_enabled
      : false;
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
  const previousBrowserEnabledRef = useRef<boolean | null>(null);
  const previousClaudeBrowserEnabledRef = useRef<boolean | null>(null);
  const capabilityRefreshRevisionRef = useRef(0);
  const capabilityRefreshPendingRef = useRef(
    new Map<string, ProviderCapabilityRefreshRequest>(),
  );
  const capabilityRefreshRunningRef = useRef(new Map<string, number>());
  const drainCapabilityRefreshesRef = useRef<() => void>(() => {});
  const pendingRoutingRef = useRef(new Map<string, BrowserSessionState>());
  const latestRoutingRef = useRef(new Map<string, BrowserSessionState>());
  const revealedOwnershipSessionIdsRef = useRef(new Set<string>());
  autoOpenRef.current = autoOpen;
  browserEnabledRef.current = browserEnabled;
  revealRef.current = onRevealBrowser;
  workbenchCollapsedRef.current = workbenchCollapsed;

  const drainCapabilityRefreshes = useCallback(() => {
    if (!settingsReadyRef.current) return;
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
    (providerFamily: "codex" | "claude") => {
      const revision = ++capabilityRefreshRevisionRef.current;
      for (const [chatId, slot] of Object.entries(
        useSessionsStore.getState().sessions,
      )) {
        if (
          agentFamily(slot.agentId) === providerFamily &&
          slot.providerBinding?.kind === "native" &&
          slot.providerBinding.providerId === slot.agentId &&
          Boolean(slot.executionId ?? slot.sessionId)
        ) {
          rememberBoundedMap(
            capabilityRefreshPendingRef.current,
            chatId,
            { revision, providerFamily },
            64,
          );
        }
      }
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

  useEffect(() => {
    if (!resolved.resolved) return;
    void nativeInvoke("browser_ui_preferences_update", {
      browserEnabled,
      showAgentCursor,
      navigationApproval,
    }).catch(() => {});
  }, [browserEnabled, navigationApproval, resolved.resolved, showAgentCursor]);

  useEffect(() => {
    if (!resolved.resolved) return;
    const previous = previousBrowserEnabledRef.current;
    previousBrowserEnabledRef.current = browserEnabled;
    if (!browserEnabled) {
      for (const [chatId, request] of capabilityRefreshPendingRef.current) {
        if (request.providerFamily === "codex") {
          capabilityRefreshPendingRef.current.delete(chatId);
        }
      }
      return;
    }
    if (
      providerCapabilityRefreshNeeded({
        providerFamily: "codex",
        previousEnabled: previous,
        enabled: browserEnabled,
      })
    ) {
      // Enabling Browser after an app-server already booted cannot add the
      // Browser plugin to that process. Resume its durable thread once idle.
      queueCapabilityRefreshes("codex");
    }
  }, [browserEnabled, queueCapabilityRefreshes, resolved.resolved]);

  useEffect(() => {
    if (!resolved.resolved) return;
    const previous = previousClaudeBrowserEnabledRef.current;
    previousClaudeBrowserEnabledRef.current = claudeBrowserEnabled;
    if (
      providerCapabilityRefreshNeeded({
        providerFamily: "claude",
        previousEnabled: previous,
        enabled: claudeBrowserEnabled,
      })
    ) {
      // Claude Code consumes this as the process-scoped `--chrome` or
      // `--no-chrome` flag, so either edge resumes the same SDK conversation.
      queueCapabilityRefreshes("claude");
    }
  }, [claudeBrowserEnabled, queueCapabilityRefreshes, resolved.resolved]);

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

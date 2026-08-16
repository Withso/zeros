import { useCallback, useSyncExternalStore } from "react";
import type {
  BrowserAgentPointer,
  BrowserSessionState,
} from "@zeros/protocol/browser-tools";

export const BROWSER_AGENT_POINTER_LINGER_MS = 1_800;

export type { BrowserAgentPointer, BrowserSessionState };

const activityBySession = new Map<string, BrowserSessionState>();
const activityByConversation = new Map<string, BrowserSessionState>();
const sessionListeners = new Map<string, Set<() => void>>();
const conversationListeners = new Map<string, Set<() => void>>();
const MAX_RETAINED_CONVERSATION_ACTIVITIES = 128;
const dismissedBrowserSessionIds = new Set<string>();
// Bind page-controlled artwork to the full origin. Reusing by hostname would
// let a different scheme or port inherit another site's visual identity.
const faviconByOrigin = new Map<string, string>();

export function nextConversationBrowserActivity(
  previous: BrowserSessionState | undefined,
  activity: BrowserSessionState,
): BrowserSessionState {
  if (
    activity.status === "closed" &&
    previous &&
    previous.browserSessionId !== activity.browserSessionId
  ) {
    return previous;
  }
  return activity;
}

export function publishBrowserSessionActivity(
  activity: BrowserSessionState,
): void {
  if (
    activity.status !== "closed" &&
    dismissedBrowserSessionIds.has(activity.browserSessionId)
  ) {
    return;
  }
  if (activity.status === "closed") {
    dismissedBrowserSessionIds.delete(activity.browserSessionId);
  }
  const previousConversation = activityByConversation.get(
    activity.conversationId,
  );
  const origin = browserActivityOrigin(activity.url);
  const retainedFavicon = origin ? faviconByOrigin.get(origin) : undefined;
  if (!activity.faviconDataUrl && retainedFavicon) {
    activity = { ...activity, faviconDataUrl: retainedFavicon };
  }
  if (origin && activity.faviconDataUrl) {
    setBoundedString(
      faviconByOrigin,
      origin,
      activity.faviconDataUrl,
      MAX_RETAINED_CONVERSATION_ACTIVITIES,
    );
  }
  if (activity.status === "closed") {
    activityBySession.delete(activity.browserSessionId);
    // A delayed close from a replaced process session may not erase the newer
    // session now owned by the same durable conversation.
    if (previousConversation?.browserSessionId === activity.browserSessionId) {
      setBoundedActivity(
        activityByConversation,
        activity.conversationId,
        activity,
        MAX_RETAINED_CONVERSATION_ACTIVITIES,
      );
    }
  } else {
    setBoundedActivity(
      activityBySession,
      activity.browserSessionId,
      activity,
      MAX_RETAINED_CONVERSATION_ACTIVITIES,
    );
    setBoundedActivity(
      activityByConversation,
      activity.conversationId,
      nextConversationBrowserActivity(previousConversation, activity),
      MAX_RETAINED_CONVERSATION_ACTIVITIES,
    );
  }
  notify(sessionListeners, activity.browserSessionId);
  if (
    activity.status !== "closed" ||
    previousConversation?.browserSessionId === activity.browserSessionId
  ) {
    notify(conversationListeners, activity.conversationId);
  }
}

/** A user-closing a Browser tab is a synchronous renderer intent while the
 * native close IPC and its state event cross process boundaries. Retain that
 * intent so cached ready/working snapshots cannot recreate the tab in the
 * intervening workspace-store notification. */
export function dismissBrowserSession(browserSessionId: string): void {
  dismissedBrowserSessionIds.delete(browserSessionId);
  dismissedBrowserSessionIds.add(browserSessionId);
  while (
    dismissedBrowserSessionIds.size > MAX_RETAINED_CONVERSATION_ACTIVITIES
  ) {
    const oldest = dismissedBrowserSessionIds.values().next().value as
      | string
      | undefined;
    if (!oldest) break;
    dismissedBrowserSessionIds.delete(oldest);
  }
}

export function browserSessionDismissedByUser(
  browserSessionId: string,
): boolean {
  return dismissedBrowserSessionIds.has(browserSessionId);
}

export function cachedBrowserFavicon(
  url: string | undefined,
): string | undefined {
  const origin = browserActivityOrigin(url);
  return origin ? faviconByOrigin.get(origin) : undefined;
}

export function currentBrowserSessionActivity(
  browserSessionId: string,
): BrowserSessionState | null {
  return activityBySession.get(browserSessionId) ?? null;
}

function browserActivityOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

function setBoundedActivity(
  target: Map<string, BrowserSessionState>,
  key: string,
  value: BrowserSessionState,
  maximum: number,
): void {
  // Delete+set refreshes insertion order so active conversations, rather than
  // merely the newest identities, survive bounded retention.
  target.delete(key);
  target.set(key, value);
  while (target.size > maximum) {
    const oldest = target.keys().next().value as string | undefined;
    if (!oldest) break;
    target.delete(oldest);
  }
}

function setBoundedString(
  target: Map<string, string>,
  key: string,
  value: string,
  maximum: number,
): void {
  target.delete(key);
  target.set(key, value);
  while (target.size > maximum) {
    const oldest = target.keys().next().value as string | undefined;
    if (!oldest) break;
    target.delete(oldest);
  }
}

function notify(registry: Map<string, Set<() => void>>, key: string): void {
  for (const listener of registry.get(key) ?? []) listener();
}

function subscribeKey(
  registry: Map<string, Set<() => void>>,
  key: string,
  listener: () => void,
): () => void {
  let listeners = registry.get(key);
  if (!listeners) {
    listeners = new Set();
    registry.set(key, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners!.delete(listener);
    if (listeners!.size === 0) registry.delete(key);
  };
}

export function useBrowserSessionActivity(
  browserSessionId: string | undefined,
): BrowserSessionState | null {
  const key = browserSessionId ?? "";
  const subscribe = useCallback(
    (listener: () => void) => subscribeKey(sessionListeners, key, listener),
    [key],
  );
  const getSnapshot = useCallback(
    () => (key ? (activityBySession.get(key) ?? null) : null),
    [key],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}

export function useConversationBrowserActivity(
  conversationId: string | undefined,
): BrowserSessionState | null {
  const key = conversationId ?? "";
  const subscribe = useCallback(
    (listener: () => void) =>
      subscribeKey(conversationListeners, key, listener),
    [key],
  );
  const getSnapshot = useCallback(
    () => (key ? (activityByConversation.get(key) ?? null) : null),
    [key],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}

export function browserSessionIsAgentActive(
  activity: BrowserSessionState | null,
  _now = Date.now(),
): boolean {
  return Boolean(
    activity && activity.status !== "closed" && activity.actor === "agent",
  );
}

/** Agent presence follows provider ownership through finalization. The hook no
 * longer polls or schedules grace-window timers between native actions. */
export function useBrowserSessionAgentPresence(
  conversationId: string | undefined,
  surfaceActive = true,
): { activity: BrowserSessionState | null; active: boolean } {
  const activity = useConversationBrowserActivity(conversationId);
  return {
    activity,
    active: surfaceActive && browserSessionIsAgentActive(activity),
  };
}

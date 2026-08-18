import {
  BROWSER_TOOL_NAMES,
  isBrowserProductId,
  type BrowserSessionState,
} from "@zeros/protocol/browser-tools";

import type { Action } from "../../state/workspace-store";
import {
  canonicalBrowsableHttpUrl,
  createBrowserTab,
  type WorkbenchTab,
} from "../../shell/workbench/tab-model";

export interface BrowserSessionOpenEvent {
  browserSessionId: string;
  conversationId: string;
  url: string;
  title?: string;
  loading?: boolean;
  activate?: boolean;
}

/** A retained WebContents can move back and forth between the user and Codex
 * across many turns without changing its opaque session id. Auto-open is
 * one-shot per agent ownership interval, not one-shot for the lifetime of the
 * retained page. */
export function browserSessionEndsAgentOwnership(
  event: Pick<BrowserSessionState, "actor" | "status">,
): boolean {
  return event.status === "closed" || event.actor === "user";
}

/** Filter a post-subscribe snapshot against events already observed on the
 * live channel. Subscription is installed first, so this closes both sides of
 * the startup race without replaying an older snapshot over newer state. */
export function unseenBrowserSessionStates(
  snapshot: readonly BrowserSessionState[],
  observedSessionIds: ReadonlySet<string>,
): BrowserSessionState[] {
  return snapshot.filter(
    (event) =>
      validBrowserSessionState(event) &&
      event.status !== "closed" &&
      !observedSessionIds.has(event.browserSessionId),
  );
}

/** Retain the newest routable lease per durable conversation. Electron can
 * deliver cleanup from an old renderer/process after its replacement has
 * already published, so a close is authoritative only for the same opaque
 * browser session. */
export function retainLatestBrowserSession(
  current: ReadonlyMap<string, BrowserSessionState>,
  event: BrowserSessionState,
  maximum: number,
): Map<string, BrowserSessionState> {
  const next = new Map(current);
  const previous = next.get(event.conversationId);
  if (
    event.status === "closed" &&
    previous &&
    previous.browserSessionId !== event.browserSessionId
  ) {
    return next;
  }
  next.delete(event.conversationId);
  if (event.status !== "closed") {
    next.set(event.conversationId, event);
  }
  const limit = Number.isSafeInteger(maximum) && maximum > 0 ? maximum : 1;
  while (next.size > limit) {
    const oldest = next.keys().next().value as string | undefined;
    if (!oldest) break;
    next.delete(oldest);
  }
  return next;
}

export function retainPendingBrowserSession(
  current: ReadonlyMap<string, BrowserSessionState>,
  event: BrowserSessionState,
  maximum: number,
): Map<string, BrowserSessionState> {
  const next = new Map(current);
  const previous = next.get(event.conversationId);
  // Main-process delivery can outlive the renderer lifecycle that observed a
  // replaced lease. A delayed close for that old opaque session must not erase
  // the newer session (or its preserved first-open intent) while chats are
  // still hydrating.
  if (
    event.status === "closed" &&
    previous &&
    previous.browserSessionId !== event.browserSessionId
  ) {
    return next;
  }
  next.delete(event.conversationId);
  if (event.status !== "closed") {
    const preserveOpenIntent =
      previous?.browserSessionId === event.browserSessionId &&
      previous.tool === "open" &&
      event.tool !== "open";
    next.set(
      event.conversationId,
      preserveOpenIntent ? { ...event, tool: "open" } : event,
    );
  }
  const limit = Number.isSafeInteger(maximum) && maximum > 0 ? maximum : 1;
  while (next.size > limit) {
    const oldest = next.keys().next().value as string | undefined;
    if (!oldest) break;
    next.delete(oldest);
  }
  return next;
}

export function validBrowserSessionState(
  value: unknown,
): value is BrowserSessionState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Partial<BrowserSessionState>;
  if (
    !isBrowserProductId(state.browserSessionId) ||
    !isBrowserProductId(state.workspaceId) ||
    !isBrowserProductId(state.conversationId) ||
    typeof state.url !== "string" ||
    state.url.length > 8_192 ||
    typeof state.title !== "string" ||
    state.title.length > 512 ||
    typeof state.loading !== "boolean" ||
    (state.canGoBack !== undefined && typeof state.canGoBack !== "boolean") ||
    (state.canGoForward !== undefined &&
      typeof state.canGoForward !== "boolean") ||
    !["working", "awaiting-confirmation", "ready", "closed"].includes(
      String(state.status),
    ) ||
    (state.actor !== undefined &&
      state.actor !== "agent" &&
      state.actor !== "user")
  ) {
    return false;
  }
  if (
    state.tool !== undefined &&
    state.tool !== "permission" &&
    state.tool !== "download" &&
    state.tool !== "renderer-crash" &&
    !(BROWSER_TOOL_NAMES as readonly string[]).includes(state.tool)
  ) {
    return false;
  }
  if (
    (state.faviconDataUrl !== undefined &&
      (typeof state.faviconDataUrl !== "string" ||
        state.faviconDataUrl.length > 300_000 ||
        !/^data:image\/(?:png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(
          state.faviconDataUrl,
        ))) ||
    (state.sourceViewport !== undefined &&
      (!Number.isSafeInteger(state.sourceViewport.width) ||
        !Number.isSafeInteger(state.sourceViewport.height) ||
        state.sourceViewport.width < 1 ||
        state.sourceViewport.height < 1 ||
        state.sourceViewport.width > 10_000 ||
        state.sourceViewport.height > 10_000)) ||
    (state.cancellable !== undefined &&
      typeof state.cancellable !== "boolean") ||
    (state.surfaceHovered !== undefined &&
      typeof state.surfaceHovered !== "boolean") ||
    (state.agentActivityUntil !== undefined &&
      (!Number.isSafeInteger(state.agentActivityUntil) ||
        state.agentActivityUntil < 0))
  ) {
    return false;
  }
  if (
    state.cancellable === true &&
    (state.actor !== "agent" ||
      (state.status !== "working" && state.status !== "awaiting-confirmation"))
  ) {
    return false;
  }
  if (state.action !== undefined) {
    const action = state.action;
    if (
      !action ||
      typeof action !== "object" ||
      !Number.isSafeInteger(action.sequence) ||
      action.sequence < 1 ||
      (!BROWSER_TOOL_NAMES.includes(action.kind as never) &&
        action.kind !== "permission" &&
        action.kind !== "download") ||
      typeof action.label !== "string" ||
      action.label.length > 160 ||
      !Number.isSafeInteger(action.startedAt) ||
      action.startedAt < 0
    ) {
      return false;
    }
  }
  if (state.pointer === undefined) return true;
  if (
    !state.pointer ||
    typeof state.pointer !== "object" ||
    Array.isArray(state.pointer)
  ) {
    return false;
  }
  const pointer = state.pointer;
  return (
    Number.isFinite(pointer.x) &&
    pointer.x >= 0 &&
    pointer.x <= 10_000 &&
    Number.isFinite(pointer.y) &&
    pointer.y >= 0 &&
    pointer.y <= 10_000 &&
    Number.isSafeInteger(pointer.updatedAt) &&
    pointer.updatedAt >= 0 &&
    ["move", "click", "type", "scroll"].includes(pointer.action)
  );
}

export function shouldRevealBrowserSession(input: {
  activeConversation: boolean;
  workspaceSurfaceActive: boolean;
  sessionAlreadyRevealed: boolean;
  autoOpen: boolean;
  url: string;
  status: BrowserSessionState["status"];
  actor?: BrowserSessionState["actor"];
  tool?: BrowserSessionState["tool"];
}): boolean {
  return (
    input.autoOpen &&
    input.activeConversation &&
    input.workspaceSurfaceActive &&
    !input.sessionAlreadyRevealed &&
    input.actor === "agent" &&
    input.status !== "closed" &&
    Boolean(canonicalBrowsableHttpUrl(input.url))
  );
}

/** Auto-open activates the conversation's Browser tab, but an explicitly
 * collapsed Workbench is a user layout choice. Keep it collapsed so the live
 * native surface is rehosted in PiP instead of expanding the whole column. */
export function browserSessionShouldExpandWorkbench(input: {
  shouldRevealSession: boolean;
  workbenchCollapsed: boolean;
}): boolean {
  return input.shouldRevealSession && !input.workbenchCollapsed;
}

/** Project one process-owned session into a durable conversation-owned tab.
 * The opaque browserSessionId is validated but deliberately never persisted. */
export function planBrowserSessionOpen(
  tabs: WorkbenchTab[],
  event: BrowserSessionOpenEvent,
): Action[] {
  if (
    !isBrowserProductId(event.browserSessionId) ||
    !isBrowserProductId(event.conversationId)
  ) {
    return [];
  }
  const url = canonicalBrowsableHttpUrl(event.url);
  if (!url) return [];
  const requestedTitle = event.title?.trim().slice(0, 512) || "Browser";
  const existing = tabs.find(
    (tab) =>
      tab.type === "browser" &&
      tab.browserConversationId === event.conversationId,
  );
  if (!existing) {
    // Chromium temporarily reports a hostname-derived title between
    // did-navigate and page-title-updated. The main process now retains its
    // last explicit title; do not synthesize the same transient hostname here
    // for a newly revealed loading tab.
    const title = requestedTitle;
    return [
      {
        type: "ADD_WORKBENCH_TAB",
        tab: createBrowserTab({
          url,
          title,
          browserConversationId: event.conversationId,
        }),
        ...(event.activate === false ? { activate: false } : {}),
      },
    ];
  }
  const title = event.loading ? existing.title : requestedTitle;
  const actions: Action[] = [];
  if (existing.url !== url || existing.title !== title) {
    actions.push({
      type: "UPDATE_WORKBENCH_TAB",
      id: existing.id,
      updates: { url, title },
    });
  }
  if (event.activate !== false) {
    actions.push({ type: "ACTIVATE_WORKBENCH_TAB", id: existing.id });
  }
  return actions;
}

/** Closing a native process lease closes its durable browser tab as well. The
 * caller separately verifies that this is the latest opaque session so stale
 * cleanup can never remove a replacement page. */
export function planBrowserSessionClose(
  tabs: WorkbenchTab[],
  event: Pick<BrowserSessionOpenEvent, "browserSessionId" | "conversationId">,
): Action[] {
  if (
    !isBrowserProductId(event.browserSessionId) ||
    !isBrowserProductId(event.conversationId)
  ) {
    return [];
  }
  const existing = tabs.find(
    (tab) =>
      tab.type === "browser" &&
      tab.browserConversationId === event.conversationId,
  );
  return existing ? [{ type: "REMOVE_WORKBENCH_TAB", id: existing.id }] : [];
}

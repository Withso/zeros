import { describe, expect, it } from "vitest";

import {
  browserSessionShouldExpandWorkbench,
  browserSessionEndsAgentOwnership,
  planBrowserSessionClose,
  planBrowserSessionOpen,
  retainLatestBrowserSession,
  retainPendingBrowserSession,
  shouldRevealBrowserSession,
  unseenBrowserSessionStates,
  validBrowserSessionState,
} from "../browser-session-routing";
import {
  createBrowserTab,
  type WorkbenchTab,
} from "../../../shell/workbench/tab-model";
import {
  browserSessionDismissedByUser,
  cachedBrowserFavicon,
  currentBrowserSessionActivity,
  dismissBrowserSession,
  nextConversationBrowserActivity,
  publishBrowserSessionActivity,
} from "../browser-session-activity-store";

describe("agent browser workbench routing", () => {
  it("keeps an explicitly collapsed workbench collapsed so live work opens in PiP", () => {
    expect(
      browserSessionShouldExpandWorkbench({
        shouldRevealSession: true,
        workbenchCollapsed: true,
      }),
    ).toBe(false);
    expect(
      browserSessionShouldExpandWorkbench({
        shouldRevealSession: true,
        workbenchCollapsed: false,
      }),
    ).toBe(true);
  });

  it("allows the same retained page to auto-reveal again on a later agent turn", () => {
    const retainedPage = browserState({
      browserSessionId: "browser-retained",
      conversationId: "conversation-a",
      url: "https://example.com/retained",
    });

    expect(
      browserSessionEndsAgentOwnership({
        ...retainedPage,
        actor: "user",
        status: "ready",
      }),
    ).toBe(true);
    expect(
      browserSessionEndsAgentOwnership({
        ...retainedPage,
        actor: "agent",
        status: "ready",
      }),
    ).toBe(false);
    expect(
      browserSessionEndsAgentOwnership({
        ...retainedPage,
        actor: "agent",
        status: "closed",
      }),
    ).toBe(true);
  });

  it("hydrates live sessions missed before subscription without replaying a raced event", () => {
    const missed = browserState({
      browserSessionId: "browser-missed",
      conversationId: "conversation-a",
      url: "https://example.com/missed",
    });
    const raced = browserState({
      browserSessionId: "browser-raced",
      conversationId: "conversation-b",
      url: "https://example.com/newer-event",
    });

    expect(
      unseenBrowserSessionStates([missed, raced], new Set(["browser-raced"])),
    ).toEqual([missed]);
  });

  it("reveals the first valid agent-owned page even when createTab began at about:blank", () => {
    const base = {
      activeConversation: true,
      workspaceSurfaceActive: true,
      sessionAlreadyRevealed: false,
      autoOpen: true,
      url: "https://example.com/",
      status: "working" as const,
      actor: "agent" as const,
      tool: "snapshot" as const,
    };
    expect(shouldRevealBrowserSession(base)).toBe(true);
    expect(
      shouldRevealBrowserSession({ ...base, activeConversation: false }),
    ).toBe(false);
    expect(
      shouldRevealBrowserSession({ ...base, sessionAlreadyRevealed: true }),
    ).toBe(false);
    expect(shouldRevealBrowserSession({ ...base, autoOpen: false })).toBe(
      false,
    );
    expect(shouldRevealBrowserSession({ ...base, url: "about:blank" })).toBe(
      false,
    );
    expect(shouldRevealBrowserSession({ ...base, actor: "user" })).toBe(false);
    expect(shouldRevealBrowserSession({ ...base, status: "closed" })).toBe(
      false,
    );
  });

  it("can reveal an already-created background tab once its conversation becomes active", () => {
    expect(
      shouldRevealBrowserSession({
        activeConversation: true,
        workspaceSurfaceActive: true,
        sessionAlreadyRevealed: false,
        autoOpen: true,
        url: "https://example.com/ready",
        status: "ready",
        actor: "agent",
        tool: "snapshot",
      }),
    ).toBe(true);
  });

  it("creates one durable conversation-owned tab without persisting a process session id", () => {
    const actions = planBrowserSessionOpen([], {
      browserSessionId: "browser-runtime-a",
      conversationId: "conversation-a",
      url: "https://example.com/path",
      title: "Example",
      activate: true,
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      type: "ADD_WORKBENCH_TAB",
      tab: {
        type: "browser",
        title: "Example",
        url: "https://example.com/path",
        browserConversationId: "conversation-a",
      },
    });
    expect((actions[0] as { tab: WorkbenchTab }).tab).not.toHaveProperty(
      "browserSessionId",
    );
  });

  it("updates a background conversation tab without activating it", () => {
    const tab = createBrowserTab({
      url: "https://example.com/old",
      title: "Old",
      browserConversationId: "conversation-a",
    });
    expect(
      planBrowserSessionOpen([tab], {
        browserSessionId: "browser-runtime-b",
        conversationId: "conversation-a",
        url: "https://example.com/new",
        title: "New",
        activate: false,
      }),
    ).toEqual([
      {
        type: "UPDATE_WORKBENCH_TAB",
        id: tab.id,
        updates: { url: "https://example.com/new", title: "New" },
      },
    ]);
  });

  it("keeps the last settled title while a new page is loading", () => {
    const tab = createBrowserTab({
      url: "https://example.com/old",
      title: "Stable page title",
      browserConversationId: "conversation-a",
    });
    expect(
      planBrowserSessionOpen([tab], {
        browserSessionId: "browser-runtime-b",
        conversationId: "conversation-a",
        url: "https://example.com/new",
        title: "Redirecting",
        loading: true,
        activate: false,
      }),
    ).toEqual([
      {
        type: "UPDATE_WORKBENCH_TAB",
        id: tab.id,
        updates: {
          url: "https://example.com/new",
          title: "Stable page title",
        },
      },
    ]);
  });

  it("does not flash a synthesized hostname before the first page title settles", () => {
    const actions = planBrowserSessionOpen([], {
      browserSessionId: "browser-runtime-loading",
      conversationId: "conversation-a",
      url: "https://nammatn.in/natural-resources",
      title: "Browser",
      loading: true,
      activate: false,
    });

    expect(actions).toMatchObject([
      {
        type: "ADD_WORKBENCH_TAB",
        tab: { title: "Browser" },
      },
    ]);
  });

  it("removes only the conversation-owned browser tab when its current session closes", () => {
    const browser = createBrowserTab({
      url: "https://example.com/",
      title: "Example",
      browserConversationId: "conversation-a",
    });
    const unrelated = createBrowserTab({
      url: "https://other.example/",
      title: "Other",
      browserConversationId: "conversation-b",
    });
    expect(
      planBrowserSessionClose([browser, unrelated], {
        browserSessionId: "browser-runtime-a",
        conversationId: "conversation-a",
      }),
    ).toEqual([{ type: "REMOVE_WORKBENCH_TAB", id: browser.id }]);
    expect(
      planBrowserSessionClose([browser], {
        browserSessionId: "not valid!",
        conversationId: "conversation-a",
      }),
    ).toEqual([]);
  });

  it("suppresses late live state after an explicit tab close until native close settles", () => {
    dismissBrowserSession("browser-user-closed");
    expect(browserSessionDismissedByUser("browser-user-closed")).toBe(true);

    publishBrowserSessionActivity({
      ...browserState({
        browserSessionId: "browser-user-closed",
        conversationId: "conversation-user-closed",
        url: "https://example.com/late",
      }),
      status: "closed",
    });
    expect(browserSessionDismissedByUser("browser-user-closed")).toBe(false);
  });

  it("does not let a delayed close erase a replacement runtime session", () => {
    const replacement = {
      browserSessionId: "browser-new",
      workspaceId: "workspace-a",
      conversationId: "conversation-a",
      url: "https://example.com/new",
      title: "New",
      loading: false,
      status: "ready" as const,
    };
    const staleClose = {
      ...replacement,
      browserSessionId: "browser-old",
      status: "closed" as const,
    };
    expect(nextConversationBrowserActivity(replacement, staleClose)).toBe(
      replacement,
    );
    const matchingClose = { ...staleClose, browserSessionId: "browser-new" };
    expect(nextConversationBrowserActivity(replacement, matchingClose)).toBe(
      matchingClose,
    );

    const latest = new Map([[replacement.conversationId, replacement]]);
    expect(
      retainLatestBrowserSession(latest, staleClose, 2).get(
        replacement.conversationId,
      ),
    ).toBe(replacement);
    expect(
      retainLatestBrowserSession(latest, matchingClose, 2).has(
        replacement.conversationId,
      ),
    ).toBe(false);
  });

  it("does not reuse a favicon across different browser origins", () => {
    const favicon = "data:image/png;base64,aGVsbG8=";
    publishBrowserSessionActivity({
      ...browserState({
        browserSessionId: "browser-favicon-origin",
        conversationId: "conversation-favicon-origin",
        url: "https://favicon-origin-boundary.invalid:8443/page",
      }),
      faviconDataUrl: favicon,
    });

    expect(
      cachedBrowserFavicon(
        "https://favicon-origin-boundary.invalid:8443/another-page",
      ),
    ).toBe(favicon);
    expect(
      cachedBrowserFavicon(
        "https://favicon-origin-boundary.invalid:9443/another-page",
      ),
    ).toBeUndefined();
    expect(
      cachedBrowserFavicon(
        "http://favicon-origin-boundary.invalid:8443/another-page",
      ),
    ).toBeUndefined();
  });

  it("retains a confirmed favicon when a later same-origin state omits artwork", () => {
    const favicon = "data:image/png;base64,c2FtZS1vcmlnaW4=";
    publishBrowserSessionActivity({
      ...browserState({
        browserSessionId: "browser-favicon-retained",
        conversationId: "conversation-favicon-retained",
        url: "https://same-origin-favicon.invalid/first",
      }),
      faviconDataUrl: favicon,
    });
    publishBrowserSessionActivity(
      browserState({
        browserSessionId: "browser-favicon-retained",
        conversationId: "conversation-favicon-retained",
        url: "https://same-origin-favicon.invalid/second",
      }),
    );

    expect(
      currentBrowserSessionActivity("browser-favicon-retained")?.faviconDataUrl,
    ).toBe(favicon);
  });

  it("does not rewrite a browser tab for action-only state events", () => {
    const tab = createBrowserTab({
      url: "https://example.com/current",
      title: "Current",
      browserConversationId: "conversation-a",
    });
    expect(
      planBrowserSessionOpen([tab], {
        browserSessionId: "browser-runtime-b",
        conversationId: "conversation-a",
        url: "https://example.com/current",
        title: "Current",
        activate: false,
      }),
    ).toEqual([]);
  });

  it("retains the newest pre-hydration event per conversation and removes a closed one", () => {
    const first = browserState({
      browserSessionId: "browser-a",
      conversationId: "conversation-a",
      url: "https://example.com/first",
    });
    const replacement = { ...first, url: "https://example.com/latest" };
    const second = browserState({
      browserSessionId: "browser-b",
      conversationId: "conversation-b",
      url: "https://example.com/second",
    });
    let pending = retainPendingBrowserSession(new Map(), first, 2);
    pending = retainPendingBrowserSession(pending, second, 2);
    pending = retainPendingBrowserSession(pending, replacement, 2);
    expect([...pending.values()]).toEqual([second, replacement]);
    expect(
      retainPendingBrowserSession(
        pending,
        { ...replacement, status: "closed" },
        2,
      ).has("conversation-a"),
    ).toBe(false);

    const newerSession = {
      ...replacement,
      browserSessionId: "browser-new",
      url: "https://example.com/reopened",
    };
    pending = retainPendingBrowserSession(pending, newerSession, 2);
    pending = retainPendingBrowserSession(
      pending,
      { ...replacement, browserSessionId: "browser-old", status: "closed" },
      2,
    );
    expect(pending.get("conversation-a")).toBe(newerSession);
  });

  it("retains the first-open reveal intent while its chat is still hydrating", () => {
    const opening = {
      ...browserState({
        browserSessionId: "browser-a",
        conversationId: "conversation-a",
        url: "https://example.com/loading",
      }),
      status: "working" as const,
      tool: "open" as const,
    };
    const settled = {
      ...opening,
      url: "https://example.com/ready",
      status: "ready" as const,
      tool: undefined,
    };
    const pending = retainPendingBrowserSession(
      retainPendingBrowserSession(new Map(), opening, 2),
      settled,
      2,
    );
    expect(pending.get("conversation-a")).toMatchObject({
      url: "https://example.com/ready",
      tool: "open",
    });
  });

  it("rejects malformed session events before they can route or attach", () => {
    const valid = browserState({
      browserSessionId: "browser-a",
      conversationId: "conversation-a",
      url: "https://example.com",
    });
    expect(validBrowserSessionState(valid)).toBe(true);
    expect(validBrowserSessionState({ ...valid, surfaceHovered: true })).toBe(
      true,
    );
    expect(
      validBrowserSessionState({
        ...valid,
        canGoBack: true,
        canGoForward: false,
      }),
    ).toBe(true);
    expect(validBrowserSessionState({ ...valid, canGoBack: "yes" })).toBe(
      false,
    );
    expect(
      validBrowserSessionState({
        ...valid,
        sourceViewport: { width: 1_440, height: 1_000 },
      }),
    ).toBe(true);
    expect(
      validBrowserSessionState({
        ...valid,
        sourceViewport: { width: 0, height: 1_000 },
      }),
    ).toBe(false);
    expect(validBrowserSessionState({ ...valid, surfaceHovered: "yes" })).toBe(
      false,
    );
    expect(validBrowserSessionState({ ...valid, actor: "provider" })).toBe(
      false,
    );
    expect(
      validBrowserSessionState({
        ...valid,
        pointer: { x: -1, y: 2, action: "click", updatedAt: Date.now() },
      }),
    ).toBe(false);
    expect(validBrowserSessionState({ ...valid, title: "x".repeat(513) })).toBe(
      false,
    );
    expect(
      validBrowserSessionState({
        ...valid,
        actor: "agent",
        status: "working",
        faviconDataUrl: "data:image/png;base64,aGVsbG8=",
        action: {
          sequence: 1,
          kind: "scroll",
          label: "Scrolling down…",
          startedAt: 1,
        },
        pointer: { x: 20, y: 30, action: "scroll", updatedAt: 1 },
        cancellable: true,
        agentActivityUntil: 2,
      }),
    ).toBe(true);
    expect(
      validBrowserSessionState({
        ...valid,
        faviconDataUrl: "https://tracker.example/favicon.png",
      }),
    ).toBe(false);
    expect(
      validBrowserSessionState({
        ...valid,
        action: {
          sequence: 0,
          kind: "snapshot",
          label: "Read",
          startedAt: 1,
        },
      }),
    ).toBe(false);
    expect(
      validBrowserSessionState({
        ...valid,
        actor: "user",
        status: "ready",
        cancellable: true,
      }),
    ).toBe(false);
  });
});

function browserState(input: {
  browserSessionId: string;
  conversationId: string;
  url: string;
}) {
  return {
    ...input,
    workspaceId: "workspace-a",
    title: "Browser",
    loading: false,
    status: "ready" as const,
  };
}

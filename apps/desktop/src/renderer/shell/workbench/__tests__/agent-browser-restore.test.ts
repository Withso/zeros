// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserSessionState } from "@zeros/protocol/browser-tools";

import { createBrowserTab, type WorkbenchTab } from "../tab-model";
import type { ChatThread } from "../../../state/store";
import type { Workspace } from "../../../platform/git";

// A conversation's Browser tab outlives the native page: tabs persist, while a
// window close, renderer reload or relaunch destroys the page. The user must
// be able to take the tab over from its last address without the agent.

const native = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: unknown) => Promise<unknown>>(),
  workspaces: [] as Workspace[],
  frames: new Map<number, FrameRequestCallback>(),
  nextFrame: 0,
}));

vi.mock("../../../platform/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../platform/runtime")>()),
  nativeInvoke: native.invoke,
  useNativeRuntime: () => ({ ready: true }),
}));
vi.mock("../../../state/use-projects", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../state/use-projects")>()),
  peekLiveWorkspaceUnion: () => native.workspaces,
}));
vi.mock("../../../features/team/cloud-workspace-account-access", () => ({
  useCloudWorkspaceAccountAccess: () => true,
  hasCloudWorkspaceAccountAccess: () => true,
}));
vi.mock("../../../features/agent/sessions-hooks", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../features/agent/sessions-hooks")
  >()),
  useAgentSessions: () => ({}),
}));

const FOLDER = "/Users/dev/zeros/worktree";
let conversationSerial = 0;

function conversationId(): string {
  conversationSerial += 1;
  return `33333333-3333-4333-8333-${String(conversationSerial).padStart(12, "0")}`;
}

function liveState(
  conversation: string,
  overrides: Partial<BrowserSessionState> = {},
): BrowserSessionState {
  return {
    browserSessionId: `browser_restored_${conversation.slice(-4)}`,
    workspaceId: "ws-local",
    conversationId: conversation,
    url: "https://cursor.com/",
    title: "AI Coding Agent for Builders",
    loading: true,
    status: "ready",
    actor: "user",
    tool: "open",
    ...overrides,
  };
}

function agentTab(conversation: string): WorkbenchTab {
  return createBrowserTab({
    url: "https://cursor.com/",
    title: "AI Coding Agent for Builders",
    browserConversationId: conversation,
  });
}

let host: HTMLDivElement;
let root: Root;

async function render(tab: WorkbenchTab, active: boolean) {
  const { BrowserTab } = await import("../tabs/browser-tab");
  const { TooltipProvider } = await import("../../../shared/ui/primitives");
  await act(async () => {
    root.render(
      createElement(
        TooltipProvider,
        null,
        createElement(BrowserTab, { tab, active, scope: FOLDER }),
      ),
    );
  });
}

/** Run the animation frames attach waits for, letting each frame's IPC settle,
 * until `done` holds. Frames are held, never timed. */
async function runFrames(done: () => boolean) {
  for (let round = 0; round < 10 && !done(); round += 1) {
    await act(async () => {
      const pending = [...native.frames.values()];
      native.frames.clear();
      for (const callback of pending) callback(0);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function attachCalls(browserSessionId: string) {
  return native.invoke.mock.calls.filter(
    ([command, args]) =>
      command === "browser_session_attach" &&
      (args as { browserSessionId?: string }).browserSessionId ===
        browserSessionId,
  ).length;
}

function restoreCalls() {
  return native.invoke.mock.calls.filter(
    ([command]) => command === "browser_session_restore",
  );
}

function addressInput(): HTMLInputElement {
  const input = host.querySelector<HTMLInputElement>(
    'input[aria-label="Browser URL"]',
  );
  if (!input) throw new Error("The agent Browser tab rendered no address bar.");
  return input;
}

async function seedConversation(conversation: string, tab: WorkbenchTab) {
  const { useWorkspaceStore } = await import("../../../state/store");
  useWorkspaceStore.setState({
    chats: [
      {
        id: conversation,
        folder: FOLDER,
        title: "Browse cursor.com",
      } as ChatThread,
    ],
    workbenchByScope: {
      [FOLDER]: { tabs: [tab], activeId: tab.id },
    } as never,
  });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  native.frames.clear();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    native.nextFrame += 1;
    native.frames.set(native.nextFrame, callback);
    return native.nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (frame: number) => {
    native.frames.delete(frame);
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 800,
    bottom: 600,
    width: 800,
    height: 600,
    toJSON: () => ({}),
  } as DOMRect);
  native.workspaces = [
    {
      id: "ws-local",
      path: FOLDER,
      repoRoot: "/Users/dev/zeros",
      placement: "local",
      archivedAt: null,
    } as Workspace,
  ];
  native.invoke.mockReset();
  native.invoke.mockImplementation(async (command) => {
    if (command === "browser_session_capture") return { dataUrl: null };
    return null;
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("taking over a conversation's Browser tab without a live page", () => {
  it("restores the tab's last page in the conversation's browser when shown", async () => {
    const conversation = conversationId();
    const tab = agentTab(conversation);
    await seedConversation(conversation, tab);
    const restored = liveState(conversation);
    native.invoke.mockImplementation(async (command) => {
      if (command === "browser_session_restore") return restored;
      if (command === "browser_session_attach") return restored;
      if (command === "browser_session_capture") return { dataUrl: null };
      return null;
    });

    await render(tab, true);
    await runFrames(() => attachCalls(restored.browserSessionId) > 0);

    expect(restoreCalls()).toEqual([
      [
        "browser_session_restore",
        {
          conversationId: conversation,
          url: "https://cursor.com/",
          owner: { workspaceId: "ws-local", workspaceRoot: FOLDER },
        },
      ],
    ]);
    // The restored page is the conversation's own native page: the tab binds
    // to it and moves it into its rectangle.
    expect(attachCalls(restored.browserSessionId)).toBe(1);
    expect(host.textContent).not.toContain(
      "The agent’s browser will appear here",
    );
  });

  it("lets the user open an address of their own without the agent", async () => {
    const conversation = conversationId();
    const tab = agentTab(conversation);
    await seedConversation(conversation, tab);
    let failFirst = true;
    native.invoke.mockImplementation(async (command, args) => {
      if (command === "browser_session_restore") {
        if (failFirst) {
          failFirst = false;
          throw new Error("Browser use is disabled in Settings.");
        }
        return liveState(conversation, {
          url: (args as { url: string }).url,
        });
      }
      if (command === "browser_session_capture") return { dataUrl: null };
      return null;
    });

    await render(tab, true);
    expect(host.textContent).toContain("Browser use is disabled in Settings.");
    const input = addressInput();
    expect(input.disabled).toBe(false);

    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      setValue.call(input, "https://docs.cursor.com/");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input.form!.requestSubmit();
    });

    expect(restoreCalls().at(-1)).toEqual([
      "browser_session_restore",
      {
        conversationId: conversation,
        url: "https://docs.cursor.com/",
        owner: { workspaceId: "ws-local", workspaceRoot: FOLDER },
      },
    ]);
  });

  it("reopens a published page that attach finds gone, then attaches it", async () => {
    const conversation = conversationId();
    const tab = agentTab(conversation);
    await seedConversation(conversation, tab);
    const stale = liveState(conversation, { loading: false, title: "Cursor" });
    const { publishBrowserSessionActivity } = await import(
      "../../../features/browser/browser-session-activity-store"
    );
    publishBrowserSessionActivity(stale);
    let pageExists = false;
    native.invoke.mockImplementation(async (command) => {
      if (command === "browser_session_attach") return pageExists ? stale : null;
      if (command === "browser_session_restore") {
        pageExists = true;
        return stale;
      }
      if (command === "browser_session_capture") return { dataUrl: null };
      return null;
    });

    await render(tab, true);
    await runFrames(() => attachCalls(stale.browserSessionId) >= 2);

    expect(restoreCalls()).toHaveLength(1);
    expect(attachCalls(stale.browserSessionId)).toBe(2);
    expect(host.textContent).not.toContain("no longer available");
  });

  it("reopens the page from Reload after a refused attempt", async () => {
    const conversation = conversationId();
    const tab = agentTab(conversation);
    await seedConversation(conversation, tab);
    const restored = liveState(conversation);
    let refuse = true;
    native.invoke.mockImplementation(async (command) => {
      if (command === "browser_session_restore") {
        if (refuse) throw new Error("Every isolated browser session is currently busy or visible.");
        return restored;
      }
      if (command === "browser_session_attach") return restored;
      if (command === "browser_session_capture") return { dataUrl: null };
      return null;
    });

    await render(tab, true);
    expect(restoreCalls()).toHaveLength(1);
    const reload = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Reload"]',
    )!;
    expect(reload.disabled).toBe(false);
    refuse = false;
    await act(async () => {
      reload.click();
    });
    await runFrames(() => attachCalls(restored.browserSessionId) > 0);

    expect(restoreCalls()).toHaveLength(2);
    expect(restoreCalls()[1]![1]).toMatchObject({ url: "https://cursor.com/" });
    expect(attachCalls(restored.browserSessionId)).toBe(1);
    expect(host.textContent).not.toContain("busy or visible");
  });

  it("never opens a page for a hidden tab", async () => {
    const conversation = conversationId();
    const tab = agentTab(conversation);
    await seedConversation(conversation, tab);

    await render(tab, false);

    expect(restoreCalls()).toEqual([]);
  });

  it("closes a page restored for a tab the user closed meanwhile", async () => {
    const conversation = conversationId();
    const tab = agentTab(conversation);
    await seedConversation(conversation, tab);
    const restored = liveState(conversation);
    let finishRestore!: (state: BrowserSessionState) => void;
    native.invoke.mockImplementation(async (command) => {
      if (command === "browser_session_restore") {
        return new Promise((resolve) => {
          finishRestore = resolve;
        });
      }
      if (command === "browser_session_capture") return { dataUrl: null };
      return null;
    });

    await render(tab, true);
    expect(restoreCalls()).toHaveLength(1);
    const { useWorkspaceStore } = await import("../../../state/store");
    await act(async () => {
      useWorkspaceStore.setState({
        workbenchByScope: {
          [FOLDER]: { tabs: [], activeId: null },
        } as never,
      });
      root.render(createElement("div"));
    });
    await act(async () => {
      finishRestore(restored);
      await Promise.resolve();
    });

    expect(native.invoke).toHaveBeenCalledWith("browser_session_close", {
      browserSessionId: restored.browserSessionId,
    });
    const { currentBrowserSessionActivity } = await import(
      "../../../features/browser/browser-session-activity-store"
    );
    expect(currentBrowserSessionActivity(restored.browserSessionId)).toBeNull();
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../../platform/git";
import type { ChatThread } from "../../../state/store";

const harness = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  spawn: vi.fn(),
  terminal: vi.fn(),
  slots: {} as Record<string, unknown>,
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const hooks = {
    useEffect: (effect: () => void | (() => void)) =>
      harness.effects.push(effect),
    useLayoutEffect: (effect: () => void | (() => void)) =>
      harness.effects.push(effect),
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) =>
      getSnapshot(),
  };
  return { ...react, ...hooks, default: { ...react, ...hooks } };
});
vi.mock("react-dom", async (original) => ({
  ...(await original<typeof import("react-dom")>()),
  createPortal: (child: unknown) => child,
}));
vi.mock("../../../state/store", async (original) => {
  const actual = await original<typeof import("../../../state/store")>();
  const read = actual.useWorkspaceStore.getState;
  return {
    ...actual,
    useWorkspaceStore: Object.assign(
      (select: (state: ReturnType<typeof read>) => unknown) => select(read()),
      { getState: read },
    ),
    useActiveChatId: () => read().activeChatId,
    useActivePage: () => read().activePage,
    useChats: () => read().chats,
    useNewAgentFolder: () => read().newAgentFolder,
    useWorkspaceDispatch: () => read().dispatch,
  };
});
vi.mock("../../../state/spawn-default-chat", () => ({
  spawnDefaultChatForWorkspace: harness.spawn,
}));
vi.mock("../../../features/agent/sessions-hooks", () => ({
  useAgentSessions: () => ({}),
}));
vi.mock("../../../state/use-projects", () => ({
  useProjectForFolder: () => ({
    id: "repo",
    repoRoot: "/repo",
    repoSlug: "repo",
  }),
  useProjects: () => ({ projects: [] }),
  useWorkspacesFor: () => ({ workspaces: [] }),
}));
vi.mock("../../../state/pending-workspaces", () => ({
  useWorkspaceProvisioning: () => false,
}));
vi.mock("../../../shared/ui/use-instant-view-switch", () => ({
  useInstantViewSwitch: () => {},
}));
vi.mock("../chat-tabs", () => ({
  ChatTabs: () => null,
  CHAT_STRIP_SHELL_CLS: "",
  CHAT_STRIP_LEADING_CLS: "",
  CHAT_STRIP_TRAILING_CLS: "",
}));
vi.mock("../pane-portal-store", async (original) => ({
  ...(await original<typeof import("../pane-portal-store")>()),
  usePanePortalsStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        panes: harness.slots,
        setSlot: () => {},
        getOrCreateHost: () => null,
      }),
    { getState: () => ({ panes: harness.slots, clearSlot: () => {} }) },
  ),
}));
vi.mock("../../terminal/terminal-session-view", () => ({
  TerminalSessionView: (props: unknown) => {
    harness.terminal(props);
    return null;
  },
}));

import { ConversationPaneLayout } from "../pane-layout";
import { TerminalDeck } from "../terminal-deck";
import { useWorkspaceStore } from "../../../state/workspace-store";
import { firstLeafId } from "../../../state/chat-panes";
import { getPaneLayout } from "../../../state/chat-panes-store";

const workspace = {
  id: "ws_link",
  path: "/tree",
  repoRoot: "/repo",
  repoSlug: "repo",
} as Workspace;
const cleanups: Array<() => void> = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), { setTimeout, clearTimeout }),
  );
  vi.stubGlobal(
    "document",
    Object.assign(new EventTarget(), { visibilityState: "visible" }),
  );
  vi.clearAllMocks();
  harness.effects = [];
  harness.slots = {};
  useWorkspaceStore.setState({
    chats: [],
    activeChatId: null,
    activePage: "workspace",
    newAgentFolder: "/tree",
    lastWorkspaceFolder: "/tree",
    pendingChatHydrationFolder: null,
    pendingWorkspaceValidationFolder: null,
  });
  useWorkspaceStore
    .getState()
    .dispatch({
      type: "OPEN_LOCAL_LINK",
      workspace,
      folder: "/tree",
      chat: null,
    });
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Local link surfaces stay passive", () => {
  it.each([true, false])(
    "suppresses default-chat creation only for navigation (passive=%s)",
    (passive) => {
      if (!passive)
        useWorkspaceStore
          .getState()
          .dispatch({ type: "ACTIVATE_LOCAL_LINK", folder: "/tree" });
      renderToStaticMarkup(
        createElement<
          NonNullable<Parameters<typeof ConversationPaneLayout>[0]>
        >(ConversationPaneLayout, { workspace }),
      );
      for (const effect of harness.effects.splice(0)) {
        const cleanup = effect();
        if (cleanup) cleanups.push(cleanup);
      }
      expect(harness.spawn).toHaveBeenCalledTimes(passive ? 0 : 1);
      expect(useWorkspaceStore.getState().chats).toEqual([]);
    },
  );

  it("does not start a terminal agent revealed in a saved split pane", () => {
    const chat = {
      id: "terminal",
      folder: "/tree",
      kind: "terminal",
      agentId: "codex",
    } as ChatThread;
    useWorkspaceStore.setState({ chats: [chat] });
    const pane = firstLeafId(getPaneLayout("/tree").root);
    harness.slots = { [pane]: { host: {}, activeChatId: chat.id } };
    renderToStaticMarkup(createElement(TerminalDeck));
    expect(harness.terminal).toHaveBeenLastCalledWith(
      expect.objectContaining({ visible: false }),
    );
    useWorkspaceStore
      .getState()
      .dispatch({ type: "ACTIVATE_LOCAL_LINK", folder: "/tree" });
    renderToStaticMarkup(createElement(TerminalDeck));
    expect(harness.terminal).toHaveBeenLastCalledWith(
      expect.objectContaining({ visible: true }),
    );
  });
});

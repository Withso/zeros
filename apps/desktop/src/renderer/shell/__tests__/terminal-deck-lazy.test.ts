import { isValidElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  chats: [] as Array<{ id: string; kind: string; folder: string; agentId: string; archived?: boolean }>,
  folder: "/personal/project", page: "workspace", active: "terminal-0",
  prepared: null as string | null,
  assignments: {} as Record<string, string>,
  panes: {} as Record<string, { host: unknown; activeChatId: string | null }>,
  refs: [] as Array<{ current: unknown }>, cursor: 0,
  effects: [] as Array<() => void>,
}));
vi.mock("react", async original => ({
  ...(await original<typeof import("react")>()),
  useRef: (initial: unknown) => fixture.refs[fixture.cursor++] ??= { current: initial },
  useMemo: (compute: () => unknown) => compute(),
  useLayoutEffect: (effect: () => void) => { fixture.effects.push(effect); },
}));
vi.mock("react-dom", () => ({ createPortal: (node: unknown) => node }));
vi.mock("zustand/react/shallow", () => ({ useShallow: (select: unknown) => select }));
vi.mock("../../state/store", () => ({
  selectActiveFolder: () => fixture.folder,
  useActivePage: () => fixture.page,
  useWorkspaceDispatch: () => vi.fn(),
  useWorkspaceStore: Object.assign((select: (state: unknown) => unknown) => select({ chats: fixture.chats }), {
    getState: () => ({ activeChatId: fixture.active }),
  }),
}));
vi.mock("../../state/chat-panes", () => ({ paneForChat: (_layout: unknown, id: string) => fixture.assignments[id] ?? "main" }));
vi.mock("../../state/chat-panes-store", () => ({ usePaneLayout: () => ({}) }));
vi.mock("../conversation/pane-portal-store", () => ({
  usePanePortalsStore: (select: (state: unknown) => unknown) => select({ panes: fixture.panes }),
}));
vi.mock("../terminal/terminal-session-view", () => ({ TerminalSessionView: () => null }));
vi.mock("../conversation/chat-intent", () => ({ usePreparedChatId: () => fixture.prepared }));

import { TerminalDeck } from "../conversation/terminal-deck";
import { TerminalSessionView } from "../terminal/terminal-session-view";

function sessionIds(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(sessionIds);
  if (!isValidElement<{ sessionId: string; children?: unknown }>(node)) return [];
  return node.type === TerminalSessionView ? [node.props.sessionId] : sessionIds(node.props.children);
}
function render(commit = true) {
  fixture.cursor = 0; fixture.effects.length = 0;
  const ids = sessionIds(TerminalDeck());
  if (commit) for (const effect of fixture.effects) effect();
  return ids;
}
function select(id: string, folder = fixture.folder) {
  fixture.active = id; fixture.folder = folder;
  fixture.panes = { main: { host: {}, activeChatId: id } };
}
beforeEach(() => {
  fixture.folder = "/personal/project"; fixture.page = "workspace";
  fixture.refs.length = 0; fixture.assignments = {};
  fixture.prepared = null;
  fixture.chats = Array.from({ length: 40 }, (_, i) => ({ id: `terminal-${i}`, kind: "terminal", folder: fixture.folder, agentId: "codex" }));
  select("terminal-0");
});

describe("Local terminal deck allocation", () => {
  it.each(["/personal/project", "/organization/project"])("%s mounts only displayed terminals from restored history", folder => {
    fixture.chats = fixture.chats.map(chat => ({ ...chat, folder })); select("terminal-0", folder);
    const ids = render();
    console.info(JSON.stringify({ savedTerminals: 40, allocatedViews: ids.length }));
    expect(ids).toEqual(["terminal-0"]);
  });

  it("retains opened Local terminals through A to B to A without allocating untouched chats", () => {
    expect(render()).toEqual(["terminal-0"]);
    select("terminal-1"); expect(render()).toEqual(["terminal-0", "terminal-1"]);
    select("terminal-0"); expect(render()).toEqual(["terminal-0", "terminal-1"]);
    fixture.page = "home"; expect(render()).toEqual(["terminal-0", "terminal-1"]);
  });

  it("allocates all visible split panes in the selection's first render", () => {
    fixture.assignments["terminal-1"] = "second";
    fixture.panes.second = { host: {}, activeChatId: "terminal-1" };
    expect(render()).toEqual(["terminal-0", "terminal-1"]);
  });

  it("warms only the newest intent and retains it only after it is opened", () => {
    render(); fixture.prepared = "terminal-1";
    expect(render()).toEqual(["terminal-0", "terminal-1"]);
    fixture.prepared = "terminal-2";
    expect(render()).toEqual(["terminal-0", "terminal-2"]);
    select("terminal-2"); render(); fixture.prepared = null;
    select("terminal-0"); expect(render()).toEqual(["terminal-0", "terminal-2"]);
  });

  it("never records an abandoned render or a missing portal host as an opened terminal", () => {
    render(); select("terminal-1"); render(false);
    select("terminal-0"); expect(render()).toEqual(["terminal-0"]);
    select("terminal-2"); fixture.panes.main.host = null; expect(render()).toEqual([]);
    select("terminal-0"); expect(render()).toEqual(["terminal-0"]);
  });

  it("prunes removed and archived identities before a replacement can be visited", () => {
    render(); fixture.chats[0].archived = true; select("terminal-1");
    expect(render()).toEqual(["terminal-1"]);
    fixture.chats[0].archived = false;
    expect(render()).toEqual(["terminal-1"]);
  });

  it("preserves all cloud terminal layers, including never-selected tabs", () => {
    const folder = "cloud://organization/workspace";
    fixture.chats = fixture.chats.map(chat => ({ ...chat, folder })); select("terminal-0", folder);
    expect(render()).toEqual(fixture.chats.map(chat => chat.id));
  });

  it("keeps Local visit history isolated while cloud is displayed", () => {
    fixture.chats.push({ id: "remote", folder: "cloud://organization/workspace", kind: "terminal", agentId: "codex" });
    expect(render()).toEqual(["terminal-0", "remote"]);
    select("remote", "cloud://organization/workspace"); expect(render()).toEqual(["terminal-0", "remote"]);
    select("terminal-1", "/personal/project"); expect(render()).toEqual(["terminal-0", "terminal-1", "remote"]);
  });
});

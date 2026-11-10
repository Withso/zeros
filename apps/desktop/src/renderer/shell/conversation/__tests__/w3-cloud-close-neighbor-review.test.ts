import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as closeHelpers from "../chat-close";
import { BLANK } from "../../../features/agent/sessions-store";
import { useWorkspaceStore, type Action } from "../../../state/workspace-store";
import type { ChatThread } from "../../../state/store";

// Pair the real tab-close callback with the real reducer/navigation epoch.
// Hold only the session-close acknowledgement so sibling edits can interleave.
const file = new URL("../pane-layout.tsx", import.meta.url);
const ast = ts.createSourceFile(file.pathname, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback = "";
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "closeTabNow" &&
      node.initializer && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0].getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
expect(callback).not.toBe("");
const code = ts.transpileModule(`globalThis.closeTab = ${callback};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

const cloud = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
beforeEach(() => {
  vi.stubGlobal("window", { setTimeout: () => 0, clearTimeout: () => {}, addEventListener: () => {} });
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
  useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
});
afterEach(() => {
  useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

function harness(folder = cloud) {
  const makeChat = (id: string, updatedAt: number): ChatThread => ({
    id, folder, title: id, createdAt: 10, updatedAt, agentId: "codex", agentName: "Codex",
    model: null, effort: "high", permissionMode: "auto",
  });
  const a = makeChat("closing-a", 100), b = makeChat("neighbor-b", 80), c = makeChat("survivor-c", 60);
  const chats = [a, b, c];
  useWorkspaceStore.setState({ chats, activeChatId: a.id, activePage: "workspace", lastWorkspaceFolder: folder,
    newAgentFolder: null, navigationVersion: 0 });
  const dispatchActual = useWorkspaceStore.getState().dispatch;
  const dispatch = vi.fn((action: Action) => dispatchActual(action));
  let confirm!: (ok: boolean) => void;
  const waiting = new Promise<boolean>(resolve => { confirm = resolve; });
  const closeSession = vi.fn(() => folder.startsWith("cloud://") ? waiting : undefined);
  const spawn = vi.fn();
  const context = vm.createContext({
    // The real editChat dispatches this same action synchronously, then (for a
    // chatEdits workspace) sends it to the control plane in the background.
    editChat: (send: (action: { type: string; id: string; title?: string }) => void, id: string, change: { title: string } | { archived: boolean }) =>
      send("title" in change ? { type: "UPDATE_CHAT_TITLE", id, title: change.title } : { type: change.archived ? "ARCHIVE_CHAT" : "UNARCHIVE_CHAT", id }),
    ...closeHelpers, readOnly: false, EMPTY_CHATS: [], useWorkspaceStore,
    useSessionsStore: { getState: () => ({ sessions: { [a.id]: { ...BLANK,
      messages: [{ kind: "text", role: "user", text: "saved history", id: "message-a", createdAt: 1 }] } } }) },
    chatsByPane: new Map([["pane", chats]]), visibleChats: chats, getLiveChatDraft: () => null,
    ptyKill: vi.fn(), closeSession, dispatch, spawnDefaultChatForWorkspace: spawn,
    sessions: { getCloseActivity: () => ({ running: false, queuedCount: 0 }) }, toast: { error: vi.fn() }, activeWorkspacePath: folder, setPaneActiveChat: vi.fn(),
    resolvePaneActiveChatId: () => a.id, layout: {},
  });
  vm.runInContext(code, context);
  return { a, b, c, dispatch, spawn, confirm, closeSession,
    close: () => (context.closeTab as (pane: string, chat: ChatThread) => void)("pane", a),
    state: useWorkspaceStore.getState };
}

describe("cloud close selects the pane neighbor at once, like Local", () => {
  it.each([cloud, "/personal/project", "/organization/project"])("archives and selects the live neighbor synchronously at %s", folder => {
    const h = harness(folder); h.close();
    expect(h.state().chats.find(row => row.id === h.a.id)?.archived).toBe(true);
    expect(h.state().activeChatId).toBe(h.b.id);
  });

  it("keeps a newer explicit selection made after an instant cloud close", () => {
    const h = harness(); h.close(); h.state().dispatch({ type: "SET_ACTIVE_CHAT", id: h.c.id });
    h.confirm(true);
    expect(h.state().activeChatId).toBe(h.c.id);
  });
});

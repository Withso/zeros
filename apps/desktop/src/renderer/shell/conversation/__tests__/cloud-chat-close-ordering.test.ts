import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import * as close from "../chat-close";
import { BLANK } from "../../../features/agent/sessions-store";

// Execute the real pane gesture, with its asynchronous session boundary held.
// No copy of archive or selection logic lives in the test.
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

function harness(local = false) {
  const chat = { id: "chat-a", folder: local ? "/personal/project" :
    "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222", title: "A saved chat", kind: "chat" };
  const state = { chats: [chat], activeChatId: chat.id, chatComposerDrafts: {}, navigationVersion: 0 };
  const actions: Array<{ type: string; id?: string }> = [];
  const dispatch = vi.fn((action: { type: string; id?: string }) => {
    actions.push(action);
    if (action.type === "ARCHIVE_CHAT" || action.type === "DELETE_CHAT") state.chats = state.chats.filter(row => row.id !== action.id);
  });
  let confirm!: (closed: boolean) => void;
  const wait = new Promise<boolean>(resolve => { confirm = resolve; });
  const closeSession = vi.fn(() => local ? undefined : wait);
  const spawn = vi.fn();
  const context = vm.createContext({
    ...close, readOnly: false, EMPTY_CHATS: [],
    useWorkspaceStore: { getState: () => state },
    useSessionsStore: { getState: () => ({ sessions: { [chat.id]: { ...BLANK, messages: [{ kind: "text", text: "retained" }] } } }) },
    chatsByPane: new Map([["pane", [chat]]]), getLiveChatDraft: () => null,
    ptyKill: vi.fn(), closeSession, dispatch, visibleChats: [chat],
    spawnDefaultChatForWorkspace: spawn, sessions: {}, activeWorkspacePath: chat.folder,
    setPaneActiveChat: vi.fn(), resolvePaneActiveChatId: () => chat.id, layout: {},
  });
  vm.runInContext(code, context);
  return { state, chat, actions, spawn, confirm, closeSession,
    close: () => (context.closeTab as (paneId: string, chat: unknown) => void)("pane", chat) };
}

describe("cloud tab close confirmation ordering", () => {
  it("archives only after the shared close operation confirms", async () => {
    const h = harness(); h.close();
    expect(h.closeSession).toHaveBeenCalledOnce(); expect(h.actions).toEqual([]);
    h.confirm(true); await vi.waitFor(() => expect(h.actions).toContainEqual({ type: "ARCHIVE_CHAT", id: h.chat.id }));
    expect(h.spawn).toHaveBeenCalledOnce();
  });

  it("keeps the tab visible when Stop or detach cannot be confirmed", async () => {
    const h = harness(); h.close(); h.confirm(false); await Promise.resolve();
    expect(h.actions).toEqual([]); expect(h.spawn).not.toHaveBeenCalled();
  });

  it.each([false, true])("does not move selection after navigation while close waits (return to A: %s)", async returnToA => {
    const h = harness(); h.close();
    h.state.activeChatId = "chat-b"; h.state.navigationVersion++;
    if (returnToA) { h.state.activeChatId = h.chat.id; h.state.navigationVersion++; }
    h.confirm(true); await vi.waitFor(() => expect(h.actions).toContainEqual({ type: "ARCHIVE_CHAT", id: h.chat.id }));
    expect(h.actions).toEqual([{ type: "ARCHIVE_CHAT", id: h.chat.id }]);
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it("ignores a close reply for a chat removed while Stop waits", async () => {
    const h = harness(); h.close(); h.state.chats = []; h.confirm(true); await Promise.resolve();
    expect(h.actions).toEqual([]); expect(h.spawn).not.toHaveBeenCalled();
  });

  it("does not create a default tab when a live sibling appeared during close", async () => {
    const h = harness(); h.close();
    h.state.chats.push({ ...h.chat, id: "chat-b" });
    h.confirm(true);
    await vi.waitFor(() => expect(h.actions).toContainEqual({ type: "ARCHIVE_CHAT", id: h.chat.id }));
    expect(h.actions).toEqual([{ type: "ARCHIVE_CHAT", id: h.chat.id }]);
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it("keeps Local close and archive synchronous", () => {
    const h = harness(true); h.close();
    expect(h.actions[0]).toEqual({ type: "ARCHIVE_CHAT", id: h.chat.id });
    expect(h.spawn).toHaveBeenCalledOnce();
  });
});

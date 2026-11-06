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

function harness(local = false, running = false, pristine = false) {
  const chat = { id: "chat-a", folder: local ? "/personal/project" :
    "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222", title: pristine ? "" : "A saved chat", kind: "chat", agentName: "Codex" };
  const state = { chats: [chat], activeChatId: chat.id, chatComposerDrafts: {}, navigationVersion: 0 };
  const actions: Array<{ type: string; id?: string }> = [];
  const dispatch = vi.fn((action: { type: string; id?: string }) => {
    actions.push(action);
    if (action.type === "ARCHIVE_CHAT" || action.type === "DELETE_CHAT") state.chats = state.chats.filter(row => row.id !== action.id);
    if (action.type === "UNARCHIVE_CHAT") state.chats = [chat];
  });
  let confirm!: (closed: boolean) => void;
  const wait = new Promise<boolean>(resolve => { confirm = resolve; });
  const closeSession = vi.fn(() => local ? undefined : wait);
  const spawn = vi.fn();
  const toast = { error: vi.fn() };
  const context = vm.createContext({
    ...close, readOnly: false, EMPTY_CHATS: [],
    useWorkspaceStore: { getState: () => state },
    useSessionsStore: { getState: () => ({ sessions: { [chat.id]: { ...BLANK, messages: pristine ? [] : [{ kind: "text", text: "retained" }] } } }) },
    chatsByPane: new Map([["pane", [chat]]]), getLiveChatDraft: () => null,
    ptyKill: vi.fn(), closeSession, dispatch, visibleChats: [chat],
    spawnDefaultChatForWorkspace: spawn, activeWorkspacePath: chat.folder, toast,
    sessions: { getCloseActivity: () => ({ running, queuedCount: 0 }) },
    setPaneActiveChat: vi.fn(), resolvePaneActiveChatId: () => chat.id, layout: {},
  });
  vm.runInContext(code, context);
  return { state, chat, actions, spawn, confirm, closeSession, toast,
    close: () => (context.closeTab as (paneId: string, chat: unknown) => void)("pane", chat) };
}

describe("cloud tab close is instant", () => {
  it("archives at once and lets the shared cloud close finish in the background", () => {
    const h = harness(); h.close();
    expect(h.closeSession).toHaveBeenCalledOnce();
    expect(h.actions[0]).toEqual({ type: "ARCHIVE_CHAT", id: h.chat.id });
    expect(h.spawn).toHaveBeenCalledOnce();
  });

  it("offers to reopen a working chat whose background Stop is not confirmed", async () => {
    const h = harness(false, true); h.close(); h.confirm(false);
    await vi.waitFor(() => expect(h.toast.error).toHaveBeenCalledOnce());
    const [, options] = h.toast.error.mock.calls[0] as [string, { action: { onClick: () => void } }];
    options.action.onClick();
    expect(h.actions).toContainEqual({ type: "UNARCHIVE_CHAT", id: h.chat.id });
    expect(h.actions).toContainEqual({ type: "SET_ACTIVE_CHAT", id: h.chat.id });
  });

  it.each([[true, true], [false, false]])("stays quiet when Stop confirms (%s) or an idle detach is unconfirmed", async (running, confirmed) => {
    const h = harness(false, running); h.close(); h.confirm(confirmed);
    await Promise.resolve(); await Promise.resolve();
    expect(h.toast.error).not.toHaveBeenCalled();
  });

  it("archives rather than discards a pristine-looking chat that was working", () => {
    const h = harness(false, true, true); h.close();
    expect(h.actions[0]).toEqual({ type: "ARCHIVE_CHAT", id: h.chat.id });
  });

  it("keeps Local close and archive synchronous", () => {
    const h = harness(true); h.close();
    expect(h.actions[0]).toEqual({ type: "ARCHIVE_CHAT", id: h.chat.id });
    expect(h.spawn).toHaveBeenCalledOnce();
  });
});

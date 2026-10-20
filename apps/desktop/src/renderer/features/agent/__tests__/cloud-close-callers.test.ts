import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { BLANK } from "../sessions-store";

// Run the actual two close callers. Hold only their shared session boundary.
const file = new URL("../agent-chat.tsx", import.meta.url);
const ast = ts.createSourceFile(file.pathname, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const callbacks = new Map<string, string>();
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && ["switchAgentModel", "runInlineSlashCommand"].includes(node.name.getText(ast)) &&
      node.initializer && ts.isCallExpression(node.initializer)) callbacks.set(node.name.getText(ast), node.initializer.arguments[0].getText(ast));
  ts.forEachChild(node, visit);
}
visit(ast);
expect(callbacks.size).toBe(2);
const code = ts.transpileModule([...callbacks].map(([name, body]) => `globalThis.${name} = ${body};`).join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function harness(local = false) {
  const chat = { id: "chat-a", folder: local ? "/personal/project" :
    "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222",
  title: "Untitled", agentId: "codex", kind: "chat", updatedAt: 1 };
  const state = { chats: [chat], activeChatId: chat.id, navigationVersion: 0 };
  let confirm!: (closed: boolean) => void;
  const pending = new Promise<boolean>(resolve => { confirm = resolve; });
  const closeSession = vi.fn(() => local ? undefined : pending);
  const dispatch = vi.fn(), update = vi.fn();
  const context = vm.createContext({
    chatId: chat.id, chatThread: chat, session: {}, agentSessions: { closeSession },
    useSessionsStore: { getState: () => ({ sessions: { [chat.id]: { ...BLANK } } }) },
    useWorkspaceStore: { getState: () => state }, dispatch, updateChatSettings: update,
    newChatBornDefaults: () => ({ permissionMode: "auto" }),
    resolveModelConfiguration: () => ({ effort: "high", fast: false }),
    slashCommandKind: () => "inline", newChatId: () => "chat-new",
  });
  vm.runInContext(code, context);
  return { state, chat, confirm, closeSession, dispatch, update,
    clear: () => (context.runInlineSlashCommand as (name: string) => boolean)("clear"),
    switch: () => (context.switchAgentModel as (selection: unknown) => void)({ agentId: "claude", model: "model" }) };
}

describe("cloud session close callers", () => {
  it("does not publish a fresh chat or archive until clear confirms", async () => {
    const h = harness(); expect(h.clear()).toBe(true);
    expect(h.closeSession).toHaveBeenCalledOnce(); expect(h.dispatch).not.toHaveBeenCalled();
    h.confirm(true); await vi.waitFor(() => expect(h.dispatch).toHaveBeenCalledTimes(2));
    expect(h.dispatch.mock.calls.map(([action]) => action.type)).toEqual(["ADD_CHAT", "ARCHIVE_CHAT"]);
  });

  it("keeps clear and model changes inert after an unconfirmed close", async () => {
    const clear = harness(), model = harness(); clear.clear(); model.switch();
    clear.confirm(false); model.confirm(false); await Promise.resolve();
    expect(clear.dispatch).not.toHaveBeenCalled(); expect(model.update).not.toHaveBeenCalled();
  });

  it.each([false, true])("does not navigate for a late clear after leaving (return to A: %s)", async returnToA => {
    const h = harness(); h.clear(); h.state.activeChatId = "chat-b"; h.state.navigationVersion++;
    if (returnToA) { h.state.activeChatId = h.chat.id; h.state.navigationVersion++; }
    h.confirm(true); await vi.waitFor(() => expect(h.dispatch).toHaveBeenCalledWith({ type: "ARCHIVE_CHAT", id: h.chat.id }));
    expect(h.dispatch).toHaveBeenCalledOnce();
  });

  it("waits for close before replacing a pristine cloud agent", async () => {
    const h = harness(); h.switch(); expect(h.update).not.toHaveBeenCalled();
    h.confirm(true); await vi.waitFor(() => expect(h.update).toHaveBeenCalledOnce());
    expect(h.update).toHaveBeenCalledWith(expect.objectContaining({ agentId: "claude", model: "model" }));
  });

  it("does not overwrite a newer selection when an older close finishes", async () => {
    const h = harness(); h.switch(); h.state.chats = [{ ...h.chat, agentId: "cursor", updatedAt: 2 }];
    h.confirm(true); await Promise.resolve(); expect(h.update).not.toHaveBeenCalled();
  });

  it("keeps Local clear and pristine agent changes synchronous", () => {
    const clear = harness(true), model = harness(true); clear.clear(); model.switch();
    expect(clear.dispatch.mock.calls.map(([action]) => action.type)).toEqual(["ADD_CHAT", "ARCHIVE_CHAT"]);
    expect(model.update).toHaveBeenCalledOnce();
  });
});

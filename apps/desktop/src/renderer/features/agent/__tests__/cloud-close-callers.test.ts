import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { BLANK } from "../sessions-store";
import { isCloudWorkspace } from "../../../platform/bridge/cloud-workspace-key";
import { canSwitchPristineChat } from "../pristine-chat";

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

function harness(local = false, title = "Untitled") {
  const chat = { id: "chat-a", folder: local ? "/personal/project" :
    "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222",
  title, agentId: "codex", kind: "chat", updatedAt: 1 };
  const state = { chats: [chat], activeChatId: chat.id, navigationVersion: 0, chatComposerDrafts: {} };
  const slot = { ...BLANK };
  let confirm!: (closed: boolean) => void;
  const pending = new Promise<boolean>(resolve => { confirm = resolve; });
  const closeSession = vi.fn((_id: string, options?: { reason: string }) => local || options?.reason === "agent-switch" ? undefined : pending);
  const dispatch = vi.fn(), update = vi.fn((updates: object) => {
    const current = state.chats.find(row => row.id === chat.id)!;
    state.chats = state.chats.map(row => row.id === chat.id ? { ...row, ...updates, updatedAt: row.updatedAt + 1 } : row);
    context.chatThread = { ...current, ...updates, updatedAt: current.updatedAt + 1 };
  });
  const hydrateChat = vi.fn(async () => { slot.transcriptState = "resident"; });
  const context = vm.createContext({
    chatId: chat.id, chatThread: chat, session: {}, agentSessions: { closeSession, hydrateChat }, agentSwitchRef: { current: 0 },
    useSessionsStore: { getState: () => ({ sessions: { [chat.id]: slot } }) },
    useWorkspaceStore: { getState: () => state }, dispatch, updateChatSettings: update,
    newChatBornDefaults: () => ({ permissionMode: "auto" }),
    resolveModelConfiguration: () => ({ effort: "high", fast: false }),
    slashCommandKind: () => "inline", newChatId: () => "chat-new",
    isCloudWorkspace, canSwitchPristineChat, getLiveChatDraft: () => null,
  });
  vm.runInContext(code, context);
  return { state, chat, slot, confirm, closeSession, dispatch, update, hydrateChat,
    clear: () => (context.runInlineSlashCommand as (name: string) => boolean)("clear"),
    switch: (agentId = "claude") => (context.switchAgentModel as (selection: unknown) => void)({ agentId, model: "model" }) };
}

describe("cloud session close callers", () => {
  it("does not create a second chat while a cloud empty-history read is pending", async () => {
    const h = harness(); h.slot.transcriptState = "loading";
    expect(() => h.switch()).not.toThrow();
    expect(h.dispatch).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(h.update).toHaveBeenCalledOnce());
    expect(h.hydrateChat).toHaveBeenCalledExactlyOnceWith(h.chat.id);
  });

  it("applies only the latest agent pick after shared hydration", async () => {
    const h = harness(); h.slot.transcriptState = "loading";
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    h.hydrateChat.mockImplementation(() => pending);
    h.switch("claude"); h.switch("cursor");
    h.slot.transcriptState = "resident"; finish();
    await vi.waitFor(() => expect(h.update).toHaveBeenCalledOnce());
    expect(h.state.chats[0].agentId).toBe("cursor"); expect(h.dispatch).not.toHaveBeenCalled();
  });

  it("does not apply a deferred pick after leaving and returning to the view", async () => {
    const h = harness(); h.slot.transcriptState = "loading";
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; }); h.hydrateChat.mockImplementation(() => pending);
    h.switch(); h.state.navigationVersion += 2;
    h.slot.transcriptState = "resident"; finish(); await Promise.resolve();
    expect(h.update).not.toHaveBeenCalled(); expect(h.dispatch).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps every agent hop on the same empty tab (Local: %s)", local => {
    const h = harness(local);
    for (const agent of ["claude", "cursor", "claude", "codex"]) {
      h.switch(agent);
      expect(h.state.chats).toHaveLength(1); expect(h.state.chats[0].agentId).toBe(agent);
      expect(h.state.activeChatId).toBe(h.chat.id);
    }
    expect(h.dispatch).not.toHaveBeenCalled();
  });
  it.each(["Untitled", ""])("switches an untouched cloud title %j synchronously in the same tab", title => {
    const h = harness(false, title);
    expect(() => h.switch()).not.toThrow();
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.closeSession).toHaveBeenCalledExactlyOnceWith(h.chat.id, { reason: "agent-switch" });
    expect(h.update).toHaveBeenCalledWith(expect.objectContaining({ agentId: "claude", model: "model", sessionId: undefined }));
    expect(h.state.chats).toHaveLength(1); expect(h.state.activeChatId).toBe(h.chat.id);
  });

  it.each(["Untitled", ""])("keeps repeated agent picks on the failed first cloud chat (%j)", title => {
    const h = harness(false, title);
    h.chat.agentId = "cursor";
    Object.assign(h.slot, { agentId: "cursor", status: "failed", error: "Cloud conversation is unavailable.",
      failure: { kind: "protocol-error", stage: "loadSession", agentId: "cursor", message: "Cloud conversation is unavailable." } });
    for (const agent of ["claude", "claude", "cursor"]) {
      h.switch(agent);
      expect(h.state.chats).toHaveLength(1);
      expect(h.state.chats[0]).toMatchObject({ id: h.chat.id, agentId: agent });
      expect(h.state.activeChatId).toBe(h.chat.id);
    }
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.hydrateChat).not.toHaveBeenCalled();
    expect(h.closeSession).toHaveBeenCalledTimes(3);
    for (const call of h.closeSession.mock.calls) expect(call).toEqual([h.chat.id, { reason: "agent-switch" }]);
  });

  it.each(["/personal/project", "/organization/project"])("keeps the failed, unused Local chat at %s in place", folder => {
    const h = harness(true); h.chat.folder = folder;
    Object.assign(h.slot, { status: "failed", error: "Agent did not start" });
    h.switch();
    expect(h.state.chats).toHaveLength(1); expect(h.state.activeChatId).toBe(h.chat.id);
    expect(h.closeSession).toHaveBeenCalledExactlyOnceWith(h.chat.id);
    expect(h.update).toHaveBeenCalledOnce(); expect(h.dispatch).not.toHaveBeenCalled();
  });

  it("still opens a different chat when the failure followed a sent message", () => {
    const h = harness();
    Object.assign(h.slot, { status: "failed", error: "Turn failed", hasTranscript: true,
      messages: [{ id: "sent", kind: "text", role: "user", text: "hello", createdAt: 1 }] });
    h.switch();
    expect(h.closeSession).not.toHaveBeenCalled(); expect(h.update).not.toHaveBeenCalled();
    expect(h.dispatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: "ADD_CHAT",
      chat: expect.objectContaining({ id: "chat-new", agentId: "claude" }) }));
    expect(h.state.chats[0].agentId).toBe("codex");
  });
  it("does not publish a fresh chat or archive until clear confirms", async () => {
    const h = harness(); expect(h.clear()).toBe(true);
    expect(h.closeSession).toHaveBeenCalledOnce(); expect(h.dispatch).not.toHaveBeenCalled();
    h.confirm(true); await vi.waitFor(() => expect(h.dispatch).toHaveBeenCalledTimes(2));
    expect(h.dispatch.mock.calls.map(([action]) => action.type)).toEqual(["ADD_CHAT", "ARCHIVE_CHAT"]);
  });

  it("keeps clear inert after an unconfirmed close", async () => {
    const clear = harness(); clear.clear();
    clear.confirm(false); await Promise.resolve();
    expect(clear.dispatch).not.toHaveBeenCalled();
  });

  it.each([false, true])("does not navigate for a late clear after leaving (return to A: %s)", async returnToA => {
    const h = harness(); h.clear(); h.state.activeChatId = "chat-b"; h.state.navigationVersion++;
    if (returnToA) { h.state.activeChatId = h.chat.id; h.state.navigationVersion++; }
    h.confirm(true); await vi.waitFor(() => expect(h.dispatch).toHaveBeenCalledWith({ type: "ARCHIVE_CHAT", id: h.chat.id }));
    expect(h.dispatch).toHaveBeenCalledOnce();
  });

  it("does not let a late old close overwrite an immediate pristine cloud selection", async () => {
    const h = harness(); h.switch(); expect(h.update).toHaveBeenCalledOnce();
    h.confirm(true); await Promise.resolve(); expect(h.update).toHaveBeenCalledOnce();
    expect(h.update).toHaveBeenCalledWith(expect.objectContaining({ agentId: "claude", model: "model" }));
  });

  it("does not overwrite a newer selection when an older close finishes", async () => {
    const h = harness(); h.switch(); h.state.chats = [{ ...h.chat, agentId: "cursor", updatedAt: 2 }];
    h.confirm(true); await Promise.resolve(); expect(h.update).toHaveBeenCalledOnce();
  });

  it("keeps Local clear and pristine agent changes synchronous", () => {
    const clear = harness(true), model = harness(true); clear.clear(); model.switch();
    expect(clear.dispatch.mock.calls.map(([action]) => action.type)).toEqual(["ADD_CHAT", "ARCHIVE_CHAT"]);
    expect(model.update).toHaveBeenCalledOnce();
  });
});

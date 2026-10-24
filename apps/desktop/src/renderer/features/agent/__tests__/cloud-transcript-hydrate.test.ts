// Run the production callbacks against the real stores. Every network and
// disk boundary is controlled independently; no timer can make a read pass.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloudScopedId, cloudWorkspaceKey, isCloudWorkspace, parseCloudScopedId } from "../../../platform/bridge/cloud-workspace-key";
import { BLANK, mergeWindowedTail, useSessionsStore } from "../sessions-store";
import { reconcileHistoryMessages } from "../history-message-identity";
import { messageSnapshotsEqual, retainMessageReferences } from "../message-persistence-tracker";
import { canApplyTranscriptRead, invalidateTranscriptRequest, isCurrentTranscriptRequest, releaseTranscriptRequest, hasTranscriptPresentation } from "../transcript-retention";
import type { AgentMessage, AgentTextMessage } from "../use-agent-session";
import * as caches from "../../../state/local-transcript-cache";
import * as presentation from "../local-transcript-presentation";
import { consumeFreshCloudChat } from "../fresh-cloud-chats";

const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const folder = cloudWorkspaceKey(target), id = cloudScopedId(target, "chat");
const owner = JSON.stringify(["https://api.example.test", "account-a"]);
const user = (id: string): AgentTextMessage => ({ id, kind: "text", role: "user", text: id, createdAt: 1 });
const agent = (id: string, text = id): AgentMessage => ({ id, kind: "text", role: "agent", text, createdAt: 2 });
type Page = { messages: AgentMessage[]; source: "worker" | "control-plane"; complete?: boolean; leadingPrompt?: AgentTextMessage };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const ast = ts.createSourceFile("sessions-provider.tsx", readFileSync(new URL("../sessions-provider.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const callbacks: Record<string, string> = {};
let subscription = "";
(function collect(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && ["hydrateChat", "reconcileChatMessages"].includes(node.name.getText(ast)) && node.initializer && ts.isCallExpression(node.initializer))
    callbacks[node.name.getText(ast)] = node.initializer.arguments[0]!.getText(ast);
  if (ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect" &&
      node.arguments[0]?.getText(ast).includes("rememberTranscript(")) subscription = node.arguments[0].getText(ast);
  ts.forEachChild(node, collect);
})(ast);
const code = ts.transpileModule(Object.entries({ ...callbacks, subscribe: subscription }).map(([name, source]) => `globalThis.${name} = ${source};`).join("\n"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function harness() {
  const page = deferred<Page>(), read = vi.fn(async () => page.promise);
  const context: Record<string, unknown> = {
    console: { warn: vi.fn() }, BLANK, parseCloudScopedId, isCloudWorkspace, cloudComputerV2: true, HYDRATE_WINDOW: 200,
    reconcileHistoryMessages, messageSnapshotsEqual, retainMessageReferences, isCurrentTranscriptRequest, releaseTranscriptRequest,
    canApplyTranscriptRead, invalidateTranscriptRequest, mergeWindowedTail, canBackgroundSyncCloudWorkspace: () => true,
    reconcileInFlightRef: { current: new Map() }, hydrateInFlightRef: { current: new Map() }, pendingHydratesRef: { current: new Set() },
    getStore: useSessionsStore.getState, useWorkspaceStore: { getState: () => ({ chats: [{ id, folder }] }) },
    bridge: { status: "connecting", request: vi.fn(() => new Promise(() => {})) },
    persistMessageWindow: read, reconcileChatMessages: vi.fn(async () => {}), reconcileChatMessagesRef: { current: vi.fn() },
    consumeFreshCloudChat, ...caches, ...presentation, useSessionsStore, window: { setTimeout, clearTimeout },
    forgetEmptyLocalChat: vi.fn(), rememberEmptyLocalChat: vi.fn(), forgetLocalChatPrompt: vi.fn(), noteLocalChatPrompt: vi.fn(),
  };
  vm.runInNewContext(code, context);
  return { read, resolve: page.resolve, hydrate: context.hydrateChat as (id: string) => Promise<void>,
    reconcile: context.reconcileChatMessages as (id: string) => Promise<void>, subscribe: context.subscribe as () => () => void };
}
const slot = () => useSessionsStore.getState().sessions[id];
beforeEach(() => {
  useSessionsStore.getState().clearAll();
  caches.cloudTranscriptCache.bindOwner(owner, true);
  caches.cloudTranscriptCache.resetForTesting();
});
afterEach(() => { caches.cloudTranscriptCache.resetForTesting(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("cloud cached transcript hydration", () => {
  it("captures once after settlement, never per stream chunk, and preserves a confirmed cache through cold/loading slots", () => {
    vi.useFakeTimers();
    const remember = vi.spyOn(caches.cloudTranscriptCache, "remember");
    const stop = harness().subscribe();
    try {
      useSessionsStore.getState().setSession(id, { ...BLANK, cwd: folder, status: "streaming", transcriptState: "resident", transcriptSource: "worker", messages: [user("prompt")] });
      for (let chunk = 0; chunk < 5; chunk++) {
        useSessionsStore.getState().patchSession(id, { messages: [user("prompt"), agent("answer", "chunk ".repeat(chunk + 1))] });
        vi.advanceTimersByTime(1000);
      }
      expect(remember).not.toHaveBeenCalled();
      useSessionsStore.getState().patchSession(id, { status: "ready" });
      vi.advanceTimersByTime(750);
      expect(remember).toHaveBeenCalledTimes(1);
      const confirmed = caches.cloudTranscriptCache.peek(id);
      for (const transcriptState of ["cold", "loading"] as const)
        presentation.rememberTranscript(id, { ...slot(), transcriptState, messages: [] }, folder);
      expect(caches.cloudTranscriptCache.peek(id)).toBe(confirmed);
      useSessionsStore.getState().patchSession(id, { messages: [agent("optimistic")], cloudPromptPending: true });
      vi.advanceTimersByTime(750);
      expect(caches.cloudTranscriptCache.peek(id)).toBe(confirmed);
    } finally { stop(); }
  });

  it("allows a replacement account to hydrate before the retired account's network read returns", async () => {
    const h = harness(), stop = h.subscribe();
    try {
      const old = h.hydrate(id);
      caches.cloudTranscriptCache.bindOwner("account-b", true);
      useSessionsStore.getState().removeSession(id);
      caches.cloudTranscriptCache.bindOwner(owner, true);
      void h.hydrate(id);
      expect(h.read).toHaveBeenCalledTimes(2);
      h.resolve({ messages: [], source: "control-plane", complete: true });
      await old;
    } finally { stop(); }
  });
  it("keeps the opening prompt beside a cached tail that begins inside a long turn", () => {
    const leading = user("opening"), messages = [agent("tail")];
    caches.cloudTranscriptCache.remember(id, folder, { messages, leadingPrompt: leading, source: "control-plane" });
    void harness().hydrate(id);
    expect(slot()?.leadingPrompt).toBe(leading);
  });
  it("hydrates the cloud window's existing opening-prompt field and captures it beside a long tail", async () => {
    const h = harness(), pending = h.hydrate(id), leadingPrompt = user("opening");
    h.resolve({ messages: [agent("tail")], leadingPrompt, source: "worker", complete: false });
    await pending;
    expect(slot()?.leadingPrompt).toBe(leadingPrompt);
    presentation.rememberTranscript(id, slot(), folder);
    expect(caches.cloudTranscriptCache.peek(id)?.leadingPrompt).toBe(leadingPrompt);
  });
  it("applies an edited opening prompt when the cloud tail itself is unchanged", async () => {
    const messages = [agent("tail")], opening = user("opening");
    useSessionsStore.getState().setSession(id, { ...BLANK, cwd: folder, messages, leadingPrompt: opening,
      transcriptState: "resident", transcriptSource: "control-plane" });
    const h = harness(), pending = h.reconcile(id), leadingPrompt = { ...opening, text: "edited opening" };
    h.resolve({ messages: structuredClone(messages), leadingPrompt, source: "control-plane", complete: false });
    await pending;
    expect(slot()?.messages).toBe(messages);
    expect(slot()?.leadingPrompt).toBe(leadingPrompt);
  });
  it("paints the cached window synchronously while every bridge/network promise is held", () => {
    const messages = [user("prompt"), agent("answer")];
    caches.cloudTranscriptCache.remember(id, folder, { messages, leadingPrompt: null, source: "control-plane" });
    const h = harness();
    void h.hydrate(id);
    expect(slot()?.messages).toBe(messages);
    expect(slot()).toMatchObject({ transcriptState: "loading", transcriptPresentation: { source: "cache" }, sessionId: null });
    expect(hasTranscriptPresentation(slot())).toBe(true);
    expect(canApplyTranscriptRead(slot(), slot())).toBe(false);
    expect(h.read).toHaveBeenCalledTimes(1);
  });

  it("paints a disk result before the authoritative read settles", async () => {
    const disk = deferred<caches.LocalTranscriptWindow | null>();
    vi.spyOn(caches.cloudTranscriptCache, "read").mockReturnValueOnce(disk.promise);
    const h = harness(), pending = h.hydrate(id);
    const messages = [user("prompt"), agent("answer")];
    disk.resolve({ messages, leadingPrompt: null, source: "control-plane" });
    await disk.promise; await Promise.resolve();
    expect(slot()?.messages).toBe(messages);
    expect(slot()?.transcriptState).toBe("loading");
    h.resolve({ messages: structuredClone(messages), source: "control-plane", complete: true });
    await pending;
    expect(slot()?.messages).toBe(messages);
  });

  it("keeps unchanged references, replaces edits and drops deleted rows on complete revalidation", async () => {
    const messages = [user("prompt"), agent("edited", "before"), agent("deleted")];
    caches.cloudTranscriptCache.remember(id, folder, { messages, leadingPrompt: null, source: "control-plane" });
    const h = harness(), pending = h.hydrate(id);
    h.resolve({ source: "control-plane", complete: true, messages: [structuredClone(messages[0]), agent("edited", "after")] });
    await pending;
    expect(slot()?.messages[0]).toBe(messages[0]);
    expect(slot()?.messages.map(message => message.id)).toEqual(["prompt", "edited"]);
    expect(slot()?.messages[1]).toMatchObject({ text: "after" });
    expect(slot()).toMatchObject({ transcriptState: "resident", transcriptPresentation: null });
  });

  it.each([{ messages: [] }, { messages: [agent("deleted")] }])("accepts a complete authoritative empty window over rows or a retained history hint: $messages", async ({ messages }) => {
    useSessionsStore.getState().setSession(id, { ...BLANK, cwd: folder, messages, hasTranscript: true, transcriptState: "resident", transcriptSource: "control-plane" });
    const h = harness(), pending = h.reconcile(id);
    h.resolve({ messages: [], source: "control-plane", complete: true });
    await pending;
    expect(slot()?.messages).toEqual([]);
    expect(slot()?.hasTranscript).toBe(false);
  });

  it("does not replace a more recent worker window with a lagging mirror", async () => {
    const messages = [user("prompt"), agent("answer", "Latest worker output")];
    caches.cloudTranscriptCache.remember(id, folder, { messages, leadingPrompt: null, source: "worker" });
    const h = harness(), pending = h.hydrate(id);
    h.resolve({ source: "control-plane", complete: true, messages: [user("prompt")] });
    await pending;
    expect(slot()?.messages).toBe(messages);
    expect(slot()).toMatchObject({ transcriptState: "loading", transcriptPresentation: { source: "cache" } });
    expect(hasTranscriptPresentation(slot())).toBe(true);
  });

  it("confirms a worker cache when the mirror catches up without replacing unchanged rows", async () => {
    const messages = [user("prompt"), agent("answer")];
    caches.cloudTranscriptCache.remember(id, folder, { messages, leadingPrompt: null, source: "worker" });
    const h = harness(), pending = h.hydrate(id);
    h.resolve({ source: "control-plane", complete: true, messages: structuredClone(messages) });
    await pending;
    expect(slot()?.messages).toBe(messages);
    expect(slot()?.transcriptPresentation).toBeNull();
  });

  it("confirms a shortened disk window when the mirror contains the original worker content", async () => {
    const messages: AgentMessage[] = [user("prompt"), { id: "tool", kind: "tool", toolCallId: "tool", title: "Read",
      toolKind: "read", status: "completed", createdAt: 2, updatedAt: 3, rawOutput: "x".repeat(100_000) }];
    const encoded = caches.encodeCloudTranscriptWindow({ messages, leadingPrompt: null, source: "worker" })!;
    const disk = caches.decodeCloudTranscriptWindow(encoded.json)!;
    expect(encoded.bytes).toBeLessThan(100_000);
    caches.cloudTranscriptCache.remember(id, folder, disk);
    const h = harness(), pending = h.hydrate(id);
    h.resolve({ messages: structuredClone(messages), source: "control-plane", complete: true });
    await pending;
    expect(slot()?.transcriptPresentation).toBeNull();
    expect(slot()?.messages).toEqual(messages);
  });

  it("does not mistake a matching shortened prefix for the worker's original content", async () => {
    const message: AgentMessage = { id: "tool", kind: "tool", toolCallId: "tool", title: "Read", toolKind: "read",
      status: "completed", createdAt: 2, updatedAt: 3, rawOutput: "x".repeat(100_000) + "new ending" };
    const encoded = caches.encodeCloudTranscriptWindow({ messages: [message], leadingPrompt: null, source: "worker" })!;
    caches.cloudTranscriptCache.remember(id, folder, caches.decodeCloudTranscriptWindow(encoded.json)!);
    const h = harness(), pending = h.hydrate(id);
    h.resolve({ messages: [{ ...message, rawOutput: "x".repeat(100_000) + "old ending" }], source: "control-plane", complete: true });
    await pending;
    expect(slot()?.transcriptPresentation).toEqual({ source: "cache" });
    expect(slot()?.transcriptState).toBe("loading");
  });

  it("keeps a cached prefix when revalidation covers only a partial tail", async () => {
    const messages = [user("prompt"), agent("earlier"), agent("tail")];
    caches.cloudTranscriptCache.remember(id, folder, { messages, leadingPrompt: null, source: "control-plane" });
    const h = harness(), pending = h.hydrate(id);
    h.resolve({ source: "control-plane", complete: false, messages: [agent("tail", "edited")] });
    await pending;
    expect(slot()?.messages.map(message => message.id)).toEqual(["prompt", "earlier", "tail"]);
    expect(slot()?.messages[0]).toBe(messages[0]);
    expect(slot()?.messages[2]).toMatchObject({ text: "edited" });
  });

  it("does not confirm or erase a cached window from an incomplete empty response", async () => {
    const messages = [user("prompt"), agent("answer")];
    caches.cloudTranscriptCache.remember(id, folder, { messages, leadingPrompt: null, source: "control-plane" });
    const h = harness(), pending = h.hydrate(id);
    h.resolve({ source: "control-plane", complete: false, messages: [] });
    await pending;
    expect(slot()?.messages).toBe(messages);
    expect(slot()).toMatchObject({ transcriptState: "loading", transcriptPresentation: { source: "cache" } });
  });

  it("fences late disk and network results across account A → B → A even after the slot is recreated", async () => {
    const disk = deferred<caches.LocalTranscriptWindow | null>();
    vi.spyOn(caches.cloudTranscriptCache, "read").mockReturnValueOnce(disk.promise);
    const h = harness(), pending = h.hydrate(id);
    caches.cloudTranscriptCache.bindOwner("account-b", true);
    caches.cloudTranscriptCache.bindOwner(owner, true);
    useSessionsStore.getState().removeSession(id);
    useSessionsStore.getState().setSession(id, { ...BLANK, cwd: folder, transcriptState: "loading" });
    disk.resolve({ ...{ messages: [agent("retired-cache")], leadingPrompt: null }, source: "worker" });
    await disk.promise; await Promise.resolve();
    h.resolve({ source: "worker", complete: true, messages: [agent("retired-network")] });
    await pending;
    expect(slot()?.messages).toEqual([]);
    expect(slot()?.transcriptPresentation).toBeNull();
  });
});

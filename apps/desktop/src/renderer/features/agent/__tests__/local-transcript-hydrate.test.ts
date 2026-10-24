// Production `hydrateChat` (extracted from sessions-provider.tsx) against the
// real sessions store, Local transcript cache and presentation helpers. The
// engine read is a controllable fake so each test can hold it open.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloudScopedId, isCloudWorkspace, parseCloudScopedId } from "../../../platform/bridge/cloud-workspace-key";
import { BLANK, mergeWindowedTail, useSessionsStore } from "../sessions-store";
import { reconcileHistoryMessages } from "../history-message-identity";
import { messageSnapshotsEqual, retainMessageReferences } from "../message-persistence-tracker";
import { canApplyTranscriptRead, invalidateTranscriptRequest, isCurrentTranscriptRequest, releaseTranscriptRequest, hasTranscriptPresentation } from "../transcript-retention";
import type { AgentMessage, AgentTextMessage } from "../use-agent-session";
import { isLocalTranscriptChat, localTranscriptCache, transcriptCacheFor } from "../../../state/local-transcript-cache";
import { consumeFreshCloudChat } from "../fresh-cloud-chats";
import { markFreshLocalChat, paintLocalTranscriptFromMemory, presentCachedLocalTranscript, presentCachedTranscript, presentKnownEmptyLocalTranscript, rememberLocalTranscript, rememberTranscript, takeFreshLocalChat, canReplaceCloudTranscript } from "../local-transcript-presentation";
import { forgetEmptyLocalChat, isKnownEmptyLocalChat, rememberEmptyLocalChat } from "../fresh-local-chats";
import { groupMessagesIntoTurns } from "../turn-grouping";
import { presentLeadingPrompt } from "../transcript-leading-prompt";
import { bumpCancelGeneration, clearPrebindGoalSnapshotsForChat } from "../session-reload-lifecycle";
import { forgetFreshLocalChat } from "../local-transcript-presentation";

const ast = ts.createSourceFile("sessions-provider.tsx", readFileSync(new URL("../sessions-provider.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let hydrateSource = "", reconcileSource = "", resetContextSource = "", prepareSource = "", cacheSubscriptionSource = "";
(function collect(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)) {
    if (node.name.getText(ast) === "hydrateChat") hydrateSource = node.initializer.arguments[0]!.getText(ast);
    if (node.name.getText(ast) === "reconcileChatMessages") reconcileSource = node.initializer.arguments[0]!.getText(ast);
    if (node.name.getText(ast) === "resetConversationContext") resetContextSource = node.initializer.arguments[0]!.getText(ast);
    if (node.name.getText(ast) === "prepareForSend") prepareSource = node.initializer.arguments[0]!.getText(ast);
  }
  if (ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect" &&
      node.arguments[0]?.getText(ast).includes("rememberTranscript(")) {
    cacheSubscriptionSource = node.arguments[0].getText(ast);
  }
  ts.forEachChild(node, collect);
})(ast);
const code = ts.transpileModule(`globalThis.hydrate = ${hydrateSource};\nglobalThis.reconcile = ${reconcileSource};`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

const user = (id: string): AgentTextMessage => ({ id, kind: "text", role: "user", text: `ask ${id}`, createdAt: 1 });
const agent = (id: string, text = id): AgentMessage => ({ id, kind: "text", role: "agent", text, createdAt: 1 });

type Page = { messages: AgentMessage[]; source: "local"; leadingPrompt?: AgentTextMessage };

function harness(connected = true) {
  let resolve!: (page: Page) => void;
  const pending = new Promise<Page>(done => { resolve = done; });
  const read = vi.fn(async () => pending);
  const requests = new Map<string, Promise<void>>();
  const pendingHydrates = new Set<string>();
  const context: Record<string, unknown> = {
    console: { warn: vi.fn() }, BLANK, parseCloudScopedId, isCloudWorkspace, cloudComputerV2: false, HYDRATE_WINDOW: 200,
    reconcileHistoryMessages, messageSnapshotsEqual, retainMessageReferences, isCurrentTranscriptRequest, releaseTranscriptRequest,
    canApplyTranscriptRead, invalidateTranscriptRequest, mergeWindowedTail, canBackgroundSyncCloudWorkspace: () => true, reconcileInFlightRef: { current: new Map() },
    getStore: useSessionsStore.getState, bridge: { status: connected ? "connected" : "connecting" }, reconcileChatMessages: vi.fn(async () => {}),
    persistMessageWindow: read, hydrateCloudSendRef: { current: vi.fn() }, reconcileChatMessagesRef: { current: vi.fn() },
    hydrateInFlightRef: { current: requests },
    pendingHydratesRef: { current: pendingHydrates }, localTranscriptCache, presentCachedLocalTranscript, takeFreshLocalChat,
    presentKnownEmptyLocalTranscript, consumeFreshCloudChat, transcriptCacheFor, presentCachedTranscript, canReplaceCloudTranscript,
    bumpCancelGeneration, clearPrebindGoalSnapshotsForChat, forgetFreshLocalChat,
    prebindBackgroundTasksRef: { current: { clearChat: vi.fn() } },
  };
  const resetMaps = ["cancelGenerationsRef", "promptAbortRef", "sendingChatsRef", "ensureInFlightRef", "loadFlightKeysRef",
    "loadFlightAdoptOnlyRef", "prebindDirtySessionsRef", "prebindGoalSnapshotsRef", "sendQueueRef", "queueHeldRef",
    "flushBubbleRef", "authPromptsRef", "turnProducedOutputRef", "announcedDirsRef", "promptActivityRef", "conversationResetFlightsRef"];
  const refs = Object.fromEntries(resetMaps.map(name => [name, { current: new Map() }]));
  Object.assign(context, refs);
  vm.runInNewContext(code, context);
  Object.assign(context, {
    useSessionsStore, rememberLocalTranscript, rememberTranscript, isLocalTranscriptChat, rememberEmptyLocalChat, forgetEmptyLocalChat,
    noteLocalChatPrompt: vi.fn(), forgetLocalChatPrompt: vi.fn(),
    useWorkspaceStore: { getState: () => ({ chats: [], dispatch: vi.fn() }) },
    window: { setTimeout, clearTimeout },
  });
  vm.runInNewContext(ts.transpileModule("globalThis.subscribeToCache = " + cacheSubscriptionSource,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  context.hydrateChat = context.hydrate;
  vm.runInNewContext(ts.transpileModule(`globalThis.resetContext = ${resetContextSource};\nglobalThis.prepare = ${prepareSource};`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return {
    hydrate: context.hydrate as (chatId: string) => Promise<void>, read, resolve, pendingHydrates,
    subscribeToCache: context.subscribeToCache as () => () => void,
    resetContext: context.resetContext as (chatId: string) => void,
    prepare: context.prepare as (chatId: string) => Promise<void> | null,
    refs,
  };
}

const slot = (chatId: string) => useSessionsStore.getState().sessions[chatId];

beforeEach(() => {
  useSessionsStore.getState().clearAll();
  localTranscriptCache.resetForTesting();
  for (const chatId of ["chat-1", "chat-2", "chat-e", "chat-x", "chat-new"]) forgetEmptyLocalChat(chatId);
});

afterEach(() => {
  localTranscriptCache.resetForTesting();
  vi.useRealTimers();
});

describe("conversation context reset", () => {
  it.each(["/repo", "/organization/repo"])("retires only the reset chat and waits for canonical history before sending in %s", async (folder) => {
    const before = [user("kept"), agent("kept-answer"), user("removed"), agent("removed-answer")];
    const binding = { version: 1 as const, kind: "native" as const, providerId: "codex", resumeId: "old" };
    const store = useSessionsStore.getState();
    store.setSession("chat-1", { ...BLANK, cwd: folder, agentId: "codex", executionId: "old-execution", sessionId: "old-execution",
      providerBinding: binding, messages: before, status: "streaming", hasTranscript: true });
    store.setSession("chat-2", { ...BLANK, cwd: "/other", agentId: "claude", sessionId: "other", messages: [user("other")] });
    const other = slot("chat-2");
    const h = harness();
    const abort = new AbortController();
    h.refs.promptAbortRef.current.set("chat-1", abort);
    h.refs.ensureInFlightRef.current.set("chat-1", Promise.resolve());
    h.refs.ensureInFlightRef.current.set("chat-2", Promise.resolve());
    h.refs.sendQueueRef.current.set("chat-1", ["queued before reset"]);
    h.resetContext("chat-1");
    expect(abort.signal.aborted).toBe(true);
    expect(h.refs.cancelGenerationsRef.current.get("chat-1")).toBe(1);
    expect(h.refs.ensureInFlightRef.current.has("chat-1")).toBe(false);
    expect(h.refs.ensureInFlightRef.current.has("chat-2")).toBe(true);
    expect(h.refs.sendQueueRef.current.has("chat-1")).toBe(false);
    expect(slot("chat-1")).toMatchObject({ executionId: null, sessionId: null, providerBinding: null, status: "idle" });
    expect(useSessionsStore.getState().executionToChatId["old-execution"]).toBeUndefined();
    expect(slot("chat-2")).toBe(other);
    let prepared = false;
    const preparation = h.prepare("chat-1")!.then(() => { prepared = true; });
    await Promise.resolve();
    expect(prepared).toBe(false);
    h.resolve({ messages: before.slice(0, 2), source: "local" });
    await preparation;
    expect(slot("chat-1")?.messages).toEqual(before.slice(0, 2));
    expect(slot("chat-2")).toBe(other);
  });

  it.each([[], [user("restored"), agent("restored-answer")]].map(messages => ({ messages })))("accepts authoritative empty history or an Undo without an overlapping row: $messages", async ({ messages }) => {
    useSessionsStore.getState().setSession("chat-1", { ...BLANK, cwd: "/repo", messages: [user("old")] });
    const h = harness();
    h.resetContext("chat-1");
    const preparation = h.prepare("chat-1");
    h.resolve({ messages, source: "local" });
    await preparation;
    expect(slot("chat-1")?.messages).toEqual(messages);
    expect(slot("chat-1")?.hasTranscript).toBe(messages.length > 0);
  });

  it("ignores a pre-reset history read that finishes after the reset's canonical read", async () => {
    useSessionsStore.getState().setSession("chat-1", { ...BLANK, cwd: "/repo", transcriptState: "cold" });
    const h = harness();
    let resolveOld!: (page: Page) => void;
    h.read.mockImplementationOnce(() => new Promise<Page>(resolve => { resolveOld = resolve; }));
    const stale = h.hydrate("chat-1");
    h.resetContext("chat-1");
    const preparation = h.prepare("chat-1");
    h.resolve({ messages: [user("kept")], source: "local" });
    await preparation;
    resolveOld({ messages: [user("kept"), agent("discarded")], source: "local" });
    await stale;
    expect(slot("chat-1")?.messages.map(message => message.id)).toEqual(["kept"]);
  });

  it("leaves cloud and evicted chats unloaded", () => {
    const cloud = cloudScopedId({ organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" }, "chat");
    const store = useSessionsStore.getState();
    store.setSession(cloud, { ...BLANK, cwd: "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222", sessionId: "cloud-native" });
    store.setSession("chat-1", { ...BLANK, cwd: "/repo", transcriptState: "cold", sessionId: "old" });
    const cloudBefore = slot(cloud);
    const h = harness();
    h.resetContext(cloud);
    h.resetContext("chat-1");
    expect(h.read).not.toHaveBeenCalled();
    expect(slot(cloud)).toBe(cloudBefore);
    expect(slot("chat-1")).toMatchObject({ transcriptState: "cold", sessionId: null });
  });
});

describe("Local transcript hydration", () => {
  it.each(["/repo", "/organization/repo"])("forgets cached history after the engine confirms an empty transcript in %s", async (folder) => {
    vi.useFakeTimers();
    localTranscriptCache.remember("chat-1", folder, { messages: [user("u1"), agent("a1")], leadingPrompt: null });
    useSessionsStore.getState().setSession("chat-1", { ...BLANK, cwd: folder, transcriptState: "cold" });
    const h = harness();
    const stop = h.subscribeToCache();
    try {
      const pending = h.hydrate("chat-1");
      h.resolve({ source: "local", messages: [] });
      await pending;
      expect(slot("chat-1")).toMatchObject({ transcriptState: "resident", messages: [] });
      // Invalidations cannot wait for the write timer: the app may close now.
      expect(localTranscriptCache.peek("chat-1")).toBeNull();
      vi.advanceTimersByTime(750);
      useSessionsStore.getState().evictTranscript("chat-1");
      // Reopening paints the confirmed empty state, never the stale rows.
      expect(paintLocalTranscriptFromMemory("chat-1", folder)).toBe(true);
      expect(slot("chat-1")).toMatchObject({ messages: [], transcriptPresentation: { empty: true } });
    } finally { stop(); }
  });

  it.each(["/repo", "/organization/repo"])("forgets a reset transcript evicted before the idle capture in %s", (folder) => {
    vi.useFakeTimers();
    const messages = [user("u1"), agent("a1")];
    localTranscriptCache.remember("chat-1", folder, { messages, leadingPrompt: null });
    useSessionsStore.getState().setSession("chat-1", { ...BLANK, cwd: folder, transcriptState: "resident", messages });
    const stop = harness().subscribeToCache();
    try {
      // TurnFooter runs this after the engine confirms Reset to this point.
      useSessionsStore.getState().truncateMessagesFromInMemory("chat-1", "u1");
      expect(slot("chat-1")!.messages).toEqual([]);
      useSessionsStore.getState().evictTranscript("chat-1");
      expect(paintLocalTranscriptFromMemory("chat-1", folder)).toBe(false);
      expect(localTranscriptCache.peek("chat-1")).toBeNull();
    } finally { stop(); }
  });

  it.each(["cold", "loading"] as const)("does not forget a confirmed cache because a %s slot is empty", (transcriptState) => {
    const messages = [user("u1"), agent("a1")];
    localTranscriptCache.remember("chat-1", "/repo", { messages, leadingPrompt: null });
    rememberLocalTranscript("chat-1", { ...BLANK, cwd: "/repo", transcriptState, messages: [] }, "/repo");
    expect(localTranscriptCache.peek("chat-1")?.messages).toBe(messages);
  });

  it("does not invalidate Local history when a cloud slot is empty", () => {
    const messages = [user("u1"), agent("a1")];
    localTranscriptCache.remember("chat-1", "/repo", { messages, leadingPrompt: null });
    const cwd = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
    rememberLocalTranscript("chat-1", { ...BLANK, cwd, transcriptState: "resident" }, cwd);
    expect(localTranscriptCache.peek("chat-1")?.messages).toBe(messages);
  });

  it("opens a chat this renderer just created without a read or a loading state", async () => {
    markFreshLocalChat("chat-new", "/repo");
    const h = harness();
    await h.hydrate("chat-new");
    expect(h.read).not.toHaveBeenCalled();
    expect(slot("chat-new")).toMatchObject({ transcriptState: "resident", messages: [], hasTranscript: false });
    // Consumed: a later cold reopen reads normally.
    expect(takeFreshLocalChat("chat-new")).toBe(false);
  });

  it.each(["/repo", "/organization/repo"])("paints a chat known to be empty without Loading at launch and confirms it in %s", async (folder) => {
    // An earlier launch confirmed it empty; nothing is cached for it.
    rememberEmptyLocalChat("chat-e", folder);
    const parked = harness(false);
    await parked.hydrate("chat-e");
    expect(parked.read).not.toHaveBeenCalled();
    expect(parked.pendingHydrates.has("chat-e")).toBe(true);
    // Its empty state (workspace rows / transcript row) paints at once; it is
    // presentation only until the engine answers.
    expect(slot("chat-e")).toMatchObject({ transcriptState: "loading", messages: [],
      transcriptPresentation: { source: "cache", empty: true } });
    expect(hasTranscriptPresentation(slot("chat-e"))).toBe(true);

    const h = harness();
    const result = h.hydrate("chat-e");
    h.resolve({ source: "local", messages: [] });
    await result;
    expect(slot("chat-e")).toMatchObject({ transcriptState: "resident", messages: [], transcriptPresentation: null });
  });

  it("lets the engine's history replace a stale known-empty paint and forgets the mark", async () => {
    rememberEmptyLocalChat("chat-x", "/repo");
    const h = harness();
    const stop = h.subscribeToCache();
    try {
      const result = h.hydrate("chat-x");
      expect(slot("chat-x")!.transcriptPresentation).toMatchObject({ empty: true });
      h.resolve({ source: "local", messages: [user("u1"), agent("a1")] });
      await result;
      expect(slot("chat-x")).toMatchObject({ transcriptState: "resident", transcriptPresentation: null });
      expect(slot("chat-x")!.messages.map(m => m.id)).toEqual(["u1", "a1"]);
      expect(isKnownEmptyLocalChat("chat-x")).toBe(false);
    } finally { stop(); }
  });

  it("learns a confirmed empty Local chat and forgets it at the first sign of history", () => {
    const stop = harness().subscribeToCache();
    try {
      // Cold or loading emptiness is not confirmation.
      useSessionsStore.getState().setSession("chat-e", { ...BLANK, cwd: "/repo", transcriptState: "loading" });
      expect(isKnownEmptyLocalChat("chat-e")).toBe(false);
      useSessionsStore.getState().patchSession("chat-e", { transcriptState: "resident" });
      expect(isKnownEmptyLocalChat("chat-e")).toBe(true);
      // The first prompt — before the engine has it — ends the fast path.
      useSessionsStore.getState().patchSession("chat-e", { messages: [user("u1")] });
      expect(isKnownEmptyLocalChat("chat-e")).toBe(false);
      // A history hint for an evicted chat does too.
      rememberEmptyLocalChat("chat-x", "/repo");
      useSessionsStore.getState().setSession("chat-x", { ...BLANK, cwd: "/repo", transcriptState: "cold", hasTranscript: true });
      expect(isKnownEmptyLocalChat("chat-x")).toBe(false);
      // Cloud chats are never recorded.
      const cloud = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
      useSessionsStore.getState().setSession("chat-2", { ...BLANK, cwd: cloud, transcriptState: "resident" });
      expect(isKnownEmptyLocalChat("chat-2")).toBe(false);
    } finally { stop(); }
  });

  it("paints the remembered window immediately and confirms it through the engine", async () => {
    const remembered = [user("u1"), agent("a1")];
    localTranscriptCache.remember("chat-1", "/repo", { messages: remembered, leadingPrompt: null });
    useSessionsStore.getState().setSession("chat-1", { ...BLANK, cwd: "/repo", transcriptState: "cold", hasTranscript: true });
    const h = harness();
    const result = h.hydrate("chat-1");

    // Same synchronous step: no blank frame, no "Loading conversation…".
    expect(slot("chat-1")).toMatchObject({ transcriptState: "loading", transcriptPresentation: { source: "cache" } });
    expect(slot("chat-1")!.messages).toBe(remembered);
    expect(hasTranscriptPresentation(slot("chat-1"))).toBe(true);

    h.resolve({ source: "local", messages: [user("u1"), agent("a1"), agent("a2")] });
    await result;
    const confirmed = slot("chat-1")!;
    expect(confirmed.transcriptState).toBe("resident");
    expect(confirmed.transcriptPresentation).toBeNull();
    expect(confirmed.messages.map(m => m.id)).toEqual(["u1", "a1", "a2"]);
    // Unchanged rows keep the painted objects, so their turns do not re-render.
    expect(confirmed.messages[0]).toBe(remembered[0]);
    expect(confirmed.messages[1]).toBe(remembered[1]);
  });

  it("keeps the cached paint visible while the engine is still starting", async () => {
    localTranscriptCache.remember("chat-1", "/repo", { messages: [agent("a1")], leadingPrompt: null });
    const h = harness(false);
    await h.hydrate("chat-1");
    expect(h.read).not.toHaveBeenCalled();
    expect(h.pendingHydrates.has("chat-1")).toBe(true);
    expect(slot("chat-1")).toMatchObject({ transcriptState: "loading", transcriptPresentation: { source: "cache" } });
    expect(slot("chat-1")!.messages.map(m => m.id)).toEqual(["a1"]);
  });

  it("paints the disk copy at launch while the hydrate waits for the engine", async () => {
    // App launch: nothing in memory yet, the engine is still starting, and the
    // disk read finishes after the hydrate has parked and released its request.
    let releaseDisk!: (value: { messages: AgentMessage[]; leadingPrompt: null }) => void;
    const disk = new Promise<{ messages: AgentMessage[]; leadingPrompt: null }>(done => { releaseDisk = done; });
    const spy = vi.spyOn(localTranscriptCache, "read").mockReturnValueOnce(disk);
    const h = harness(false);
    await h.hydrate("chat-1");
    expect(h.pendingHydrates.has("chat-1")).toBe(true);
    releaseDisk({ messages: [user("u1"), agent("a1")], leadingPrompt: null });
    await disk; await Promise.resolve();
    expect(slot("chat-1")).toMatchObject({ transcriptState: "loading", transcriptPresentation: { source: "cache" } });
    expect(slot("chat-1")!.messages.map(m => m.id)).toEqual(["u1", "a1"]);
    // A parked chat that left the deck meanwhile is not repopulated.
    let releaseLate!: (value: { messages: AgentMessage[]; leadingPrompt: null }) => void;
    const late = new Promise<{ messages: AgentMessage[]; leadingPrompt: null }>(done => { releaseLate = done; });
    spy.mockReturnValueOnce(late);
    await h.hydrate("chat-2");
    h.pendingHydrates.delete("chat-2");
    useSessionsStore.getState().evictTranscript("chat-2");
    releaseLate({ messages: [agent("stale")], leadingPrompt: null });
    await late; await Promise.resolve();
    expect(slot("chat-2")).toMatchObject({ transcriptState: "cold", messages: [] });
    spy.mockRestore();
  });

  it("never lets a slower cache read replace a confirmed engine window", async () => {
    const h = harness();
    let releaseDisk!: (value: null | { messages: AgentMessage[]; leadingPrompt: null }) => void;
    const disk = new Promise<{ messages: AgentMessage[]; leadingPrompt: null } | null>(done => { releaseDisk = done; });
    const spy = vi.spyOn(localTranscriptCache, "read").mockReturnValueOnce(disk);
    const result = h.hydrate("chat-1");
    h.resolve({ source: "local", messages: [agent("fresh")] });
    await result;
    releaseDisk({ messages: [agent("stale")], leadingPrompt: null });
    await Promise.resolve(); await Promise.resolve();
    expect(slot("chat-1")).toMatchObject({ transcriptState: "resident" });
    expect(slot("chat-1")!.messages.map(m => m.id)).toEqual(["fresh"]);
    spy.mockRestore();
  });

  it("shows the opening prompt of a turn longer than the window", async () => {
    const h = harness();
    const result = h.hydrate("chat-1");
    const tail = Array.from({ length: 5 }, (_, index) => agent(`t${index}`));
    h.resolve({ source: "local", messages: tail, leadingPrompt: user("u1") });
    await result;
    const hydrated = slot("chat-1")!;
    expect(hydrated.leadingPrompt?.id).toBe("u1");
    const turns = groupMessagesIntoTurns(presentLeadingPrompt(hydrated.messages, hydrated.leadingPrompt));
    expect(turns).toHaveLength(1);
    expect(turns[0].userPrompt?.id).toBe("u1");
    // The live cap keeps it as the turn keeps streaming past the front.
    useSessionsStore.getState().patchSession("chat-1", { messages: tail.slice(2) });
    expect(slot("chat-1")!.leadingPrompt?.id).toBe("u1");
    // Editing that prompt cuts every resident row after it.
    useSessionsStore.getState().truncateMessagesFromInMemory("chat-1", "u1");
    expect(slot("chat-1")).toMatchObject({ messages: [], leadingPrompt: null });
  });

  it("paints from memory in the same frame a view becomes visible", () => {
    const remembered = [user("u1"), agent("a1")];
    localTranscriptCache.remember("chat-1", "/repo", { messages: remembered, leadingPrompt: null });
    useSessionsStore.getState().setSession("chat-1", { ...BLANK, cwd: "/repo", transcriptState: "cold" });
    expect(paintLocalTranscriptFromMemory("chat-1", "/repo")).toBe(true);
    expect(slot("chat-1")!.messages).toBe(remembered);
    // Never over a resident transcript or a visible durable row.
    useSessionsStore.getState().setSession("chat-2", { ...BLANK, cwd: "/repo", transcriptState: "resident", messages: [agent("live")] });
    localTranscriptCache.remember("chat-2", "/repo", { messages: [agent("old")], leadingPrompt: null });
    expect(paintLocalTranscriptFromMemory("chat-2", "/repo")).toBe(false);
    expect(slot("chat-2")!.messages.map(m => m.id)).toEqual(["live"]);
  });

  it("never paints a cloud conversation from the Local cache", async () => {
    const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
    const cloudChat = cloudScopedId(target, "chat-a");
    localTranscriptCache.remember(cloudChat, "/repo", { messages: [agent("leak")], leadingPrompt: null });
    expect(localTranscriptCache.peek(cloudChat)).toBeNull();
    expect(paintLocalTranscriptFromMemory(cloudChat, "/repo")).toBe(false);
    // A legacy unscoped id bound to a cloud workspace stays on the cloud path.
    localTranscriptCache.remember("chat-legacy", "/repo", { messages: [agent("leak")], leadingPrompt: null });
    useSessionsStore.getState().setSession("chat-legacy", { ...BLANK, cwd: `cloud://${target.organizationId}/${target.workspaceId}`, transcriptState: "cold" });
    const h = harness();
    const result = h.hydrate("chat-legacy");
    expect(slot("chat-legacy")!.messages).toEqual([]);
    expect(slot("chat-legacy")!.transcriptPresentation).toBeNull();
    h.resolve({ source: "local", messages: [] });
    await result;
  });
});

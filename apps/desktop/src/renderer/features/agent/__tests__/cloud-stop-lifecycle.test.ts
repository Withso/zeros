import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isCloudWorkspace } from "../../../platform/bridge/cloud-workspace-key";
import { hasBackgroundAgentWork, loadedBackgroundTaskState } from "../background-task-state";
import * as lifecycle from "../session-reload-lifecycle";
import { agentSessionHasActiveWork, BLANK, useSessionsStore } from "../sessions-store";
import type { AgentSessionState } from "../use-agent-session";

const CHAT = "11111111-1111-4111-8111-111111111111";
const CLOUD = "cloud://22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333";
const REVOKED = { version: 1, actor: "agent-code", backend: "cloud-worker", state: "revoked",
  designProtection: { required: false, enforced: false, protectedDirectoryCount: 0 },
  parity: { level: "full", restrictions: [] } } as const;

// Run the actual renderer callback with the real session store. Bridge I/O is
// held at its asynchronous boundary; no copy of the cancellation logic is used.
const file = new URL("../sessions-provider.tsx", import.meta.url);
const ast = ts.createSourceFile(file.pathname, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let cancelSource = "";
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "cancel" &&
      node.initializer && ts.isCallExpression(node.initializer)) {
    cancelSource = node.initializer.arguments[0].getText(ast);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
expect(cancelSource).not.toBe("");
const code = ts.transpileModule(`globalThis.cancel = ${cancelSource};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const chatFile = new URL("../agent-chat.tsx", import.meta.url);
const chatAst = ts.createSourceFile(chatFile.pathname, readFileSync(chatFile, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let composerExpression = "";
function findComposer(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(chatAst) === "composerStreaming" && node.initializer)
    composerExpression = node.initializer.getText(chatAst);
  ts.forEachChild(node, findComposer);
}
findComposer(chatAst);
expect(composerExpression).not.toBe("");
function showsStop(session: AgentSessionState) {
  return vm.runInNewContext(composerExpression, { session, isCloudWorkspace,
    composerShowsStopControl: lifecycle.composerShowsStopControl,
    backgroundContinuationActive: false, pendingLocalTurnId: null, planReview: null });
}

function deferred() {
  let resolve!: (value?: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(cwd = CLOUD) {
  const slot: AgentSessionState = {
    ...BLANK, cwd, agentId: "codex", status: "streaming", sessionId: "execution-1", executionId: "execution-1",
    foregroundTurnId: "turn-1", activeTurnStartedAt: 42, messages: [],
  };
  useSessionsStore.setState({ sessions: { [CHAT]: slot }, executionToChatId: { "execution-1": CHAT },
    pendingLocalTurns: {}, cancellingChats: new Set() });
  const gate = deferred();
  const bridge = { request: vi.fn(() => gate.promise), send: vi.fn() };
  const followUp = { bubbleId: "follow-up", prompt: [{ type: "text", text: "retained follow-up" }] };
  const sendQueueRef = { current: new Map([[CHAT, [followUp]]]) };
  const context = vm.createContext({
    ...lifecycle, isCloudWorkspace, hasBackgroundAgentWork, loadedBackgroundTaskState,
    crypto: { randomUUID }, bridge, getStore: useSessionsStore.getState,
    cancelGenerationsRef: { current: new Map() },
    flushLocalNotificationsRef: { current: vi.fn() },
    cloudSendPreparationRef: { current: { cancel: vi.fn() } },
    cloudSendWaitRef: { current: { cancel: vi.fn() } },
    sendingChatsRef: { current: new Set() }, sendQueueRef,
    ensureInFlightRef: { current: new Map() }, loadFlightKeysRef: { current: new Map() },
    loadFlightAdoptOnlyRef: { current: new Map() },
    cloudStopsRef: { current: new Map() },
    pauseQueue: () => useSessionsStore.getState().patchSession(CHAT, { queuePaused: true }),
    evictUnretainedTranscripts: vi.fn(), cancelStalledAdmission: vi.fn(), notifyAgentSendFailure: vi.fn(),
  });
  vm.runInContext(code, context);
  return {
    bridge, gate, followUp, sendQueueRef,
    cancel: () => (context.cancel as (id: string) => Promise<void>)(CHAT),
    slot: () => useSessionsStore.getState().sessions[CHAT],
  };
}

afterEach(() => {
  useSessionsStore.setState({ sessions: {}, executionToChatId: {}, pendingLocalTurns: {}, cancellingChats: new Set() });
  vi.restoreAllMocks();
});

describe("cloud Stop renderer lifetime", () => {
  it("retains the active turn and Stop control until exact retirement is confirmed", async () => {
    const h = harness();
    const pending = h.cancel();
    expect(h.bridge.request).toHaveBeenCalledOnce();
    expect(h.slot().activeTurnStartedAt).toBe(42);
    expect(h.slot().lastStopReason).not.toBe("cancelled");
    expect(agentSessionHasActiveWork(h.slot(), null)).toBe(true);
    expect(h.slot().queuePaused).toBe(true);
    expect(h.sendQueueRef.current.get(CHAT)).toEqual([h.followUp]);
    h.gate.resolve({ type: "WORKSPACE_RESPONSE", result: { conversationId: CHAT, commandId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", state: "cancelled" } });
    await pending;
    expect(h.slot().status).toBe("ready");
    expect(h.slot().activeTurnStartedAt).toBeNull();
  });

  it("joins a repeated click to the same pending Stop operation", async () => {
    const h = harness();
    const first = h.cancel(), second = h.cancel();
    const messages = h.bridge.request.mock.calls as unknown as Array<[Record<string, unknown>]>;
    expect(new Set(messages.map(([message]) => message.id)).size).toBe(1);
    h.gate.resolve({ type: "WORKSPACE_RESPONSE", result: { conversationId: CHAT, commandId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", state: "cancelled" } });
    await Promise.all([first, second]);
  });

  it("keeps unconfirmed work and a visible recovery error after losing the Stop reply", async () => {
    const h = harness();
    const pending = h.cancel();
    h.gate.reject(new Error("transport lost"));
    await pending;
    expect(agentSessionHasActiveWork(h.slot(), null)).toBe(true);
    expect(h.slot().activeTurnStartedAt).toBe(42);
    expect(h.slot().error).toContain("Stop could not be confirmed");
    expect(h.sendQueueRef.current.get(CHAT)).toEqual([h.followUp]);
  });

  it.each(["snapshot", "reattachment", "running event"])("keeps the unconfirmed Stop error through a passive %s", async source => {
    const h = harness(), pending = h.cancel();
    h.gate.reject(new Error("transport lost")); await pending;
    const original = h.slot().cloudStop, error = h.slot().error, failure = h.slot().failure;
    const store = useSessionsStore.getState();
    if (source === "snapshot") store.installCloudSnapshot(CHAT, {
      version: 1, conversationId: CHAT, agentId: "codex", executionId: "execution-1", session: null, initialize: null,
      activeTurn: null, messages: [], permissions: [], questions: [],
    });
    else if (source === "reattachment") store.setSession(CHAT, { ...BLANK, agentId: "codex", cwd: CLOUD, status: "warming" });
    else store.applyBridgeUpdate({ sessionId: "execution-1", update: { sessionUpdate: "turn_state", turnId: "turn-1", state: "running", startedAt: 42 } });
    expect(h.slot().cloudStop).toBe(original);
    expect(h.slot().error).toBe(error); expect(h.slot().failure).toBe(failure);
    expect(showsStop(h.slot())).toBe(true);
  });

  it("keeps a real turn failure when the Stop observer confirms its terminal receipt", async () => {
    const h = harness(), pending = h.cancel();
    const failure = { kind: "auth-required" as const, stage: "prompt" as const, agentId: "codex", message: "Synthetic provider connection expired" };
    useSessionsStore.getState().patchSession(CHAT, { status: "failed", error: failure.message, failure });
    h.gate.resolve({ type: "WORKSPACE_RESPONSE", result: { conversationId: CHAT, commandId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", state: "failed" } });
    await pending;
    expect(h.slot().cloudStop).toBeUndefined(); expect(h.slot().activeTurnStartedAt).toBeNull();
    expect(h.slot()).toMatchObject({ status: "failed", error: failure.message, failure });
    expect(h.slot().lastStopReason).not.toBe("cancelled");
  });

  it("does not relabel a successfully completed turn as cancelled after its Stop loses the race", async () => {
    const h = harness(), pending = h.cancel();
    useSessionsStore.getState().patchSession(CHAT, { status: "ready", lastStopReason: "end_turn" });
    h.gate.resolve({ type: "WORKSPACE_RESPONSE", result: { conversationId: CHAT, commandId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", state: "succeeded" } });
    await pending;
    expect(h.slot()).toMatchObject({ status: "ready", lastStopReason: "end_turn" });
    expect(h.slot().cloudStop).toBeUndefined(); expect(h.slot().activeTurnStartedAt).toBeNull();
  });

  it("does not overwrite a real turn failure when Stop observation times out", async () => {
    const h = harness(), pending = h.cancel();
    const failure = { kind: "auth-required" as const, stage: "prompt" as const, agentId: "codex", message: "Synthetic provider connection expired" };
    useSessionsStore.getState().patchSession(CHAT, { status: "failed", error: failure.message, failure });
    h.gate.reject(new Error("Stop observation timed out")); await pending;
    expect(h.slot().cloudStop?.state).toBe("unconfirmed");
    expect(h.slot()).toMatchObject({ status: "failed", error: failure.message, failure });
  });

  it("retries an unconfirmed Stop with its original operation while a follow-up is waiting", async () => {
    const h = harness(), first = h.cancel();
    h.gate.reject(new Error("transport lost")); await first;
    const original = h.slot().cloudStop, reply = deferred();
    h.bridge.request.mockReturnValueOnce(reply.promise);
    useSessionsStore.getState().patchSession(CHAT, { status: "ready", cloudSendWait: { state: "waiting", turnId: h.followUp.bubbleId } });
    const retried = h.cancel();
    try {
      expect(h.bridge.request).toHaveBeenCalledTimes(2);
      const messages = h.bridge.request.mock.calls as unknown as Array<[Record<string, unknown>]>;
      expect(messages[1]![0].id).toBe(original?.operationId);
      expect(h.sendQueueRef.current.get(CHAT)).toEqual([h.followUp]);
    } finally {
      reply.resolve({ type: "WORKSPACE_RESPONSE", result: { conversationId: CHAT, commandId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", state: "cancelled" } });
      await retried;
    }
  });

  it.each(["paused", "foreign terminal"])("does not treat a legacy %s acknowledgement as command retirement", async kind => {
    const h = harness(), pending = h.cancel();
    h.gate.resolve({ type: "WORKSPACE_RESPONSE", result: kind === "paused" ? { conversationId: CHAT, paused: true } :
      { conversationId: "another-chat", state: "cancelled" } });
    await pending;
    expect(h.slot().cloudStop?.state).toBe("unconfirmed");
    expect(h.slot().activeTurnStartedAt).toBe(42); expect(agentSessionHasActiveWork(h.slot(), null)).toBe(true);
  });

  it("does not let an old Stop completion settle a successor turn", async () => {
    const h = harness();
    const pending = h.cancel();
    useSessionsStore.getState().patchSession(CHAT, {
      status: "streaming", executionId: "execution-2", sessionId: "execution-2",
      foregroundTurnId: "turn-2", activeTurnStartedAt: 84,
    });
    h.gate.resolve({ type: "WORKSPACE_RESPONSE", result: { conversationId: CHAT, commandId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", state: "cancelled" } });
    await pending;
    expect(h.slot()).toMatchObject({ status: "streaming", foregroundTurnId: "turn-2", activeTurnStartedAt: 84 });
    expect(h.slot().cloudStop).toBeUndefined();
    expect(useSessionsStore.getState().cancellingChats.has(CHAT)).toBe(false);
  });

  it("retains the original Stop through a passive session reattachment", async () => {
    const h = harness(), pending = h.cancel(), original = h.slot().cloudStop;
    useSessionsStore.getState().setSession(CHAT, { ...BLANK, agentId: "codex", cwd: CLOUD, status: "warming" });
    expect(h.slot().cloudStop).toBe(original); expect(h.slot().foregroundTurnId).toBe("turn-1");
    expect(h.slot().activeTurnStartedAt).toBe(42);
    h.gate.resolve({ type: "WORKSPACE_RESPONSE", result: { conversationId: CHAT, commandId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", state: "cancelled" } }); await pending;
    expect(h.slot().cloudStop).toBeUndefined();
  });

  it.each(["boundary revocation", "provider exit"])("retains the Stop owner through %s before retirement", async event => {
    const h = harness(), pending = h.cancel(), store = useSessionsStore.getState(), original = h.slot().cloudStop;
    store.applyBridgeUpdate({ sessionId: "execution-1", update: {
      sessionUpdate: "turn_state", turnId: "turn-1", state: "cancelled", startedAt: 42,
    } });
    if (event === "boundary revocation") store.applyBridgeBoundaryStatus("codex", "execution-1", { ...REVOKED, parity: { level: "full", restrictions: [] } });
    else store.applyBridgeAgentExit("codex", "execution-1");
    try {
      expect(h.slot().cloudStop).toBe(original);
      expect(h.slot().foregroundTurnId).toBe("turn-1");
      expect(h.slot().executionId).toBe("execution-1");
      expect(h.slot().activeTurnStartedAt).toBe(42);
      expect(showsStop(h.slot())).toBe(true);
    } finally {
      h.gate.resolve({ type: "WORKSPACE_RESPONSE", result: { conversationId: CHAT, commandId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", state: "cancelled" } });
      await pending;
    }
    expect(h.slot().cloudStop).toBeUndefined();
  });

  it.each(["boundary revocation", "provider exit"])("can retry the original unconfirmed Stop after %s", async event => {
    const h = harness(), pending = h.cancel();
    h.gate.reject(new Error("transport lost")); await pending;
    const original = h.slot().cloudStop, error = h.slot().error, store = useSessionsStore.getState();
    store.applyBridgeUpdate({ sessionId: "execution-1", update: {
      sessionUpdate: "turn_state", turnId: "turn-1", state: "cancelled", startedAt: 42,
    } });
    if (event === "boundary revocation") store.applyBridgeBoundaryStatus("codex", "execution-1", { ...REVOKED, parity: { level: "full", restrictions: [] } });
    else store.applyBridgeAgentExit("codex", "execution-1");
    expect(h.slot().error).toBe(error);
    expect(h.slot().cloudStop).toBe(original);
    const reply = deferred(); h.bridge.request.mockReturnValueOnce(reply.promise);
    const retried = h.cancel();
    try {
      expect(h.bridge.request).toHaveBeenCalledTimes(2);
      const messages = h.bridge.request.mock.calls as unknown as Array<[Record<string, unknown>]>;
      expect(messages[1]![0].id).toBe(original?.operationId);
    } finally {
      reply.resolve({ type: "WORKSPACE_RESPONSE", result: { conversationId: CHAT, commandId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", state: "cancelled" } });
      await retried;
    }
    expect(h.slot().cloudStop).toBeUndefined();
  });

  it.each(["patch", "replace"])("does not carry a Stop into a different cloud owner through %s", async method => {
    const h = harness(), pending = h.cancel(), store = useSessionsStore.getState();
    const replacement = { ...h.slot(), cwd: "cloud://44444444-4444-4444-8444-444444444444/55555555-5555-4555-8555-555555555555" };
    if (method === "patch") store.patchSession(CHAT, replacement); else store.setSession(CHAT, replacement);
    h.gate.resolve({ type: "WORKSPACE_RESPONSE", result: { conversationId: CHAT, commandId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", state: "cancelled" } }); await pending;
    expect(h.slot().cloudStop).toBeUndefined();
  });

  it.each(["snapshot", "turn event"])("keeps the Stop clock until retirement despite a terminal %s", async source => {
    const h = harness(), pending = h.cancel(), store = useSessionsStore.getState();
    if (source === "snapshot") store.installCloudSnapshot(CHAT, {
      version: 1, conversationId: CHAT, agentId: "codex", executionId: "execution-1", session: null, initialize: null,
      activeTurn: null, messages: [], permissions: [], questions: [],
      latestTurn: { commandId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", conversationId: CHAT, executionId: "execution-1",
        turnId: "turn-1", agentId: "codex", status: "cancelled", stopReason: "cancelled" },
    });
    else store.applyBridgeUpdate({ sessionId: "execution-1", update: { sessionUpdate: "turn_state", turnId: "turn-1", state: "cancelled", startedAt: 42 } });
    expect(h.slot().activeTurnStartedAt).toBe(42);
    expect(showsStop(h.slot())).toBe(true);
    h.gate.resolve({ type: "WORKSPACE_RESPONSE", result: { conversationId: CHAT, commandId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", state: "cancelled" } }); await pending;
    expect(h.slot().activeTurnStartedAt).toBeNull(); expect(h.slot().cloudStop).toBeUndefined();
  });

  it("keeps Stop visible while a reconnect snapshot and a waiting follow-up arrive", async () => {
    const h = harness(), pending = h.cancel();
    useSessionsStore.getState().patchSession(CHAT, { status: "ready", activeTurnStartedAt: null,
      cloudPromptPending: true, cloudSendWait: { state: "waiting", turnId: "follow-up" } });
    expect(showsStop(h.slot())).toBe(true);
    expect(agentSessionHasActiveWork(h.slot(), null)).toBe(true);
    h.gate.resolve({ type: "WORKSPACE_RESPONSE", result: { conversationId: CHAT, commandId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", state: "cancelled" } }); await pending;
  });

  it.each(["/personal/project", "/organization/project"])("retains Local cancellation for %s", async cwd => {
    const h = harness(cwd);
    await h.cancel();
    expect(h.bridge.send).toHaveBeenCalledOnce();
    expect(h.bridge.request).not.toHaveBeenCalled();
    expect(h.slot().status).toBe("ready");
    expect(h.slot().activeTurnStartedAt).toBeNull();
    expect(h.sendQueueRef.current.get(CHAT)).toEqual([h.followUp]);
  });
});

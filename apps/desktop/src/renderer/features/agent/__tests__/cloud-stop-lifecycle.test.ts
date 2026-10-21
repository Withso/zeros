import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cloudScopedId, parseCloudScopedId, parseCloudWorkspaceKey, isCloudWorkspace } from "../../../platform/bridge/cloud-workspace-key";
import { hasBackgroundAgentWork, loadedBackgroundTaskState } from "../background-task-state";
import * as lifecycle from "../session-reload-lifecycle";
import { closeActivityForSession, closeRouteForSession } from "../session-close-lifecycle";
import { invalidateTranscriptRequest } from "../transcript-retention";
import { agentSessionHasActiveWork, BLANK, useSessionsStore } from "../sessions-store";
import type { AgentSessionState } from "../use-agent-session";
import { lastUserPrompt } from "../auth-prompt-recovery";
import { classifyRpcError } from "../../../platform/bridge/failure";

const CHAT = "11111111-1111-4111-8111-111111111111";
const CLOUD = "cloud://22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333";
const REVOKED = { version: 1, actor: "agent-code", backend: "zeros-srt", state: "revoked", checkedAt: 42,
  designProtection: { required: false, enforced: false, protectedDirectoryCount: 0 },
  parity: { level: "full", restrictions: [] } } as const;

// Run the actual renderer callback with the real session store. Bridge I/O is
// held at its asynchronous boundary; no copy of the cancellation logic is used.
const file = new URL("../sessions-provider.tsx", import.meta.url);
const ast = ts.createSourceFile(file.pathname, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let cancelSource = "";
let closeSource = "", disposeSource = "", recoverSource = "", failureSource = "";
function visit(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name?.getText(ast) === "failureFromAgentError") failureSource = node.getText(ast);
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "cancel" &&
      node.initializer && ts.isCallExpression(node.initializer)) {
    cancelSource = node.initializer.arguments[0].getText(ast);
  }
  if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)) {
    if (node.name.getText(ast) === "closeSession") closeSource = node.initializer.arguments[0].getText(ast);
    if (node.name.getText(ast) === "disposeAll") disposeSource = node.initializer.arguments[0].getText(ast);
    if (node.name.getText(ast) === "recoverCloudPrompt") recoverSource = node.initializer.arguments[0].getText(ast);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
expect(cancelSource).not.toBe("");
expect(closeSource).not.toBe(""); expect(disposeSource).not.toBe("");
expect(recoverSource).not.toBe("");
const code = ts.transpileModule(`${failureSource}; globalThis.cancel = ${cancelSource}; globalThis.closeSession = ${closeSource}; globalThis.disposeAll = ${disposeSource}; globalThis.recoverCloudPrompt = ${recoverSource};`, {
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

function harness(cwd = CLOUD, chat = CHAT) {
  const slot: AgentSessionState = {
    ...BLANK, cwd, agentId: "codex", status: "streaming", sessionId: "execution-1", executionId: "execution-1",
    foregroundTurnId: "turn-1", activeTurnStartedAt: 42, messages: [],
  };
  useSessionsStore.setState({ sessions: { [chat]: slot }, executionToChatId: { "execution-1": chat },
    pendingLocalTurns: {}, cancellingChats: new Set() });
  const gate = deferred();
  class RecoveryBridge {
    request = vi.fn(() => gate.promise);
    send = vi.fn();
    recoverCloudPrompt = vi.fn(() => gate.promise);
  }
  const bridge = new RecoveryBridge(), reconcile = vi.fn(async () => {});
  const followUp = { bubbleId: "follow-up", prompt: [{ type: "text", text: "retained follow-up" }] };
  const sendQueueRef = { current: new Map([[chat, [followUp]]]) };
  const mapRef = () => ({ current: new Map() });
  const account = { value: 1 };
  const context = vm.createContext({
    ...lifecycle, isCloudWorkspace, parseCloudScopedId, parseCloudWorkspaceKey, cloudScopedId, hasBackgroundAgentWork, loadedBackgroundTaskState, agentSessionHasActiveWork,
    WorkspaceRuntimeClient: RecoveryBridge, lastUserPrompt, classifyRpcError, Error,
    reconcileChatMessagesRef: { current: reconcile },
    closeActivityForSession, closeRouteForSession, invalidateTranscriptRequest,
    crypto: { randomUUID }, bridge, getStore: useSessionsStore.getState,
    cancelGenerationsRef: { current: new Map() },
    flushLocalNotificationsRef: { current: vi.fn() },
    cloudSendPreparationRef: { current: { cancel: vi.fn(), clear: vi.fn(), has: () => false } },
    cloudSendWaitRef: { current: { cancel: vi.fn(), clear: vi.fn() } },
    sendingChatsRef: { current: new Set() }, sendQueueRef,
    ensureInFlightRef: { current: new Map() }, loadFlightKeysRef: { current: new Map() },
    loadFlightAdoptOnlyRef: { current: new Map() },
    cloudStopsRef: { current: new Map() },
    cloudClosesRef: mapRef(), cloudCatalogGeneration: () => account.value,
    prebindDirtySessionsRef: mapRef(), prebindGoalSnapshotsRef: mapRef(),
    prebindBackgroundTasksRef: { current: { clearChat: vi.fn(), clear: vi.fn() } },
    pendingHydratesRef: { current: new Set() }, hydrateInFlightRef: mapRef(), reconcileInFlightRef: mapRef(),
    nativeTranscriptSnapshotsRef: mapRef(), cloudFlushRef: mapRef(), queueHeldRef: mapRef(), flushBubbleRef: mapRef(),
    authPromptsRef: mapRef(), turnProducedOutputRef: mapRef(), announcedDirsRef: mapRef(), promptActivityRef: mapRef(),
    capabilityRefreshInFlightRef: mapRef(),
    useWorkspaceStore: { getState: () => ({ chats: [{ id: chat, folder: cwd, agentId: "codex" }] }) },
    pauseQueue: () => useSessionsStore.getState().patchSession(chat, { queuePaused: true }),
    evictUnretainedTranscripts: vi.fn(), cancelStalledAdmission: vi.fn(), notifyAgentSendFailure: vi.fn(),
  });
  vm.runInContext(code, context);
  return {
    bridge, gate, followUp, sendQueueRef, account, context, reconcile,
    cancel: () => (context.cancel as (id: string) => Promise<void>)(chat),
    close: () => (context.closeSession as (id: string) => void | Promise<boolean>)(chat),
    dispose: () => (context.disposeAll as () => void)(),
    recover: () => (context.recoverCloudPrompt as (chat: string, turn: string) => Promise<boolean>)(chat, "turn-1"),
    slot: () => useSessionsStore.getState().sessions[chat],
  };
}

afterEach(() => {
  useSessionsStore.setState({ sessions: {}, executionToChatId: {}, pendingLocalTurns: {}, cancellingChats: new Set() });
  vi.restoreAllMocks();
});

describe("cloud Retry renderer reconciliation", () => {
  const completed = { type: "AGENT_PROMPT_COMPLETE", chatId: CHAT, agentId: "codex", turnId: "turn-1", stopReason: "end_turn" };
  function failedChat(cwd = CLOUD) {
    const h = harness(cwd);
    useSessionsStore.getState().patchSession(CHAT, { status: "failed", error: "Connection closed", cloudPromptPending: false,
      messages: [{ id: "turn-1", kind: "text", role: "user", text: "Original request", createdAt: 42 }] });
    return h;
  }

  it("reconciles the original command's transcript before clearing its failed presentation", async () => {
    const h = failedChat(), history = deferred(); h.reconcile.mockReturnValueOnce(history.promise as Promise<void>);
    const pending = h.recover(); expect(h.bridge.recoverCloudPrompt).toHaveBeenCalledExactlyOnceWith(CHAT, "turn-1", "codex");
    h.gate.resolve(completed); await vi.waitFor(() => expect(h.reconcile).toHaveBeenCalledExactlyOnceWith(CHAT));
    expect(h.slot().status).toBe("failed"); history.resolve(); expect(await pending).toBe(true);
    expect(h.slot()).toMatchObject({ status: "ready", error: null, activeTurnStartedAt: null });
    expect(h.bridge.request).not.toHaveBeenCalled(); expect(h.bridge.send).not.toHaveBeenCalled();
  });

  it("allows a new attempt only when the bridge confirms a prior failed terminal", async () => {
    const h = failedChat(), pending = h.recover(); h.gate.resolve(null);
    expect(await pending).toBe(false); expect(h.reconcile).not.toHaveBeenCalled(); expect(h.slot().status).toBe("failed");
  });

  it("does not clear a newer turn or a pending Stop when an old recovery completes", async () => {
    const h = failedChat(), pending = h.recover();
    useSessionsStore.getState().patchSession(CHAT, { foregroundTurnId: "turn-2", status: "streaming", activeTurnStartedAt: 84,
      cloudStop: { turnId: "turn-2", operationId: "new-stop", state: "pending" } });
    h.gate.resolve(completed); expect(await pending).toBe(true);
    expect(h.slot()).toMatchObject({ foregroundTurnId: "turn-2", status: "streaming", cloudStop: { operationId: "new-stop" } });
    expect(h.reconcile).not.toHaveBeenCalled();
  });

  it("fences an account change and return while original history is being reconciled", async () => {
    const h = failedChat(), history = deferred(); h.reconcile.mockReturnValueOnce(history.promise as Promise<void>);
    const pending = h.recover(); h.gate.resolve(completed); await vi.waitFor(() => expect(h.reconcile).toHaveBeenCalledOnce());
    h.account.value += 2; history.resolve(); expect(await pending).toBe(true); expect(h.slot().status).toBe("failed");
  });

  it("keeps an unavailable original receipt visible without a new prompt", async () => {
    const h = failedChat(), pending = h.recover(); h.gate.reject(new Error("command_not_found"));
    await expect(pending).rejects.toThrow("command_not_found"); expect(h.slot().status).toBe("failed");
    expect(h.bridge.request).not.toHaveBeenCalled(); expect(h.bridge.send).not.toHaveBeenCalled();
  });

  it.each(["/personal/project", "/organization/project"])("leaves %s Retry on the existing Local path", async cwd => {
    const h = failedChat(cwd); expect(await h.recover()).toBe(false);
    expect(h.bridge.recoverCloudPrompt).not.toHaveBeenCalled();
  });
});

describe("explicit cloud close renderer lifetime", () => {
  const terminal = { type: "WORKSPACE_RESPONSE", result: { conversationId: CHAT,
    commandId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", state: "cancelled" } };
  const closed = { type: "AGENT_SESSION_CLOSED", agentId: "codex", chatId: CHAT, sessionId: "execution-1", executionId: "execution-1" };
  const calls = (h: ReturnType<typeof harness>) => h.bridge.request.mock.calls as unknown as Array<[Record<string, unknown>]>;

  it("waits for exact Stop retirement and close acknowledgement before detaching", async () => {
    const h = harness(), closeAck = deferred();
    h.bridge.request.mockReturnValueOnce(h.gate.promise).mockReturnValueOnce(closeAck.promise);
    const pending = h.close();
    expect(calls(h).map(([message]) => message.type)).toEqual(["AGENT_CANCEL"]);
    expect(h.slot()?.activeTurnStartedAt).toBe(42);
    expect(h.sendQueueRef.current.get(CHAT)).toEqual([h.followUp]);
    h.gate.resolve(terminal); await vi.waitFor(() => expect(h.bridge.request).toHaveBeenCalledTimes(2));
    expect(calls(h)[1]![0]).toMatchObject({ type: "AGENT_CLOSE_SESSION", chatId: CHAT });
    expect(h.slot()).toBeDefined();
    closeAck.resolve(closed); expect(await pending).toBe(true);
    expect(h.slot()).toBeUndefined(); expect(h.sendQueueRef.current.has(CHAT)).toBe(false);
  });

  it("joins duplicate close clicks to one Stop and one close", async () => {
    const h = harness(); h.bridge.request.mockReturnValueOnce(h.gate.promise).mockResolvedValueOnce(closed);
    const first = h.close(), duplicate = h.close();
    expect(h.bridge.request).toHaveBeenCalledOnce();
    h.gate.resolve(terminal);
    expect(await Promise.all([first, duplicate])).toEqual([true, true]);
    expect(calls(h).map(([message]) => message.type)).toEqual(["AGENT_CANCEL", "AGENT_CLOSE_SESSION"]);
  });

  it("keeps the chat and queued payloads after an unconfirmed Stop, then retries its exact operation", async () => {
    const h = harness(), first = h.close();
    h.gate.reject(new Error("transport lost")); expect(await first).toBe(false);
    expect(h.slot()?.cloudStop?.state).toBe("unconfirmed");
    expect(h.sendQueueRef.current.get(CHAT)).toEqual([h.followUp]);
    const operation = calls(h)[0]![0].id;
    h.bridge.request.mockResolvedValueOnce(terminal).mockResolvedValueOnce(closed);
    expect(await h.close()).toBe(true);
    expect(calls(h).map(([message]) => message.type)).toEqual(["AGENT_CANCEL", "AGENT_CANCEL", "AGENT_CLOSE_SESSION"]);
    expect(calls(h)[1]![0].id).toBe(operation);
  });

  it("does not close a successor when an older Stop confirms", async () => {
    const h = harness(), pending = h.close();
    useSessionsStore.getState().patchSession(CHAT, { foregroundTurnId: "turn-2", activeTurnStartedAt: 84,
      sessionId: "execution-2", executionId: "execution-2", status: "streaming" });
    h.gate.resolve(terminal); expect(await pending).toBe(false);
    expect(h.slot()).toMatchObject({ foregroundTurnId: "turn-2", activeTurnStartedAt: 84 });
    expect(calls(h).map(([message]) => message.type)).toEqual(["AGENT_CANCEL"]);
  });

  it("does not detach after an account change and return during Stop", async () => {
    const h = harness(), pending = h.close(); h.account.value += 2;
    h.gate.resolve(terminal); expect(await pending).toBe(false);
    expect(h.slot()).toBeDefined();
    expect(h.slot()).toMatchObject({ activeTurnStartedAt: 42, cloudStop: { state: "pending" } });
    expect(calls(h).map(([message]) => message.type)).toEqual(["AGENT_CANCEL"]);
  });

  it("keeps a stopped chat visible if its close acknowledgement is lost", async () => {
    const h = harness(); h.bridge.request.mockReturnValueOnce(h.gate.promise).mockRejectedValueOnce(new Error("connection closed"));
    const pending = h.close(); h.gate.resolve(terminal);
    expect(await pending).toBe(false);
    expect(h.slot()).toBeDefined(); expect(h.sendQueueRef.current.get(CHAT)).toEqual([h.followUp]);
    expect(h.slot()?.error).toEqual(expect.stringMatching(/close.*confirmed/i));
  });

  it("Stops the retained cloud turn even when reconnect has cleared its native route", async () => {
    const id = cloudScopedId(parseCloudWorkspaceKey(CLOUD)!, CHAT), h = harness(CLOUD, id);
    useSessionsStore.getState().patchSession(id, { sessionId: null, executionId: null, status: "reconnecting" });
    h.bridge.request.mockReturnValueOnce(h.gate.promise).mockResolvedValueOnce({ ...closed, chatId: id });
    const pending = h.close();
    expect(calls(h).map(([message]) => message.type)).toEqual(["AGENT_CANCEL"]);
    expect(calls(h)[0]![0]).toMatchObject({ chatId: id, sessionId: cloudScopedId(parseCloudWorkspaceKey(CLOUD)!, `conversation:${CHAT}`) });
    h.gate.resolve({ ...terminal, result: { ...terminal.result, conversationId: id } });
    expect(await pending).toBe(true); expect(h.slot()).toBeUndefined();
  });

  it("refuses a close acknowledgement that identifies another execution", async () => {
    const h = harness(); h.bridge.request.mockReturnValueOnce(h.gate.promise).mockResolvedValueOnce({
      type: "AGENT_SESSION_CLOSED", agentId: "codex", sessionId: "other-execution", executionId: "other-execution",
    });
    const pending = h.close(); h.gate.resolve(terminal);
    expect(await pending).toBe(false); expect(h.slot()).toBeDefined();
  });

  it("keeps a successor attached if it appears while the close acknowledgement waits", async () => {
    const h = harness(), closeAck = deferred();
    useSessionsStore.getState().patchSession(CHAT, { status: "ready", foregroundTurnId: null, activeTurnStartedAt: null });
    h.bridge.request.mockReturnValueOnce(closeAck.promise);
    const pending = h.close();
    useSessionsStore.getState().patchSession(CHAT, { executionId: "execution-2", sessionId: "execution-2" });
    closeAck.resolve(closed); expect(await pending).toBe(false); expect(h.slot()?.executionId).toBe("execution-2");
  });

  it("keeps a never-dispatched cold cloud close bounded by its acknowledgement", async () => {
    const h = harness();
    useSessionsStore.getState().patchSession(CHAT, { status: "idle", foregroundTurnId: null, activeTurnStartedAt: null,
      sessionId: null, executionId: null });
    h.bridge.request.mockReturnValueOnce(h.gate.promise);
    const pending = h.close(); expect(h.slot()).toBeDefined();
    expect(calls(h).map(([message]) => message.type)).toEqual(["AGENT_CLOSE_SESSION"]);
    h.gate.resolve({ type: "AGENT_SESSION_CLOSED", agentId: "codex", chatId: CHAT });
    expect(await pending).toBe(true); expect(h.slot()).toBeUndefined();
  });

  it("app disposal does not synthesize Stop or close", () => {
    const h = harness(); h.dispose();
    expect(h.bridge.request).not.toHaveBeenCalled(); expect(h.bridge.send).not.toHaveBeenCalled();
  });

  it.each(["/personal/project", "/organization/project"])("keeps %s close synchronous and on its original route", cwd => {
    const h = harness(cwd); h.bridge.request.mockResolvedValueOnce(closed);
    expect(h.close()).toBeUndefined();
    expect(h.slot()).toBeUndefined();
    expect(calls(h).map(([message]) => message.type)).toEqual(["AGENT_CLOSE_SESSION"]);
    expect(h.bridge.send).not.toHaveBeenCalled();
  });
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

  it.each(["reattachment", "running event"])("keeps the unconfirmed Stop error through a passive %s", async source => {
    const h = harness(), pending = h.cancel();
    h.gate.reject(new Error("transport lost")); await pending;
    const original = h.slot().cloudStop, error = h.slot().error, failure = h.slot().failure;
    const store = useSessionsStore.getState();
    if (source === "reattachment") store.setSession(CHAT, { ...BLANK, agentId: "codex", cwd: CLOUD, status: "warming" });
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

  it("keeps the Stop clock until retirement despite a terminal turn event", async () => {
    const h = harness(), pending = h.cancel(), store = useSessionsStore.getState();
    store.applyBridgeUpdate({ sessionId: "execution-1", update: { sessionUpdate: "turn_state", turnId: "turn-1", state: "cancelled", startedAt: 42 } });
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

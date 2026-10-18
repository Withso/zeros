// The provider's bridge listener effect, extracted from sessions-provider.tsx
// and run against the real sessions store. Animation frames are explicit: a
// minimized, hidden or occluded window never runs them, which is exactly when
// background agents keep streaming and asking for permissions.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BLANK, useSessionsStore } from "../sessions-store";
import { permissionPolicyOption } from "../policies";
import {
  agentUpdateFlushMode,
  markPrebindDirty,
  takePrebindDirty,
} from "../session-reload-lifecycle";
import {
  AGENT_UPDATE_BACKLOG_LIMIT,
  AGENT_UPDATE_FLUSH_DEADLINE_MS,
  createAgentUpdateFlushScheduler,
} from "../agent-update-flush-scheduler";
import { cloudReplyOwnership } from "../../../platform/bridge/cloud-runtime-wire";
import { cloudScopedId, cloudWorkspaceKey } from "../../../platform/bridge/cloud-workspace-key";

const ast = ts.createSourceFile(
  "sessions-provider.tsx",
  readFileSync(new URL("../sessions-provider.tsx", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
let effect = "";
(function collect(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect" &&
      node.arguments[0]?.getText(ast).includes('bridge.on("AGENT_SESSION_UPDATE"')) {
    effect = node.arguments[0].getText(ast);
  }
  ts.forEachChild(node, collect);
})(ast);
if (!effect) throw new Error("Production bridge listener effect was not found");
const code = ts.transpileModule(`globalThis.listen = ${effect};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

const target = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
};
const placements = [
  { owner: "Personal Local", cwd: "/personal/project", chat: "personal-chat", route: "personal-execution" },
  { owner: "organization-local", cwd: "/organization/project", chat: "organization-chat", route: "organization-execution" },
  { owner: "cloud", cwd: cloudWorkspaceKey(target), chat: cloudScopedId(target, "chat"), route: cloudScopedId(target, "conversation:chat") },
];
type Placement = (typeof placements)[number];
type Handler = (message: Record<string, unknown>) => void;

function harness() {
  const handlers = new Map<string, Set<Handler>>();
  const emit = (type: string, message: object) => {
    for (const handler of [...(handlers.get(type) ?? [])]) handler({ type, ...message });
  };
  let onSend: ((message: Record<string, unknown>) => void) | undefined;
  const send = vi.fn((message: Record<string, unknown>) => onSend?.(message));
  const bridge = {
    on(type: string, handler: Handler) {
      const set = handlers.get(type) ?? new Set<Handler>();
      set.add(handler);
      handlers.set(type, set);
      return () => set.delete(handler);
    },
    send,
  };
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  const requestAnimationFrame = (callback: FrameRequestCallback) => {
    const handle = nextFrame++;
    frames.set(handle, callback);
    return handle;
  };
  const cancelAnimationFrame = (handle: number) => {
    frames.delete(handle);
  };
  vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
  vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);
  const release = vi.fn();
  const context: Record<string, unknown> = {
    bridge, useSessionsStore, permissionPolicyOption, cloudReplyOwnership, agentUpdateFlushMode,
    takePrebindDirty, markPrebindDirty, createAgentUpdateFlushScheduler, AGENT_UPDATE_BACKLOG_LIMIT,
    markPrebindGoalSnapshot: vi.fn(), trackAgentPermissionDecided: vi.fn(), trackAgentPromptFinished: vi.fn(),
    trackAgentFirstResponse: vi.fn(), finishCloudFirstText: vi.fn(), peekAgentPromptId: () => undefined,
    notifyAgentCapabilityNotice: vi.fn(), useWorkspaceStore: { getState: () => ({ chats: [] }) },
    startTransition: (callback: () => void) => callback(),
    promptActivityRef: { current: new Map() }, releaseQueueRef: { current: release },
    sendingChatsRef: { current: new Set() }, prebindDirtySessionsRef: { current: new Map() },
    reconcileChatMessagesRef: { current: vi.fn() }, setModelRef: { current: vi.fn() },
    updateConfigRef: { current: vi.fn() }, warnedLongWakeupsRef: { current: new Set() },
    ensureInFlightRef: { current: new Map() }, prebindBackgroundTasksRef: { current: { remember: vi.fn() } },
    prebindGoalSnapshotsRef: { current: new Map() }, turnProducedOutputRef: { current: new Map() },
    questionChatRef: { current: new Map() }, answerAcksRef: { current: new Map() },
    retriedAnswersRef: { current: new Set() }, getClaudeIdleTimeoutMinutes: () => 60,
    isClaudeWakeupBeyondIdleTimeout: () => false, toast: { info: vi.fn() }, openClaudeModelsSettings: vi.fn(),
    providerQuotaCache: { setData: vi.fn() }, hasBackgroundAgentWork: () => false, cloudSessionMetadata: () => null,
    requestAnimationFrame, cancelAnimationFrame, queueMicrotask,
    setTimeout: (callback: () => void, delay?: number) => setTimeout(callback, delay),
    clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
  };
  vm.runInNewContext(code, context);
  const stop = (context.listen as () => () => void)();
  let notifications = 0;
  const unsubscribe = useSessionsStore.subscribe(() => { notifications += 1; });
  return {
    emit, send, release,
    frame() {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback(0);
    },
    pendingFrames: () => frames.size,
    notifications: () => notifications,
    onSend(callback: (message: Record<string, unknown>) => void) { onSend = callback; },
    stop() { stop(); unsubscribe(); },
  };
}

const slot = (chatId: string) => useSessionsStore.getState().sessions[chatId]!;
const text = (chatId: string) =>
  slot(chatId).messages.filter((message) => message.kind === "text" && message.role === "agent")
    .map((message) => (message.kind === "text" ? message.text : "")).join("|");

function open(placement: Placement, agentId = "claude") {
  useSessionsStore.getState().setSession(placement.chat, {
    ...BLANK, agentId, cwd: placement.cwd, sessionId: placement.route, status: "streaming",
  });
}
function chunk(placement: Placement, value: string, options: { stamped?: boolean; messageId?: string } = {}) {
  return {
    agentId: "claude",
    ...(options.stamped ? { chatId: placement.chat } : {}),
    notification: {
      sessionId: placement.route,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: value }, messageId: options.messageId ?? "answer" },
    },
  };
}
function terminal(placement: Placement, turnId = "turn-1") {
  return {
    agentId: "claude",
    notification: { sessionId: placement.route, update: { sessionUpdate: "turn_state", turnId, state: "completed", stopReason: "end_turn" } },
  };
}
const options = [
  { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
  { optionId: "allow-once", name: "Allow", kind: "allow_once" },
  { optionId: "reject-once", name: "Reject", kind: "reject_once" },
];
function permission(placement: Placement, permissionId: string, kind = "execute") {
  return {
    agentId: "claude",
    permissionId,
    request: {
      sessionId: placement.route,
      toolCall: { toolCallId: `tool-${permissionId}`, title: kind === "execute" ? "Bash" : "Edit", kind, status: "pending" },
      options,
    },
  };
}
function allowShell(placement: Placement) {
  useSessionsStore.setState((state) => ({
    chatPolicies: {
      ...state.chatPolicies,
      [placement.chat]: [{ id: "allow-shell", chatId: placement.chat, toolKind: "execute", decision: "allow", createdAt: 1 }],
    },
  }));
}
function question(placement: Placement, questionId: string) {
  return {
    agentId: "claude",
    questionId,
    request: {
      sessionId: placement.route, questionId, nativeRequestId: `native-${questionId}`, source: "native_rpc", blocking: true,
      questions: [{ id: "q1", header: "Pick", question: "Which?", options: [{ id: "a", label: "A" }], multiSelect: false }],
    },
  };
}

let active: ReturnType<typeof harness> | null = null;
function start() {
  active = harness();
  return active;
}

beforeEach(() => {
  vi.useFakeTimers();
  useSessionsStore.getState().clearAll();
  useSessionsStore.setState({ chatPolicies: {} });
});
afterEach(() => {
  active?.stop();
  active = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("agent notifications while animation frames are suspended", () => {
  it.each(placements)("$owner answers a chat-policy permission at once", (placement) => {
    open(placement);
    allowShell(placement);
    const h = start();
    const request = permission(placement, "permission-1");
    h.emit("AGENT_PERMISSION_REQUEST", request);
    expect(h.send).toHaveBeenCalledExactlyOnceWith({
      type: "AGENT_PERMISSION_RESPONSE",
      ...cloudReplyOwnership(placement.cwd, placement.chat, request.request),
      permissionId: "permission-1",
      response: { outcome: { outcome: "selected", optionId: "allow-always" } },
    });
    expect(slot(placement.chat).pendingPermission).toBeNull();
  });

  it.each(placements)("$owner shows and settles a permission card without a frame", (placement) => {
    open(placement);
    const h = start();
    h.emit("AGENT_PERMISSION_REQUEST", permission(placement, "permission-1", "edit"));
    expect(slot(placement.chat).pendingPermission?.permissionId).toBe("permission-1");
    expect(h.send).not.toHaveBeenCalled();
    h.emit("AGENT_PERMISSION_SETTLED", { permissionId: "permission-1", sessionId: placement.route });
    expect(slot(placement.chat).pendingPermission).toBeNull();
  });

  it.each(placements)("$owner applies questions, settles and agent exits without a frame", (placement) => {
    open(placement);
    const h = start();
    h.emit("AGENT_QUESTION_REQUEST", question(placement, "question-1"));
    expect(slot(placement.chat).pendingQuestions.map((entry) => entry.questionId)).toEqual(["question-1"]);
    h.emit("AGENT_QUESTION_SETTLED", { questionId: "question-1", outcome: { outcome: "dismissed" } });
    expect(slot(placement.chat).pendingQuestions).toEqual([]);
    h.emit("AGENT_QUESTION_REQUEST", question(placement, "question-2"));
    h.emit("AGENT_AGENT_EXITED", { agentId: "claude", sessionId: placement.route, code: 1, signal: null });
    expect(slot(placement.chat).pendingQuestions).toEqual([]);
  });

  it.each(placements)("$owner drains streamed content by the deadline", (placement) => {
    open(placement);
    const h = start();
    h.emit("AGENT_SESSION_UPDATE", chunk(placement, "Hello"));
    h.emit("AGENT_SESSION_UPDATE", chunk(placement, " world"));
    // Ordinary content still waits for a frame-aligned pass.
    expect(text(placement.chat)).toBe("");
    vi.advanceTimersByTime(AGENT_UPDATE_FLUSH_DEADLINE_MS);
    expect(text(placement.chat)).toBe("Hello world");
    expect(h.pendingFrames()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never parks more than the backlog bound of cumulative tool output", () => {
    const [placement] = placements;
    open(placement, "codex");
    const h = start();
    h.emit("AGENT_SESSION_UPDATE", {
      agentId: "codex",
      notification: { sessionId: placement.route, update: { sessionUpdate: "tool_call", toolCallId: "command", title: "pnpm test", kind: "execute", status: "in_progress" } },
    });
    // Codex streams the whole log so far with every delta.
    const deltas = AGENT_UPDATE_BACKLOG_LIMIT * 3;
    let maximumParked = 0;
    for (let index = 1; index <= deltas; index += 1) {
      h.emit("AGENT_SESSION_UPDATE", {
        agentId: "codex",
        notification: { sessionId: placement.route, update: { sessionUpdate: "tool_call_update", toolCallId: "command", status: "in_progress", rawOutput: "x".repeat(index) } },
      });
      const tool = slot(placement.chat).messages.find((message) => message.kind === "tool");
      const applied = typeof tool?.rawOutput === "string" ? tool.rawOutput.length : 0;
      maximumParked = Math.max(maximumParked, index - applied);
    }
    expect(maximumParked).toBeLessThanOrEqual(AGENT_UPDATE_BACKLOG_LIMIT);
    vi.advanceTimersByTime(AGENT_UPDATE_FLUSH_DEADLINE_MS);
    const tool = slot(placement.chat).messages.find((message) => message.kind === "tool");
    expect(tool?.rawOutput).toBe("x".repeat(deltas));
  });

  it("applies a re-entrant control event after the running flush, in order", () => {
    const [placement] = placements;
    open(placement);
    allowShell(placement);
    const h = start();
    h.onSend((message) => {
      if (message.permissionId !== "permission-1") return;
      // The engine settles the auto-answered gate, asks for a gate the policy
      // does not cover and streams a chunk, all before this flush returns.
      h.emit("AGENT_PERMISSION_SETTLED", { permissionId: "permission-1", sessionId: placement.route });
      h.emit("AGENT_PERMISSION_REQUEST", permission(placement, "permission-2", "edit"));
      h.emit("AGENT_SESSION_UPDATE", chunk(placement, "after"));
    });
    h.emit("AGENT_SESSION_UPDATE", chunk(placement, "before "));
    h.emit("AGENT_PERMISSION_REQUEST", permission(placement, "permission-1"));
    expect(h.send).toHaveBeenCalledOnce();
    expect(slot(placement.chat).pendingPermissions.map((entry) => entry.permissionId)).toEqual(["permission-2"]);
    expect(text(placement.chat)).toBe("before after");
    // Nothing remains armed once the follow-up drain has applied everything.
    expect(h.pendingFrames()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("routes interleaved Local, organization and cloud content to its exact chat", () => {
    for (const placement of placements) open(placement);
    const h = start();
    const [personal, organization, cloud] = placements;
    h.emit("AGENT_SESSION_UPDATE", chunk(personal, "p1"));
    h.emit("AGENT_SESSION_UPDATE", chunk(cloud, "c1", { stamped: true }));
    h.emit("AGENT_SESSION_UPDATE", chunk(organization, "o1"));
    // A retired execution without an engine chat id has no owner.
    h.emit("AGENT_SESSION_UPDATE", chunk({ ...personal, route: "retired-execution" }, "stale"));
    h.emit("AGENT_SESSION_UPDATE", chunk(personal, "p2"));
    h.emit("AGENT_SESSION_UPDATE", chunk(cloud, "c2", { stamped: true }));
    h.emit("AGENT_SESSION_UPDATE", chunk(organization, "o2"));
    vi.advanceTimersByTime(AGENT_UPDATE_FLUSH_DEADLINE_MS);
    expect(text(personal.chat)).toBe("p1p2");
    expect(text(organization.chat)).toBe("o1o2");
    expect(text(cloud.chat)).toBe("c1c2");
  });
});

describe("agent notifications in a visible window", () => {
  it("keeps content in one frame-aligned flush with no extra timer flush", () => {
    const [placement] = placements;
    open(placement);
    const h = start();
    const before = h.notifications();
    for (const value of ["a", "b", "c"]) h.emit("AGENT_SESSION_UPDATE", chunk(placement, value));
    expect(h.notifications()).toBe(before);
    h.frame();
    expect(text(placement.chat)).toBe("abc");
    const afterFrame = h.notifications();
    vi.advanceTimersByTime(AGENT_UPDATE_FLUSH_DEADLINE_MS * 4);
    expect(h.notifications()).toBe(afterFrame);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drains a turn boundary synchronously and leaves nothing armed", () => {
    const [placement] = placements;
    open(placement);
    useSessionsStore.getState().applyBridgeUpdate({
      sessionId: placement.route,
      update: { sessionUpdate: "turn_state", turnId: "turn-1", state: "running", startedAt: 1 },
    } as never);
    const h = start();
    h.emit("AGENT_SESSION_UPDATE", chunk(placement, "final answer"));
    h.emit("AGENT_SESSION_UPDATE", terminal(placement));
    expect(text(placement.chat)).toBe("final answer");
    expect(slot(placement.chat).status).toBe("ready");
    expect(h.release).toHaveBeenCalledExactlyOnceWith(placement.chat);
    expect(h.pendingFrames()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("applies buffered content on teardown and leaves no callback behind", () => {
    const [placement] = placements;
    open(placement);
    const h = start();
    h.emit("AGENT_SESSION_UPDATE", chunk(placement, "kept"));
    h.stop();
    active = null;
    expect(text(placement.chat)).toBe("kept");
    expect(h.pendingFrames()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("agent stderr", () => {
  it("applies a burst of stderr lines as one store update with the same retained lines", () => {
    const [personal, organization, cloud] = placements;
    open(personal);
    open(cloud);
    open(organization, "codex");
    useSessionsStore.getState().patchSession(cloud.chat, { transcriptState: "cold" });
    const h = start();
    const lines = Array.from({ length: 250 }, (_, index) => `line ${index}`);
    for (const line of lines) h.emit("AGENT_AGENT_STDERR", { agentId: "claude", line });
    const before = h.notifications();
    h.frame();
    expect(h.notifications() - before).toBe(1);
    expect(slot(personal.chat).stderrLog).toEqual(lines.slice(-200));
    expect(slot(organization.chat).stderrLog).toEqual([]);
    expect(slot(cloud.chat).stderrLog).toEqual([]);
  });
});

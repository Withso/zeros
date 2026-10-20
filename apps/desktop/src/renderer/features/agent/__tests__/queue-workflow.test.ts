import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SendQueue } from "../send-queue";
import { CloudSendPreparation } from "../cloud-send-preparation";
import * as lifecycle from "../session-reload-lifecycle";
import { isCloudWorkspace, parseCloudWorkspaceKey } from "../../../platform/bridge/cloud-workspace-key";
import { hasBackgroundAgentWork } from "../background-task-state";
import { queuedTranscriptPresentation } from "./helpers/queued-transcript-presentation";

// Exercise the actual provider callbacks with an in-memory bridge/store. This
// keeps Stop/Send now races deterministic without mounting unrelated app UI.
const source = readFileSync(
  new URL("../sessions-provider.tsx", import.meta.url),
  "utf8",
);
const ast = ts.createSourceFile(
  "provider.tsx",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const names = new Set([
  "pauseQueue",
  "resumeQueue",
  "markQueuedDelivery",
  "cancel",
  "steerQueued",
  "drainNextQueued",
  "flushQueuedPrompt",
  "refreshQueuedAttachments",
  "holdQueue",
  "releaseQueue",
  "editQueued",
  "removeQueued",
  "sendPrompt",
]);
const callbacks: string[] = [];
function collect(node: ts.Node): void {
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    names.has(node.name.text)
  ) {
    callbacks.push(`const ${node.getText(ast)};`);
  }
  ts.forEachChild(node, collect);
}
collect(ast);
const code = ts.transpileModule(
  callbacks.join("\n") + `\nglobalThis.actions = {${[...names].filter(name => !["flushQueuedPrompt", "refreshQueuedAttachments"].includes(name)).join(",")}};`,
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  },
).outputText;

function setup(agentId = "claude", status = "streaming") {
  type Entry = { bubbleId: string; args: unknown[]; steerRequest?: unknown };
  const queue = new SendQueue<Entry>();
  const requests: Array<{
    message: Record<string, unknown>;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }> = [];
  const sent: unknown[][] = [];
  const sending = new Set(status === "streaming" ? ["chat"] : []);
  const messages = ["B", "C", "D"].map((id) => ({
    id,
    kind: "text",
    role: "user",
    text: id,
    queued: true,
  }));
  // Only test-harness boundaries are dynamic; callbacks retain their real types.
  const store: any = {
    sessions: {
      chat: {
        agentId,
        sessionId: "execution",
        executionId: "execution",
        status,
        cwd: "/repo",
        initialize: { protocolVersion: 1, agentCapabilities: { steering: true } },
        messages,
      },
    },
    patchSession(id: string, patch: object) {
      Object.assign(this.sessions[id], patch);
    },
    setPendingLocalTurn: vi.fn(),
    setCancelling: vi.fn(),
  };
  queue.set(
    "chat",
    messages.map((m) => ({ bubbleId: m.id, args: ["chat", m.text] })),
  );
  const flush = new Map<string, string>();
  const context: any = {
    ...lifecycle,
    hasBackgroundAgentWork,
    isCloudWorkspace,
    parseCloudWorkspaceKey,
    cloudComputerV2: false,
    cloudCatalogGeneration: () => "account",
    hasCloudWorkspaceAccountAccess: () => true,
    useWorkspaceStore: { getState: () => ({ chats: [] }) },
    getAgentsSnapshot: () => [],
    pendingAuthenticationPrompts: () => [],
    prepareForSend: vi.fn(() => null),
    persistAuthPrompt: vi.fn(),
    drainOrDropQueue: vi.fn(),
    retryCloudQueuedPrompt: vi.fn(),
    notifyAgentSendFailure: vi.fn(),
    refreshModelCatalog: vi.fn(),
    cloudFlushRef: { current: new Map() },
    cloudStopsRef: { current: new Map() },
    beginCloudSendWaitRef: { current: vi.fn() },
    capUserAppend: (list: unknown[], message: unknown) => [...list, message],
    crypto: {
      randomUUID: (() => {
        let id = 0;
        return () => `attempt-${++id}`;
      })(),
    },
    useCallback: (fn: unknown) => fn,
    getStore: () => store,
    sendQueueRef: { current: queue },
    queueHeldRef: { current: new Set() },
    cancelGenerationsRef: { current: new Map() },
    cloudSendPreparationRef: { current: new CloudSendPreparation() },
    cloudSendWaitRef: { current: { cancel: vi.fn() } },
    flushLocalNotificationsRef: { current: vi.fn() },
    sendingChatsRef: { current: sending },
    flushBubbleRef: { current: flush },
    ensureInFlightRef: { current: new Map() },
    sendPromptRef: {
      current: (...args: unknown[]) => {
        sent.push(args);
        sending.add("chat");
        store.sessions.chat.status = "streaming";
        const id = flush.get("chat");
        flush.delete("chat");
        store.sessions.chat.messages = store.sessions.chat.messages.map(
          (m: { id: string }) => (m.id === id ? { ...m, queued: false } : m),
        );
      },
    },
    steerQueuedRef: { current: null },
    bridge: {
      request: (
        message: Record<string, unknown>,
        options: { timeoutMs?: number } = {},
      ) =>
        new Promise((resolve, reject) => {
          const timeoutMs = options.timeoutMs ?? 5_000;
          const timer = timeoutMs > 0
            ? setTimeout(() => reject(new Error("bridge timeout")), timeoutMs)
            : undefined;
          requests.push({
            message,
            resolve: (value) => { clearTimeout(timer); resolve(value); },
            reject: (error) => { clearTimeout(timer); reject(error); },
          });
        }),
      send: vi.fn(),
    },
    loadedBackgroundTaskState: () => ({}),
    awaitComposerMode: vi.fn(() => undefined),
    cancelStalledAdmission: vi.fn(),
    evictUnretainedTranscripts: vi.fn(),
    toast: { error: vi.fn() },
    queueMicrotask,
    activeProviderTurnId: () => "A",
    hasPromptAttachmentReferences: (payload: { bubbleAttachments?: unknown[] }) => !!payload.bubbleAttachments?.length,
    refreshPromptAttachments: vi.fn(async (payload: object) => payload),
    promoteToEnd: (
      list: Array<{ id: string }>,
      id: string,
      message: object,
    ) => [...list.filter((m) => m.id !== id), message],
  };
  vm.runInNewContext(code, context);
  context.steerQueuedRef.current = context.actions.steerQueued;
  const finish = async () => {
    sending.delete("chat");
    store.sessions.chat.status = "ready";
    context.actions.drainNextQueued("chat");
    await Promise.resolve();
  };
  return {
    queue,
    requests,
    sent,
    store,
    actions: context.actions,
    finish,
    context,
  };
}

afterEach(() => vi.useRealTimers());

describe.each(["claude", "codex", "cursor"])("%s follow-up submission", agentId => {
  it.each(["/personal/project", "/organization/project", "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222"])(
    "keeps Steer visible in the correct surface for %s while native consumption is pending", async folder => {
      const h = setup(agentId);
      h.store.sessions.chat.cwd = folder;
      h.context.cloudComputerV2 = isCloudWorkspace(folder);
      await h.actions.sendPrompt("chat", "Steer now", undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, "steer");
      await vi.waitFor(() => expect(h.requests).toHaveLength(1));
      const projected = queuedTranscriptPresentation(h.store.sessions.chat.messages, h.store.sessions.chat);
      const steer = h.store.sessions.chat.messages.at(-1);
      expect(isCloudWorkspace(folder) ? projected.queuedMessages.at(-1) : projected.visibleMessages[0]).toMatchObject({ text: "Steer now", steeredTurnId: "A" });
      expect(projected.visibleMessages).toHaveLength(isCloudWorkspace(folder) ? 0 : 1);
      expect(projected.queuedMessages.map(message => message.id)).toEqual(isCloudWorkspace(folder) ? ["B", "C", "D", steer.id] : ["B", "C", "D"]);
      expect(h.store.sessions.chat.cloudSendWait).toBeUndefined();
      const bubbleId = steer.id;
      h.store.sessions.chat.messages.push({ id: "continued", kind: "text", role: "agent", text: "Still working", createdAt: 10 });
      h.requests[0]!.resolve({ type: "AGENT_STEERED", outcome: "delivered", turnId: "A" });
      await vi.waitFor(() => expect(h.queue.get("chat")).toHaveLength(3));
      expect(queuedTranscriptPresentation(h.store.sessions.chat.messages).visibleMessages.map(message => message.id)).toEqual([bubbleId, "continued"]);
    },
  );

  it("keeps Queue as the default while a turn is working", async () => {
    const h = setup(agentId);
    await h.actions.sendPrompt("chat", "new follow-up");
    expect(h.requests).toEqual([]);
    expect(h.queue.get("chat")?.map(entry => entry.args[1])).toEqual(["B", "C", "D", "new follow-up"]);
  });

  it("dispatches Steer immediately without waiting for the current turn to finish", async () => {
    const h = setup(agentId);
    await h.actions.sendPrompt("chat", "new instruction", undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, "steer");
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].message).toMatchObject({ type: "AGENT_STEER", prompt: [{ type: "text", text: "new instruction" }] });
    h.requests[0].resolve({ type: "AGENT_STEERED", outcome: "delivered", turnId: "A" });
    await vi.waitFor(() => expect(h.queue.get("chat")?.map(entry => entry.bubbleId)).toEqual(["B", "C", "D"]));
    expect(h.store.sessions.chat.messages.at(-1)).toMatchObject({ text: "new instruction", queued: false });
  });

  it("prepares cloud attachment payloads before immediate steering", async () => {
    const h = setup(agentId);
    h.context.cloudComputerV2 = true;
    h.store.sessions.chat.cwd = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
    const prepare = vi.fn(async () => ({ text: "Inspect attached context", attachments: [{ type: "text", text: "Saved attachment content" }] }));
    await h.actions.sendPrompt("chat", "Inspect attached context", undefined, undefined, undefined, undefined, undefined, undefined,
      { prepare }, undefined, "steer");
    await vi.waitFor(() => expect(h.requests).toHaveLength(1));
    expect(prepare).toHaveBeenCalledOnce();
    expect(h.requests[0].message).toMatchObject({ type: "AGENT_STEER", prompt: [
      { type: "text", text: "Inspect attached context" }, { type: "text", text: "Saved attachment content" },
    ] });
    h.requests[0].resolve({ type: "AGENT_STEERED", outcome: "delivered", turnId: "A" });
    await vi.waitFor(() => expect(h.queue.get("chat")).toHaveLength(3));
  });
});

describe("undispatched cloud cancellation", () => {
  it.each(["waiting", "failed"])("retains the %s queued opening send as Not sent after Stop without cancelling a native turn", async state => {
    const h = setup("codex", "ready");
    h.context.cloudComputerV2 = true;
    h.store.sessions.chat.cwd = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
    h.store.sessions.chat.cloudSendWait = { state, phase: "sending", turnId: "B" };
    h.store.sessions.chat.messages[0].queuedPresentation = "active-turn";
    const original = h.queue.get("chat")![0];
    const attachments = [{ type: "image", data: "synthetic-retained-payload" }];
    original.args.push(undefined, attachments);
    const stop = h.actions.cancel("chat");
    // Always release the old implementation's request, so an intended
    // assertion red cannot leave a timer/transport flight behind.
    for (const request of h.requests) request.resolve({ type: "AGENT_CANCELLED" });
    await stop;
    expect(h.requests).toEqual([]);
    expect(h.store.sessions.chat.messages.map((m: { id: string }) => m.id)).toEqual(["B", "C", "D"]);
    expect(h.queue.get("chat")?.map(row => row.bubbleId)).toEqual(["B", "C", "D"]);
    expect(h.queue.get("chat")![0]).toBe(original);
    expect(h.queue.get("chat")![0].args.at(-1)).toBe(attachments);
    expect(h.store.sessions.chat.cloudSendWait).toMatchObject({ state: "failed", turnId: "B", message: expect.stringContaining("Stopped") });
    expect(h.queue.isPaused("chat")).toBe(true);
    expect(h.context.cloudSendWaitRef.current.cancel).toHaveBeenCalledExactlyOnceWith("chat");
    h.actions.drainNextQueued("chat");
    expect(h.sent).toEqual([]);
  });
});

describe("cloud steering preparation ownership", () => {
  it("cancels a ready cloud preparation even when it has no Waiting presentation", async () => {
    const h = setup("codex", "ready");
    h.context.cloudComputerV2 = true;
    h.store.sessions.chat.cwd = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
    const stopped = h.actions.cancel("chat");
    expect(h.context.cloudSendWaitRef.current.cancel).toHaveBeenCalledExactlyOnceWith("chat");
    expect(h.queue.isPaused("chat")).toBe(true);
    expect(h.requests).toHaveLength(1);
    h.requests[0]!.resolve({ type: "AGENT_CANCELLED" });
    await stopped;
    expect(h.sent).toEqual([]);
  });

  it.each(["stop", "execution", "workspace", "account"])("does not deliver an attachment prepared after %s changes", async changed => {
    const h = setup("claude");
    h.context.cloudComputerV2 = true;
    h.store.sessions.chat.cwd = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
    let release!: (payload: { text: string }) => void;
    const prepare = vi.fn(() => new Promise(resolve => { release = resolve; }));
    await h.actions.sendPrompt("chat", "pending attachment", undefined, undefined, undefined, undefined, undefined, undefined,
      { prepare }, undefined, "steer");
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    if (changed === "stop") {
      h.context.cancelGenerationsRef.current.set("chat", 1);
      h.queue.pause("chat");
    } else if (changed === "execution") h.store.sessions.chat.executionId = "replacement";
    else if (changed === "workspace") h.store.sessions.chat.cwd = "/other";
    else h.context.cloudCatalogGeneration = () => "another-account";
    release({ text: "prepared attachment" });
    await vi.waitFor(() => expect(h.queue.isSending("chat")).toBe(false));
    expect(h.requests).toEqual([]);
    expect(h.queue.get("chat")?.at(-1)?.args[1]).toBe("pending attachment");
    expect(h.store.sessions.chat.messages.at(-1).queuedDelivery).toBeUndefined();
  });
});

describe.each(["/repo", "/organization/repo", "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222"])(
  "background queue ownership in %s",
  cwd => {
    it("accepts a new follow-up into the queue while only background work remains", () => {
      expect(lifecycle.shouldQueuePrompt({ status: "ready", hasLocalSend: false,
        hasQueuedSends: false, queueHeld: false, flushing: false, hasBackgroundWork: true })).toBe(true);
    });

    it("keeps follow-ups queued after the foreground reply while Claude still has background tasks", async () => {
      const h = setup("claude", "ready");
      h.store.sessions.chat.cwd = cwd;
      h.store.sessions.chat.backgroundTasks = [{ taskId: "child", status: "running", description: "Verify changes", startedAt: 1 }];
      h.store.sessions.chat.waitingForBackgroundTasks = true;
      h.actions.drainNextQueued("chat");
      await Promise.resolve();
      expect(h.sent).toEqual([]);
      expect(h.queue.get("chat")?.map(entry => entry.bubbleId)).toEqual(["B", "C", "D"]);

      h.store.sessions.chat.backgroundTasks = [];
      h.store.sessions.chat.waitingForBackgroundTasks = false;
      h.actions.drainNextQueued("chat");
      await Promise.resolve();
      expect(h.sent).toEqual([["chat", "B"]]);
    });

    it("holds the queue while the parent is reporting after its last background task exits", async () => {
      const h = setup("claude", "ready");
      h.store.sessions.chat.cwd = cwd;
      h.store.sessions.chat.backgroundTasks = [];
      h.store.sessions.chat.backgroundActivity = { state: "running", startedAt: 1 };
      h.actions.releaseQueue("chat");
      await Promise.resolve();
      expect(h.sent).toEqual([]);
    });

    it("sends an explicit steer immediately while the parent is waiting on background tasks", async () => {
      const h = setup("claude", "ready");
      h.store.sessions.chat.cwd = cwd;
      h.store.sessions.chat.backgroundTasks = [{ taskId: "child", status: "running" }];
      h.store.sessions.chat.waitingForBackgroundTasks = true;
      await h.actions.sendPrompt("chat", "redirect the task", undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, "steer");
      expect(h.sent).toEqual([["chat", "redirect the task", undefined, undefined, undefined, undefined, undefined]]);
      expect(h.queue.get("chat")?.map(entry => entry.bubbleId)).toEqual(["B", "C", "D"]);
    });
  },
);

describe("cloud Stop acknowledgement", () => {
  it("retains a dispatched unaccepted prompt when Remove is called outside the queue UI", () => {
    const h = setup("codex");
    const slot = h.store.sessions.chat;
    slot.cwd = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
    slot.cloudPromptPending = true;
    slot.foregroundTurnId = "pending-command";
    const prompt = { id: "pending-command", kind: "text", role: "user", text: "Keep this prompt", queued: false };
    slot.messages.push(prompt);
    h.actions.removeQueued("chat", prompt.id);
    expect(slot.messages).toContain(prompt);
    expect(slot.cloudPromptPending).toBe(true);
    expect(h.queue.get("chat")?.map(entry => entry.bubbleId)).toEqual(["B", "C", "D"]);
    expect(h.requests).toHaveLength(0);
  });

  it("sends a correlated owned request and a late acknowledgement does not clear a newer turn", async () => {
    const h = setup("codex"); h.store.sessions.chat.cwd = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
    const pending = h.actions.cancel("chat");
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].message).toMatchObject({ type: "AGENT_CANCEL", chatId: "chat", id: expect.any(String), executionId: "execution" });
    expect(h.context.bridge.send).not.toHaveBeenCalled();
    h.store.sessions.chat.status = "streaming"; h.store.sessions.chat.activeTurnStartedAt = 100;
    h.requests[0].resolve({ type: "WORKSPACE_RESPONSE", result: { paused: true, conversationId: "chat" } }); await pending;
    expect(h.store.sessions.chat).toMatchObject({ status: "streaming", activeTurnStartedAt: 100 });
  });
});

describe.each(["claude", "codex", "cursor"])(
  "%s queue and Stop workflow",
  (agentId) => {
    it("waits for slow native delivery without pausing or losing the receipt", async () => {
      vi.useFakeTimers();
      const h = setup(agentId);
      const settled = vi.fn();
      const pending = h.actions.steerQueued("chat", "C").then(settled);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(settled).not.toHaveBeenCalled();
      expect(h.queue.isPaused("chat")).toBe(false);
      expect(h.store.sessions.chat.messages.find((m: { id: string }) => m.id === "C"))
        .toMatchObject({ queued: true, queuedDelivery: "sending" });
      // Other follow-ups remain editable/deletable while native delivery waits.
      h.actions.editQueued("chat", "B", { text: "edited B" });
      h.actions.removeQueued("chat", "D");
      await h.actions.steerQueued("chat", "C");
      expect(h.requests).toHaveLength(1);

      h.requests[0]!.resolve({ type: "AGENT_STEERED", outcome: "delivered", turnId: "A" });
      await pending;
      expect(settled).toHaveBeenCalledExactlyOnceWith(true);
      expect(h.store.sessions.chat.messages.find((m: { id: string }) => m.id === "C"))
        .toMatchObject({ queued: false, queuedDelivery: undefined, steeredTurnId: "A" });
      await h.finish();
      expect(h.sent.map(args => args[1])).toEqual(["edited B"]);
    });

    it("restores edit and delete after Stop returns a delayed instruction to the queue", async () => {
      vi.useFakeTimers();
      const h = setup(agentId);
      const pending = h.actions.steerQueued("chat", "C");
      await vi.advanceTimersByTimeAsync(60_000);
      await h.actions.cancel("chat");
      await h.finish();
      h.requests[0]!.resolve({ type: "AGENT_STEERED", outcome: "queued" });
      expect(await pending).toBe(true);
      expect(h.queue.isPaused("chat")).toBe(true);
      expect(h.queue.get("chat")!.map(entry => entry.bubbleId)).toEqual(["B", "C", "D"]);
      expect(h.store.sessions.chat.messages.find((m: { id: string }) => m.id === "C"))
        .toMatchObject({ queued: true, queuedDelivery: undefined });
      h.actions.editQueued("chat", "C", { text: "edited C" });
      expect(h.queue.get("chat")!.find(entry => entry.bubbleId === "C")!.args[1]).toBe("edited C");
      h.actions.removeQueued("chat", "C");
      expect(h.queue.get("chat")!.map(entry => entry.bubbleId)).toEqual(["B", "D"]);
      expect(h.sent).toEqual([]);
    });

    it("does not steer after Stop while a composer mode selection is pending", async () => {
      const h = setup(agentId);
      let confirm!: () => void;
      h.context.awaitComposerMode.mockReturnValue(new Promise<void>((resolve) => { confirm = resolve; }));
      const sending = h.actions.steerQueued("chat", "C");
      expect(h.requests).toHaveLength(0);
      h.actions.cancel("chat");
      confirm();
      expect(await sending).toBe(false);
      expect(h.requests).toHaveLength(0);
      expect(h.queue.get("chat")?.find((entry) => entry.bubbleId === "C")?.steerRequest).toBeUndefined();
    });

    it("keeps a message editable when its composer mode selection fails before delivery", async () => {
      const h = setup(agentId);
      h.context.awaitComposerMode.mockReturnValue(Promise.reject(new Error("mode selection failed")));
      expect(await h.actions.steerQueued("chat", "C")).toBe(false);
      expect(h.requests).toHaveLength(0);
      expect(h.queue.get("chat")?.find((entry) => entry.bubbleId === "C")?.steerRequest).toBeUndefined();
    });

    it("preserves an uncertain original attempt when its receipt retry is rejected", async () => {
      const h = setup(agentId);
      const first = h.actions.steerQueued("chat", "C");
      h.requests[0]!.reject(new Error("reply lost"));
      await first;
      await h.finish();
      h.store.sessions.chat.sessionId = "replacement";
      h.store.sessions.chat.executionId = "replacement";
      const retry = h.actions.steerQueued("chat", "C");
      h.requests[1]!.resolve({ type: "AGENT_ERROR", code: "SESSION_ACCESS_DENIED" });
      await retry;
      expect(h.queue.isPaused("chat")).toBe(true);
      expect(h.store.sessions.chat.messages.find((m: { id: string }) => m.id === "C"))
        .toMatchObject({ queued: true, queuedDelivery: "unconfirmed" });
      h.actions.editQueued("chat", "C", { text: "changed" });
      expect(h.queue.get("chat")!.find(e => e.bubbleId === "C")!.args[1]).toBe("C");
      const again = h.actions.steerQueued("chat", "C");
      expect(h.sent).toEqual([]);
      expect(h.requests[2]!.message).toMatchObject({
        attemptId: h.requests[0]!.message.attemptId,
        sessionId: "execution",
      });
      h.requests[2]!.resolve({ type: "AGENT_STEERED", outcome: "delivered", turnId: "A" });
      await again;
      expect(h.queue.get("chat")!.map(e => e.bubbleId)).not.toContain("C");
    });

    it("keeps a first-attempt admission rejection editable", async () => {
      const h = setup(agentId);
      const first = h.actions.steerQueued("chat", "C");
      h.requests[0]!.resolve({ type: "AGENT_ERROR", code: "SESSION_ACCESS_DENIED" });
      await first;
      expect(h.queue.isPaused("chat")).toBe(true);
      expect(h.queue.get("chat")!.find(e => e.bubbleId === "C")!.steerRequest).toBeUndefined();
      h.actions.editQueued("chat", "C", { text: "changed" });
      expect(h.queue.get("chat")!.find(e => e.bubbleId === "C")!.args[1]).toBe("changed");
    });

    it("never resends an interrupted receipt from a retired execution", async () => {
      const h = setup(agentId);
      const first = h.actions.steerQueued("chat", "C");
      h.requests[0]!.reject(new Error("reply lost"));
      await first;
      await h.finish();
      h.store.sessions.chat.sessionId = "replacement";
      h.store.sessions.chat.executionId = "replacement";
      const retry = h.actions.steerQueued("chat", "C");
      h.requests[1]!.resolve({ type: "AGENT_STEERED", outcome: "interrupted" });
      await retry;
      await h.finish();
      expect(h.sent).toEqual([]);
      expect(h.queue.isPaused("chat")).toBe(true);
      expect(h.queue.get("chat")!.map(e => e.bubbleId)).toEqual(["B", "D"]);
      expect(h.store.sessions.chat.messages.find((m: { id: string }) => m.id === "C"))
        .toMatchObject({ queued: false, steeredTurnId: "A" });
    });

    it("retries an unconfirmed delivery receipt without resolving its files again", async () => {
      const h = setup(agentId);
      const entry = h.queue.get("chat")![0]!;
      entry.args[4] = [{ delivery: "reference" }];
      h.context.refreshPromptAttachments.mockResolvedValue({ bubbleAttachments: entry.args[4] });
      const first = h.actions.steerQueued("chat", "B");
      await vi.waitFor(() => expect(h.requests).toHaveLength(1));
      h.requests[0]!.reject(new Error("reply lost"));
      await first;
      h.context.refreshPromptAttachments.mockRejectedValue(new Error("file since deleted"));
      const retry = h.actions.steerQueued("chat", "B");
      expect(h.requests[1]!.message.attemptId).toBe(h.requests[0]!.message.attemptId);
      h.requests[1]!.resolve({ type: "AGENT_STEERED", outcome: "delivered" });
      await retry;
      expect(h.context.refreshPromptAttachments).toHaveBeenCalledTimes(1);
    });

    it("ignores preparation completion after the queue owner is replaced", async () => {
      const h = setup(agentId, "ready");
      h.queue.get("chat")![0]!.args[4] = [{ delivery: "reference" }];
      let finish!: (payload: object) => void;
      h.context.refreshPromptAttachments.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
      h.actions.drainNextQueued("chat");
      h.queue.delete("chat");
      h.queue.set("chat", [{ bubbleId: "replacement", args: ["chat", "newer instruction"] }]);
      finish({});
      await Promise.resolve();
      await Promise.resolve();
      expect(h.sent).toEqual([]);
      expect(h.queue.get("chat")![0]!.args[1]).toBe("newer instruction");
      expect(h.queue.isPaused("chat")).toBe(false);
    });

    it.each(["drain", "send now", "steer"])("refreshes moved attachment paths before %s", async (action) => {
      const h = setup(agentId, action === "steer" ? "streaming" : "ready");
      const oldPath = ".context/local/attachments/att/file.pdf";
      const newPath = ".context/shared/attachments/att/file.pdf";
      const original = { name: "file.pdf", kind: "file", mimeType: "application/pdf", attachmentId: "att", diskPath: oldPath, delivery: "reference" };
      const entry = h.queue.get("chat")![0]!;
      entry.args = ["chat", "B", "B", [{ type: "text", text: oldPath }], [original], [{ type: "attachment", ...original }]];
      h.context.refreshPromptAttachments.mockResolvedValue({ attachments: [{ type: "text", text: newPath }], bubbleAttachments: [{ ...original, diskPath: newPath }], segments: [{ type: "attachment", ...original, diskPath: newPath }] });
      const pending = action === "drain" ? h.actions.drainNextQueued("chat") : h.actions.steerQueued("chat", "B");
      await vi.waitFor(() => expect(action === "steer" ? h.requests : h.sent).toHaveLength(1));
      if (action === "steer") {
        expect(h.requests[0]!.message.prompt).toEqual([{ type: "text", text: "B" }, { type: "text", text: newPath }]);
        expect(h.requests[0]!.message.bubble).toMatchObject({ attachments: [{ diskPath: newPath }], segments: [{ diskPath: newPath }] });
        h.requests[0]!.resolve({ type: "AGENT_STEERED", outcome: "delivered" });
      } else {
        expect(h.sent[0]![3]).toEqual([{ type: "text", text: newPath }]);
        expect(h.sent[0]![4]).toMatchObject([{ diskPath: newPath }]);
      }
      await pending;
    });

    it.each(["drain", "steer"])("keeps an unavailable attachment queued on %s without sending stale paths", async (action) => {
      const h = setup(agentId, action === "steer" ? "streaming" : "ready");
      h.queue.get("chat")![0]!.args[4] = [{ delivery: "reference" }];
      h.context.refreshPromptAttachments.mockRejectedValue(new Error("The saved attachment is not available"));
      if (action === "drain") h.actions.drainNextQueued("chat");
      else await h.actions.steerQueued("chat", "B");
      await vi.waitFor(() => expect(h.queue.isPaused("chat")).toBe(true));
      expect(h.sent).toEqual([]);
      expect(h.requests).toEqual([]);
      expect(h.queue.get("chat")!.map(e => e.bubbleId)).toEqual(["B", "C", "D"]);
      expect(h.queue.get("chat")![0]!.steerRequest).toBeUndefined();
      expect(h.queue.isSending("chat")).toBe(false);
    });

    it.each(["drain", "steer"])("honors Stop while %s resolves attachments", async (action) => {
      const h = setup(agentId, action === "steer" ? "streaming" : "ready");
      h.queue.get("chat")![0]!.args[4] = [{ delivery: "reference" }];
      let finish!: (payload: object) => void;
      h.context.refreshPromptAttachments.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
      const pending = action === "drain" ? h.actions.drainNextQueued("chat") : h.actions.steerQueued("chat", "B");
      await h.actions.cancel("chat");
      expect(finish).toBeTypeOf("function");
      finish({});
      await pending;
      await Promise.resolve();
      expect(h.sent).toEqual([]);
      expect(h.requests).toEqual([]);
      expect(h.queue.get("chat")![0]!.steerRequest).toBeUndefined();
      expect(h.queue.isPaused("chat")).toBe(true);
    });

    it("preserves editable B/C/D, then sends selected C → edited B → D automatically", async () => {
      const h = setup(agentId);
      await h.actions.cancel("chat");
      expect(h.queue.get("chat")?.map((e) => e.bubbleId)).toEqual([
        "B",
        "C",
        "D",
      ]);
      expect(h.store.sessions.chat.queuePaused).toBe(true);
      h.actions.holdQueue("chat");
      h.actions.editQueued("chat", "B", { text: "edited B" });
      h.actions.releaseQueue("chat");
      await h.finish();
      expect(h.sent).toEqual([]);
      await h.actions.steerQueued("chat", "C");
      expect(h.sent.map((args) => args[1])).toEqual(["C"]);
      expect(h.store.sessions.chat.queuePaused).toBe(false);
      await h.finish();
      await h.finish();
      expect(h.sent.map((args) => args[1])).toEqual(["C", "edited B", "D"]);
    });

    it("honors a selected send while the stopped A is still settling", async () => {
      const h = setup(agentId);
      await h.actions.cancel("chat");
      await h.actions.steerQueued("chat", "C");
      expect(h.sent).toEqual([]);
      await h.finish();
      expect(h.sent.map((args) => args[1])).toEqual(["C"]);
    });

    it("does not resume when a queued steering receipt arrives after Stop", async () => {
      const h = setup(agentId);
      const pending = h.actions.steerQueued("chat", "C");
      expect(h.requests).toHaveLength(1);
      await h.actions.cancel("chat");
      await h.finish();
      h.requests[0]!.resolve({ type: "AGENT_STEERED", outcome: "queued" });
      await pending;
      await Promise.resolve();
      expect(h.sent).toEqual([]);
      expect(h.queue.get("chat")?.map((e) => e.bubbleId)).toEqual([
        "B",
        "C",
        "D",
      ]);
      expect(h.queue.isPaused("chat")).toBe(true);
      expect(
        h.store.sessions.chat.messages.find((m: { id: string }) => m.id === "C")
          .queuedDelivery,
      ).toBeUndefined();
    });

    it("keeps confirmed late delivery attached to stopped A and does not resend it", async () => {
      const h = setup(agentId);
      const pending = h.actions.steerQueued("chat", "C");
      await h.actions.cancel("chat");
      await h.finish();
      h.requests[0]!.resolve({
        type: "AGENT_STEERED",
        outcome: "delivered",
        turnId: "A",
      });
      await pending;
      await Promise.resolve();
      expect(h.sent).toEqual([]);
      expect(h.queue.get("chat")?.map((e) => e.bubbleId)).toEqual(["B", "D"]);
      expect(
        h.store.sessions.chat.messages.find(
          (m: { id: string }) => m.id === "C",
        ),
      ).toMatchObject({ queued: false, steeredTurnId: "A" });
    });

    it("retries a lost acknowledgement using the same attempt, without flushing unknown delivery", async () => {
      const h = setup(agentId);
      const first = h.actions.steerQueued("chat", "C");
      h.requests[0]!.reject(new Error("bridge timeout"));
      await first;
      await h.finish();
      expect(h.sent).toEqual([]);
      const retry = h.actions.steerQueued("chat", "C");
      expect(h.requests[1]!.message.attemptId).toBe(
        h.requests[0]!.message.attemptId,
      );
      h.requests[1]!.resolve({ type: "AGENT_STEERED", outcome: "queued" });
      await retry;
      await Promise.resolve();
      expect(h.sent.map((args) => args[1])).toEqual(["C"]);
    });

    it("ignores a late reply after this chat's queue was replaced", async () => {
      const h = setup(agentId);
      const pending = h.actions.steerQueued("chat", "C");
      h.queue.delete("chat");
      h.queue.set("chat", [{ bubbleId: "new", args: ["chat", "new"] }]);
      h.store.sessions.chat = {
        agentId,
        sessionId: "replacement",
        status: "ready",
        messages: [
          { id: "new", kind: "text", role: "user", queued: true, text: "new" },
        ],
      };
      h.context.sendingChatsRef.current.clear();
      h.requests[0]!.reject(new Error("old transport closed"));
      await pending;
      await Promise.resolve();
      expect(h.queue.isPaused("chat")).toBe(false);
      expect(h.sent).toEqual([]);
      expect(h.queue.get("chat")?.map((e) => e.bubbleId)).toEqual(["new"]);
    });

    it("blocks edits, deletion and duplicate submission while delivery is unconfirmed", async () => {
      const h = setup(agentId);
      const pending = h.actions.steerQueued("chat", "C");
      await h.actions.steerQueued("chat", "C");
      h.actions.editQueued("chat", "C", { text: "changed" });
      h.actions.removeQueued("chat", "C");
      expect(h.requests).toHaveLength(1);
      expect(
        h.queue.get("chat")?.find((e) => e.bubbleId === "C")?.args[1],
      ).toBe("C");
      h.requests[0]!.resolve({ type: "AGENT_STEERED", outcome: "queued" });
      await pending;
    });

    it("sends selected C next when the native provider returns it as a follow-up", async () => {
    const h = setup(agentId);
    const pending = h.actions.steerQueued("chat", "C");
    h.requests[0]!.resolve({ type: "AGENT_STEERED", outcome: "queued" });
    await pending;
    await h.finish(); await h.finish(); await h.finish();
    expect(h.sent.map((args) => args[1])).toEqual(["C", "B", "D"]);
  });

  it("can send a preserved message when Stop cancelled session admission", async () => {
      const h = setup(agentId, "idle");
      h.store.sessions.chat.sessionId = null;
      h.store.sessions.chat.executionId = null;
      await h.actions.cancel("chat");
      await h.actions.steerQueued("chat", "C");
      expect(h.sent.map((args) => args[1])).toEqual(["C"]);
      expect(h.queue.get("chat")?.map((e) => e.bubbleId)).toEqual(["B", "D"]);
    });
  },
);


describe("ARCH receipt-owned optimistic steering", () => {
  it("does not move or rebind an old receipt retry to a newer provider turn", async () => {
    const h = setup("claude");
    const first = h.actions.steerQueued("chat", "C");
    h.requests[0]!.reject(new Error("reply lost"));
    await first;
    h.store.sessions.chat.executionId = "replacement";
    h.store.sessions.chat.sessionId = "replacement";
    h.store.sessions.chat.status = "streaming";
    h.store.sessions.chat.messages.push({ id: "next-turn", kind: "text", role: "user", text: "New turn", createdAt: 20 });
    h.context.activeProviderTurnId = () => "next-turn";
    const before = h.store.sessions.chat.messages.map((message: { id: string }) => message.id);
    const retry = h.actions.steerQueued("chat", "C");
    const pending = h.store.sessions.chat.messages.find((message: { id: string }) => message.id === "C");
    const pendingOrder = h.store.sessions.chat.messages.map((message: { id: string }) => message.id);
    h.requests[1]!.resolve({ type: "AGENT_STEERED", outcome: "delivered", turnId: "A" });
    await retry;
    expect(h.requests[1]!.message).toMatchObject({ attemptId: h.requests[0]!.message.attemptId, executionId: "execution", sessionId: "execution" });
    expect(h.sent).toEqual([]);
    expect(pending.steeredTurnId).not.toBe("next-turn");
    expect(pendingOrder).toEqual(before);
  });

  it.each([
    { agent: "claude", folder: "/personal/project", outcome: "delivered", replaceExecution: false },
    { agent: "codex", folder: "/organization/project", outcome: "interrupted", replaceExecution: true },
    { agent: "cursor", folder: "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222", outcome: "rejected", replaceExecution: true },
  ])("keeps $agent's original turn and position through a $outcome receipt in $folder", async ({ agent, folder, outcome, replaceExecution }) => {
    const h = setup(agent);
    h.store.sessions.chat.cwd = folder;
    h.context.cloudComputerV2 = isCloudWorkspace(folder);
    const first = h.actions.steerQueued("chat", "C");
    h.requests[0]!.reject(new Error("reply lost"));
    await first;
    if (replaceExecution) {
      h.store.sessions.chat.executionId = "replacement";
      h.store.sessions.chat.sessionId = "replacement";
    }
    h.store.sessions.chat.messages.push({ id: "next-turn", kind: "text", role: "user", text: "Next turn", createdAt: 20 });
    h.context.activeProviderTurnId = () => "next-turn";
    const before = h.store.sessions.chat.messages.map((message: { id: string }) => message.id);
    const retry = h.actions.steerQueued("chat", "C");
    const pending = h.store.sessions.chat.messages.find((message: { id: string }) => message.id === "C");
    const pendingOrder = h.store.sessions.chat.messages.map((message: { id: string }) => message.id);
    h.requests[1]!.resolve(outcome === "rejected"
      ? { type: "AGENT_ERROR", code: "SESSION_ACCESS_DENIED" }
      : { type: "AGENT_STEERED", outcome, turnId: "A" });
    await retry;
    expect(h.requests[1]!.message).toMatchObject({ attemptId: h.requests[0]!.message.attemptId,
      executionId: "execution", sessionId: "execution" });
    expect(h.sent).toEqual([]);
    expect(pending.steeredTurnId).toBe("A");
    expect(pendingOrder).toEqual(before);
    expect(h.store.sessions.chat.messages.map((message: { id: string }) => message.id)).toEqual(before);
    expect(h.store.sessions.chat.messages.find((message: { id: string }) => message.id === "C").steeredTurnId).toBe("A");
    if (outcome === "rejected") {
      expect(h.queue.get("chat")!.find(entry => entry.bubbleId === "C")!.steerRequest).toBeDefined();
      expect(h.queue.isPaused("chat")).toBe(true);
    }
  });
});

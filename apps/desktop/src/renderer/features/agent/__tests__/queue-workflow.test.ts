import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { SendQueue } from "../send-queue";
import * as lifecycle from "../session-reload-lifecycle";

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
      request: (message: Record<string, unknown>) =>
        new Promise((resolve, reject) =>
          requests.push({ message, resolve, reject }),
        ),
      send: vi.fn(),
    },
    loadedBackgroundTaskState: () => ({}),
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

describe.each(["claude", "codex", "cursor"])(
  "%s queue and Stop workflow",
  (agentId) => {
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

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
  callbacks.join("\n") + `\nglobalThis.actions = {${[...names].join(",")}};`,
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

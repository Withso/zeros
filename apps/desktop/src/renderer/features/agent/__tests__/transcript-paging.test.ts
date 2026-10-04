import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import type {
  AgentMessage,
  AgentSessionState,
  AgentTextMessage,
  AgentToolMessage,
} from "../use-agent-session";
import { beginChatScrollNavigation, CHAT_SCROLL_NAVIGATION_EVENT } from "../chat-scroll-navigation";
import { BLANK } from "../sessions-store";
import { captureScrollAnchor, restoreTargetTop } from "../chat-scroll-anchor";
import * as paging from "../transcript-paging";

// Like queue-workflow.test.ts, exercise the actual callbacks with deferred I/O
// and immutable session slots. No provider account or private history is needed.
const source = readFileSync(
  new URL("../agent-chat.tsx", import.meta.url),
  "utf8",
);
const ast = ts.createSourceFile(
  "chat.tsx",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const callbacks: string[] = [];
function collect(node: ts.Node): void {
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    ["loadOlder", "probe", "settleScroll"].includes(node.name.text) &&
    node.initializer
  ) {
    const initializer = ts.isCallExpression(node.initializer)
      ? node.initializer.arguments[0]
      : node.initializer;
    callbacks.push(
      `globalThis.${node.name.text} = ${initializer.getText(ast)};`,
    );
  }
  ts.forEachChild(node, collect);
}
collect(ast);
const code = ts.transpileModule(callbacks.join("\n"), {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
  },
}).outputText;

const user = (id: string, queued = false): AgentTextMessage => ({
  id,
  kind: "text",
  role: "user",
  text: id,
  createdAt: 1,
  ...(queued ? { queued: true } : {}),
});
const answer = (text: string): AgentTextMessage => ({
  id: "answer",
  kind: "text",
  role: "agent",
  text,
  createdAt: 2,
});

function setup(agentId = "claude") {
  const initial = [user("oldest"), user("steering", true), answer("First ")];
  const store = {
    sessions: {
      chat: {
        ...BLANK,
        agentId,
        executionId: "execution",
        sessionId: "execution",
        status: "streaming",
        messages: initial,
      },
    } as Record<string, AgentSessionState>,
    patchSession(id: string, patch: Partial<AgentSessionState>) {
      this.sessions = {
        ...this.sessions,
        [id]: { ...(this.sessions[id] ?? BLANK), ...patch },
      };
    },
  };
  const requests: Array<{ resolve: (messages: AgentMessage[]) => void }> = [];
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  const turns = [
    { id: "oldest", top: 0 },
    { id: "next-turn", top: 800 },
  ];
  const listeners = new Map<string, Set<() => void>>();
  const scrollEl = {
    scrollHeight: 1_000,
    scrollTop: 200,
    clientHeight: 400,
    isConnected: true,
    getBoundingClientRect: () => ({ top: 0 }),
    querySelectorAll: () =>
      turns.map((turn) => ({
        getBoundingClientRect: () => ({ top: turn.top - scrollEl.scrollTop }),
        getAttribute: () => turn.id,
      })),
    querySelector: (selector: string) =>
      scrollEl
        .querySelectorAll()
        .find((turn) => selector.includes(`"${turn.getAttribute()}"`)) ?? null,
    addEventListener(type: string, listener: () => void) {
      const handlers = listeners.get(type) ?? new Set();
      handlers.add(listener);
      listeners.set(type, handlers);
    },
    dispatchEvent(event: Event) {
      for (const listener of [...(listeners.get(event.type) ?? [])]) listener();
      return true;
    },
    removeEventListener(type: string, listener: () => void) {
      listeners.get(type)?.delete(listener);
    },
  };
  const context = {
    ...paging,
    chatId: "chat",
    loadingOlder: false,
    LOAD_OLDER_PAGE: 200,
    NEAR_TOP_PX: 600,
    cancelled: false,
    SETTLE_FRAMES: 4,
    olderPageRequestRef: { current: null as object | null },
    olderPageEpochRef: { current: 0 },
    olderScrollCancelRef: { current: () => {} },
    settleEpochRef: { current: 0 },
    settleCancelRef: { current: () => {} },
    checkpointRecomputeRef: { current: vi.fn() },
    scrollEl,
    beginChatScrollNavigation, CHAT_SCROLL_NAVIGATION_EVENT,
    captureScrollAnchor,
    restoreTargetTop,
    useSessionsStore: { getState: () => store },
    ipcWindowOlderMessages: vi.fn(
      () =>
        new Promise<AgentMessage[]>((resolve) => requests.push({ resolve })),
    ),
    setLoadingOlder: vi.fn(),
    setHasOlder: vi.fn(),
    setNearTop: vi.fn(),
    surfaceActiveRef: { current: true },
    restoreInProgressRef: { current: false },
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    console,
  };
  const runtime = vm.createContext(context);
  vm.runInContext(code, runtime);
  const loadOlder = runtime.loadOlder as () => Promise<void>;
  const probe = runtime.probe as () => Promise<void>;
  const flushFrames = () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  };
  return {
    context,
    store,
    requests,
    scrollEl,
    turns,
    listeners,
    frames,
    loadOlder,
    probe,
    flushFrames,
  };
}

describe.each(["claude", "codex", "cursor"])(
  "%s transcript paging",
  (agentId) => {
    it("keeps live output and a steering promotion when a page resolves after Stop", async () => {
      const test = setup(agentId);
      const pending = test.loadOlder();
      const streamed = answer("First complete answer");
      const promoted = { ...user("steering"), steeredTurnId: "accepting-turn" };
      const final: AgentMessage = {
        ...answer("New final answer"),
        id: "new-final",
      };
      test.store.patchSession("chat", {
        status: "ready",
        lastStopReason: "cancelled",
        messages: [user("oldest"), streamed, promoted, final],
      });
      test.requests[0].resolve([user("older")]);
      await pending;
      expect(
        test.store.sessions.chat.messages.map((message) => message.id),
      ).toEqual(["older", "oldest", "answer", "steering", "new-final"]);
      expect(test.store.sessions.chat.messages.at(-1)).toBe(final);
      expect(
        test.store.sessions.chat.messages.find(
          (message) => message.id === "answer",
        ),
      ).toBe(streamed);
      expect(
        test.store.sessions.chat.messages.find(
          (message) => message.id === "steering",
        ),
      ).toBe(promoted);
      expect(test.store.sessions.chat.lastStopReason).toBe("cancelled");
    });
  },
);

describe("transcript page ownership", () => {
  it("does not resurrect a removed session from a late page", async () => {
    const test = setup();
    const pending = test.loadOlder();
    delete test.store.sessions.chat;
    test.requests[0].resolve([user("older")]);
    await pending;
    expect(test.store.sessions.chat).toBeUndefined();
  });

  it("deduplicates against messages added while the page was pending", async () => {
    const test = setup();
    const pending = test.loadOlder();
    const current = user("overlap");
    test.store.patchSession("chat", {
      messages: [...test.store.sessions.chat.messages, current],
    });
    test.requests[0].resolve([
      user("older"),
      { ...current, text: "stale overlap" },
    ]);
    await pending;
    expect(
      test.store.sessions.chat.messages.filter(
        (message) => message.id === "overlap",
      ),
    ).toEqual([current]);
  });

  it("retains terminal tool results, retractions and a removed queued row", async () => {
    const test = setup();
    const started: AgentToolMessage = {
      id: "tool",
      kind: "tool",
      toolCallId: "tool",
      title: "Synthetic tool",
      toolKind: "other",
      status: "in_progress",
      createdAt: 1,
      updatedAt: 1,
    };
    test.store.patchSession("chat", {
      messages: [...test.store.sessions.chat.messages, started],
    });
    const pending = test.loadOlder();
    const completed: AgentToolMessage = {
      ...started,
      status: "failed",
      rawOutput: "Synthetic failure",
    };
    const withdrawn = { ...answer(""), retracted: true as const };
    test.store.patchSession("chat", {
      messages: [user("oldest"), withdrawn, completed],
    });
    test.requests[0].resolve([user("older")]);
    await pending;
    expect(test.store.sessions.chat.messages).toEqual([
      user("older"),
      user("oldest"),
      withdrawn,
      completed,
    ]);
    expect(test.store.sessions.chat.messages.at(-1)).toBe(completed);
  });

  it.each([
    { executionId: "replacement", sessionId: "replacement" },
    { transcriptState: "cold" as const, messages: [] },
    { messages: [user("new-cursor")] },
  ])(
    "rejects a page after its execution, residency or cursor changes: %j",
    async (patch) => {
      const test = setup();
      const pending = test.loadOlder();
      test.store.patchSession("chat", patch);
      const current = test.store.sessions.chat;
      test.requests[0].resolve([user("older")]);
      await pending;
      expect(test.store.sessions.chat).toBe(current);
      expect(test.context.setHasOlder).not.toHaveBeenCalled();
    },
  );

  it("does not clear a replacement request when a retired read finishes", async () => {
    const test = setup();
    const pending = test.loadOlder();
    const replacement = {};
    test.context.olderPageEpochRef.current++;
    test.context.olderPageRequestRef.current = replacement;
    test.context.setLoadingOlder.mockClear();
    test.requests[0].resolve([user("older")]);
    await pending;
    expect(test.context.olderPageRequestRef.current).toBe(replacement);
    expect(test.context.setLoadingOlder).not.toHaveBeenCalled();
    expect(test.store.sessions.chat.messages[0].id).toBe("oldest");
  });

  it("keeps a hidden surface inert when its page arrives", async () => {
    const test = setup();
    const pending = test.loadOlder();
    const current = test.store.sessions.chat;
    test.context.surfaceActiveRef.current = false;
    test.requests[0].resolve([user("older")]);
    await pending;
    expect(test.store.sessions.chat).toBe(current);
    expect(test.frames.size).toBe(0);
  });

  it("ignores a probe whose paging cursor was replaced", async () => {
    const test = setup();
    const pending = test.probe();
    test.store.patchSession("chat", { messages: [user("replacement")] });
    test.requests[0].resolve([user("older")]);
    await pending;
    expect(test.context.setHasOlder).not.toHaveBeenCalled();
  });

  it("deduplicates a probe against the current tail", async () => {
    const test = setup();
    const pending = test.probe();
    test.store.patchSession("chat", {
      messages: [...test.store.sessions.chat.messages, user("overlap")],
    });
    test.requests[0].resolve([user("overlap")]);
    await pending;
    expect(test.context.setHasOlder).toHaveBeenLastCalledWith(false);
  });

  it("allows only one older read before React publishes loading state", async () => {
    const test = setup();
    const first = test.loadOlder();
    const duplicate = test.loadOlder();
    expect(test.requests).toHaveLength(1);
    test.requests[0].resolve([]);
    await Promise.all([first, duplicate]);
  });

  it("keeps the page locked until its viewport correction settles", async () => {
    const test = setup();
    const pending = test.loadOlder();
    test.requests[0].resolve([user("older")]);
    await pending;
    const duplicate = test.loadOlder();
    expect(test.requests).toHaveLength(1);
    test.turns.forEach((turn) => {
      turn.top += 700;
    });
    test.scrollEl.scrollHeight += 700;
    for (let frame = 0; frame < 5; frame++) test.flushFrames();
    expect(test.context.olderPageRequestRef.current).toBeNull();
    expect(test.context.setLoadingOlder).toHaveBeenLastCalledWith(false);
    expect(test.context.setNearTop).toHaveBeenLastCalledWith(false);
    await duplicate;
  });
});

describe("transcript page scroll restoration", () => {
  it("keeps the same checkpoint offset when tail growth races the prepend", async () => {
    const test = setup();
    const pending = test.loadOlder();
    test.requests[0].resolve([user("older")]);
    await pending;
    test.turns.forEach((turn) => {
      turn.top += 300;
    });
    test.scrollEl.scrollHeight += 300 + 200; // prepend plus unrelated tail growth
    test.flushFrames();
    expect(test.scrollEl.scrollTop).toBe(500);
  });

  it("lets a user gesture cancel the pending page correction", async () => {
    const test = setup();
    const pending = test.loadOlder();
    test.requests[0].resolve([user("older")]);
    await pending;
    test.turns.forEach((turn) => {
      turn.top += 300;
    });
    test.scrollEl.scrollHeight += 300;
    for (const listener of test.listeners.get("wheel") ?? []) listener();
    test.scrollEl.scrollTop = 250;
    test.flushFrames();
    expect(test.scrollEl.scrollTop).toBe(250);
    expect(test.frames.size).toBe(0);
    expect(test.context.olderPageRequestRef.current).toBeNull();
  });

  it("captures the current reader position after the delayed read", async () => {
    const test = setup();
    const pending = test.loadOlder();
    test.scrollEl.scrollTop = 350;
    test.requests[0].resolve([user("older")]);
    await pending;
    test.turns.forEach((turn) => {
      turn.top += 300;
    });
    test.scrollEl.scrollHeight += 300;
    test.flushFrames();
    expect(test.scrollEl.scrollTop).toBe(650);
  });

  it("anchors a partial leading turn to the next complete checkpoint", async () => {
    const test = setup();
    test.turns.shift();
    const pending = test.loadOlder();
    test.requests[0].resolve([user("older")]);
    await pending;
    test.turns.forEach((turn) => {
      turn.top += 300;
    });
    test.scrollEl.scrollHeight += 500;
    test.flushFrames();
    expect(test.scrollEl.scrollTop).toBe(500);
  });

  it("does not compensate twice after browser scroll anchoring", async () => {
    const test = setup();
    const pending = test.loadOlder();
    test.requests[0].resolve([user("older")]);
    await pending;
    test.turns.forEach((turn) => {
      turn.top += 300;
    });
    test.scrollEl.scrollHeight += 300;
    test.scrollEl.scrollTop += 300;
    test.flushFrames();
    expect(test.scrollEl.scrollTop).toBe(500);
    expect(test.context.olderPageRequestRef.current).toBeNull();
  });

  it("releases correction frames when the reader takes over during settling", async () => {
    const test = setup();
    const pending = test.loadOlder();
    test.requests[0].resolve([user("older")]);
    await pending;
    test.turns.forEach((turn) => {
      turn.top += 300;
    });
    test.flushFrames();
    expect(test.context.restoreInProgressRef.current).toBe(true);
    for (const listener of test.listeners.get("wheel") ?? []) listener();
    test.scrollEl.scrollTop = 550;
    test.flushFrames();
    expect(test.scrollEl.scrollTop).toBe(550);
    expect(test.frames.size).toBe(0);
    expect(test.context.restoreInProgressRef.current).toBe(false);
    expect(test.context.olderPageRequestRef.current).toBeNull();
  });

  it("skips raw height compensation when an unanchored tail changes", async () => {
    const test = setup();
    test.turns.length = 0;
    const pending = test.loadOlder();
    test.requests[0].resolve([user("older")]);
    await pending;
    test.store.patchSession("chat", {
      messages: [...test.store.sessions.chat.messages, answer("New tail")],
    });
    test.scrollEl.scrollHeight += 500;
    test.flushFrames();
    expect(test.scrollEl.scrollTop).toBe(200);
    expect(test.context.olderPageRequestRef.current).toBeNull();
  });

  it("drops a pending correction after another programmatic restore", async () => {
    const test = setup();
    const pending = test.loadOlder();
    test.requests[0].resolve([user("older")]);
    await pending;
    test.context.settleEpochRef.current++;
    test.turns.forEach((turn) => {
      turn.top += 300;
    });
    test.flushFrames();
    expect(test.scrollEl.scrollTop).toBe(200);
    expect(test.context.olderPageRequestRef.current).toBeNull();
  });
});

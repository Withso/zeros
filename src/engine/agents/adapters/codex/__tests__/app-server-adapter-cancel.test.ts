// Stop must stop EVERYTHING (field report 2026-07-04: "STOPPED BY USER"
// rendered but tool calls kept streaming). Codex collab subagents
// (spawn_agent / wait) run as sibling THREADS inside the same
// `codex app-server` child, each with their own turns; `turn/interrupt`
// is per-(thread, turn). The adapter must therefore:
//
//   - track every in-flight turn it sees (turn/started AND item/started —
//     the latter is the belt-and-braces pair source for subagent turns);
//   - sweep ALL of them on cancel(), not just the parent's activeTurnId;
//   - interrupt a turn whose id is born AFTER cancel() (the turn/start
//     ack race — cancel had no target, so the turn would run to
//     completion while the stopReason claimed "cancelled");
//   - drop a thread's entry once its turn/completed lands (no stale
//     interrupts for turns that already ended).
//
// Same controllable fake-runtime pattern as the reconnect suite.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentAdapterContext, ContentBlock } from "../../../types";

// Controllable fake-runtime state shared with the (hoisted) mock factory.
const rt = vi.hoisted(() => ({
  notificationHandlers: new Map<string, Set<(params: unknown) => void>>(),
  interruptCalls: [] as Array<{ threadId: string; turnId: string }>,
  runTurnImpl: null as
    | null
    | ((params: unknown, opts: { onTurnStarted?: (id: string) => void }) => Promise<unknown>),
  fire(method: string, params: unknown): void {
    for (const h of rt.notificationHandlers.get(method) ?? []) h(params);
  },
}));

vi.mock("../app-server", () => ({
  bootCodexAppServerRuntime: vi.fn(async () => ({
    initializeResponse: {
      userAgent: "codex_cli 0.139.0",
      codexHome: "/tmp",
      platformFamily: "unix",
      platformOs: "linux",
    },
    cliVersion: "0.139.0",
    binarySource: { source: "path", path: "codex" },
    child: { pid: 1234, killed: false },
    startThread: async () => ({
      threadId: "thread-1",
      model: "gpt-5",
      approvalPolicy: "on-request",
      sandbox: { type: "workspaceWrite" },
      raw: {},
    }),
    resumeThread: async (p: { threadId: string }) => ({ threadId: p.threadId, raw: {} }),
    runTurn: async (
      params: unknown,
      o: { onTurnStarted?: (id: string) => void },
    ) => {
      if (!rt.runTurnImpl) throw new Error("test did not set rt.runTurnImpl");
      return rt.runTurnImpl(params, o);
    },
    interruptTurn: async (threadId: string, turnId: string) => {
      rt.interruptCalls.push({ threadId, turnId });
    },
    respondToPermission: () => {},
    respondToUserInput: () => {},
    onNotification: (method: string, handler: (params: unknown) => void) => {
      let set = rt.notificationHandlers.get(method);
      if (!set) {
        set = new Set();
        rt.notificationHandlers.set(method, set);
      }
      set.add(handler);
      return () => set?.delete(handler);
    },
    request: vi.fn(async () => ({})),
    dispose: async () => {},
  })),
}));

vi.mock("../../session-paths", () => ({
  ensureSessionDir: vi.fn(async () => ({
    root: "/tmp/s",
    env: "/tmp/s/env",
    log: "/tmp/s/log",
    telemetry: "/tmp/s/tel",
  })),
  removeSessionDir: vi.fn(async () => {}),
}));

// Import AFTER the mocks are registered (vi.mock is hoisted above imports).
import { CodexAppServerAdapter } from "../app-server-adapter";

const TEXT = (t: string): ContentBlock[] => [{ type: "text", text: t } as never];

/** Drain enough microtasks for prompt() to reach runTurn (buildUserInput and
 *  the JSON-RPC fakes each cost an await). Fake timers don't affect these. */
const tick = async (n = 8): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

function makeAdapter() {
  const emit = {
    onSessionUpdate: vi.fn(),
    onPermissionRequest: vi.fn(),
    onQuestionRequest: vi.fn(),
    onAgentStderr: vi.fn(),
    onAgentExit: vi.fn(),
  };
  const ctx: AgentAdapterContext = {
    projectRoot: "/tmp/proj",
    mcpServers: [],
    sessionDirRoot: "/tmp/sessions",
    emit,
  };
  return { adapter: new CodexAppServerAdapter(ctx), emit };
}

/** Externally-resolvable runTurn result, so tests can hold a turn open
 *  across cancel() and settle it afterwards. Settling fires the parent's
 *  turn/completed BEFORE resolving — the real runtime's contract ("runTurn
 *  resolves only after turn/completed arrives"), which is also what evicts
 *  the parent from activeTurns so drainCollabTurns only ever sees the
 *  subagent stragglers. */
function pendingTurn(turnId: string) {
  let resolve!: (v: unknown) => void;
  const result = new Promise<unknown>((r) => {
    resolve = r;
  });
  rt.runTurnImpl = async (_params, o) => {
    o.onTurnStarted?.(turnId);
    rt.fire("turn/started", { threadId: "thread-1", turn: { id: turnId } });
    return result;
  };
  const settle = (notifStatus: string, resultStatus: string) => {
    rt.fire("turn/completed", {
      threadId: "thread-1",
      turn: { id: turnId, status: notifStatus },
    });
    resolve({ turnId, status: resultStatus, raw: {} });
  };
  return {
    settleInterrupted: () => settle("interrupted", "cancelled"),
    settleCompleted: () => settle("completed", "completed"),
  };
}

describe("codex cancel interrupts every live turn (parent + collab subagents)", () => {
  beforeEach(() => {
    // Fake timers so bootSession's [1.5s/4s/9s] slash-command re-poll timers
    // don't linger past the test. Real microtasks/promises are unaffected.
    vi.useFakeTimers();
    rt.notificationHandlers.clear();
    rt.interruptCalls = [];
    rt.runTurnImpl = null;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sweeps subagent turns tracked via turn/started", async () => {
    const { adapter } = makeAdapter();
    const { session } = await adapter.newSession({ cwd: "/tmp/proj" });

    const turn = pendingTurn("turn-1");
    const prompt = adapter.prompt({ sessionId: session.sessionId, prompt: TEXT("go") });
    await tick(); // let runTurnImpl fire turn/started

    // A collab subagent thread starts its own turn inside the same child.
    rt.fire("turn/started", { threadId: "sub-thread-1", turn: { id: "sub-turn-1" } });

    await adapter.cancel({ sessionId: session.sessionId });

    expect(rt.interruptCalls).toEqual(
      expect.arrayContaining([
        { threadId: "thread-1", turnId: "turn-1" },
        { threadId: "sub-thread-1", turnId: "sub-turn-1" },
      ]),
    );

    turn.settleInterrupted();
    const res = await prompt;
    expect(res.stopReason).toBe("cancelled");
  });

  it("tracks subagent turns from item/started when no turn/started was seen", async () => {
    const { adapter } = makeAdapter();
    const { session } = await adapter.newSession({ cwd: "/tmp/proj" });

    const turn = pendingTurn("turn-1");
    const prompt = adapter.prompt({ sessionId: session.sessionId, prompt: TEXT("go") });
    await tick();

    // Only the subagent's ITEM stream is observed (it demonstrably renders
    // in the timeline) — the pair source must still be captured.
    rt.fire("item/started", {
      threadId: "sub-thread-2",
      turnId: "sub-turn-2",
      item: { type: "commandExecution", id: "item-1" },
      startedAtMs: 0,
    });

    await adapter.cancel({ sessionId: session.sessionId });

    expect(rt.interruptCalls).toEqual(
      expect.arrayContaining([
        { threadId: "sub-thread-2", turnId: "sub-turn-2" },
      ]),
    );

    turn.settleInterrupted();
    await prompt;
  });

  it("interrupts a turn whose id is born after cancel (turn/start ack race)", async () => {
    const { adapter } = makeAdapter();
    const { session } = await adapter.newSession({ cwd: "/tmp/proj" });

    // Hold the ack: onTurnStarted fires only when the test releases it.
    let releaseAck!: () => void;
    const ackGate = new Promise<void>((r) => {
      releaseAck = r;
    });
    let resolveTurn!: (v: unknown) => void;
    const result = new Promise<unknown>((r) => {
      resolveTurn = r;
    });
    rt.runTurnImpl = async (_params, o) => {
      await ackGate;
      o.onTurnStarted?.("turn-9");
      rt.fire("turn/started", { threadId: "thread-1", turn: { id: "turn-9" } });
      return result;
    };

    const prompt = adapter.prompt({ sessionId: session.sessionId, prompt: TEXT("go") });
    await tick();

    // Stop lands while the ack is still in flight — no turn id to target yet.
    await adapter.cancel({ sessionId: session.sessionId });
    expect(rt.interruptCalls).toEqual([]);

    releaseAck();
    await tick();
    await tick();

    expect(rt.interruptCalls).toEqual(
      expect.arrayContaining([{ threadId: "thread-1", turnId: "turn-9" }]),
    );

    resolveTurn({ turnId: "turn-9", status: "cancelled", raw: {} });
    const res = await prompt;
    expect(res.stopReason).toBe("cancelled");
  });

  it("interrupts an orphan parent turn re-triggered after cancel (trigger_turn wake)", async () => {
    const { adapter } = makeAdapter();
    const { session } = await adapter.newSession({ cwd: "/tmp/proj" });

    const turn = pendingTurn("turn-1");
    const prompt = adapter.prompt({ sessionId: session.sessionId, prompt: TEXT("go") });
    await tick();

    await adapter.cancel({ sessionId: session.sessionId });
    turn.settleInterrupted();
    await prompt; // cancelRequested is reset; no prompt is in flight anymore
    rt.interruptCalls = [];

    // A finishing child wakes the parent: codex starts a FRESH parent turn
    // even though the user just stopped. Must be interrupted on sight.
    rt.fire("turn/started", { threadId: "thread-1", turn: { id: "turn-2" } });
    expect(rt.interruptCalls).toEqual([{ threadId: "thread-1", turnId: "turn-2" }]);
  });

  it("does not interrupt a genuinely new prompt sent right after cancel", async () => {
    const { adapter } = makeAdapter();
    const { session } = await adapter.newSession({ cwd: "/tmp/proj" });

    const turn = pendingTurn("turn-1");
    const prompt = adapter.prompt({ sessionId: session.sessionId, prompt: TEXT("go") });
    await tick();
    await adapter.cancel({ sessionId: session.sessionId });
    turn.settleInterrupted();
    await prompt;
    rt.interruptCalls = [];

    const turn2 = pendingTurn("turn-3");
    const prompt2 = adapter.prompt({ sessionId: session.sessionId, prompt: TEXT("again") });
    await tick();

    expect(rt.interruptCalls).toEqual([]);

    turn2.settleInterrupted();
    await prompt2;
  });

  it("does not interrupt a subagent turn that already completed", async () => {
    const { adapter } = makeAdapter();
    const { session } = await adapter.newSession({ cwd: "/tmp/proj" });

    const turn = pendingTurn("turn-1");
    const prompt = adapter.prompt({ sessionId: session.sessionId, prompt: TEXT("go") });
    await tick();

    rt.fire("turn/started", { threadId: "sub-thread-3", turn: { id: "sub-turn-3" } });
    rt.fire("turn/completed", {
      threadId: "sub-thread-3",
      turn: { id: "sub-turn-3", status: "completed" },
    });

    await adapter.cancel({ sessionId: session.sessionId });

    expect(rt.interruptCalls).toEqual([{ threadId: "thread-1", turnId: "turn-1" }]);

    turn.settleInterrupted();
    await prompt;
  });
});

describe("prompt holds open while collab subagent turns still run", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    rt.notificationHandlers.clear();
    rt.interruptCalls = [];
    rt.runTurnImpl = null;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a plain turn (no subagents) settles with no drain wait", async () => {
    const { adapter } = makeAdapter();
    const { session } = await adapter.newSession({ cwd: "/tmp/proj" });

    const turn = pendingTurn("turn-1");
    const prompt = adapter.prompt({ sessionId: session.sessionId, prompt: TEXT("go") });
    await tick();

    turn.settleCompleted();
    // Microtasks only — settling must not require any timer to elapse.
    const res = await prompt;
    expect(res.stopReason).toBe("end_turn");
  });

  it("does not settle while a subagent turn is live; settles after drain + grace", async () => {
    const { adapter } = makeAdapter();
    const { session } = await adapter.newSession({ cwd: "/tmp/proj" });

    const turn = pendingTurn("turn-1");
    const prompt = adapter.prompt({ sessionId: session.sessionId, prompt: TEXT("go") });
    await tick();

    // A collab subagent thread is mid-flight when the parent turn ends.
    rt.fire("turn/started", { threadId: "sub-1", turn: { id: "sub-turn-1" } });
    turn.settleCompleted();

    let settled = false;
    void prompt.then(() => {
      settled = true;
    });

    // Well past the grace window — the prompt must still be held open
    // because the subagent's turn never completed.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).toBe(false);

    // Subagent finishes → drain empties → grace (1.5s) elapses → settle.
    rt.fire("turn/completed", {
      threadId: "sub-1",
      turn: { id: "sub-turn-1", status: "completed" },
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(settled).toBe(true);
    expect((await prompt).stopReason).toBe("end_turn");
  });

  it("a trigger_turn parent wake inside the grace window keeps the prompt open", async () => {
    const { adapter } = makeAdapter();
    const { session } = await adapter.newSession({ cwd: "/tmp/proj" });

    const turn = pendingTurn("turn-1");
    const prompt = adapter.prompt({ sessionId: session.sessionId, prompt: TEXT("go") });
    await tick();

    rt.fire("turn/started", { threadId: "sub-1", turn: { id: "sub-turn-1" } });
    turn.settleCompleted();

    let settled = false;
    void prompt.then(() => {
      settled = true;
    });

    // Child finishes…
    rt.fire("turn/completed", {
      threadId: "sub-1",
      turn: { id: "sub-turn-1", status: "completed" },
    });
    // …and 500ms later codex wakes the parent to deliver the report.
    await vi.advanceTimersByTimeAsync(500);
    rt.fire("turn/started", { threadId: "thread-1", turn: { id: "turn-2" } });

    // The wake turn is live — still held open well past the grace window.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).toBe(false);

    // Wake turn ends → drain + grace → settle.
    rt.fire("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-2", status: "completed" },
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(settled).toBe(true);
  });

  it("Stop during the drain wait settles promptly as cancelled", async () => {
    const { adapter } = makeAdapter();
    const { session } = await adapter.newSession({ cwd: "/tmp/proj" });

    const turn = pendingTurn("turn-1");
    const prompt = adapter.prompt({ sessionId: session.sessionId, prompt: TEXT("go") });
    await tick();

    rt.fire("turn/started", { threadId: "sub-1", turn: { id: "sub-turn-1" } });
    turn.settleCompleted();
    await vi.advanceTimersByTimeAsync(1_000); // parked in the drain wait

    // Stop: the sweep interrupts the subagent turn; when its turn/completed
    // lands the drain exits without paying the grace window.
    await adapter.cancel({ sessionId: session.sessionId });
    expect(rt.interruptCalls).toEqual(
      expect.arrayContaining([{ threadId: "sub-1", turnId: "sub-turn-1" }]),
    );
    rt.fire("turn/completed", {
      threadId: "sub-1",
      turn: { id: "sub-turn-1", status: "interrupted" },
    });
    await vi.advanceTimersByTimeAsync(300);
    expect((await prompt).stopReason).toBe("cancelled");
  });

  it("Stop bails out of the drain even if a wedged subagent turn never completes", async () => {
    const { adapter } = makeAdapter();
    const { session } = await adapter.newSession({ cwd: "/tmp/proj" });

    const turn = pendingTurn("turn-1");
    const prompt = adapter.prompt({ sessionId: session.sessionId, prompt: TEXT("go") });
    await tick();

    rt.fire("turn/started", { threadId: "sub-1", turn: { id: "sub-turn-1" } });
    turn.settleCompleted();
    await vi.advanceTimersByTimeAsync(1_000); // parked in the drain wait

    await adapter.cancel({ sessionId: session.sessionId });
    // The wedged subagent never sends turn/completed. The 5s post-cancel
    // bail-out must still settle the prompt as cancelled.
    await vi.advanceTimersByTimeAsync(6_000);
    expect((await prompt).stopReason).toBe("cancelled");
  });
});

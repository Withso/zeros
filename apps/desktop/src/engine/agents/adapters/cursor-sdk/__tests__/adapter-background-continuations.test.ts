import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyUpdate, type AgentMessage } from "@zeros/protocol/agent-messages";
import { CursorSdkAdapter, type CursorSdkSendOptions } from "../adapter";
import type { AgentAdapterContext, SessionNotification } from "../../../types";

const sdk = vi.hoisted(() => ({
  create: vi.fn(),
  send: vi.fn(),
  usage: vi.fn(),
}));
vi.mock("@cursor/sdk", () => ({
  Agent: { create: sdk.create, resume: vi.fn(), list: vi.fn() },
  Cursor: { models: { list: vi.fn(async () => []) } },
  JsonlLocalAgentStore: class {
    runs = { get: async () => null };
  },
  getDefaultSdkStateRoot: () => "/synthetic-cursor-state",
}));

const tokens = (inputTokens: number) => ({
  inputTokens,
  outputTokens: inputTokens / 10,
  cacheReadTokens: 1,
  cacheWriteTokens: 0,
});
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function setup() {
  let messages: AgentMessage[] = [];
  const updates: SessionNotification["update"][] = [];
  const ctx: AgentAdapterContext = {
    projectRoot: "/tmp/cursor-continuation-fixture",
    mcpServers: [],
    sessionDirRoot: "/tmp/fixture-sessions",
    emit: {
      onSessionUpdate: (_agent, event) => {
        messages = applyUpdate(messages, event);
        updates.push(event.update);
      },
      onPermissionRequest: () => {},
      onQuestionRequest: () => {},
      onAgentStderr: () => {},
      onAgentExit: () => {},
    },
  };
  return {
    adapter: new CursorSdkAdapter(ctx),
    messages: () => messages,
    updates,
  };
}
beforeEach(() => {
  vi.stubEnv("CURSOR_API_KEY", "");
  vi.stubEnv("CURSOR_RIPGREP_PATH", "/usr/bin/rg");
  sdk.create.mockReset().mockResolvedValue({
    agentId: "parent",
    send: sdk.send,
    getUsage: sdk.usage,
    close: () => {},
  });
  sdk.send.mockReset();
  sdk.usage.mockReset().mockResolvedValue({ runs: [] });
});
afterEach(() => vi.unstubAllEnvs());

const task = (callId: string, isBackground?: boolean) => ({
  type:
    isBackground === undefined ? "tool-call-started" : "tool-call-completed",
  callId,
  toolCall: {
    type: "task",
    args: { description: `Inspect ${callId}`, agentId: `child-${callId}` },
    ...(isBackground === undefined
      ? {}
      : {
          result: {
            status: "success",
            value: { agentId: `child-${callId}`, isBackground },
          },
        }),
  },
});

describe("Cursor adapter background run ownership", () => {
  it("keeps one send alive through two child reports, steering and cumulative usage", async () => {
    const c = setup();
    const a = gate(),
      b = gate();
    const steer = vi.fn(async () => "complete_delivered" as const);
    const wait = vi.fn(async () => ({
      status: "finished",
      result: "Both reports",
      usage: { ...tokens(60), cacheReadTokens: 3 },
    }));
    let callbacks!: CursorSdkSendOptions;
    let stage = 0;
    const delta = async (update: unknown) => {
      await callbacks.onDelta?.({ update });
    };
    const report = async (text: string, input: number) => {
      await delta({ type: "text-delta", text });
      await callbacks.onStep?.({
        step: { type: "assistantMessage", message: { text } },
      });
      await delta({ type: "turn-ended", usage: tokens(input) });
    };
    sdk.send.mockImplementation(async (_message, options) => {
      callbacks = options;
      return {
        id: "run-owned",
        steer,
        cancel: async () => {
          a.release();
          b.release();
        },
        wait,
        stream: async function* () {
          for (const id of ["a", "b"]) {
            await delta(task(id));
            await delta({
              type: "tool-call-delta",
              callId: id,
              taskUpdate: { type: "text-delta", text: `Child ${id}` },
            });
            await delta(task(id, true));
          }
          await report("Initial report", 10);
          yield { type: "usage", usage: tokens(10) };
          stage = 1;
          await a.promise;
          await delta(task("a", false));
          await report("First child report", 20);
          yield { type: "usage", usage: tokens(20) };
          stage = 2;
          await b.promise;
          await delta(task("b", false));
          await report("Both reports", 30);
          yield { type: "usage", usage: tokens(30) };
          yield {
            type: "status",
            status: "FINISHED",
            agent_id: "parent",
            run_id: "run-owned",
          };
        },
      };
    });
    // An earlier agent-wide bill must not leak into this continuation's cost.
    sdk.usage.mockResolvedValue({
      runs: [
        { runId: "old-run", usage: tokens(1000), cost: { chargedCents: 900 } },
      ],
    });
    const { session } = await c.adapter.newSession({
      cwd: "/tmp/cursor-continuation-fixture",
      env: { CURSOR_API_KEY: "fixture" },
    });
    const settled = vi.fn();
    const pending = c.adapter
      .prompt({
        sessionId: session.sessionId,
        turnId: "user-turn",
        prompt: [{ type: "text", text: "Inspect" }],
      })
      .then((result) => {
        settled();
        return result;
      });
    try {
      await vi.waitFor(() => expect(stage).toBe(1));
      expect(wait).not.toHaveBeenCalled();
      expect(settled).not.toHaveBeenCalled();
      await expect(
        c.adapter.steer({
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "Include errors" }],
        }),
      ).resolves.toBe("delivered");
      expect(steer).toHaveBeenCalledExactlyOnceWith("Include errors");
      a.release();
      await vi.waitFor(() => expect(stage).toBe(2));
      expect(
        c
          .messages()
          .filter((m) => m.kind === "tool" && !m.parentToolId)
          .map((m) => m.kind === "tool" && m.status),
      ).toEqual(["completed", "in_progress"]);
      expect(settled).not.toHaveBeenCalled();
      expect(sdk.usage).not.toHaveBeenCalled();
      b.release();
      const result = await pending;
      expect(result).toMatchObject({
        stopReason: "end_turn",
        response: {
          usage: { inputTokens: 63, outputTokens: 6, cacheReadTokens: 3 },
        },
      });
      expect(result.response.usage?.totalCostUsd).toBeUndefined();
      expect(sdk.send).toHaveBeenCalledOnce();
      expect(wait).toHaveBeenCalledOnce();
      expect(settled).toHaveBeenCalledOnce();
      expect(
        c
          .messages()
          .filter(
            (m) => m.kind === "text" && m.role === "agent" && !m.parentToolId,
          )
          .map((m) => m.kind === "text" && [m.text, m.phase]),
      ).toEqual([
        ["Initial report", "final_answer"],
        ["First child report", "final_answer"],
        ["Both reports", "final_answer"],
      ]);
      const before = c.messages();
      await delta({ type: "text-delta", text: "Late" });
      await delta({
        type: "tool-call-delta",
        callId: "b",
        taskUpdate: { type: "text-delta", text: "Late child" },
      });
      expect(c.messages()).toBe(before);
      expect(
        c.updates.filter((u) => u.sessionUpdate === "turn_usage_update"),
      ).toEqual([
        expect.objectContaining({
          turnId: "user-turn",
          usage: expect.objectContaining({ inputTokens: 63 }),
        }),
      ]);
    } finally {
      a.release();
      b.release();
      await c.adapter.dispose();
    }
  });

  it.each(["stop", "dispose", "disconnect", "eof"])(
    "settles %s between reports without publishing late child output",
    async (ending) => {
      const c = setup(),
        hold = gate();
      let callbacks!: CursorSdkSendOptions;
      let ready = false;
      const delta = async (update: unknown) => {
        await callbacks.onDelta?.({ update });
      };
      sdk.send.mockImplementation(async (_message, options) => {
        callbacks = options;
        return {
          id: "run",
          cancel: async () => hold.release(),
          wait: async () =>
            ending === "stop" || ending === "dispose"
              ? { status: "cancelled", usage: tokens(10) }
              : undefined,
          stream: async function* () {
            await delta(task("a"));
            await delta({
              type: "tool-call-delta",
              callId: "a",
              taskUpdate: { type: "text-delta", text: "Child started" },
            });
            await delta(task("a", true));
            await delta({ type: "text-delta", text: "Initial report" });
            await delta({ type: "turn-ended", usage: tokens(10) });
            yield { type: "usage", usage: tokens(10) };
            ready = true;
            await hold.promise;
            if (ending === "disconnect")
              throw new Error("transport disconnected");
            if (ending === "stop" || ending === "dispose")
              await delta({
                type: "tool-call-delta",
                callId: "a",
                taskUpdate: { type: "text-delta", text: "Late child" },
              });
          },
        };
      });
      const { session } = await c.adapter.newSession({
        cwd: "/tmp/cursor-continuation-fixture",
        env: { CURSOR_API_KEY: "fixture" },
      });
      const settled = vi.fn();
      const pending = c.adapter.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "Inspect" }],
      });
      void pending.then(settled, settled);
      try {
        await vi.waitFor(() => expect(ready).toBe(true));
        expect(settled).not.toHaveBeenCalled();
        if (ending === "stop")
          await c.adapter.cancel({ sessionId: session.sessionId });
        else if (ending === "dispose")
          await c.adapter.disposeSession(session.sessionId);
        else hold.release();
        if (ending === "stop" || ending === "dispose")
          await expect(pending).resolves.toMatchObject({
            stopReason: "cancelled",
          });
        else await expect(pending).rejects.toThrow();
        expect(settled).toHaveBeenCalledOnce();
        expect(
          c
            .messages()
            .some((m) => m.kind === "text" && m.text.includes("Late child")),
        ).toBe(false);
        const before = c.messages();
        await delta({
          type: "tool-call-delta",
          callId: "a",
          taskUpdate: { type: "text-delta", text: "Later still" },
        });
        expect(c.messages()).toBe(before);
      } finally {
        hold.release();
        await c.adapter.dispose();
      }
    },
  );
});

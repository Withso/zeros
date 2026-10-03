import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  listeners: new Map<string, Set<(params: unknown) => void>>(),
  runTurn: vi.fn(async () => ({
    turnId: "turn-normal",
    status: "completed" as const,
    raw: {},
  })),
  runReview: vi.fn(
    async (
      _params: unknown,
      _options?: { onTurnStarted?: (turnId: string) => void },
    ): Promise<{
      turnId: string;
      status: "completed" | "failed" | "cancelled";
      raw: unknown;
    }> => ({
      turnId: "turn-review",
      status: "completed",
      raw: {},
    }),
  ),
  interruptTurn: vi.fn(async () => {}),
  requestTyped: vi.fn(async (method: string) => {
    if (method === "config/read") return { config: {} };
    return method === "skills/list" ? { data: [] } : {};
  }),
}));

vi.mock("../app-server", () => ({
  bootCodexAppServerRuntime: vi.fn(async () => ({
    initializeResponse: {
      userAgent: "codex_cli 0.149.0",
      codexHome: "/tmp",
      platformFamily: "unix",
      platformOs: "linux",
    },
    cliVersion: "0.149.0",
    binarySource: { source: "path", path: "codex" },
    child: { pid: 1234, killed: false },
    startThread: async () => ({
      threadId: "thread-exact",
      providerSessionId: "provider-session",
      model: "gpt-5",
      approvalPolicy: "on-request",
      sandbox: { type: "workspaceWrite" },
      raw: {},
    }),
    resumeThread: async (params: { threadId: string }) => ({
      threadId: params.threadId,
      providerSessionId: "provider-session",
      raw: {},
    }),
    runTurn: runtime.runTurn,
    runReview: runtime.runReview,
    interruptTurn: runtime.interruptTurn,
    respondToPermission: vi.fn(),
    respondToUserInput: vi.fn(),
    onNotification: vi.fn((method: string, handler: (params: unknown) => void) => {
      const listeners = runtime.listeners.get(method) ?? new Set();
      listeners.add(handler);
      runtime.listeners.set(method, listeners);
      return () => listeners.delete(handler);
    }),
    request: vi.fn(async () => ({})),
    requestTyped: runtime.requestTyped,
    dispose: vi.fn(async () => {}),
  })),
}));

vi.mock("../../session-paths", () => ({
  ensureSessionDir: vi.fn(async () => ({
    root: "/tmp/s",
    env: "/tmp/s/env",
    log: "/tmp/s/log",
    telemetry: "/tmp/s/tel",
  })),
  writeSessionMeta: vi.fn(async () => {}),
  removeSessionDir: vi.fn(async () => {}),
}));

import { CodexAppServerAdapter } from "../app-server-adapter";

describe("Codex native review command", () => {
  beforeEach(() => {
    runtime.listeners.clear();
    runtime.runTurn.mockClear();
    runtime.runReview.mockClear();
    runtime.interruptTurn.mockClear();
    runtime.requestTyped.mockClear();
  });

  const adapter = (onSessionUpdate = vi.fn()) =>
    new CodexAppServerAdapter({
      projectRoot: "/tmp/proj",
      mcpServers: [],
      sessionDirRoot: "/tmp/sessions",
      emit: {
        onSessionUpdate,
        onPermissionRequest: vi.fn(),
        onQuestionRequest: vi.fn(),
        onAgentStderr: vi.fn(),
        onAgentExit: vi.fn(),
      },
    });

  it("routes a bare /review to native inline uncommitted-changes review", async () => {
    const instance = adapter();
    const created = await instance.newSession({ cwd: "/tmp/proj" });

    await instance.prompt({
      sessionId: created.session.sessionId,
      prompt: [{ type: "text", text: "  /review  " }],
    });

    expect(runtime.runReview).toHaveBeenCalledWith(
      {
        threadId: "thread-exact",
        delivery: "inline",
        target: { type: "uncommittedChanges" },
      },
      expect.objectContaining({ onTurnStarted: expect.any(Function) }),
    );
    expect(runtime.runTurn).not.toHaveBeenCalled();
    await instance.dispose();
  });

  it("applies the current model, effort, and service tier before native review", async () => {
    const instance = adapter();
    const created = await instance.newSession({ cwd: "/tmp/proj" });
    await instance.setModel({
      sessionId: created.session.sessionId,
      model: "gpt-5.6-terra",
    });
    await instance.updateConfig({
      sessionId: created.session.sessionId,
      env: {
        OPENAI_MODEL: "gpt-5.6-terra",
        ZEROS_THINKING_EFFORT: "high",
        ZEROS_FAST_MODE: "1",
      },
    });
    runtime.requestTyped.mockClear();

    await instance.prompt({
      sessionId: created.session.sessionId,
      prompt: [{ type: "text", text: "/review" }],
    });

    expect(runtime.requestTyped).toHaveBeenCalledWith(
      "thread/settings/update",
      {
        threadId: "thread-exact",
        model: "gpt-5.6-terra",
        effort: "high",
        serviceTier: "fast",
      },
    );
    expect(
      runtime.requestTyped.mock.invocationCallOrder[0],
    ).toBeLessThan(runtime.runReview.mock.invocationCallOrder[0]);
    await instance.dispose();
  });

  it("delivers the native exit review text before the review prompt resolves", async () => {
    const onSessionUpdate = vi.fn();
    const instance = adapter(onSessionUpdate);
    const created = await instance.newSession({ cwd: "/tmp/proj" });
    runtime.runReview.mockImplementationOnce(async (_params, options) => {
      const notify = (method: string, params: unknown) => {
        for (const handler of runtime.listeners.get(method) ?? []) handler(params);
      };
      options?.onTurnStarted?.("turn-review");
      notify("turn/started", { threadId: "thread-exact", turn: { id: "turn-review", status: "inProgress" } });
      for (const type of ["enteredReviewMode", "exitedReviewMode"]) {
        const params = { threadId: "thread-exact", turnId: "turn-review",
          item: { id: "turn-review", type, review: type === "exitedReviewMode" ? "Native review completed." : "current changes" } };
        notify("item/started", params);
        notify("item/completed", params);
      }
      notify("turn/completed", { threadId: "thread-exact", turn: { id: "turn-review", status: "completed" } });
      return { turnId: "turn-review", status: "completed", raw: {} };
    });
    await expect(instance.prompt({ sessionId: created.session.sessionId, prompt: [{ type: "text", text: "/review" }] }))
      .resolves.toMatchObject({ stopReason: "end_turn" });
    expect(onSessionUpdate.mock.calls.flatMap(([, notification]) =>
      notification.update.sessionUpdate === "agent_message_chunk" ? [notification.update.content.text] : []))
      .toEqual(["Native review completed."]);
    await instance.dispose();
  });

  it.each(["before", "after"])(
    "routes the native review's output when its acknowledgement arrives %s a distinct start notification",
    async (acknowledgement) => {
      const onSessionUpdate = vi.fn();
      const instance = adapter(onSessionUpdate);
      const created = await instance.newSession({ cwd: "/tmp/proj" });
      const notify = (method: string, params: unknown) => {
        for (const handler of runtime.listeners.get(method) ?? []) handler(params);
      };
      // Match an existing conversation, as used by cloud qualification.
      runtime.runTurn.mockImplementationOnce(async () => {
        notify("turn/started", { threadId: "thread-exact", turn: { id: "turn-prior", status: "inProgress" } });
        notify("turn/completed", { threadId: "thread-exact", turn: { id: "turn-prior", status: "completed" } });
        return { turnId: "turn-prior", status: "completed", raw: {} };
      });
      await instance.prompt({ sessionId: created.session.sessionId, prompt: [{ type: "text", text: "An earlier turn" }] });
      onSessionUpdate.mockClear();
      runtime.runReview.mockImplementationOnce(async (_params, options) => {
        // Captured from the pinned native binary with an offline Responses
        // fixture: review/start, items and completion identify turn-review;
        // the intervening turn/started identifies a different internal turn.
        if (acknowledgement === "before") options?.onTurnStarted?.("turn-review");
        const item = (type: string, id: string, fields: Record<string, unknown>) => {
          for (const method of ["item/started", "item/completed"]) {
            notify(method, { threadId: "thread-exact", turnId: "turn-review", item: { type, id, ...fields } });
          }
        };
        item("enteredReviewMode", "turn-review", { review: "current changes" });
        notify("turn/started", { threadId: "thread-exact", turn: { id: "turn-review-internal", status: "inProgress" } });
        item("exitedReviewMode", "turn-review", { review: "Native review completed." });
        item("agentMessage", "review-answer", { text: "Native review completed.", phase: "final_answer" });
        notify("turn/completed", { threadId: "thread-exact", turn: { id: "turn-review", status: "completed" } });
        if (acknowledgement === "after") options?.onTurnStarted?.("turn-review");
        return { turnId: "turn-review", status: "completed", raw: {} };
      });
      await expect(instance.prompt({ sessionId: created.session.sessionId, prompt: [{ type: "text", text: "/review" }] }))
        .resolves.toMatchObject({ stopReason: "end_turn" });
      expect(onSessionUpdate.mock.calls.flatMap(([, notification]) =>
        notification.update.sessionUpdate === "agent_message_chunk" ? [notification.update.content.text] : []))
        .toEqual(["Native review completed."]);

      onSessionUpdate.mockClear();
      runtime.runTurn.mockImplementationOnce(async () => {
        for (const id of ["turn-prior", "turn-review", "turn-review-internal"]) {
          notify("turn/started", { threadId: "thread-exact", turn: { id, status: "inProgress" } });
          notify("item/completed", { threadId: "thread-exact", turnId: id, item: { type: "agentMessage", id, text: "Late review output" } });
        }
        notify("turn/started", { threadId: "thread-exact", turn: { id: "turn-next", status: "inProgress" } });
        notify("item/completed", { threadId: "thread-exact", turnId: "turn-next", item: { type: "agentMessage", id: "next-answer", text: "Next ordinary answer" } });
        notify("turn/completed", { threadId: "thread-exact", turn: { id: "turn-next", status: "completed" } });
        return { turnId: "turn-next", status: "completed", raw: {} };
      });
      await instance.prompt({ sessionId: created.session.sessionId, prompt: [{ type: "text", text: "Continue normally" }] });
      expect(onSessionUpdate.mock.calls.flatMap(([, notification]) =>
        notification.update.sessionUpdate === "agent_message_chunk" ? [notification.update.content.text] : []))
        .toEqual(["Next ordinary answer"]);
      await instance.dispose();
    },
  );

  it("does not reinterpret review-like text or an attachment-bearing prompt", async () => {
    const instance = adapter();
    const created = await instance.newSession({ cwd: "/tmp/proj" });

    await instance.prompt({
      sessionId: created.session.sessionId,
      prompt: [{ type: "text", text: "/review the last commit" }],
    });
    await instance.prompt({
      sessionId: created.session.sessionId,
      prompt: [
        { type: "text", text: "/review" },
        { type: "text", text: "attachment body" },
      ],
    });

    expect(runtime.runReview).not.toHaveBeenCalled();
    expect(runtime.runTurn).toHaveBeenCalledTimes(2);
    await instance.dispose();
  });

  it("interrupts an in-flight native review through the ordinary Stop path", async () => {
    let finishReview!: () => void;
    runtime.runReview.mockImplementationOnce(async (_params, options) => {
      options?.onTurnStarted?.("turn-review-live");
      for (const handler of runtime.listeners.get("turn/started") ?? []) {
        handler({ threadId: "thread-exact", turn: { id: "turn-review-internal", status: "inProgress" } });
      }
      await new Promise<void>((resolve) => {
        finishReview = resolve;
      });
      return {
        turnId: "turn-review-live",
        status: "cancelled" as const,
        raw: {},
      };
    });
    const instance = adapter();
    const created = await instance.newSession({ cwd: "/tmp/proj" });

    const prompt = instance.prompt({
      sessionId: created.session.sessionId,
      prompt: [{ type: "text", text: "/review" }],
    });
    await vi.waitFor(() => expect(runtime.runReview).toHaveBeenCalled());
    await instance.cancel({ sessionId: created.session.sessionId });

    expect(runtime.interruptTurn).toHaveBeenCalledWith(
      "thread-exact",
      "turn-review-live",
    );
    finishReview();
    await expect(prompt).resolves.toMatchObject({ stopReason: "cancelled" });
    await instance.dispose();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
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
  requestTyped: vi.fn(async (method: string) =>
    method === "skills/list" ? { data: [] } : {},
  ),
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
    onNotification: vi.fn(() => () => {}),
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
    runtime.runTurn.mockClear();
    runtime.runReview.mockClear();
    runtime.interruptTurn.mockClear();
    runtime.requestTyped.mockClear();
  });

  const adapter = () =>
    new CodexAppServerAdapter({
      projectRoot: "/tmp/proj",
      mcpServers: [],
      sessionDirRoot: "/tmp/sessions",
      emit: {
        onSessionUpdate: vi.fn(),
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

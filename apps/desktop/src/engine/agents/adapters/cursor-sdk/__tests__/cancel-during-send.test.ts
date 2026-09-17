// Stop must stop a turn whose run hasn't been born yet. cancel() aborts
// `session.activeRun` — but that is only assigned AFTER `agent.send()`
// resolves. A Stop clicked inside that window used to be a no-op (it only
// set cancelRequested), so the run streamed to completion while the UI
// showed STOPPED BY USER. The prompt loop now cancels the run the moment
// send() hands it over if a cancel was requested meanwhile.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CursorSdkAdapter } from "../adapter";
import type { AgentAdapterContext, ContentBlock } from "../../../types";

const { createSpy, sendSpy, modelsListSpy, readRunSpy } = vi.hoisted(() => ({
  createSpy: vi.fn(),
  sendSpy: vi.fn(),
  modelsListSpy: vi.fn(),
  readRunSpy: vi.fn(),
}));

vi.mock("@cursor/sdk", () => ({
  Agent: { create: createSpy, resume: vi.fn(), list: vi.fn() },
  Cursor: { models: { list: modelsListSpy } },
  // Real surface — see the note in cwd-binding.test.ts. No run docs here; these
  // suites only need create/send to reach the SDK.
  JsonlLocalAgentStore: class {
    runs = { get: readRunSpy };
    constructor(readonly rootDir: string) {}
  },
  getDefaultSdkStateRoot: (workspaceRef: string) =>
    `/state-root${workspaceRef}`,
}));

const fakeAgent = { agentId: "agent-xyz", send: sendSpy, close: () => {} };

function makeCtx(): AgentAdapterContext {
  return {
    projectRoot: "/tmp/proj",
    mcpServers: [],
    sessionDirRoot: "/tmp/proj/.sessions",
    emit: {
      onSessionUpdate: () => {},
      onPermissionRequest: () => {},
      onQuestionRequest: () => {},
      onAgentStderr: () => {},
      onAgentExit: () => {},
    },
  };
}

beforeAll(() => {
  process.env.CURSOR_RIPGREP_PATH = "/usr/bin/rg"; // short-circuit ensureRipgrep
});

beforeEach(() => {
  delete process.env.CURSOR_API_KEY; // avoid initialize()'s background discovery
  createSpy.mockReset().mockResolvedValue(fakeAgent);
  sendSpy.mockReset();
  modelsListSpy.mockReset().mockResolvedValue([]);
  readRunSpy.mockReset().mockResolvedValue(null);
});

const TEXT: ContentBlock[] = [{ type: "text", text: "hi" } as ContentBlock];

describe("CursorSdkAdapter — cancel during agent.send() still stops the run", () => {
  it.each([
    [{ status: 429, code: "rate_limit_exceeded", message: "Authentication request refused." }, null],
    [{ status: 403, code: "model_not_found", message: "Selection rejected." }, null],
    [{ status: 401, code: "unauthenticated", message: "Credential rejected." }, false],
    [{ message: "Unknown failure. Check your API key settings." }, null],
  ])("validates keys using native authentication evidence: %j", async (native, ok) => {
    modelsListSpy.mockRejectedValue(native);
    const adapter = new CursorSdkAdapter(makeCtx());
    try { expect(await adapter.validateApiKey("candidate")).toMatchObject({ ok }); }
    finally { await adapter.dispose(); }
  });

  it("settles cancellation when disposing the host makes send reject", async () => {
    let rejectSend!: (error: Error) => void;
    sendSpy.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectSend = reject;
        }),
    );
    const adapter = new CursorSdkAdapter(makeCtx());
    const { session } = await adapter.newSession({
      cwd: "/tmp/proj",
      env: { CURSOR_API_KEY: "key_test" },
    });
    const result = adapter.prompt({
      sessionId: session.sessionId,
      prompt: TEXT,
    });
    const settled = vi.fn();
    void result.then(settled, settled);
    await vi.waitFor(() => expect(sendSpy).toHaveBeenCalled());
    await adapter.disposeSession(session.sessionId);
    rejectSend(new Error("Host disposed"));
    await expect(result).resolves.toMatchObject({
      stopReason: "cancelled",
      response: { stopReason: "cancelled" },
    });
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it("ignores callbacks that arrive after a run has settled", async () => {
    const context = makeCtx();
    const emit = vi.spyOn(context.emit, "onSessionUpdate");
    let late!: (args: { update: unknown }) => void;
    sendSpy.mockImplementationOnce(async (_message, options) => {
      late = options.onDelta;
      return {
        id: "run-1",
        stream: async function* () {
          yield { type: "status", status: "FINISHED" };
        },
        wait: async () => ({ status: "finished" }),
        cancel: async () => {},
      };
    });
    const adapter = new CursorSdkAdapter(context);
    const { session } = await adapter.newSession({
      cwd: "/tmp/proj",
      env: { CURSOR_API_KEY: "key_test" },
    });
    await adapter.prompt({ sessionId: session.sessionId, prompt: TEXT });
    const before = emit.mock.calls.length;
    late({ update: { type: "text-delta", text: "late output" } });
    expect(emit).toHaveBeenCalledTimes(before);
    await adapter.dispose();
  });

  it("cancels the run as soon as send() resolves when Stop raced the send", async () => {
    let releaseSend!: () => void;
    const sendGate = new Promise<void>((r) => (releaseSend = r));
    let releaseStream!: () => void;
    const streamGate = new Promise<void>((r) => (releaseStream = r));
    const runCancel = vi.fn(async () => {
      releaseStream();
    });

    sendSpy.mockImplementationOnce(async () => {
      await sendGate; // Stop lands while send() is still in flight
      return {
        id: "run-1",
        // Blocks without yielding until cancel() releases it — a run that
        // would stream forever if nobody aborts it.
        // eslint-disable-next-line require-yield
        stream: async function* (): AsyncGenerator<unknown, void> {
          await streamGate;
        },
        wait: async () => ({ status: "error" }),
        cancel: runCancel,
      };
    });

    const adapter = new CursorSdkAdapter(makeCtx());
    const { session } = await adapter.newSession({
      cwd: "/tmp/proj",
      env: { CURSOR_API_KEY: "key_test" },
    });

    const promptPromise = adapter.prompt({
      sessionId: session.sessionId,
      prompt: TEXT,
    });
    await vi.waitFor(() => expect(sendSpy).toHaveBeenCalledOnce()); // activeRun still null

    await adapter.cancel({ sessionId: session.sessionId });
    expect(runCancel).not.toHaveBeenCalled(); // nothing to abort yet

    releaseSend();

    // The prompt loop must abort the newborn run and end the turn cleanly.
    await expect(promptPromise).resolves.toMatchObject({
      stopReason: "cancelled",
      response: { stopReason: "cancelled" },
    });
    expect(runCancel).toHaveBeenCalledTimes(1);
    await adapter.dispose();
  });

  it("keeps Stop authoritative while reading a legacy error from the store", async () => {
    let resolveStore!: (value: unknown) => void;
    readRunSpy.mockReturnValue(new Promise((resolve) => { resolveStore = resolve; }));
    sendSpy.mockResolvedValueOnce({ id: "run-1", stream: async function* () {}, wait: async () => ({ status: "error" }), cancel: async () => {} });
    const adapter = new CursorSdkAdapter(makeCtx());
    const { session } = await adapter.newSession({ cwd: "/tmp/proj", env: { CURSOR_API_KEY: "key_test" } });
    const result = adapter.prompt({ sessionId: session.sessionId, prompt: TEXT });
    void result.catch(() => {});
    await vi.waitFor(() => expect(readRunSpy).toHaveBeenCalled());
    await adapter.cancel({ sessionId: session.sessionId });
    resolveStore({ error: { code: "unauthenticated", message: "A late credential error." } });
    try { await expect(result).resolves.toMatchObject({ stopReason: "cancelled" }); }
    finally { await adapter.dispose(); }
  });

  it.each([undefined, { status: "running" }, { result: "Partial answer" }])(
    "rejects a run without completion evidence: %j",
    async (result) => {
      sendSpy.mockResolvedValueOnce({
        id: "run-1",
        stream: async function* () {
          yield {
            type: "assistant",
            message: { content: [{ type: "text", text: "Partial answer" }] },
          };
        },
        wait: async () => result,
        cancel: async () => {},
      });
      const adapter = new CursorSdkAdapter(makeCtx());
      const { session } = await adapter.newSession({
        cwd: "/tmp/proj",
        env: { CURSOR_API_KEY: "key_test" },
      });
      try {
        await expect(
          adapter.prompt({ sessionId: session.sessionId, prompt: TEXT }),
        ).rejects.toMatchObject({
          failure: { kind: "transport-closed", stage: "prompt" },
        });
      } finally {
        await adapter.dispose();
      }
    },
  );

  it.each(["cancelled", "finished"])(
    "uses wait status %s when the stream omitted its status event",
    async (status) => {
      sendSpy.mockResolvedValueOnce({
        id: "run-1",
        stream: async function* () {
          yield { type: "system" };
        },
        wait: async () => ({ status }),
        cancel: async () => {},
      });
      const adapter = new CursorSdkAdapter(makeCtx());
      const { session } = await adapter.newSession({
        cwd: "/tmp/proj",
        env: { CURSOR_API_KEY: "key_test" },
      });
      try {
        await expect(
          adapter.prompt({ sessionId: session.sessionId, prompt: TEXT }),
        ).resolves.toMatchObject({
          stopReason: status === "cancelled" ? "cancelled" : "end_turn",
        });
      } finally {
        await adapter.dispose();
      }
    },
  );

  it("accepts an explicit FINISHED stream event when wait has no result", async () => {
    sendSpy.mockResolvedValueOnce({
      id: "run-1",
      stream: async function* () {
        yield { type: "status", status: "FINISHED" };
      },
      wait: async () => undefined,
      cancel: async () => {},
    });
    const adapter = new CursorSdkAdapter(makeCtx());
    const { session } = await adapter.newSession({
      cwd: "/tmp/proj",
      env: { CURSOR_API_KEY: "key_test" },
    });
    try {
      await expect(
        adapter.prompt({ sessionId: session.sessionId, prompt: TEXT }),
      ).resolves.toMatchObject({ stopReason: "end_turn" });
    } finally {
      await adapter.dispose();
    }
  });

  it("preserves an explicit stream cancellation when wait reports an error", async () => {
    sendSpy.mockResolvedValueOnce({
      id: "run-1",
      stream: async function* () {
        yield { type: "status", status: "CANCELLED" };
      },
      wait: async () => ({ status: "error" }),
      cancel: async () => {},
    });
    const adapter = new CursorSdkAdapter(makeCtx());
    const { session } = await adapter.newSession({
      cwd: "/tmp/proj",
      env: { CURSOR_API_KEY: "key_test" },
    });
    try {
      await expect(
        adapter.prompt({ sessionId: session.sessionId, prompt: TEXT }),
      ).resolves.toMatchObject({
        stopReason: "cancelled",
        response: { stopReason: "cancelled" },
      });
    } finally {
      await adapter.dispose();
    }
  });

  it("preserves the structured wait error when the stream has no error detail", async () => {
    sendSpy.mockResolvedValueOnce({
      id: "run-1",
      stream: async function* () {
        yield { type: "status", status: "ERROR" };
      },
      wait: async () => ({
        status: "error",
        error: { message: "Selected model is at capacity.", code: "capacity" },
      }),
      cancel: async () => {},
    });
    const adapter = new CursorSdkAdapter(makeCtx());
    const { session } = await adapter.newSession({
      cwd: "/tmp/proj",
      env: { CURSOR_API_KEY: "key_test" },
    });
    try {
      await expect(
        adapter.prompt({ sessionId: session.sessionId, prompt: TEXT }),
      ).rejects.toThrow("Selected model is at capacity.");
    } finally {
      await adapter.dispose();
    }
  });

  it("retains a valid native code when its message has a malformed shape", async () => {
    sendSpy.mockResolvedValueOnce({ id: "run-1", stream: async function* () {}, wait: async () => ({ status: "error", error: { code: "resource_exhausted", message: 42 } }), cancel: async () => {} });
    const adapter = new CursorSdkAdapter(makeCtx());
    const { session } = await adapter.newSession({ cwd: "/tmp/proj", env: { CURSOR_API_KEY: "key_test" } });
    try {
      await expect(adapter.prompt({ sessionId: session.sessionId, prompt: TEXT })).rejects.toMatchObject({ failure: { kind: "rate-limited" } });
    } finally { await adapter.dispose(); }
  });

  it.each([
    [{ status: "error", error: { code: "rate_limit_exceeded", message: "Please check your API key settings." } }, "rate-limited"],
    [{ status: "error", error: { code: "unauthenticated", message: "Credential rejected." } }, "auth-required"],
    [{ status: "error", error: { code: "model_not_found", message: "Selection rejected." } }, "protocol-error"],
    [{ status: "expired" }, "session-expired"],
    [{ status: "error", error: { code: "ECONNRESET", message: "Request interrupted." } }, "transport-closed"],
    [{ status: "error", error: { code: "unknown", message: "Unexpected response. Check your API key." } }, "protocol-error"],
    [{ error: { code: "rate_limit_exceeded", message: "Please check your API key settings." } }, "rate-limited"],
  ])("uses the authoritative wait failure, including without status: %j", async (result, kind) => {
    readRunSpy.mockResolvedValue({ error: "Invalid API key from a stale store row." });
    sendSpy.mockResolvedValueOnce({
      id: "run-1", stream: async function* () {}, wait: async () => result, cancel: async () => {},
    });
    const adapter = new CursorSdkAdapter(makeCtx());
    const { session } = await adapter.newSession({ cwd: "/tmp/proj", env: { CURSOR_API_KEY: "key_test" } });
    try {
      const error = await adapter.prompt({ sessionId: session.sessionId, prompt: TEXT }).catch((failure: unknown) => failure);
      expect(error).toMatchObject({ failure: { kind } });
      if ("error" in result) expect((error as Error).message).toContain(result.error.message);
      expect(readRunSpy).not.toHaveBeenCalled();
      expect(sendSpy).toHaveBeenCalledTimes(1);
    } finally { await adapter.dispose(); }
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CursorSdkAdapter, type CursorSdkSendOptions } from "../adapter";
import type { AgentAdapterContext, SessionNotification } from "../../../types";

const sdk = vi.hoisted(() => ({
  create: vi.fn(),
  resume: vi.fn(),
  send: vi.fn(),
  storeGet: vi.fn(),
}));
vi.mock("@cursor/sdk", () => ({
  Agent: { create: sdk.create, resume: sdk.resume, list: vi.fn() },
  Cursor: { models: { list: vi.fn(async () => []) } },
  JsonlLocalAgentStore: class {
    runs = { get: sdk.storeGet };
  },
  getDefaultSdkStateRoot: () => "/synthetic-cursor-credentials",
}));

function setup() {
  const events: SessionNotification[] = [];
  const ctx: AgentAdapterContext = {
    projectRoot: "/tmp/cursor-credential-fixture",
    mcpServers: [],
    sessionDirRoot: "/tmp/fixture-sessions",
    emit: {
      onSessionUpdate: (_id, event) => events.push(event),
      onPermissionRequest: () => {},
      onQuestionRequest: () => {},
      onAgentStderr: () => {},
      onAgentExit: () => {},
    },
  };
  return { adapter: new CursorSdkAdapter(ctx), events };
}
const options = {
  cwd: "/tmp/cursor-credential-fixture",
  env: { CURSOR_API_KEY: "fixture-key" },
};
const prompt = [{ type: "text" as const, text: "Continue" }];
function run(error?: unknown) {
  return {
    id: "run-fixture",
    cancel: vi.fn(async () => {}),
    stream: async function* () {
      yield { type: "status", status: error ? "ERROR" : "FINISHED" };
    },
    wait: async () =>
      error
        ? { status: "error", error }
        : { status: "finished", result: "Done" },
  };
}
beforeEach(() => {
  vi.stubEnv("CURSOR_API_KEY", "");
  vi.stubEnv("CURSOR_RIPGREP_PATH", "/usr/bin/rg");
  const agent = { agentId: "parent", send: sdk.send, close: vi.fn() };
  sdk.create.mockReset().mockResolvedValue(agent);
  sdk.resume.mockReset().mockResolvedValue(agent);
  sdk.send.mockReset().mockResolvedValue(run());
  sdk.storeGet.mockReset().mockResolvedValue(null);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Cursor credential lifecycle", () => {
  it("keeps a long turn and the next send on the same session after native renewal", async () => {
    const c = setup();
    let release!: () => void;
    const renewed = new Promise<void>((resolve) => {
      release = resolve;
    });
    let streaming = false;
    sdk.send.mockImplementationOnce(
      async (_message, callbacks: CursorSdkSendOptions) => ({
        ...run(),
        stream: async function* () {
          await callbacks.onDelta?.({
            update: { type: "text-delta", text: "Working" },
          });
          streaming = true;
          yield { type: "status", status: "RUNNING" };
          await renewed;
          await callbacks.onDelta?.({
            update: { type: "text-delta", text: " after renewal" },
          });
          yield { type: "status", status: "FINISHED" };
        },
      }),
    );
    const { session } = await c.adapter.newSession(options);
    const settled = vi.fn();
    const pending = c.adapter
      .prompt({ sessionId: session.sessionId, prompt })
      .then((value) => {
        settled();
        return value;
      });
    try {
      await vi.waitFor(() => expect(streaming).toBe(true));
      const later = Date.now() + 61 * 60_000;
      vi.spyOn(Date, "now").mockReturnValue(later);
      expect(settled).not.toHaveBeenCalled();
      release();
      await expect(pending).resolves.toMatchObject({ stopReason: "end_turn" });
      await expect(
        c.adapter.prompt({ sessionId: session.sessionId, prompt }),
      ).resolves.toMatchObject({ stopReason: "end_turn" });
      expect(sdk.create).toHaveBeenCalledOnce();
      expect(sdk.resume).not.toHaveBeenCalled();
      expect(
        c.events.some((event) => event.update.sessionUpdate === "error_notice"),
      ).toBe(false);
    } finally {
      release();
      await pending.catch(() => {});
      await c.adapter.dispose();
    }
  });

  it.each([
    // Captured from the installed 1.0.31 local SDK after a controlled 503 at
    // token renewal. wait() omitted error/code; its run store retained this.
    [
      '[unknown] Server error during API key exchange: {"error":{"message":"Temporary fixture outage."}}',
      "transport-closed",
    ],
    [
      "[unknown] Failed to connect to API key exchange endpoint: Unknown error",
      "transport-closed",
    ],
    ["[unknown] The fixture credential was revoked.", "auth-required"],
    [
      { code: "unauthenticated", message: "The access token has expired." },
      "auth-required",
    ],
    [
      { code: "resource_exhausted", message: "Refresh requests are limited." },
      "rate-limited",
    ],
    [
      {
        code: "permission_denied",
        message: "This operation is not permitted.",
      },
      "protocol-error",
    ],
  ])("preserves refresh failure recovery: %j", async (error, kind) => {
    const c = setup();
    // Establish a usable session before its renewal fails.
    const { session } = await c.adapter.newSession(options);
    await c.adapter.prompt({ sessionId: session.sessionId, prompt });
    if (typeof error === "string") {
      const failed = run(error);
      sdk.send.mockResolvedValueOnce({
        ...failed,
        wait: async () => ({ status: "error" }),
      });
      sdk.storeGet.mockResolvedValue({ error });
    } else sdk.send.mockResolvedValueOnce(run(error));
    try {
      await expect(
        c.adapter.prompt({ sessionId: session.sessionId, prompt }),
      ).rejects.toMatchObject({ failure: { kind } });
      expect(sdk.send).toHaveBeenCalledTimes(2);
      expect(sdk.create).toHaveBeenCalledOnce();
      expect(sdk.resume).not.toHaveBeenCalled();
      expect(
        c.events.some(
          (event) =>
            event.update.sessionUpdate === "error_notice" &&
            /Connection lost/.test(event.update.message),
        ),
      ).toBe(kind === "transport-closed");
    } finally {
      await c.adapter.dispose();
    }
  });

  it("resumes the same provider conversation with the replacement credential after reconnect", async () => {
    const c = setup();
    const { session } = await c.adapter.newSession(options);
    await c.adapter.prompt({ sessionId: session.sessionId, prompt });
    await c.adapter.disposeSession(session.sessionId);
    try {
      await c.adapter.loadSession({
        ...options,
        sessionId: "parent",
        env: { CURSOR_API_KEY: "replacement-fixture-key" },
      });
      await expect(
        c.adapter.prompt({ sessionId: "parent", prompt }),
      ).resolves.toMatchObject({ stopReason: "end_turn" });
      expect(sdk.resume).toHaveBeenCalledWith(
        "parent",
        expect.objectContaining({ apiKey: "replacement-fixture-key" }),
      );
      expect(sdk.create).toHaveBeenCalledOnce();
    } finally {
      await c.adapter.dispose();
    }
  });
});

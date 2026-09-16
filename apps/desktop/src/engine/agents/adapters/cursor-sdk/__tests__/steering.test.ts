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

describe("Cursor steering delivery", () => {
  it("advertises steering for local SDK runs", async () => {
    const adapter = new CursorSdkAdapter(makeCtx());
    try {
      expect((await adapter.initialize()).agentCapabilities?.steering).toBe(
        true,
      );
    } finally {
      await adapter.dispose();
    }
  });

  it.each(["complete_delivered", "revert_to_followup"] as const)(
    "resolves only after native delivery outcome %s",
    async (nativeOutcome) => {
      let finishStream!: () => void;
      const streamGate = new Promise<void>((resolve) => {
        finishStream = resolve;
      });
      let acknowledge!: (outcome: string) => void;
      const nativeSteer = vi.fn(
        () =>
          new Promise<string>((resolve) => {
            acknowledge = resolve;
          }),
      );
      sendSpy.mockResolvedValue({
        id: "run",
        steer: nativeSteer,
        // eslint-disable-next-line require-yield
        stream: async function* () {
          await streamGate;
        },
        wait: async () => ({ status: "cancelled" }),
        cancel: async () => {
          finishStream();
        },
      });
      const adapter = new CursorSdkAdapter(makeCtx());
      const { session } = await adapter.newSession({
        cwd: "/tmp/proj",
        env: { CURSOR_API_KEY: "key_test" },
      });
      const turn = adapter.prompt({
        sessionId: session.sessionId,
        prompt: TEXT,
      });
      await vi.waitFor(() => expect(sendSpy).toHaveBeenCalled());
      await expect(
        adapter.steer({
          sessionId: session.sessionId,
          prompt: [
            { type: "text", text: "Legacy image" },
            { type: "image", mimeType: "image/png", data: "fixture" },
          ],
        }),
      ).resolves.toBe("queued");
      expect(nativeSteer).not.toHaveBeenCalled();
      const settled = vi.fn();
      const steering = adapter
        .steer({
          sessionId: session.sessionId,
          prompt: [
            { type: "text", text: "Inspect the attachment" },
            { type: "text", text: "Read .context/local/attachments/report.md" },
          ],
        })
        .then((result) => {
          settled(result);
          return result;
        });
      await vi.waitFor(() => expect(nativeSteer).toHaveBeenCalled());
      expect(settled).not.toHaveBeenCalled();
      expect(nativeSteer).toHaveBeenCalledWith(
        "Inspect the attachment\n\nRead .context/local/attachments/report.md",
      );
      acknowledge(nativeOutcome);
      await expect(steering).resolves.toBe(
        nativeOutcome === "complete_delivered" ? "delivered" : "queued",
      );
      await adapter.cancel({ sessionId: session.sessionId });
      await turn;
      await adapter.dispose();
    },
  );

  it.each(["cancel", "dispose", "rejected"])(
    "settles pending steering once after %s and ignores a late acknowledgement",
    async (end) => {
      let finishStream!: () => void;
      const gate = new Promise<void>((resolve) => {
        finishStream = resolve;
      });
      let acknowledge!: (value: string) => void;
      let reject!: (error: Error) => void;
      const nativeSteer = vi.fn(
        () =>
          new Promise<string>((resolve, fail) => {
            acknowledge = resolve;
            reject = fail;
          }),
      );
      sendSpy.mockResolvedValue({
        id: "run",
        steer: nativeSteer,
        // eslint-disable-next-line require-yield
        stream: async function* () {
          await gate;
        },
        wait: async () => ({ status: "cancelled" }),
        cancel: async () => finishStream(),
      });
      const adapter = new CursorSdkAdapter(makeCtx());
      const { session } = await adapter.newSession({
        cwd: "/tmp/proj",
        env: { CURSOR_API_KEY: "key_test" },
      });
      const turn = adapter.prompt({
        sessionId: session.sessionId,
        prompt: TEXT,
      });
      await vi.waitFor(() => expect(sendSpy).toHaveBeenCalled());
      const settled = vi.fn();
      const steering = adapter
        .steer({ sessionId: session.sessionId, prompt: TEXT })
        .then(settled);
      await vi.waitFor(() => expect(nativeSteer).toHaveBeenCalled());
      if (end === "rejected") reject(new Error("connection lost"));
      else if (end === "dispose")
        await adapter.disposeSession(session.sessionId);
      else await adapter.cancel({ sessionId: session.sessionId });
      await steering;
      expect(settled).toHaveBeenCalledExactlyOnceWith("interrupted");
      acknowledge("complete_delivered");
      await Promise.resolve();
      expect(settled).toHaveBeenCalledOnce();
      finishStream();
      await turn;
      await adapter.dispose();
    },
  );

  it("does not let a late Stop acknowledgement settle steering on the next run", async () => {
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    let finishCancel!: () => void;
    const firstStream = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const secondStream = new Promise<void>((resolve) => {
      finishSecond = resolve;
    });
    const cancellation = new Promise<void>((resolve) => {
      finishCancel = resolve;
    });
    let acknowledge!: (value: string) => void;
    const nativeSteer = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          acknowledge = resolve;
        }),
    );
    sendSpy
      .mockResolvedValueOnce({
        id: "first",
        // eslint-disable-next-line require-yield
        stream: async function* () {
          await firstStream;
        },
        wait: async () => ({ status: "cancelled" }),
        cancel: async () => {
          finishFirst();
          await cancellation;
        },
      })
      .mockResolvedValueOnce({
        id: "second",
        steer: nativeSteer,
        // eslint-disable-next-line require-yield
        stream: async function* () {
          await secondStream;
        },
        wait: async () => ({ status: "cancelled" }),
        cancel: async () => finishSecond(),
      });
    const adapter = new CursorSdkAdapter(makeCtx());
    const { session } = await adapter.newSession({
      cwd: "/tmp/proj",
      env: { CURSOR_API_KEY: "key_test" },
    });
    const first = adapter.prompt({
      sessionId: session.sessionId,
      prompt: TEXT,
    });
    await vi.waitFor(() => expect(sendSpy).toHaveBeenCalledTimes(1));
    const stopping = adapter.cancel({ sessionId: session.sessionId });
    await first;
    const second = adapter.prompt({
      sessionId: session.sessionId,
      prompt: TEXT,
    });
    await vi.waitFor(() => expect(sendSpy).toHaveBeenCalledTimes(2));
    const settled = vi.fn();
    const steer = adapter
      .steer({ sessionId: session.sessionId, prompt: TEXT })
      .then(settled);
    await vi.waitFor(() => expect(nativeSteer).toHaveBeenCalledOnce());
    finishCancel();
    await stopping;
    expect(settled).not.toHaveBeenCalled();
    acknowledge("complete_delivered");
    await steer;
    expect(settled).toHaveBeenCalledExactlyOnceWith("delivered");
    finishSecond();
    await second;
    await adapter.dispose();
  });

  it("returns input to the queue if Stop wins before native steering dispatch", async () => {
    let finishStream!: () => void;
    const gate = new Promise<void>((resolve) => {
      finishStream = resolve;
    });
    const nativeSteer = vi.fn(async () => "complete_delivered");
    sendSpy.mockResolvedValue({
      id: "run",
      steer: nativeSteer,
      // eslint-disable-next-line require-yield
      stream: async function* () {
        await gate;
      },
      wait: async () => ({ status: "cancelled" }),
      cancel: () => {
        finishStream();
        throw new Error("cancel transport closed");
      },
    });
    const adapter = new CursorSdkAdapter(makeCtx());
    const { session } = await adapter.newSession({
      cwd: "/tmp/proj",
      env: { CURSOR_API_KEY: "key_test" },
    });
    const turn = adapter.prompt({ sessionId: session.sessionId, prompt: TEXT });
    await vi.waitFor(() => expect(sendSpy).toHaveBeenCalled());
    const steer = adapter.steer({ sessionId: session.sessionId, prompt: TEXT });
    await adapter.cancel({ sessionId: session.sessionId });
    await expect(steer).resolves.toBe("queued");
    expect(nativeSteer).not.toHaveBeenCalled();
    await turn;
    await adapter.dispose();
  });

  it("keeps an idle follow-up queued without starting a run", async () => {
    const adapter = new CursorSdkAdapter(makeCtx());
    const { session } = await adapter.newSession({
      cwd: "/tmp/proj",
      env: { CURSOR_API_KEY: "key_test" },
    });
    try {
      await expect(
        adapter.steer({ sessionId: session.sessionId, prompt: TEXT }),
      ).resolves.toBe("queued");
      expect(sendSpy).not.toHaveBeenCalled();
    } finally {
      await adapter.dispose();
    }
  });
});

// Stop must stop a turn whose run hasn't been born yet. cancel() aborts
// `session.activeRun` — but that is only assigned AFTER `agent.send()`
// resolves. A Stop clicked inside that window used to be a no-op (it only
// set cancelRequested), so the run streamed to completion while the UI
// showed STOPPED BY USER. The prompt loop now cancels the run the moment
// send() hands it over if a cancel was requested meanwhile.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CursorSdkAdapter } from "../adapter";
import type { AgentAdapterContext, ContentBlock } from "../../../types";

const { createSpy, sendSpy, modelsListSpy } = vi.hoisted(() => ({
  createSpy: vi.fn(),
  sendSpy: vi.fn(),
  modelsListSpy: vi.fn(),
}));

vi.mock("@cursor/sdk", () => ({
  Agent: { create: createSpy, resume: vi.fn(), list: vi.fn() },
  Cursor: { models: { list: modelsListSpy } },
  SqliteLocalAgentStore: {
    open: async () => ({ runs: { get: async () => null }, dispose: async () => {} }),
  },
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
});

const TEXT: ContentBlock[] = [{ type: "text", text: "hi" } as ContentBlock];

describe("CursorSdkAdapter — cancel during agent.send() still stops the run", () => {
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
    await Promise.resolve(); // send() is now in flight; activeRun still null

    await adapter.cancel({ sessionId: session.sessionId });
    expect(runCancel).not.toHaveBeenCalled(); // nothing to abort yet

    releaseSend();

    // The prompt loop must abort the newborn run and end the turn cleanly.
    await expect(promptPromise).resolves.toBeDefined();
    expect(runCancel).toHaveBeenCalledTimes(1);
  });
});

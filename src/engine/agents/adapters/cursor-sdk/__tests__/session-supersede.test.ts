// Locks the "one live session per chat" mid-turn teardown contract for cursor.
//
// When a chat's session is SUPERSEDED while a turn is in flight — the engine
// disposes the prior session the instant a fresh one binds to the same chat
// (the AGENT_NEW_SESSION handler in src/engine/index.ts, added to stop an old
// agent lingering / co-streaming into the chat) — the in-flight prompt MUST end
// via the deliberate-cancel path (a clean stop), NOT throw AGENT_PROMPT_FAILED.
// Otherwise a model/effort respawn mid-turn would surface a spurious error pill.
// disposeSession sets `cancelRequested` BEFORE cancelling the run so the prompt
// loop's cancel branch wins over the run's (error) terminal status.

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
  // Real surface — see the note in cwd-binding.test.ts. No run docs here; these
  // suites only need create/send to reach the SDK.
  JsonlLocalAgentStore: class {
    runs = { get: async () => null };
    constructor(readonly rootDir: string) {}
  },
  getDefaultSdkStateRoot: (workspaceRef: string) => `/state-root${workspaceRef}`,
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

describe("CursorSdkAdapter — mid-turn supersede (disposeSession) is a clean cancel", () => {
  it("ends the in-flight prompt cleanly instead of throwing when disposed mid-turn", async () => {
    let startStreaming!: () => void;
    const streaming = new Promise<void>((r) => (startStreaming = r));
    let releaseStream!: () => void;
    const streamGate = new Promise<void>((r) => (releaseStream = r));
    let cancelled = false;

    // A run that blocks in stream() until cancel() releases it. A cancelled
    // local run can report a terminal "error" status — without the deliberate-
    // cancel flag the prompt loop would (wrongly) treat that as a turn failure.
    sendSpy.mockImplementationOnce(async () => ({
      id: "run-1",
      // This mock stream intentionally blocks (await streamGate) WITHOUT
      // yielding — it simulates a hung in-flight run that gets cancelled
      // mid-turn. A real `yield` would emit a spurious chunk and change the
      // test's semantics, so the require-yield lint is suppressed here by intent.
      // eslint-disable-next-line require-yield
      stream: async function* (): AsyncGenerator<unknown, void> {
        startStreaming();
        await streamGate;
      },
      wait: async () => ({ status: cancelled ? "error" : "finished" }),
      cancel: async () => {
        cancelled = true;
        releaseStream();
      },
    }));

    const adapter = new CursorSdkAdapter(makeCtx());
    const { session } = await adapter.newSession({
      cwd: "/tmp/proj",
      env: { CURSOR_API_KEY: "key_test" },
    });

    const promptPromise = adapter.prompt({
      sessionId: session.sessionId,
      prompt: TEXT,
    });
    await streaming; // the turn is now in flight (session.activeRun is set)

    // Supersede the session mid-turn — exactly what the engine does when a
    // fresh session binds to the same chat.
    await adapter.disposeSession(session.sessionId);

    // The in-flight prompt resolves cleanly — NOT a rejected AGENT_PROMPT_FAILED.
    await expect(promptPromise).resolves.toBeDefined();
  });
});

// @cursor/sdk keys its workspace executor on `autoReview` (together with cwd,
// apiKey, settingSources, sandbox and MCP), so "Auto" and "not Auto" are two
// SEPARATE executors — and building one is the full rules / skills / ignore /
// MCP walk, 8-12s on a repo this size.
//
// autoReview is also a CREATE-TIME option, so a mode change is reconciled by
// ensureAutoReview()'s `Agent.resume` on the next prompt. Before this, that
// resume asked for an executor nobody had built: the session-start prewarm had
// warmed the OTHER shape, so the whole walk landed inside the user's first
// message after they touched the mode picker.
//
// These lock the fix: the moment the desired shape changes, the build starts.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const {
  createSpy,
  resumeSpy,
  listSpy,
  modelsListSpy,
  prewarmSpy,
  sendSpy,
  usageSpy,
} = vi.hoisted(() => ({
  createSpy: vi.fn(),
  resumeSpy: vi.fn(),
  listSpy: vi.fn(),
  modelsListSpy: vi.fn(),
  prewarmSpy: vi.fn(),
  sendSpy: vi.fn(),
  usageSpy: vi.fn(),
}));

// The real in-process wrapper drops `platform` (only the subprocess host
// synthesizes that surface — host-client.ts). Pass it through so the adapter's
// prewarm path is reachable from a unit test.
vi.mock("../local-store", () => ({
  wrapSdkWithLocalStore: (raw: Record<string, unknown>) => ({
    ...raw,
    localStore: { open: async () => null },
  }),
}));

vi.mock("@cursor/sdk", () => ({
  Agent: { create: createSpy, resume: resumeSpy, list: listSpy },
  Cursor: { models: { list: modelsListSpy } },
  platform: { prewarm: prewarmSpy },
}));

import { CursorSdkAdapter } from "../adapter";
import type { AgentAdapterContext, ContentBlock } from "../../../types";

const fakeAgent = {
  agentId: "agent-xyz",
  send: sendSpy,
  getUsage: usageSpy,
  close: () => {},
};

let runSeq = 0;
const makeRun = () => ({
  id: `run-${++runSeq}`,
  stream: async function* (): AsyncGenerator<unknown, void> {
    /* no streamed events — the turn ends cleanly via wait() */
  },
  wait: async () => ({ status: "finished" }),
  cancel: async () => {},
});

const EMPTY_AGENT_USAGE = {
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
  },
  cost: { rawCostCents: 0, chargedCents: 0 },
  runs: [],
};

const TEXT = [{ type: "text", text: "hi" }] as unknown as ContentBlock[];

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

/** `local` carries every executor-cache-key field the adapter controls
 *  (cwd, dirs, autoReview, sandbox, settingSources). autoReview=false is
 *  expressed by OMITTING the key — buildLocalOpts only sets it when true — so
 *  compare the whole object rather than one field. */
const localOf = (call: unknown[], index = 0): unknown =>
  (call[index] as { local?: unknown }).local;

beforeAll(() => {
  process.env.CURSOR_RIPGREP_PATH = "/usr/bin/rg"; // short-circuit ensureRipgrep
  process.env.ZEROS_CURSOR_IN_PROCESS = "1"; // take the direct SDK path
});

beforeEach(() => {
  delete process.env.CURSOR_API_KEY;
  createSpy.mockReset().mockResolvedValue(fakeAgent);
  resumeSpy.mockReset().mockResolvedValue(fakeAgent);
  listSpy.mockReset().mockResolvedValue({ items: [] });
  modelsListSpy.mockReset().mockResolvedValue([]);
  prewarmSpy.mockReset().mockResolvedValue({ prewarmed: true });
  sendSpy.mockReset().mockImplementation(async () => makeRun());
  usageSpy.mockReset().mockResolvedValue(EMPTY_AGENT_USAGE);
  runSeq = 0;
});

async function startSession(): Promise<{
  adapter: CursorSdkAdapter;
  sessionId: string;
}> {
  const adapter = new CursorSdkAdapter(makeCtx());
  const { session } = await adapter.newSession({
    cwd: "/tmp/proj/wt",
    env: { CURSOR_API_KEY: "key_test" },
  });
  return { adapter, sessionId: session.executionId };
}

describe("Cursor executor prewarm across a mode change", () => {
  it("warms the born-default Auto shape at session start", async () => {
    await startSession();
    expect(prewarmSpy).toHaveBeenCalledTimes(1);
    // CURSOR_DEFAULT_MODE is "auto", and autoReviewFor("auto") is true.
    expect(
      (localOf(prewarmSpy.mock.calls[0]) as { autoReview?: unknown })
        .autoReview,
    ).toBe(true);
  });

  it("warms exactly the executor ensureAutoReview's resume will ask for", async () => {
    const { adapter, sessionId } = await startSession();
    // The born-default warm is the Auto shape, and it sets autoReview.
    expect(
      (localOf(prewarmSpy.mock.calls[0]) as { autoReview?: unknown })
        .autoReview,
    ).toBe(true);
    prewarmSpy.mockClear();

    await adapter.setMode({ sessionId, modeId: "agent" });
    expect(prewarmSpy).toHaveBeenCalledTimes(1);

    // Now let the lazy reconcile run. THIS is the invariant that matters: the
    // options we warmed must be byte-for-byte the ones the resume presents, or
    // the SDK hashes a different cache key and warms an executor nobody uses.
    await adapter.prompt({ sessionId, prompt: TEXT });

    expect(resumeSpy).toHaveBeenCalledTimes(1);
    expect(localOf(prewarmSpy.mock.calls[0])).toEqual(
      localOf(resumeSpy.mock.calls[0], 1),
    );
    const warmed = prewarmSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(warmed.cwd).toBe("/tmp/proj/wt");
    expect(warmed.apiKey).toBe("key_test");
  });

  it("does not queue a second build while the first is still in flight", async () => {
    const { adapter, sessionId } = await startSession();
    prewarmSpy.mockClear();

    await adapter.setMode({ sessionId, modeId: "agent" });
    await adapter.setMode({ sessionId, modeId: "plan" }); // same autoReview=false
    await adapter.setMode({ sessionId, modeId: "agent" });

    expect(prewarmSpy).toHaveBeenCalledTimes(1);
  });

  it("does not rewarm the shape the live agent already has", async () => {
    const { adapter, sessionId } = await startSession();
    prewarmSpy.mockClear();

    // Back to the born default: the agent still carries autoReview=true, so
    // there is no rebuild coming and nothing to warm.
    await adapter.setMode({ sessionId, modeId: "auto" });

    expect(prewarmSpy).not.toHaveBeenCalled();
  });

  it("keeps a mode change instant when the prewarm is slow or fails", async () => {
    const { adapter, sessionId } = await startSession();
    let settle: (() => void) | undefined;
    prewarmSpy.mockReset().mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = () => resolve({ prewarmed: true });
        }),
    );

    // Fire-and-forget: setMode must not await the build.
    await expect(
      adapter.setMode({ sessionId, modeId: "agent" }),
    ).resolves.toBeUndefined();
    expect(settle).toBeDefined();
    settle?.();

    // And a rejected prewarm is swallowed — it is a pure optimization, the
    // send rebuilds. An unhandled rejection here would take the engine down.
    prewarmSpy.mockReset().mockRejectedValue(new Error("host gone"));
    const { adapter: other, sessionId: otherId } = await startSession();
    await expect(
      other.setMode({ sessionId: otherId, modeId: "plan" }),
    ).resolves.toBeUndefined();
    await Promise.resolve();
  });

  it("is a no-op on an unknown session and on an unrecognized mode", async () => {
    const { adapter, sessionId } = await startSession();
    prewarmSpy.mockClear();

    await adapter.setMode({ sessionId: "nope", modeId: "agent" });
    await adapter.setMode({ sessionId, modeId: "not-a-mode" });

    expect(prewarmSpy).not.toHaveBeenCalled();
  });
});

// Regression for the "Cursor committed in the wrong repo" bug (2026-06-20).
//
// @cursor/sdk runs in a SINGLE shared Node host whose process.cwd() is a neutral
// non-repo dir (host-client.ts → resolveHostCwd). The SDK's local executor roots
// shell commands at `local.cwd ?? process.cwd()`, so the ONLY thing keeping an
// agent's `git`/file writes inside its worktree is the per-agent cwd we thread
// into Agent.create / Agent.resume. If any of those call sites drops it, shells
// silently fall back to the host cwd. These tests pin that every create/resume —
// including the session-expired rebuild — carries the worktree cwd at BOTH the
// top level and on `local`.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CursorSdkAdapter } from "../adapter";
import type { AgentAdapterContext, ContentBlock } from "../../../types";

const { createSpy, resumeSpy, sendSpy, listSpy, modelsListSpy, storeGetSpy } =
  vi.hoisted(() => ({
    createSpy: vi.fn(),
    resumeSpy: vi.fn(),
    sendSpy: vi.fn(),
    listSpy: vi.fn(),
    modelsListSpy: vi.fn(),
    storeGetSpy: vi.fn(),
  }));

vi.mock("@cursor/sdk", () => ({
  Agent: { create: createSpy, resume: resumeSpy, list: listSpy },
  Cursor: { models: { list: modelsListSpy } },
  // The REAL @cursor/sdk surface: a JsonlLocalAgentStore constructor plus
  // getDefaultSdkStateRoot. Mocking a `LocalAgentStore.open` namespace (as this
  // did) rubber-stamped a name the package has never exported, so the in-process
  // store path looked covered while it could not work at all.
  JsonlLocalAgentStore: class {
    runs = { get: storeGetSpy };
    constructor(readonly rootDir: string) {}
  },
  getDefaultSdkStateRoot: (workspaceRef: string) => `/state-root${workspaceRef}`,
}));

let runSeq = 0;
const makeRun = (status = "finished") => ({
  id: `run-${++runSeq}`,
  stream: async function* (): AsyncGenerator<unknown, void> {
    /* no streamed events */
  },
  wait: async () => ({ status }),
  cancel: async () => {},
});

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
  delete process.env.CURSOR_API_KEY;
  createSpy.mockReset().mockResolvedValue(fakeAgent);
  resumeSpy.mockReset().mockResolvedValue(fakeAgent);
  sendSpy.mockReset().mockImplementation(async () => makeRun());
  listSpy.mockReset().mockResolvedValue({ items: [] });
  modelsListSpy.mockReset().mockResolvedValue([]);
  storeGetSpy.mockReset().mockResolvedValue(null);
  runSeq = 0;
});

// A worktree path distinct from the test's process.cwd() — the bug shipped a
// commit to the ENGINE's cwd, so the worktree must never collapse to it.
const WORKTREE = "/Users/dev/zeros/workspaces/acme-widgets/ws_12ad4b-mayflower";
const TEXT: ContentBlock[] = [{ type: "text", text: "hi" } as ContentBlock];

describe("CursorSdkAdapter — every agent is rooted at its worktree cwd", () => {
  it("newSession binds the worktree cwd at top-level AND on local", async () => {
    const adapter = new CursorSdkAdapter(makeCtx());
    await adapter.newSession({ cwd: WORKTREE, env: { CURSOR_API_KEY: "k" } });

    expect(createSpy).toHaveBeenCalledTimes(1);
    const [opts] = createSpy.mock.calls[0];
    expect(opts.cwd).toBe(WORKTREE);
    expect(opts.local).toMatchObject({ cwd: WORKTREE });
    expect(opts.cwd).not.toBe(process.cwd());
  });

  it("loadSession (resume) retargets cwd to the CURRENT worktree", async () => {
    const adapter = new CursorSdkAdapter(makeCtx());
    await adapter.loadSession({
      sessionId: "prior-agent-id",
      cwd: WORKTREE,
      env: { CURSOR_API_KEY: "k" },
    });

    expect(resumeSpy).toHaveBeenCalledTimes(1);
    const [, opts] = resumeSpy.mock.calls[0];
    expect(opts.cwd).toBe(WORKTREE);
    expect(opts.local).toMatchObject({ cwd: WORKTREE });
  });

  it("session-expired rebuild seeds the FRESH agent in the same worktree cwd", async () => {
    // resume throws the SDK's "Agent <id> not found" → adapter transparently
    // creates a fresh agent. That recovery path must also carry the cwd.
    resumeSpy.mockReset().mockRejectedValue(new Error("Agent abc not found"));
    const adapter = new CursorSdkAdapter(makeCtx());
    await adapter.loadSession({
      sessionId: "gone-id",
      cwd: WORKTREE,
      env: { CURSOR_API_KEY: "k" },
    });

    expect(createSpy).toHaveBeenCalledTimes(1);
    const [opts] = createSpy.mock.calls[0];
    expect(opts.cwd).toBe(WORKTREE);
    expect(opts.local).toMatchObject({ cwd: WORKTREE });
  });

  it("send still runs against the session whose agent is rooted at the worktree", async () => {
    const adapter = new CursorSdkAdapter(makeCtx());
    const { session } = await adapter.newSession({
      cwd: WORKTREE,
      env: { CURSOR_API_KEY: "k" },
    });
    await adapter.prompt({ sessionId: session.sessionId, prompt: TEXT });

    // The run is issued on the agent created with the worktree cwd (above), and
    // @cursor/sdk's executor lease is bound to that agent's create-time cwd.
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const [createOpts] = createSpy.mock.calls[0];
    expect(createOpts.local).toMatchObject({ cwd: WORKTREE });
  });
});

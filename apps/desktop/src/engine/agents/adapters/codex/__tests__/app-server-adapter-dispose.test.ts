// Codex owns an explicit process-group stop, so a dispose rejection is the one
// adapter signal that genuinely means "a child may still be alive in the
// worktree" — the archive/delete reaper passes failClosed and aborts on it.
// That reporting must not cost retryability: the runtime memoizes its dispose
// promise, so a retained session would re-await the same hung stop forever and
// leave the workspace permanently unarchivable for the process lifetime.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentAdapterContext } from "../../../types";

const rt = vi.hoisted(() => ({
  disposeCalls: 0,
  disposeImpl: null as null | (() => Promise<void>),
}));

vi.mock("../app-server", () => ({
  bootCodexAppServerRuntime: vi.fn(async () => ({
    initializeResponse: {
      userAgent: "codex_cli 0.139.0",
      codexHome: "/tmp",
      platformFamily: "unix",
      platformOs: "linux",
    },
    cliVersion: "0.139.0",
    binarySource: { source: "path", path: "codex" },
    child: { pid: 4321, killed: false },
    startThread: async () => ({
      threadId: "thread-1",
      providerSessionId: "codex-root-session-1",
      gitInfo: { sha: "abc", branch: "main", originUrl: null },
      model: "gpt-5",
      approvalPolicy: "on-request",
      sandbox: { type: "workspaceWrite" },
      raw: {},
    }),
    resumeThread: async (p: { threadId: string }) => ({
      threadId: p.threadId,
      model: "gpt-5",
      raw: {},
    }),
    runTurn: async () => ({ turnId: "turn-1", status: "completed", raw: {} }),
    interruptTurn: async () => {},
    respondToPermission: () => {},
    respondToUserInput: () => {},
    onNotification: () => () => {},
    request: vi.fn(async () => ({})),
    dispose: async () => {
      rt.disposeCalls += 1;
      if (rt.disposeImpl) await rt.disposeImpl();
    },
  })),
}));

vi.mock("../../../session-paths", () => ({
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
import { writeSessionMeta } from "../../../session-paths";

function makeAdapter() {
  const ctx = {
    projectRoot: "/tmp/proj",
    mcpServers: [],
    sessionDirRoot: "/tmp/sessions",
    emit: {
      onSessionUpdate: vi.fn(),
      onPermissionRequest: vi.fn(),
      onPermissionSettled: vi.fn(),
      onQuestionRequest: vi.fn(),
      onAgentStderr: vi.fn(),
      onAgentExit: vi.fn(),
    },
  } as unknown as AgentAdapterContext;
  return new CodexAppServerAdapter(ctx);
}

describe("CodexAppServerAdapter.disposeSession", () => {
  beforeEach(() => {
    rt.disposeCalls = 0;
    rt.disposeImpl = null;
  });

  it("returns Codex thread identity separately from the Zeros execution", async () => {
    const adapter = makeAdapter();
    const { session } = await adapter.newSession({
      executionId: "zeros-execution-1",
      cwd: "/tmp/proj",
    });

    expect(session).toMatchObject({
      executionId: "zeros-execution-1",
      sessionId: "zeros-execution-1",
      providerBinding: {
        version: 1,
        providerId: "codex",
        kind: "native",
        resumeId: "thread-1",
        scopeId: "codex-root-session-1",
      },
    });
    expect(session).not.toHaveProperty("providerMetadata");
    expect(writeSessionMeta).toHaveBeenCalledWith(
      "zeros-execution-1",
      expect.objectContaining({
        agentId: "codex",
        cwd: "/tmp/proj",
        pid: process.pid,
      }),
    );
    await adapter.disposeSession(session.executionId);
  });

  it("reports a process-group teardown failure to the caller", async () => {
    const adapter = makeAdapter();
    const { session } = await adapter.newSession({ cwd: "/tmp/proj" });
    rt.disposeImpl = async () => {
      throw new Error("process group still alive");
    };

    await expect(adapter.disposeSession(session.sessionId)).rejects.toThrow(
      "process group still alive",
    );
  });

  it("drops the session on failure so a retry is not pinned to the same stop", async () => {
    const adapter = makeAdapter();
    const { session } = await adapter.newSession({ cwd: "/tmp/proj" });
    rt.disposeImpl = async () => {
      throw new Error("process group still alive");
    };

    await expect(adapter.disposeSession(session.sessionId)).rejects.toThrow();
    // The retry the user reaches for after the aborted archive must make
    // progress. The child has already been SIGKILLed by the runtime's own stop
    // and there is no further escalation, so re-entering the memoized promise
    // could only fail identically — permanently.
    rt.disposeImpl = null;
    await expect(
      adapter.disposeSession(session.sessionId),
    ).resolves.toBeUndefined();
    expect(rt.disposeCalls).toBe(1);
  });
});

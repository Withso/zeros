// Codex session identity must be the app-server thread id. A Zeros-local UUID
// cannot be resumed after an engine restart because thread/resume resolves only
// Codex's persisted rollout ids. Legacy local ids that already exist in chat
// rows are migrated to the fresh replacement thread on their first degraded
// resume.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentAdapterContext } from "../../../types";

const runtimeState = vi.hoisted(() => ({
  startThreadIds: [] as string[],
  resumeError: null as Error | null,
  resumeCalls: [] as string[],
}));

vi.mock("../app-server", () => ({
  bootCodexAppServerRuntime: vi.fn(async () => ({
    initializeResponse: {
      userAgent: "codex_cli 0.146.0",
      codexHome: "/tmp",
      platformFamily: "unix",
      platformOs: "darwin",
    },
    cliVersion: "0.146.0",
    binarySource: { source: "path", path: "codex" },
    child: { pid: 1234, killed: false },
    startThread: async () => ({
      threadId: runtimeState.startThreadIds.shift() ?? "thread-created",
      model: "gpt-5",
      approvalPolicy: "on-request",
      sandbox: { type: "workspaceWrite" },
      raw: {},
    }),
    resumeThread: async ({ threadId }: { threadId: string }) => {
      runtimeState.resumeCalls.push(threadId);
      if (runtimeState.resumeError) throw runtimeState.resumeError;
      return { threadId, model: "gpt-5", raw: {} };
    },
    runTurn: async () => ({
      turnId: "turn-1",
      status: "completed",
      raw: {},
    }),
    interruptTurn: async () => {},
    respondToPermission: () => {},
    respondToUserInput: () => {},
    onNotification: () => () => {},
    request: vi.fn(async () => ({})),
    dispose: async () => {},
  })),
}));

vi.mock("../../../session-paths", () => ({
  ensureSessionDir: vi.fn(async () => ({
    root: "/tmp/session",
    env: "/tmp/session/env",
    log: "/tmp/session/log",
    telemetry: "/tmp/session/telemetry",
  })),
  removeSessionDir: vi.fn(async () => {}),
}));

import { CodexAppServerAdapter } from "../app-server-adapter";
import { ensureSessionDir, removeSessionDir } from "../../../session-paths";

function makeAdapter(): CodexAppServerAdapter {
  const ctx: AgentAdapterContext = {
    projectRoot: "/tmp/project",
    mcpServers: [],
    sessionDirRoot: "/tmp/sessions",
    emit: {
      onSessionUpdate: vi.fn(),
      onPermissionRequest: vi.fn(),
      onQuestionRequest: vi.fn(),
      onAgentStderr: vi.fn(),
      onAgentExit: vi.fn(),
    },
  };
  return new CodexAppServerAdapter(ctx);
}

describe("Codex app-server canonical session identity", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    runtimeState.startThreadIds = [];
    runtimeState.resumeError = null;
    runtimeState.resumeCalls = [];
    vi.mocked(ensureSessionDir).mockClear();
    vi.mocked(removeSessionDir).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("publishes and stores the thread/start id for a new chat", async () => {
    runtimeState.startThreadIds = ["thread-from-codex"];
    const adapter = makeAdapter();

    const { session } = await adapter.newSession({ cwd: "/tmp/project" });

    expect(session.sessionId).toBe("thread-from-codex");
    expect(ensureSessionDir).toHaveBeenCalledWith("thread-from-codex");
    await expect(
      adapter.setMode({
        sessionId: "thread-from-codex",
        modeId: "auto-edit",
      }),
    ).resolves.toBeUndefined();

    await adapter.dispose();
    expect(removeSessionDir).toHaveBeenCalledWith("thread-from-codex");
  });

  it("rekeys a stale legacy id to the fresh replacement thread", async () => {
    runtimeState.startThreadIds = ["thread-replacement"];
    runtimeState.resumeError = new Error(
      "thread/resume failed: no rollout found for legacy-local-id",
    );
    const adapter = makeAdapter();

    const response = (await adapter.loadSession({
      sessionId: "legacy-local-id",
      cwd: "/tmp/project",
    })) as { resumedFresh?: boolean; sessionId?: string };

    expect(runtimeState.resumeCalls).toEqual(["legacy-local-id"]);
    expect(response).toMatchObject({
      resumedFresh: true,
      sessionId: "thread-replacement",
    });
    await expect(
      adapter.setMode({
        sessionId: "thread-replacement",
        modeId: "auto-edit",
      }),
    ).resolves.toBeUndefined();
    await expect(
      adapter.setMode({ sessionId: "legacy-local-id", modeId: "auto-edit" }),
    ).rejects.toThrow("unknown codex session");
  });
});

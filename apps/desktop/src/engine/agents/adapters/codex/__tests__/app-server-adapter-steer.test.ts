import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentAdapterContext, ContentBlock } from "../../../types";

const rt = vi.hoisted(() => ({
  handlers: new Map<string, Set<(params: unknown) => void>>(),
  requests: [] as Array<{
    method: string;
    params: Record<string, unknown>;
  }>,
  interruptCalls: [] as Array<{ threadId: string; turnId: string }>,
  resolveTurn: null as null | ((value: unknown) => void),
}));

vi.mock("../app-server", () => ({
  bootCodexAppServerRuntime: vi.fn(async () => ({
    initializeResponse: {
      userAgent: "codex_cli 0.146.0",
      codexHome: "/tmp",
      platformFamily: "unix",
      platformOs: "linux",
    },
    cliVersion: "0.146.0",
    binarySource: { source: "path", path: "codex" },
    child: { pid: 1234, killed: false },
    startThread: async () => ({
      threadId: "thread-steer",
      model: "gpt-5",
      approvalPolicy: "on-request",
      sandbox: { type: "workspaceWrite" },
      raw: {},
    }),
    resumeThread: async (params: { threadId: string }) => ({
      threadId: params.threadId,
      raw: {},
    }),
    runTurn: async (
      _params: unknown,
      options: { onTurnStarted?: (turnId: string) => void },
    ) => {
      options.onTurnStarted?.("turn-active");
      return new Promise<unknown>((resolve) => {
        rt.resolveTurn = resolve;
      });
    },
    interruptTurn: async (threadId: string, turnId: string) => {
      rt.interruptCalls.push({ threadId, turnId });
    },
    respondToPermission: vi.fn(),
    respondToUserInput: vi.fn(),
    onNotification: (method: string, handler: (params: unknown) => void) => {
      let handlers = rt.handlers.get(method);
      if (!handlers) {
        handlers = new Set();
        rt.handlers.set(method, handlers);
      }
      handlers.add(handler);
      return () => handlers?.delete(handler);
    },
    request: vi.fn(async (method: string, params: Record<string, unknown>) => {
      rt.requests.push({ method, params });
      if (method === "skills/list") return { data: [] };
      if (method === "turn/steer") return { turnId: "turn-active" };
      return {};
    }),
    dispose: vi.fn(async () => {}),
  })),
}));

vi.mock("../../../session-paths", () => ({
  ensureSessionDir: vi.fn(async () => ({
    root: "/tmp/s",
    env: "/tmp/s/env",
    log: "/tmp/s/log",
    telemetry: "/tmp/s/tel",
  })),
  removeSessionDir: vi.fn(async () => {}),
}));

import { CodexAppServerAdapter } from "../app-server-adapter";

const text = (value: string): ContentBlock[] => [
  { type: "text", text: value } as ContentBlock,
];

const tick = async (count = 8): Promise<void> => {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
};

function makeAdapter(): CodexAppServerAdapter {
  const ctx: AgentAdapterContext = {
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
  };
  return new CodexAppServerAdapter(ctx);
}

describe("CodexAppServerAdapter.steer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    rt.handlers.clear();
    rt.requests = [];
    rt.interruptCalls = [];
    rt.resolveTurn = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("injects into the active turn without interrupting or starting another", async () => {
    const adapter = makeAdapter();
    const { session } = await adapter.newSession({ cwd: "/tmp/proj" });
    const prompt = adapter.prompt({
      sessionId: session.sessionId,
      prompt: text("initial"),
    });
    await tick();

    await adapter.steer({
      sessionId: session.sessionId,
      prompt: text("mid-turn direction"),
    });

    expect(rt.requests).toContainEqual({
      method: "turn/steer",
      params: {
        threadId: "thread-steer",
        input: [
          { type: "text", text: "mid-turn direction", text_elements: [] },
        ],
        expectedTurnId: "turn-active",
      },
    });
    expect(rt.interruptCalls).toEqual([]);

    rt.resolveTurn?.({
      turnId: "turn-active",
      status: "completed",
      raw: {},
    });
    await prompt;
    await adapter.dispose();
  });
});

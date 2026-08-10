import { beforeEach, describe, expect, it, vi } from "vitest";

const rt = vi.hoisted(() => ({
  handlers: new Map<string, Set<(params: unknown) => void>>(),
  requests: [] as Array<{
    method: string;
    params: Record<string, unknown>;
  }>,
  fire(method: string, params: unknown): void {
    for (const handler of rt.handlers.get(method) ?? []) handler(params);
  },
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
      threadId: "thread-exact",
      model: "gpt-5",
      approvalPolicy: "on-request",
      sandbox: { type: "workspaceWrite" },
      raw: {},
    }),
    resumeThread: async (params: { threadId: string }) => ({
      threadId: params.threadId,
      raw: {},
    }),
    runTurn: vi.fn(),
    interruptTurn: vi.fn(),
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
      return {};
    }),
    dispose: vi.fn(async () => {}),
  })),
}));

vi.mock("../../session-paths", () => ({
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

const tick = async (count = 8): Promise<void> => {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
};

describe("Codex command execution", () => {
  beforeEach(() => {
    rt.handlers.clear();
    rt.requests = [];
  });

  it("never inventories ordinary terminals as background tasks", async () => {
    const emit = {
      onSessionUpdate: vi.fn(),
      onPermissionRequest: vi.fn(),
      onQuestionRequest: vi.fn(),
      onAgentStderr: vi.fn(),
      onAgentExit: vi.fn(),
    };
    const adapter = new CodexAppServerAdapter({
      projectRoot: "/tmp/proj",
      mcpServers: [],
      sessionDirRoot: "/tmp/sessions",
      emit,
    });
    await adapter.newSession({ cwd: "/tmp/proj" });
    await tick();

    rt.fire("item/started", {
      threadId: "thread-exact",
      item: {
        type: "commandExecution",
        id: "command-ordinary",
        command: "pnpm test:git",
      },
    });
    await tick();

    expect(
      rt.requests.some(({ method }) =>
        method.startsWith("thread/backgroundTerminals/"),
      ),
    ).toBe(false);
    expect(
      emit.onSessionUpdate.mock.calls.some(
        (call) =>
          call[1].update.sessionUpdate === "background_tasks_update" ||
          call[1].update.kind === "background_task",
      ),
    ).toBe(false);
    await adapter.dispose();
  });
});

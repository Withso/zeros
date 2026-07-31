import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentAdapterContext } from "../../../types";

type Deferred = {
  promise: Promise<unknown>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
};

const rt = vi.hoisted(() => ({
  handlers: new Map<string, Set<(params: unknown) => void>>(),
  listRequests: [] as Array<{
    params: Record<string, unknown>;
    deferred: Deferred;
  }>,
  requests: [] as Array<{
    method: string;
    params: Record<string, unknown>;
  }>,
  fire(method: string, params: unknown): void {
    for (const handler of rt.handlers.get(method) ?? []) handler(params);
  },
}));

function deferred(): Deferred {
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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
    resumeThread: async (p: { threadId: string }) => ({
      threadId: p.threadId,
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
      if (method === "thread/backgroundTerminals/list") {
        const request = { params, deferred: deferred() };
        rt.listRequests.push(request);
        return request.deferred.promise;
      }
      if (method === "thread/backgroundTerminals/terminate") {
        return { terminated: true };
      }
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
  removeSessionDir: vi.fn(async () => {}),
}));

import { CodexAppServerAdapter } from "../app-server-adapter";

const tick = async (count = 8): Promise<void> => {
  for (let i = 0; i < count; i++) await Promise.resolve();
};

describe("Codex background-terminal refresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    rt.handlers.clear();
    rt.listRequests = [];
    rt.requests = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is exact-thread, latest-request-wins, and retains confirmed data on failure", async () => {
    const emit = {
      onSessionUpdate: vi.fn(),
      onPermissionRequest: vi.fn(),
      onQuestionRequest: vi.fn(),
      onAgentStderr: vi.fn(),
      onAgentExit: vi.fn(),
    };
    const ctx: AgentAdapterContext = {
      projectRoot: "/tmp/proj",
      mcpServers: [],
      sessionDirRoot: "/tmp/sessions",
      emit,
    };
    const adapter = new CodexAppServerAdapter(ctx);
    const { session } = await adapter.newSession({ cwd: "/tmp/proj" });
    await tick();
    expect(rt.listRequests).toHaveLength(1);
    expect(rt.listRequests[0].params).toMatchObject({
      threadId: "thread-exact",
      cursor: null,
      limit: 100,
    });

    // Start a newer refresh before the initial read resolves.
    rt.fire("item/started", { threadId: "thread-exact" });
    await tick();
    expect(rt.listRequests).toHaveLength(2);
    rt.listRequests[1].deferred.resolve({
      data: [
        {
          itemId: "item-1",
          processId: "process-new",
          command: "pnpm test",
          cwd: "/tmp/proj",
          osPid: null,
          cpuPercent: null,
          rssKb: null,
        },
      ],
      nextCursor: null,
    });
    await tick();

    // The stale initial response must not erase the newer terminal.
    rt.listRequests[0].deferred.resolve({ data: [], nextCursor: null });
    await tick();
    const snapshots = emit.onSessionUpdate.mock.calls
      .map((call) => call[1])
      .filter(
        (notification) =>
          notification.update.sessionUpdate === "background_tasks_update",
      );
    expect(snapshots.at(-1)).toMatchObject({
      sessionId: session.sessionId,
      update: {
        tasks: [expect.objectContaining({ taskId: "process-new" })],
      },
    });

    // A failed revalidation retains the last exact-key snapshot and emits no
    // synthetic empty state.
    const beforeFailure = snapshots.length;
    rt.fire("item/completed", { threadId: "thread-exact" });
    await tick();
    rt.listRequests[2].deferred.reject(new Error("temporary disconnect"));
    await tick();
    const afterFailure = emit.onSessionUpdate.mock.calls
      .map((call) => call[1])
      .filter(
        (notification) =>
          notification.update.sessionUpdate === "background_tasks_update",
      );
    expect(afterFailure).toHaveLength(beforeFailure);
    expect(afterFailure.at(-1)?.update.tasks).toEqual([
      expect.objectContaining({ taskId: "process-new" }),
    ]);

    await adapter.dispose();
  });

  it("terminates the exact process and records the confirmed removal as stopped", async () => {
    const emit = {
      onSessionUpdate: vi.fn(),
      onPermissionRequest: vi.fn(),
      onQuestionRequest: vi.fn(),
      onAgentStderr: vi.fn(),
      onAgentExit: vi.fn(),
    };
    const ctx: AgentAdapterContext = {
      projectRoot: "/tmp/proj",
      mcpServers: [],
      sessionDirRoot: "/tmp/sessions",
      emit,
    };
    const adapter = new CodexAppServerAdapter(ctx);
    const { session } = await adapter.newSession({ cwd: "/tmp/proj" });
    await tick();
    rt.listRequests[0].deferred.resolve({
      data: [
        {
          itemId: "item-1",
          processId: "process-1",
          command: "pnpm test:git",
          cwd: "/tmp/proj",
          osPid: 101,
          cpuPercent: 12,
          rssKb: null,
        },
      ],
      nextCursor: null,
    });
    await tick();

    const stopping = adapter.stopBackgroundTask({
      sessionId: session.sessionId,
      taskId: "process-1",
    });
    await tick();
    expect(rt.requests).toContainEqual({
      method: "thread/backgroundTerminals/terminate",
      params: { threadId: "thread-exact", processId: "process-1" },
    });
    expect(rt.listRequests).toHaveLength(2);
    rt.listRequests[1].deferred.resolve({ data: [], nextCursor: null });
    await stopping;

    const notifications = emit.onSessionUpdate.mock.calls.map(
      (call) => call[1],
    );
    expect(notifications.at(-2)).toMatchObject({
      sessionId: session.sessionId,
      update: { sessionUpdate: "background_tasks_update", tasks: [] },
    });
    expect(notifications.at(-1)).toMatchObject({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "tool_call",
        kind: "background_task",
        title: "Background Task",
        rawInput: {
          taskId: "process-1",
          name: "pnpm test:git",
          command: "pnpm test:git",
        },
        rawOutput: { status: "stopped" },
      },
    });
    await adapter.dispose();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentFailureError, type AgentAdapterContext } from "../../../types";

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
  terminateError: null as Error | null,
  terminateResult: true,
  descendantThreads: [] as Array<Record<string, unknown>>,
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
        if (rt.terminateError) throw rt.terminateError;
        return { terminated: rt.terminateResult };
      }
      if (method === "thread/list") {
        return {
          data: rt.descendantThreads,
          nextCursor: null,
          backwardsCursor: null,
        };
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
    rt.terminateError = null;
    rt.terminateResult = true;
    rt.descendantThreads = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is exact-thread, coalesces lifecycle bursts, and retains confirmed data on failure", async () => {
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

    // Non-command items cannot change a background-terminal list, so they
    // must not invalidate it. A different thread on this dedicated runtime is
    // a collaboration descendant and is covered separately below.
    rt.fire("item/started", {
      threadId: "thread-exact",
      item: { type: "agentMessage" },
    });

    // A streamed command can emit a burst of lifecycle beats while the
    // initial exact-thread read is still in flight. Share that read and run
    // at most one trailing refresh; never launch overlapping list RPCs.
    for (let index = 0; index < 20; index += 1) {
      rt.fire(index % 2 === 0 ? "item/started" : "item/completed", {
        threadId: "thread-exact",
        item: { type: "commandExecution", id: `command-${index}` },
      });
    }
    await tick();
    expect(rt.listRequests).toHaveLength(1);

    // The invalidation makes this response stale. It must not publish a
    // transient empty snapshot before the single trailing read settles.
    rt.listRequests[0].deferred.resolve({ data: [], nextCursor: null });
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
    rt.fire("item/completed", {
      threadId: "thread-exact",
      item: { type: "commandExecution", id: "command-final" },
    });
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

  it("does not publish an identical successful refresh twice", async () => {
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
    const terminal = {
      itemId: "item-stable",
      processId: "process-stable",
      command: "pnpm test",
      cwd: "/tmp/proj",
      osPid: 101,
      cpuPercent: null,
      rssKb: null,
    };
    rt.listRequests[0].deferred.resolve({
      data: [terminal],
      nextCursor: null,
    });
    await tick();
    const before = emit.onSessionUpdate.mock.calls.filter(
      (call) => call[1].update.sessionUpdate === "background_tasks_update",
    ).length;

    rt.fire("item/completed", {
      threadId: "thread-exact",
      item: { type: "commandExecution", id: "item-stable" },
    });
    await tick();
    rt.listRequests[1].deferred.resolve({
      data: [terminal],
      nextCursor: null,
    });
    await tick();

    expect(
      emit.onSessionUpdate.mock.calls.filter(
        (call) => call[1].update.sessionUpdate === "background_tasks_update",
      ),
    ).toHaveLength(before);
    await adapter.dispose();
  });

  it("tracks and stops a terminal owned by a collaboration subthread", async () => {
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
    const { session } = await adapter.newSession({ cwd: "/tmp/proj" });
    await tick();
    rt.listRequests[0].deferred.resolve({ data: [], nextCursor: null });
    await tick();

    rt.fire("item/started", {
      threadId: "thread-child",
      turnId: "turn-child",
      item: {
        type: "commandExecution",
        id: "item-child",
        command: "pnpm test:backend",
      },
    });
    await tick();
    const childRequest = rt.listRequests.find(
      (request) => request.params.threadId === "thread-child",
    );
    expect(childRequest).toBeDefined();
    for (const request of rt.listRequests.slice(1)) {
      request.deferred.resolve({
        data:
          request.params.threadId === "thread-child"
            ? [
                {
                  itemId: "item-child",
                  processId: "process-child",
                  command: "pnpm test:backend",
                  cwd: "/tmp/proj",
                  osPid: 202,
                  cpuPercent: null,
                  rssKb: null,
                },
              ]
            : [],
        nextCursor: null,
      });
    }
    await tick();

    const snapshot = emit.onSessionUpdate.mock.calls
      .map((call) => call[1])
      .filter(
        (notification) =>
          notification.update.sessionUpdate === "background_tasks_update",
      )
      .at(-1);
    expect(snapshot).toMatchObject({
      sessionId: session.sessionId,
      update: {
        tasks: [
          expect.objectContaining({
            name: "pnpm test:backend",
            taskType: "codex_terminal",
          }),
        ],
      },
    });
    const taskId = snapshot!.update.tasks[0].taskId;
    const requestsBeforeStop = rt.listRequests.length;
    const stopping = adapter.stopBackgroundTask({
      sessionId: session.sessionId,
      taskId,
    });
    await tick();
    expect(rt.requests).toContainEqual({
      method: "thread/backgroundTerminals/terminate",
      params: { threadId: "thread-child", processId: "process-child" },
    });
    for (const request of rt.listRequests.slice(requestsBeforeStop)) {
      request.deferred.resolve({ data: [], nextCursor: null });
    }
    await stopping;
    await adapter.dispose();
  });

  it("does not let a full descendant cache hide a newly active command thread", async () => {
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
    const { session } = await adapter.newSession({ cwd: "/tmp/proj" });
    await tick();
    const state = (
      adapter as unknown as {
        sessions: Map<
          string,
          {
            backgroundThreadIds: Set<string>;
          }
        >;
      }
    ).sessions.get(session.sessionId)!;
    for (let index = 0; index < 99; index += 1) {
      state.backgroundThreadIds.add(`thread-idle-${index}`);
    }

    rt.fire("item/started", {
      threadId: "thread-new-active",
      turnId: "turn-new-active",
      item: { type: "commandExecution", id: "item-new-active" },
    });
    rt.listRequests[0].deferred.resolve({ data: [], nextCursor: null });
    await tick();
    const requestedNewThread = rt.listRequests.some(
      (request) => request.params.threadId === "thread-new-active",
    );
    for (const request of rt.listRequests.slice(1)) {
      request.deferred.resolve({ data: [], nextCursor: null });
    }
    await tick();
    await adapter.dispose();

    expect(requestedNewThread).toBe(true);
  });

  it("settles a child task when the server authoritatively unloads its thread", async () => {
    rt.descendantThreads = [
      {
        id: "thread-unloaded-child",
        status: { type: "idle" },
      },
    ];
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
    for (const request of rt.listRequests) {
      request.deferred.resolve({
        data:
          request.params.threadId === "thread-unloaded-child"
            ? [
                {
                  itemId: "item-unloaded-child",
                  processId: "process-unloaded-child",
                  command: "npm run watch",
                  cwd: "/tmp/proj",
                  osPid: 404,
                  cpuPercent: null,
                  rssKb: null,
                },
              ]
            : [],
        nextCursor: null,
      });
    }
    await tick();

    rt.fire("thread/status/changed", {
      threadId: "thread-unloaded-child",
      status: { type: "notLoaded" },
    });
    await tick();
    const settledBeforeAnotherList = emit.onSessionUpdate.mock.calls.some(
      (call) =>
        call[1].update.sessionUpdate === "tool_call" &&
        call[1].update.kind === "background_task" &&
        call[1].update.rawInput?.name === "npm run watch",
    );
    for (const request of rt.listRequests.slice(2)) {
      request.deferred.resolve({ data: [], nextCursor: null });
    }
    await tick();
    await adapter.dispose();

    expect(settledBeforeAnotherList).toBe(true);
  });

  it("retains one child exact-key snapshot when a sibling refresh fails", async () => {
    rt.descendantThreads = [
      {
        id: "thread-retained-child",
        status: { type: "idle" },
      },
    ];
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
    for (const request of rt.listRequests) {
      request.deferred.resolve({
        data:
          request.params.threadId === "thread-retained-child"
            ? [
                {
                  itemId: "item-retained-child",
                  processId: "process-retained-child",
                  command: "pnpm dev",
                  cwd: "/tmp/proj",
                  osPid: 505,
                  cpuPercent: null,
                  rssKb: null,
                },
              ]
            : [],
        nextCursor: null,
      });
    }
    await tick();

    rt.fire("item/started", {
      threadId: "thread-exact",
      turnId: "turn-parent",
      item: { type: "commandExecution", id: "item-parent" },
    });
    await tick();
    const revalidation = rt.listRequests.slice(2);
    revalidation
      .find((request) => request.params.threadId === "thread-exact")!
      .deferred.resolve({
        data: [
          {
            itemId: "item-parent",
            processId: "process-parent",
            command: "pnpm lint",
            cwd: "/tmp/proj",
            osPid: 606,
            cpuPercent: null,
            rssKb: null,
          },
        ],
        nextCursor: null,
      });
    revalidation
      .find((request) => request.params.threadId === "thread-retained-child")!
      .deferred.reject(new Error("child list temporarily unavailable"));
    await tick();

    const tasks = emit.onSessionUpdate.mock.calls
      .map((call) => call[1])
      .filter(
        (notification) =>
          notification.update.sessionUpdate === "background_tasks_update",
      )
      .at(-1)?.update.tasks;
    expect(tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "pnpm dev" }),
        expect.objectContaining({ name: "pnpm lint" }),
      ]),
    );
    await adapter.dispose();
  });

  it("reserves aggregate capacity for a child when the parent is saturated", async () => {
    rt.descendantThreads = [
      {
        id: "thread-fair-child",
        status: { type: "idle" },
      },
    ];
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
    const { session } = await adapter.newSession({ cwd: "/tmp/proj" });
    await tick();
    for (const request of rt.listRequests) {
      const child = request.params.threadId === "thread-fair-child";
      request.deferred.resolve({
        data: child
          ? [
              {
                itemId: "item-fair-child",
                processId: "process-fair-child",
                command: "pnpm test:backend",
                cwd: "/tmp/proj",
                osPid: 707,
                cpuPercent: null,
                rssKb: null,
              },
            ]
          : Array.from({ length: 100 }, (_, index) => ({
              itemId: `item-parent-${index}`,
              processId: `process-parent-${index}`,
              command: `parent command ${index}`,
              cwd: "/tmp/proj",
              osPid: index,
              cpuPercent: null,
              rssKb: null,
            })),
        nextCursor: null,
      });
    }
    await tick();

    const tasks = emit.onSessionUpdate.mock.calls
      .map((call) => call[1])
      .filter(
        (notification) =>
          notification.update.sessionUpdate === "background_tasks_update",
      )
      .at(-1)?.update.tasks;
    expect(tasks).toHaveLength(100);
    expect(tasks).toContainEqual(
      expect.objectContaining({ name: "pnpm test:backend" }),
    );
    const authoritativeTaskCount = (
      adapter as unknown as {
        sessions: Map<string, { backgroundTasks: Map<string, unknown> }>;
      }
    ).sessions.get(session.sessionId)!.backgroundTasks.size;
    expect(authoritativeTaskCount).toBe(101);
    await adapter.dispose();
  });

  it("discovers a loaded descendant terminal when resuming before new item events", async () => {
    rt.descendantThreads = [
      {
        id: "thread-resumed-child",
        status: { type: "idle" },
      },
    ];
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
    expect(
      rt.listRequests.some(
        (request) => request.params.threadId === "thread-resumed-child",
      ),
    ).toBe(true);
    for (const request of rt.listRequests) {
      request.deferred.resolve({
        data:
          request.params.threadId === "thread-resumed-child"
            ? [
                {
                  itemId: "item-resumed-child",
                  processId: "process-resumed-child",
                  command: "npm run dev",
                  cwd: "/tmp/proj",
                  osPid: 303,
                  cpuPercent: null,
                  rssKb: null,
                },
              ]
            : [],
        nextCursor: null,
      });
    }
    await tick();
    expect(
      emit.onSessionUpdate.mock.calls
        .map((call) => call[1])
        .filter(
          (notification) =>
            notification.update.sessionUpdate === "background_tasks_update",
        )
        .at(-1),
    ).toMatchObject({
      update: {
        tasks: [expect.objectContaining({ name: "npm run dev" })],
      },
    });
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

  it("accepts authoritative removal when terminate reports an ambiguous transport error", async () => {
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
          cpuPercent: null,
          rssKb: null,
        },
      ],
      nextCursor: null,
    });
    await tick();

    rt.terminateError = new Error("connection closed after write");
    const stopping = adapter.stopBackgroundTask({
      sessionId: session.sessionId,
      taskId: "process-1",
    });
    const stoppingOutcome = stopping.then(
      () => null,
      (error: unknown) => error,
    );
    await tick();
    expect(rt.listRequests).toHaveLength(2);
    rt.listRequests[1].deferred.resolve({ data: [], nextCursor: null });
    await expect(stoppingOutcome).resolves.toBeNull();

    const settled = emit.onSessionUpdate.mock.calls
      .map((call) => call[1])
      .find(
        (notification) =>
          notification.update.sessionUpdate === "tool_call" &&
          notification.update.kind === "background_task",
      );
    expect(settled).toMatchObject({
      update: { rawOutput: { status: "stopped" } },
    });
    await adapter.dispose();
  });

  it("does not label a natural exit as stopped when termination is refused", async () => {
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
    const terminal = {
      itemId: "item-1",
      processId: "process-1",
      command: "pnpm test:git",
      cwd: "/tmp/proj",
      osPid: 101,
      cpuPercent: null,
      rssKb: null,
    };
    rt.listRequests[0].deferred.resolve({ data: [terminal], nextCursor: null });
    await tick();

    rt.terminateResult = false;
    const stopping = adapter.stopBackgroundTask({
      sessionId: session.sessionId,
      taskId: "process-1",
    });
    const stoppingOutcome = stopping.then(
      () => null,
      (error: unknown) => error,
    );
    await tick();
    rt.listRequests[1].deferred.resolve({
      data: [terminal],
      nextCursor: null,
    });
    const failure = await stoppingOutcome;
    expect(failure).toBeInstanceOf(AgentFailureError);
    expect((failure as AgentFailureError).failure).toMatchObject({
      kind: "protocol-error",
      stage: "stopBackgroundTask",
      agentId: "codex",
    });

    rt.fire("item/completed", {
      threadId: "thread-exact",
      item: { type: "commandExecution", id: "item-1" },
    });
    await tick();
    rt.listRequests[2].deferred.resolve({ data: [], nextCursor: null });
    await tick();
    const settled = emit.onSessionUpdate.mock.calls
      .map((call) => call[1])
      .find(
        (notification) =>
          notification.update.sessionUpdate === "tool_call" &&
          notification.update.kind === "background_task",
      );
    expect(settled).toMatchObject({
      update: { rawOutput: { status: "finished" } },
    });
    await adapter.dispose();
  });
});

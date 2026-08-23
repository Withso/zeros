import { beforeEach, describe, expect, it, vi } from "vitest";

const rt = vi.hoisted(() => ({
  handlers: new Map<string, Set<(params: unknown) => void>>(),
  requests: [] as Array<{
    method: string;
    params: Record<string, unknown>;
  }>,
  terminalsByThread: new Map<string, Array<Record<string, unknown>>>(),
  nextListResponse: null as Promise<unknown> | null,
  nextThreadListResponse: null as Promise<unknown> | null,
  fire(method: string, params: unknown): void {
    for (const handler of rt.handlers.get(method) ?? []) handler(params);
  },
}));

vi.mock("../app-server", () => ({
  bootCodexAppServerRuntime: vi.fn(async () => {
    const request = vi.fn(
      async (method: string, params: Record<string, unknown>) => {
        rt.requests.push({ method, params });
        if (method === "skills/list") return { data: [] };
        if (method === "thread/backgroundTerminals/list") {
          if (rt.nextListResponse) {
            const response = rt.nextListResponse;
            rt.nextListResponse = null;
            return response;
          }
          return {
            data: rt.terminalsByThread.get(String(params.threadId)) ?? [],
            nextCursor: null,
          };
        }
        if (method === "thread/list" && rt.nextThreadListResponse) {
          const response = rt.nextThreadListResponse;
          rt.nextThreadListResponse = null;
          return response;
        }
        if (method === "thread/backgroundTerminals/terminate") {
          const threadId = String(params.threadId);
          const processId = String(params.processId);
          const terminals = rt.terminalsByThread.get(threadId) ?? [];
          rt.terminalsByThread.set(
            threadId,
            terminals.filter((terminal) => terminal.processId !== processId),
          );
          return { terminated: true };
        }
        return {};
      },
    );
    return {
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
      request,
      requestTyped: request,
      dispose: vi.fn(async () => {}),
    };
  }),
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
    rt.terminalsByThread.clear();
    rt.nextListResponse = null;
    rt.nextThreadListResponse = null;
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

  it("lists after turn settlement and stops only the mapped native process", async () => {
    rt.terminalsByThread.set("thread-exact", [
      {
        itemId: "item-background",
        processId: "process-exact",
        command: "pnpm test:git",
        cwd: "/tmp/proj",
        osPid: 987,
        cpuPercent: 1,
        rssKb: 2n,
      },
    ]);
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
    const created = await adapter.newSession({ cwd: "/tmp/proj" });

    rt.fire("turn/completed", {
      threadId: "thread-exact",
      turn: { id: "turn-1", status: "completed" },
    });
    await vi.waitFor(() => {
      expect(
        emit.onSessionUpdate.mock.calls.some(
          (call) =>
            call[1].update.sessionUpdate === "background_tasks_update" &&
            call[1].update.tasks.length === 1,
        ),
      ).toBe(true);
    });
    const update = emit.onSessionUpdate.mock.calls
      .map((call) => call[1].update)
      .find(
        (candidate) =>
          candidate.sessionUpdate === "background_tasks_update" &&
          candidate.tasks.length === 1,
      );
    const taskId = update.tasks[0].taskId as string;
    expect(taskId).not.toBe("process-exact");
    expect(decodeURIComponent(taskId)).not.toContain("process-exact");
    expect(decodeURIComponent(taskId)).not.toContain("thread-exact");
    expect(update.waiting).toBe(true);

    await adapter.stopBackgroundTask({
      sessionId: created.session.sessionId,
      taskId,
    });

    expect(rt.requests).toContainEqual({
      method: "thread/backgroundTerminals/terminate",
      params: {
        threadId: "thread-exact",
        processId: "process-exact",
      },
    });
    expect(
      rt.requests.some(
        ({ method }) => method === "thread/backgroundTerminals/clean",
      ),
    ).toBe(false);
    await vi.waitFor(() => {
      const updates = emit.onSessionUpdate.mock.calls
        .map((call) => call[1].update)
        .filter(
          (candidate) => candidate.sessionUpdate === "background_tasks_update",
        );
      expect(updates.at(-1)?.tasks).toEqual([]);
    });
    await adapter.dispose();
  });

  it("coalesces repeated Stop clicks for the same live terminal", async () => {
    rt.terminalsByThread.set("thread-exact", [
      {
        itemId: "item-background",
        processId: "process-exact",
        command: "pnpm test:git",
        cwd: "/tmp/proj",
        osPid: 987,
        cpuPercent: 1,
        rssKb: 2n,
      },
    ]);
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
    const created = await adapter.newSession({ cwd: "/tmp/proj" });
    rt.fire("turn/completed", {
      threadId: "thread-exact",
      turn: { id: "turn-1", status: "completed" },
    });
    await vi.waitFor(() => {
      expect(
        emit.onSessionUpdate.mock.calls.some(
          (call) => call[1].update.tasks?.length === 1,
        ),
      ).toBe(true);
    });
    const taskId = emit.onSessionUpdate.mock.calls
      .map((call) => call[1].update)
      .find((update) => update.tasks?.length === 1).tasks[0].taskId as string;

    await Promise.all([
      adapter.stopBackgroundTask({
        sessionId: created.session.sessionId,
        taskId,
      }),
      adapter.stopBackgroundTask({
        sessionId: created.session.sessionId,
        taskId,
      }),
    ]);

    expect(
      rt.requests.filter(
        ({ method }) => method === "thread/backgroundTerminals/terminate",
      ),
    ).toHaveLength(1);
    await adapter.dispose();
  });

  it("does not let a stale list resurrect a terminal after Stop", async () => {
    const terminal = {
      itemId: "item-background",
      processId: "process-exact",
      command: "pnpm test:git",
      cwd: "/tmp/proj",
      osPid: 987,
      cpuPercent: 1,
      rssKb: 2n,
    };
    rt.terminalsByThread.set("thread-exact", [terminal]);
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
    const created = await adapter.newSession({ cwd: "/tmp/proj" });
    rt.fire("turn/completed", {
      threadId: "thread-exact",
      turn: { id: "turn-1", status: "completed" },
    });
    await vi.waitFor(() => {
      expect(
        emit.onSessionUpdate.mock.calls.some(
          (call) => call[1].update.tasks?.length === 1,
        ),
      ).toBe(true);
    });
    const taskId = emit.onSessionUpdate.mock.calls
      .map((call) => call[1].update)
      .find((update) => update.tasks?.length === 1).tasks[0].taskId as string;

    let releaseStale!: (value: unknown) => void;
    rt.nextListResponse = new Promise((resolve) => {
      releaseStale = resolve;
    });
    rt.fire("turn/completed", {
      threadId: "thread-exact",
      turn: { id: "turn-2", status: "completed" },
    });
    await vi.waitFor(() => {
      expect(
        rt.requests.filter(
          ({ method }) => method === "thread/backgroundTerminals/list",
        ).length,
      ).toBeGreaterThanOrEqual(2);
    });

    await adapter.stopBackgroundTask({
      sessionId: created.session.sessionId,
      taskId,
    });
    releaseStale({ data: [terminal], nextCursor: null });
    await tick();

    const snapshots = emit.onSessionUpdate.mock.calls
      .map((call) => call[1].update)
      .filter((update) => update.sessionUpdate === "background_tasks_update");
    expect(snapshots.at(-1)?.tasks).toEqual([]);
    await adapter.dispose();
  });

  it("revalidates a descendant discovered after a newer parent refresh", async () => {
    rt.terminalsByThread.set("thread-child", [
      {
        itemId: "item-child-background",
        processId: "process-child",
        command: "pnpm child:test",
        cwd: "/tmp/proj",
        osPid: 988,
        cpuPercent: 1,
        rssKb: 2n,
      },
    ]);
    let releaseDiscovery!: (value: unknown) => void;
    rt.nextThreadListResponse = new Promise((resolve) => {
      releaseDiscovery = resolve;
    });
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

    await adapter.loadSession({
      executionId: "execution-resumed",
      providerBinding: {
        version: 1,
        providerId: "codex",
        kind: "native",
        resumeId: "thread-exact",
      },
      cwd: "/tmp/proj",
    });
    await vi.waitFor(() => {
      expect(rt.requests.some(({ method }) => method === "thread/list")).toBe(
        true,
      );
    });

    // A parent turn settles while resumed-child discovery is still in flight.
    // That newer refresh cannot know about thread-child yet.
    rt.fire("turn/completed", {
      threadId: "thread-exact",
      turn: { id: "turn-parent", status: "completed" },
    });
    await tick();
    releaseDiscovery({
      data: [
        {
          id: "thread-child",
          status: { type: "loaded" },
        },
      ],
      nextCursor: null,
    });

    await vi.waitFor(() => {
      expect(
        emit.onSessionUpdate.mock.calls.some(
          (call) =>
            call[1].update.sessionUpdate === "background_tasks_update" &&
            call[1].update.tasks.some(
              (task: { name?: string }) => task.name === "pnpm child:test",
            ),
        ),
      ).toBe(true);
    });
    await adapter.dispose();
  });

  it("drops terminal rows when their loaded descendant thread closes", async () => {
    rt.terminalsByThread.set("thread-child", [
      {
        itemId: "item-child-background",
        processId: "process-child",
        command: "pnpm child:test",
        cwd: "/tmp/proj",
        osPid: 988,
        cpuPercent: 1,
        rssKb: 2n,
      },
    ]);
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

    rt.fire("turn/started", {
      threadId: "thread-child",
      turn: { id: "turn-child", status: "inProgress" },
    });
    rt.fire("turn/completed", {
      threadId: "thread-child",
      turn: { id: "turn-child", status: "completed" },
    });
    await vi.waitFor(() => {
      expect(
        emit.onSessionUpdate.mock.calls.some(
          (call) => call[1].update.tasks?.length === 1,
        ),
      ).toBe(true);
    });

    rt.fire("thread/closed", { threadId: "thread-child" });

    await vi.waitFor(() => {
      const snapshots = emit.onSessionUpdate.mock.calls
        .map((call) => call[1].update)
        .filter((update) => update.sessionUpdate === "background_tasks_update");
      expect(snapshots.at(-1)?.tasks).toEqual([]);
    });
    await adapter.dispose();
  });

  it("bounds the combined task snapshot across parent and descendant threads", async () => {
    const terminals = (prefix: string) =>
      Array.from({ length: 60 }, (_, index) => ({
        itemId: `${prefix}-item-${index}`,
        processId: `${prefix}-process-${index}`,
        command: `${prefix} task ${index}`,
        cwd: "/tmp/proj",
        osPid: 1_000 + index,
        cpuPercent: 1,
        rssKb: 2n,
      }));
    rt.terminalsByThread.set("thread-exact", terminals("parent"));
    rt.terminalsByThread.set("thread-child", terminals("child"));
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

    rt.fire("turn/started", {
      threadId: "thread-child",
      turn: { id: "turn-child", status: "inProgress" },
    });
    rt.fire("turn/completed", {
      threadId: "thread-child",
      turn: { id: "turn-child", status: "completed" },
    });

    await vi.waitFor(() => {
      const snapshots = emit.onSessionUpdate.mock.calls
        .map((call) => call[1].update)
        .filter((update) => update.sessionUpdate === "background_tasks_update");
      expect(snapshots.at(-1)?.tasks).toHaveLength(100);
    });
    await adapter.dispose();
  });

  it("revalidates a visible task until the native process exits", async () => {
    vi.useFakeTimers();
    try {
      rt.terminalsByThread.set("thread-exact", [
        {
          itemId: "item-background",
          processId: "process-exact",
          command: "pnpm test:git",
          cwd: "/tmp/proj",
          osPid: 987,
          cpuPercent: 1,
          rssKb: 2n,
        },
      ]);
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
      rt.fire("turn/completed", {
        threadId: "thread-exact",
        turn: { id: "turn-1", status: "completed" },
      });
      await tick(20);
      const backgroundSnapshots = () =>
        emit.onSessionUpdate.mock.calls
          .map((call) => call[1].update)
          .filter(
            (update) => update.sessionUpdate === "background_tasks_update",
          );
      expect(backgroundSnapshots().at(-1)?.tasks).toHaveLength(1);

      rt.terminalsByThread.set("thread-exact", []);
      await vi.advanceTimersByTimeAsync(30_000);
      await tick();

      expect(backgroundSnapshots().at(-1)?.tasks).toEqual([]);
      await adapter.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an unowned task id without forwarding it as a process id", async () => {
    const adapter = new CodexAppServerAdapter({
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
    });
    const created = await adapter.newSession({ cwd: "/tmp/proj" });

    await expect(
      adapter.stopBackgroundTask({
        sessionId: created.session.sessionId,
        taskId: "process-from-another-session",
      }),
    ).rejects.toMatchObject({
      failure: { kind: "protocol-error", stage: "stopBackgroundTask" },
    });
    expect(
      rt.requests.some(
        ({ method }) => method === "thread/backgroundTerminals/terminate",
      ),
    ).toBe(false);
    await adapter.dispose();
  });
});

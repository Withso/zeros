import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentAdapterContext } from "../../../types";
import type { ProviderBinding } from "@zeros/protocol/identities";

type Handler = (params: unknown) => void;

const rt = vi.hoisted(() => ({
  bootCount: 0,
  handlers: [] as Array<Map<string, Set<Handler>>>,
  requests: [] as Array<{ runtime: number; method: string; params: unknown }>,
  resumeParams: [] as Array<Record<string, unknown>>,
  startParams: [] as Array<Record<string, unknown>>,
  turnParams: [] as Array<Record<string, unknown>>,
  disposeCalls: [] as number[],
  bootOptions: [] as Array<Record<string, unknown>>,
  bootError: null as Error | null,
  startError: null as Error | null,
  /** Merged `config/read` payload reported by each booted runtime, by boot order. */
  configByRuntime: [] as Array<Record<string, unknown> | undefined>,
  /** `config/read { includeLayers: true }` layers, by boot order. */
  layersByRuntime: [] as Array<unknown[] | undefined>,
}));

const sessionPaths = vi.hoisted(() => ({
  remove: vi.fn(async () => {}),
}));

function forkThread() {
  return {
    id: "thread-fork",
    sessionId: "session-from-fork-response",
    forkedFromId: "thread-source",
    ephemeral: false,
    turns: [],
  };
}

vi.mock("../app-server", () => ({
  bootCodexAppServerRuntime: vi.fn(async (options: Record<string, unknown>) => {
    rt.bootOptions.push(options);
    if (rt.bootError) throw rt.bootError;
    const runtime = rt.bootCount++;
    const handlers = new Map<string, Set<Handler>>();
    rt.handlers[runtime] = handlers;
    const requestTyped = vi.fn(async (method: string, params: unknown) => {
      rt.requests.push({ runtime, method, params });
      if (method === "config/read")
        return {
          config: rt.configByRuntime[runtime] ?? {},
          ...((params as { includeLayers?: boolean })?.includeLayers && rt.layersByRuntime[runtime]
            ? { layers: rt.layersByRuntime[runtime] } : {}),
        };
      if (method === "model/list" || method === "skills/list") {
        return { data: [] };
      }
      if (method === "thread/fork") {
        return {
          thread: forkThread(),
          model: "gpt-5",
          modelProvider: "openai",
          cwd: "/tmp/proj",
        };
      }
      return {};
    });
    const onNotification = (method: string, handler: Handler) => {
      let listeners = handlers.get(method);
      if (!listeners) {
        listeners = new Set();
        handlers.set(method, listeners);
      }
      listeners.add(handler);
      return () => listeners?.delete(handler);
    };
    return {
      initializeResponse: {
        userAgent: "codex_cli 0.146.0",
        codexHome: "/tmp",
        platformFamily: "unix",
        platformOs: "linux",
      },
      cliVersion: "0.146.0",
      binarySource: { source: "path", path: "codex" },
      child: { pid: 4000 + runtime, killed: false },
      startThread: async (params: Record<string, unknown>) => {
        rt.startParams.push(params);
        if (rt.startError) throw rt.startError;
        return {
          threadId: "thread-source",
          providerSessionId: "session-source",
          gitInfo: {
            sha: "provider-sha",
            branch: "provider",
            originUrl: null,
          },
          model: "gpt-5",
          approvalPolicy: "on-request",
          sandbox: { type: "workspaceWrite" },
          raw: {},
        };
      },
      resumeThread: async (params: Record<string, unknown>) => {
        rt.resumeParams.push(params);
        return {
          threadId: String(params.threadId),
          providerSessionId: "session-source",
          gitInfo: { sha: "provider-sha", branch: "provider", originUrl: null },
          model: "gpt-5",
          raw: {},
        };
      },
      runTurn: async (params: Record<string, unknown>) => {
        rt.turnParams.push(params);
        return { turnId: "turn-1", status: "completed", raw: {} };
      },
      interruptTurn: async () => {},
      respondToPermission: vi.fn(),
      respondToUserInput: vi.fn(),
      onNotification,
      onNotificationTyped: onNotification,
      request: requestTyped,
      requestTyped,
      dispose: vi.fn(async () => {
        rt.disposeCalls.push(runtime);
      }),
    };
  }),
}));

vi.mock("../../../session-paths", () => ({
  ensureSessionDir: vi.fn(async () => ({
    root: "/tmp/s",
    env: "/tmp/s/env",
    log: "/tmp/s/log",
    telemetry: "/tmp/s/tel",
  })),
  writeSessionMeta: vi.fn(async () => {}),
  removeSessionDir: sessionPaths.remove,
}));

import { CodexAppServerAdapter } from "../app-server-adapter";

function makeAdapter() {
  const onSessionUpdate = vi.fn();
  const onAgentStderr = vi.fn();
  const onAgentExit = vi.fn();
  const ctx = {
    projectRoot: "/tmp/proj",
    mcpServers: [],
    sessionDirRoot: "/tmp/sessions",
    emit: {
      onSessionUpdate,
      onPermissionRequest: vi.fn(),
      onQuestionRequest: vi.fn(),
      onAgentStderr,
      onAgentExit,
    },
  } as unknown as AgentAdapterContext;
  return {
    adapter: new CodexAppServerAdapter(ctx),
    onSessionUpdate,
    onAgentStderr,
    onAgentExit,
  };
}

const sourceBinding: ProviderBinding = {
  version: 1,
  providerId: "codex",
  kind: "native",
  resumeId: "thread-source",
  scopeId: "session-source",
};

describe("Codex opaque provider bindings", () => {
  beforeEach(() => {
    rt.bootCount = 0;
    rt.handlers = [];
    rt.requests = [];
    rt.resumeParams = [];
    rt.startParams = [];
    rt.turnParams = [];
    rt.disposeCalls = [];
    rt.bootOptions = [];
    rt.bootError = null;
    rt.startError = null;
    rt.configByRuntime = [];
    rt.layersByRuntime = [];
    sessionPaths.remove.mockClear();
  });

  // Codex uses Zeros computer use and the Zeros browser like every agent.
  const BUILT_IN_PLUGINS_OFF = {
    "plugins.browser@openai-bundled.enabled": false,
    "plugins.chrome@openai-bundled.enabled": false,
    "plugins.computer-use@openai-bundled.enabled": false,
    "plugins.unified-computer-use@openai-bundled.enabled": false,
  };

  it("turns every built-in browser and computer-use plugin off on new and resumed threads", async () => {
    const { adapter } = makeAdapter();

    await adapter.newSession({ executionId: "execution-new", cwd: "/tmp/proj" });
    await adapter.loadSession({
      executionId: "execution-resume",
      providerBinding: sourceBinding,
      cwd: "/tmp/proj",
    });

    expect(rt.startParams.at(-1)).toMatchObject({ config: BUILT_IN_PLUGINS_OFF });
    expect(rt.resumeParams).toContainEqual(
      expect.objectContaining({
        threadId: "thread-source",
        config: expect.objectContaining(BUILT_IN_PLUGINS_OFF),
      }),
    );
    // Zeros injects no runtime of its own for them.
    expect(JSON.stringify(rt.bootOptions)).not.toContain("node_repl");
    await adapter.dispose();
  });

  it("retires the runtime and session directory when thread startup fails", async () => {
    rt.startError = new Error("thread start failed");
    const { adapter } = makeAdapter();

    await expect(
      adapter.newSession({
        executionId: "execution-browser-thread-failure",
        cwd: "/tmp/proj",
      }),
    ).rejects.toThrow(/thread start failed/i);

    expect(rt.disposeCalls).toEqual([0]);
    expect(sessionPaths.remove).toHaveBeenCalledWith(
      "execution-browser-thread-failure",
    );
    await adapter.dispose();
  });

  it("forks through typed app-server dispatch and reads the returned scope", async () => {
    const { adapter } = makeAdapter();
    await adapter.newSession({
      executionId: "execution-source",
      cwd: "/tmp/proj",
    });

    await expect(
      adapter.forkProviderBinding!({
        providerBinding: sourceBinding,
        cwd: "/tmp/proj",
        systemInstruction: "Zeros-owned workspace orientation",
      }),
    ).resolves.toEqual({
      providerBinding: {
        version: 1,
        providerId: "codex",
        kind: "native",
        resumeId: "thread-fork",
        scopeId: "session-from-fork-response",
      },
    });
    expect(rt.bootCount).toBe(1);
    expect(rt.requests).toContainEqual({
      runtime: 0,
      method: "thread/fork",
      params: {
        threadId: "thread-source",
        cwd: "/tmp/proj",
        developerInstructions: "Zeros-owned workspace orientation",
        ephemeral: false,
        excludeTurns: true,
        deferGoalContinuation: true,
      },
    });
    await adapter.dispose();
  });

  it("uses a short-lived runtime when the source has no live execution", async () => {
    const { adapter } = makeAdapter();
    await expect(
      adapter.forkProviderBinding!({
        providerBinding: sourceBinding,
        cwd: "/tmp/proj",
      }),
    ).resolves.toMatchObject({
      providerBinding: { resumeId: "thread-fork" },
    });
    expect(rt.disposeCalls).toEqual([0]);
  });

  it("projects only exact native deletion as binding detachment", async () => {
    const { adapter, onSessionUpdate } = makeAdapter();
    await adapter.newSession({
      executionId: "execution-source",
      cwd: "/tmp/proj",
    });
    const deleted = rt.handlers[0]?.get("thread/deleted");
    expect(deleted?.size).toBe(1);

    for (const handler of deleted ?? [])
      handler({ threadId: "descendant-thread" });
    expect(onSessionUpdate).not.toHaveBeenCalledWith(
      "codex",
      expect.objectContaining({
        update: expect.objectContaining({
          sessionUpdate: "provider_binding_detached",
        }),
      }),
    );

    for (const handler of deleted ?? []) handler({ threadId: "thread-source" });
    expect(onSessionUpdate).toHaveBeenCalledWith("codex", {
      sessionId: "execution-source",
      update: {
        sessionUpdate: "provider_binding_detached",
        providerBinding: sourceBinding,
        reason: "provider_deleted",
      },
    });
    expect(rt.handlers[0]?.has("thread/archived")).toBe(false);
    expect(rt.handlers[0]?.has("thread/unarchived")).toBe(false);
    expect(rt.handlers[0]?.has("thread/name/updated")).toBe(false);
    await adapter.dispose();
  });
});

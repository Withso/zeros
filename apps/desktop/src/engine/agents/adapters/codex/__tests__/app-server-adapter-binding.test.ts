import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentAdapterContext } from "../../../types";
import type { ProviderBinding } from "@zeros/protocol/identities";

type Handler = (params: unknown) => void;

const rt = vi.hoisted(() => ({
  bootCount: 0,
  handlers: [] as Array<Map<string, Set<Handler>>>,
  requests: [] as Array<{ runtime: number; method: string; params: unknown }>,
  resumeParams: [] as Array<Record<string, unknown>>,
  turnParams: [] as Array<Record<string, unknown>>,
  disposeCalls: [] as number[],
}));

const browserHost = vi.hoisted(() => ({
  register: vi.fn(async () => true),
  settle: vi.fn(async () => true),
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
  bootCodexAppServerRuntime: vi.fn(async () => {
    const runtime = rt.bootCount++;
    const handlers = new Map<string, Set<Handler>>();
    rt.handlers[runtime] = handlers;
    const requestTyped = vi.fn(async (method: string, params: unknown) => {
      rt.requests.push({ runtime, method, params });
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
      startThread: async () => ({
        threadId: "thread-source",
        providerSessionId: "session-source",
        gitInfo: { sha: "provider-sha", branch: "provider", originUrl: null },
        model: "gpt-5",
        approvalPolicy: "on-request",
        sandbox: { type: "workspaceWrite" },
        raw: {},
      }),
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
  removeSessionDir: vi.fn(async () => {}),
}));

vi.mock("../../../../browser/browser-tool-client", () => ({
  registerCodexBrowserUseSession: browserHost.register,
  settleCodexBrowserUseTurn: browserHost.settle,
}));

vi.mock("../binary-resolver", () => ({
  resolveCodexBinary: vi.fn(async () => ({ path: "/tmp/codex" })),
}));

vi.mock("../browser-tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../browser-tools")>();
  return {
    ...actual,
    resolveCodexNativeBrowserRuntime: vi.fn(async () => ({
      pluginId: "browser@openai-bundled",
      pluginRoot:
        "/tmp/.codex/plugins/cache/openai-bundled/browser/26.803.61601",
      browserSkill: {
        name: "control-in-app-browser",
        path: "/tmp/.codex/plugins/cache/openai-bundled/browser/26.803.61601/skills/control-in-app-browser/SKILL.md",
      },
      mcpServer: {
        name: "node_repl",
        transport: "stdio",
        command: "/tmp/node_repl",
      },
    })),
    mergeCodexNativeBrowserMcp: vi.fn((servers) => servers),
  };
});

import { CodexAppServerAdapter } from "../app-server-adapter";

function makeAdapter() {
  const onSessionUpdate = vi.fn();
  const ctx = {
    projectRoot: "/tmp/proj",
    mcpServers: [],
    sessionDirRoot: "/tmp/sessions",
    emit: {
      onSessionUpdate,
      onPermissionRequest: vi.fn(),
      onQuestionRequest: vi.fn(),
      onAgentStderr: vi.fn(),
      onAgentExit: vi.fn(),
    },
  } as unknown as AgentAdapterContext;
  return { adapter: new CodexAppServerAdapter(ctx), onSessionUpdate };
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
    rt.turnParams = [];
    rt.disposeCalls = [];
    browserHost.register.mockClear();
    browserHost.settle.mockClear();
  });

  it("keeps the ChatGPT Browser plugin out of resumed Zeros threads", async () => {
    const { adapter } = makeAdapter();

    await adapter.loadSession({
      executionId: "execution-resume",
      providerBinding: sourceBinding,
      cwd: "/tmp/proj",
    });

    expect(rt.resumeParams).toContainEqual(
      expect.objectContaining({
        threadId: "thread-source",
        config: { "plugins.browser@openai-bundled.enabled": false },
      }),
    );
    await adapter.dispose();
  });

  it("hands native IAB control back when the owning app-server turn settles", async () => {
    const { adapter } = makeAdapter();
    const started = await adapter.newSession({
      executionId: "execution-browser",
      cwd: "/tmp/proj",
      browserUse: {
        kind: "codex-app-server",
        browserSessionId: "browser_opaque",
      },
    });

    await adapter.prompt({
      sessionId: started.session.sessionId,
      prompt: [{ type: "text", text: "browse" } as never],
    });

    expect(browserHost.register).toHaveBeenCalledWith({
      browserSessionId: "browser_opaque",
      nativeSessionId: "thread-source",
    });
    expect(browserHost.settle).toHaveBeenCalledWith({
      browserSessionId: "browser_opaque",
      nativeSessionId: "thread-source",
    });
    await adapter.dispose();
  });

  it("invokes the verified Browser skill directly for an interactive website prompt", async () => {
    const { adapter } = makeAdapter();
    const started = await adapter.newSession({
      executionId: "execution-browser-skill",
      cwd: "/tmp/proj",
      browserUse: {
        kind: "codex-app-server",
        browserSessionId: "browser_skill",
      },
    });

    await adapter.prompt({
      sessionId: started.session.sessionId,
      prompt: [
        {
          type: "text",
          text: "Open https://example.com and explore the public pages.",
        } as never,
      ],
    });

    expect(rt.turnParams.at(-1)).toMatchObject({
      input: [
        {
          type: "text",
          text: "$control-in-app-browser Open https://example.com and explore the public pages.",
        },
        {
          type: "skill",
          name: "control-in-app-browser",
          path: "/tmp/.codex/plugins/cache/openai-bundled/browser/26.803.61601/skills/control-in-app-browser/SKILL.md",
        },
      ],
    });
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

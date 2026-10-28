import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AgentAdapterContext,
  McpServerRegistration,
} from "../../../types";
import type { CodexNativeBrowserRuntime } from "../browser-tools";
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
}));

const browserHost = vi.hoisted(() => ({
  register: vi.fn(async () => true),
  settle: vi.fn(async () => true),
}));

const browserRuntime = vi.hoisted(() => ({
  resolve: vi.fn(),
}));

const browserCapability = vi.hoisted(() => ({
  reason: null as string | null,
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
      if (method === "config/read") return { config: rt.configByRuntime[runtime] ?? {} };
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
    codexNativeBrowserUnavailableReason: vi.fn(
      ({ contained }: { contained: boolean }) =>
        contained ? browserCapability.reason : null,
    ),
    resolveCodexNativeBrowserRuntime: browserRuntime.resolve,
    mergeCodexNativeBrowserMcp: vi.fn(
      (
        servers: readonly McpServerRegistration[],
        runtime: CodexNativeBrowserRuntime,
      ) => [
        runtime.mcpServer,
        ...servers.filter((server) => server.name !== runtime.mcpServer.name),
      ],
    ),
  };
});

import { CodexAppServerAdapter } from "../app-server-adapter";

function makeAdapter() {
  const onSessionUpdate = vi.fn();
  const onAgentStderr = vi.fn();
  const onCapabilityNotice = vi.fn();
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
      onCapabilityNotice,
    },
  } as unknown as AgentAdapterContext;
  return {
    adapter: new CodexAppServerAdapter(ctx),
    onSessionUpdate,
    onAgentStderr,
    onCapabilityNotice,
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
    browserHost.register.mockClear();
    browserHost.settle.mockClear();
    browserRuntime.resolve.mockReset();
    browserCapability.reason = null;
    sessionPaths.remove.mockClear();
    const runtime = {
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
    } satisfies CodexNativeBrowserRuntime;
    browserRuntime.resolve.mockResolvedValue(runtime);
  });

  it("keeps the ChatGPT Browser plugin out of resumed Zeros threads", async () => {
    const { adapter } = makeAdapter();

    await adapter.loadSession({
      executionId: "execution-resume",
      providerBinding: sourceBinding,
      cwd: "/tmp/proj",
    });

    // The resume path carries the same thread config a fresh start does: the
    // browser gate, while native MCP remains under provider configuration.
    expect(rt.resumeParams).toContainEqual(
      expect.objectContaining({
        threadId: "thread-source",
        config: expect.objectContaining({
          "plugins.browser@openai-bundled.enabled": false,
        }),
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

  it("keeps contained macOS Codex usable while Browser fails closed", async () => {
    browserCapability.reason =
      "Official Browser cannot safely run inside the macOS containment boundary";
    const { adapter, onAgentStderr } = makeAdapter();
    const started = await adapter.newSession({
      executionId: "execution-browser-contained",
      cwd: "/tmp/proj",
      executionBoundary: {
        status: { actor: "agent-code", backend: "zeros-srt", state: "ready" },
      } as never,
      browserUse: {
        kind: "codex-app-server",
        browserSessionId: "browser_contained",
      },
    });

    expect(browserRuntime.resolve).not.toHaveBeenCalled();
    expect(rt.startParams.at(-1)).toMatchObject({
      config: { "plugins.browser@openai-bundled.enabled": false },
    });
    expect(browserHost.register).not.toHaveBeenCalled();
    expect(onAgentStderr).toHaveBeenCalledWith(
      "codex",
      expect.stringMatching(/cannot safely run inside the macOS containment/i),
    );

    await adapter.disposeSession(started.session.sessionId);
  });

  it("keeps Browser enabled behind the native lifecycle boundary", async () => {
    browserCapability.reason =
      "Official Browser cannot safely run inside the macOS containment boundary";
    const { adapter } = makeAdapter();
    const started = await adapter.newSession({
      executionId: "execution-browser-native-host",
      cwd: "/tmp/proj",
      executionBoundary: {
        status: { backend: "none", state: "ready" },
      } as never,
      browserUse: {
        kind: "codex-app-server",
        browserSessionId: "browser_native_host",
      },
    });

    expect(browserRuntime.resolve).toHaveBeenCalledOnce();
    expect(rt.startParams.at(-1)).toMatchObject({
      config: { "plugins.browser@openai-bundled.enabled": true },
    });
    expect(browserHost.register).toHaveBeenCalledWith({
      browserSessionId: "browser_native_host",
      nativeSessionId: "thread-source",
    });

    await adapter.disposeSession(started.session.sessionId);
  });

  it("keeps Codex usable when official Browser runtime discovery fails", async () => {
    browserRuntime.resolve.mockRejectedValueOnce(
      new Error("browser plugin cache is unreadable"),
    );
    const { adapter, onAgentStderr } = makeAdapter();

    const started = await adapter.newSession({
      executionId: "execution-browser-discovery-failure",
      cwd: "/tmp/proj",
      browserUse: {
        kind: "codex-app-server",
        browserSessionId: "browser_discovery_failure",
      },
    });

    expect(started.session.sessionId).toBe(
      "execution-browser-discovery-failure",
    );
    expect(rt.bootOptions).toHaveLength(1);
    expect(onAgentStderr).toHaveBeenCalledWith(
      "codex",
      expect.stringMatching(/Official Browser runtime discovery failed/i),
    );
    await adapter.dispose();
  });

  it("tells the desktop when the installed Browser plugin cannot be used", async () => {
    browserRuntime.resolve.mockImplementationOnce(
      async (options: {
        onUnavailable?: (reason: Record<string, string>) => void;
      }) => {
        options.onUnavailable?.({
          code: "plugin-unsupported",
          version: "27.1.0",
          detail: "scripts/browser-service.mjs does not export handleRpc",
        });
        return null;
      },
    );
    const { adapter, onAgentStderr, onCapabilityNotice } = makeAdapter();

    const started = await adapter.newSession({
      executionId: "execution-browser-unsupported",
      cwd: "/tmp/proj",
      browserUse: {
        kind: "codex-app-server",
        browserSessionId: "browser_unsupported",
      },
    });

    expect(rt.startParams.at(-1)).toMatchObject({
      config: { "plugins.browser@openai-bundled.enabled": false },
    });
    expect(browserHost.register).not.toHaveBeenCalled();
    expect(onCapabilityNotice).toHaveBeenCalledExactlyOnceWith("codex", {
      sessionId: "execution-browser-unsupported",
      notice: {
        code: "codex-browser-plugin-unsupported",
        version: "27.1.0",
      },
    });
    expect(onAgentStderr).toHaveBeenCalledWith(
      "codex",
      expect.stringMatching(/27\.1\.0.*does not export handleRpc/),
    );
    await adapter.disposeSession(started.session.sessionId);
  });

  it("stays quiet on the desktop when ChatGPT Desktop is not installed", async () => {
    browserRuntime.resolve.mockImplementationOnce(
      async (options: {
        onUnavailable?: (reason: Record<string, string>) => void;
      }) => {
        options.onUnavailable?.({ code: "runtime-missing" });
        return null;
      },
    );
    const { adapter, onAgentStderr, onCapabilityNotice } = makeAdapter();

    const started = await adapter.newSession({
      executionId: "execution-browser-not-installed",
      cwd: "/tmp/proj",
      browserUse: {
        kind: "codex-app-server",
        browserSessionId: "browser_not_installed",
      },
    });

    expect(onCapabilityNotice).not.toHaveBeenCalled();
    expect(onAgentStderr).toHaveBeenCalledWith(
      "codex",
      expect.stringMatching(/Official Browser runtime unavailable/),
    );
    await adapter.disposeSession(started.session.sessionId);
  });

  const zerosBrowser = {
    name: "zeros_browser",
    transport: "http",
    url: "http://127.0.0.1:9/mcp",
    headersFromEnv: { Authorization: "ZEROS_BROWSER_TOOLS_CAPABILITY" },
  } satisfies McpServerRegistration;
  const bootedServerNames = () =>
    (rt.bootOptions.at(-1)!.mcpServers as McpServerRegistration[]).map(
      (server) => server.name,
    );

  it("drops the Zeros browser tools when Codex's built-in browser loads", async () => {
    const { adapter, onCapabilityNotice } = makeAdapter();
    const started = await adapter.newSession({
      executionId: "execution-browser-native-wins",
      cwd: "/tmp/proj",
      mcpServers: [zerosBrowser],
      browserUse: {
        kind: "codex-app-server",
        browserSessionId: "browser_native_wins",
      },
    });

    expect(bootedServerNames()).toEqual(["node_repl"]);
    expect(onCapabilityNotice).not.toHaveBeenCalled();
    await adapter.disposeSession(started.session.sessionId);
  });

  it.each([
    [
      "an unsupported plugin",
      { code: "plugin-unsupported", version: "27.1.0", detail: "no handleRpc" },
      {
        code: "codex-browser-plugin-unsupported",
        version: "27.1.0",
        fallback: "zeros-browser",
      },
    ],
    [
      "an incomplete plugin",
      { code: "plugin-incomplete", version: "26.1.0", detail: "missing files" },
      {
        code: "codex-browser-plugin-incomplete",
        version: "26.1.0",
        fallback: "zeros-browser",
      },
    ],
    ["a missing ChatGPT app", { code: "runtime-missing" }, null],
  ])(
    "keeps the Zeros browser as Codex's fallback for %s",
    async (_label, reason, notice) => {
      browserRuntime.resolve.mockImplementationOnce(
        async (options: {
          onUnavailable?: (reason: Record<string, string>) => void;
        }) => {
          options.onUnavailable?.(reason);
          return null;
        },
      );
      const { adapter, onAgentStderr, onCapabilityNotice } = makeAdapter();
      const started = await adapter.newSession({
        executionId: "execution-browser-fallback",
        cwd: "/tmp/proj",
        mcpServers: [zerosBrowser],
        browserUse: {
          kind: "codex-app-server",
          browserSessionId: "browser_fallback",
        },
      });

      expect(bootedServerNames()).toEqual(["zeros_browser"]);
      expect(rt.startParams.at(-1)).toMatchObject({
        config: { "plugins.browser@openai-bundled.enabled": false },
      });
      if (notice) {
        expect(onCapabilityNotice).toHaveBeenCalledExactlyOnceWith("codex", {
          sessionId: "execution-browser-fallback",
          notice,
        });
      } else {
        expect(onCapabilityNotice).not.toHaveBeenCalled();
      }
      expect(onAgentStderr).toHaveBeenCalledWith(
        "codex",
        expect.stringMatching(/Codex will use the Zeros browser/),
      );
      await adapter.disposeSession(started.session.sessionId);
    },
  );

  // ChatGPT Desktop writes its own [mcp_servers.node_repl] table to
  // ~/.codex/config.toml. Codex merges Zeros' verified Browser override into
  // it, so the effective definition is a hybrid. Never run that hybrid, but
  // never strand the chat either: start once more without the built-in browser.
  const chatgptNodeRepl = {
    command: "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl",
    args: [],
    env_vars: ["HOME", "PATH", "TMPDIR"],
    startup_timeout_sec: 120,
    env: {
      NODE_REPL_INSTRUCTIONS_USE_CASE_CHROME: "",
      NODE_REPL_INSTRUCTIONS_USE_CASE_COMPUTER_USE: "",
      SKY_CUA_SERVICE_PATH: "/Applications/ChatGPT.app/Contents/Resources/cua_node/service.mjs",
    },
  };
  it.each([
    ["the Zeros browser", [zerosBrowser], ["zeros_browser"], { code: "codex-browser-config-conflict", fallback: "zeros-browser" }],
    ["no browser", [], [], { code: "codex-browser-config-conflict" }],
  ] as const)(
    "starts Codex with %s when ChatGPT's node_repl declaration conflicts",
    async (_label, servers, fallbackNames, notice) => {
      rt.configByRuntime = [
        { mcp_servers: { node_repl: { ...chatgptNodeRepl, command: "/tmp/node_repl" } } },
        { mcp_servers: { node_repl: chatgptNodeRepl } },
      ];
      const { adapter, onAgentStderr, onCapabilityNotice } = makeAdapter();
      const started = await adapter.newSession({
        executionId: "execution-browser-config-conflict",
        cwd: "/tmp/proj",
        mcpServers: [...servers],
        browserUse: {
          kind: "codex-app-server",
          browserSessionId: "browser_config_conflict",
        },
      });

      expect(
        rt.bootOptions.map((options) =>
          (options.mcpServers as McpServerRegistration[]).map((server) => server.name),
        ),
      ).toEqual([["node_repl"], fallbackNames]);
      expect(rt.disposeCalls).toEqual([0]);
      expect(rt.startParams).toHaveLength(1);
      expect(rt.startParams[0]).toMatchObject({
        config: {
          "plugins.browser@openai-bundled.enabled": false,
          mcp_servers: { node_repl: { enabled: false } },
        },
      });
      expect(browserHost.register).not.toHaveBeenCalled();
      expect(sessionPaths.remove).not.toHaveBeenCalled();
      expect(onCapabilityNotice).toHaveBeenCalledExactlyOnceWith("codex", {
        sessionId: "execution-browser-config-conflict",
        notice,
      });
      expect(onAgentStderr).toHaveBeenCalledWith(
        "codex",
        expect.stringMatching(/node_repl.*Codex configuration/),
      );
      await adapter.disposeSession(started.session.sessionId);
    },
  );

  it("ignores a late exit from the retired runtime after the fallback starts", async () => {
    rt.configByRuntime = [
      { mcp_servers: { node_repl: { ...chatgptNodeRepl, command: "/tmp/node_repl" } } },
      { mcp_servers: { node_repl: chatgptNodeRepl } },
    ];
    const { adapter, onAgentExit } = makeAdapter();
    const started = await adapter.newSession({
      executionId: "execution-browser-late-exit",
      cwd: "/tmp/proj",
      browserUse: {
        kind: "codex-app-server",
        browserSessionId: "browser_late_exit",
      },
    });
    const exitOf = (index: number) =>
      rt.bootOptions[index]!.onExit as (code: number | null, signal: NodeJS.Signals | null) => void;

    exitOf(0)(0, "SIGTERM");
    expect(onAgentExit).not.toHaveBeenCalled();
    exitOf(1)(1, null);
    expect(onAgentExit).toHaveBeenCalledExactlyOnceWith(
      "codex", 1, null, "execution-browser-late-exit",
    );
    await adapter.disposeSession(started.session.sessionId);
  });

  it("still refuses a conflicting registration Zeros does not own", async () => {
    rt.configByRuntime = [
      { mcp_servers: { owned: { command: "approved", env: { NODE_OPTIONS: "--require=./unapproved" } } } },
    ];
    const { adapter, onCapabilityNotice } = makeAdapter();

    await expect(
      adapter.newSession({
        executionId: "execution-owned-conflict",
        cwd: "/tmp/proj",
        mcpServers: [{ name: "owned", transport: "stdio", command: "approved" }],
        browserUse: {
          kind: "codex-app-server",
          browserSessionId: "browser_owned_conflict",
        },
      }),
    ).rejects.toThrow(/MCP configuration conflict for owned/);

    expect(rt.bootOptions).toHaveLength(1);
    expect(rt.disposeCalls).toEqual([0]);
    expect(rt.startParams).toHaveLength(0);
    expect(sessionPaths.remove).toHaveBeenCalledWith("execution-owned-conflict");
    expect(onCapabilityNotice).not.toHaveBeenCalled();
    await adapter.dispose();
  });

  it("refuses a conflicting imported node_repl once the built-in browser is off", async () => {
    rt.configByRuntime = [
      { mcp_servers: { node_repl: { ...chatgptNodeRepl, command: "/tmp/node_repl" } } },
      { mcp_servers: { node_repl: chatgptNodeRepl } },
    ];
    const { adapter } = makeAdapter();

    await expect(
      adapter.newSession({
        executionId: "execution-imported-node-repl",
        cwd: "/tmp/proj",
        mcpServers: [{ name: "node_repl", transport: "stdio", command: "/opt/imported/node_repl" }],
        browserUse: {
          kind: "codex-app-server",
          browserSessionId: "browser_imported_node_repl",
        },
      }),
    ).rejects.toThrow(/MCP configuration conflict for node_repl/);

    expect(rt.bootOptions).toHaveLength(2);
    expect(rt.disposeCalls).toEqual([0, 1]);
    expect(rt.startParams).toHaveLength(0);
    expect(sessionPaths.remove).toHaveBeenCalledWith("execution-imported-node-repl");
    await adapter.dispose();
  });

  it("tells the desktop Codex switched browsers when discovery fails", async () => {
    browserRuntime.resolve.mockRejectedValueOnce(new Error("cache unreadable"));
    const { adapter, onCapabilityNotice } = makeAdapter();
    const started = await adapter.newSession({
      executionId: "execution-browser-discovery-fallback",
      cwd: "/tmp/proj",
      mcpServers: [zerosBrowser],
      browserUse: {
        kind: "codex-app-server",
        browserSessionId: "browser_discovery_fallback",
      },
    });

    expect(bootedServerNames()).toEqual(["zeros_browser"]);
    expect(onCapabilityNotice).toHaveBeenCalledExactlyOnceWith("codex", {
      sessionId: "execution-browser-discovery-fallback",
      notice: { code: "codex-browser-unavailable", fallback: "zeros-browser" },
    });
    await adapter.disposeSession(started.session.sessionId);
  });

  it("retires the runtime and session directory when thread startup fails", async () => {
    rt.startError = new Error("thread start failed");
    const { adapter } = makeAdapter();

    await expect(
      adapter.newSession({
        executionId: "execution-browser-thread-failure",
        cwd: "/tmp/proj",
        browserUse: {
          kind: "codex-app-server",
          browserSessionId: "browser_thread_failure",
        },
      }),
    ).rejects.toThrow(/thread start failed/i);

    expect(rt.disposeCalls).toEqual([0]);
    expect(sessionPaths.remove).toHaveBeenCalledWith(
      "execution-browser-thread-failure",
    );
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

// Native extensions load in ordinary chats. The legacy host opt-out retains
// selective disabling without colliding with Zeros-injected server names.
// Throwaway title threads always disable native MCP, including account apps.

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentAdapterContext } from "../../../types";

const rt = vi.hoisted(() => ({
  /** Merged `config/read` payload the fake app-server reports. */
  mcpServers: {} as Record<string, unknown>,
  /** Set to make the surface reads fail, the way a timeout or old CLI would. */
  configReadError: null as null | Error,
  plugins: [] as {
    name: string;
    installed: boolean;
    enabled: boolean;
    source: { type: string };
    remotePluginId: string | null;
  }[],
  startThreadParams: [] as unknown[],
  /** `mcpServerStatus/list` rows the fake app-server reports. */
  mcpStatus: [] as { name: string; runtimeStatus: string }[],
  /** Method order, to prove the read happens before the thread starts. */
  methodOrder: [] as string[],
}));

vi.mock("../app-server", () => ({
  bootCodexAppServerRuntime: vi.fn(async () => ({
    initializeResponse: {
      userAgent: "codex_cli 0.149.0",
      codexHome: "/tmp/codex",
      platformFamily: "unix",
      platformOs: "linux",
    },
    cliVersion: "0.149.0",
    binarySource: { source: "path", path: "codex" },
    child: { pid: 99, killed: false },
    startThread: vi.fn(async (params: unknown) => {
      rt.methodOrder.push("thread/start");
      rt.startThreadParams.push(params);
      return {
        threadId: "thread-title",
        providerSessionId: "codex-session-title",
        model: "gpt-5",
        approvalPolicy: "never",
        sandbox: { type: "readOnly" },
        raw: {},
      };
    }),
    resumeThread: vi.fn(),
    runTurn: vi.fn(async () => ({
      turnId: "turn-1",
      status: "completed",
      raw: {},
    })),
    interruptTurn: vi.fn(async () => {}),
    respondToPermission: vi.fn(),
    respondToUserInput: vi.fn(),
    onNotification: vi.fn(() => () => {}),
    onNotificationTyped: vi.fn(() => () => {}),
    request: vi.fn(async () => ({})),
    requestTyped: vi.fn(async (method: string) => {
      rt.methodOrder.push(method);
      if (rt.configReadError) throw rt.configReadError;
      if (method === "config/read")
        return { config: { mcp_servers: rt.mcpServers }, origins: {} };
      if (method === "plugin/installed")
        return {
          marketplaces: [
            { name: "fixture", path: "/fixture", plugins: rt.plugins },
          ],
          marketplaceLoadErrors: [],
        };
      if (method === "plugin/read")
        return { plugin: { mcpServers: ["local_plugin_mcp"] } };
      if (method === "mcpServerStatus/list")
        return { data: rt.mcpStatus, nextCursor: null };
      if (method === "app/installed")
        return {
          apps: [
            {
              id: "notes",
              runtimeName: "Notes",
              enabled: true,
              callable: true,
            },
          ],
        };
      if (method === "app/read") return { apps: [], missingAppIds: [] };
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
  writeSessionMeta: vi.fn(async () => {}),
  removeSessionDir: vi.fn(async () => {}),
}));

import { CodexAppServerAdapter } from "../app-server-adapter";

// The plugin half of the surface read walks $CODEX_HOME/plugins/cache on the
// real filesystem. Pin it at an empty path so these assertions describe the
// adapter and not whichever Codex connectors the machine running the suite
// happens to have installed.
const realCodexHome = process.env.CODEX_HOME;
beforeAll(() => {
  process.env.CODEX_HOME = "/nonexistent/zeros-test-codex-home";
});
afterAll(() => {
  if (realCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = realCodexHome;
});

function makeAdapter(emit: Partial<AgentAdapterContext["emit"]> = {}) {
  rt.startThreadParams = [];
  rt.methodOrder = [];
  rt.configReadError = null;
  rt.plugins = [];
  rt.mcpServers = {};
  rt.mcpStatus = [{ name: "codex_apps", runtimeStatus: "connected" }];
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
      ...emit,
    },
  } as unknown as AgentAdapterContext;
  return new CodexAppServerAdapter(ctx);
}

const configOfThreadStart = (index = 0): Record<string, unknown> =>
  (rt.startThreadParams[index] as { config?: Record<string, unknown> })
    ?.config ?? {};
const threadServers = (index = 0): Record<string, Record<string, unknown>> =>
  (configOfThreadStart(index).mcp_servers ?? {}) as Record<string, Record<string, unknown>>;


/** Codex's built-in computer-use servers, disabled on every thread: Codex
 * uses Zeros computer use like every agent. */
const COMPUTER_USE_OFF = {
  cua_repl: { enabled: false, command: "zeros-disabled-mcp-server" },
  "computer-use": { enabled: false, command: "zeros-disabled-mcp-server" },
};

describe("CodexAppServerAdapter native extension loading", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reads the model catalog while the thread starts, not after it", async () => {
    // A new chat waits for the catalog so its picker is right at once; the
    // request rides alongside the MCP read and thread/start, and is made once.
    const adapter = makeAdapter();
    try {
      await adapter.newSession({ cwd: "/tmp/proj" });
      expect(rt.methodOrder.indexOf("model/list")).toBeGreaterThanOrEqual(0);
      expect(rt.methodOrder.indexOf("model/list")).toBeLessThan(rt.methodOrder.indexOf("config/read"));
      expect(rt.methodOrder.filter((method) => method === "model/list")).toHaveLength(1);
    } finally {
      await adapter.dispose();
    }
  });

  it.each(["/tmp/personal/project", "/tmp/organization/project"])(
    "starts a chat in %s with a registered server's verified environment intact",
    async (cwd) => {
      const adapter = makeAdapter();
      rt.mcpServers = {
        local_tools: {
          command: "/opt/verified/local_tools", args: [], enabled: true,
          environment_id: "local", tool_timeout_sec: null,
          env: { TOOLS_HOME: "/opt/verified" },
        },
      };
      try {
        await adapter.newSession({
          cwd,
          mcpServers: [{
            name: "local_tools", transport: "stdio", command: "/opt/verified/local_tools",
            env: { TOOLS_HOME: "/opt/verified" },
          }],
        });
        expect(rt.methodOrder.indexOf("config/read")).toBeLessThan(rt.methodOrder.indexOf("thread/start"));
        expect(rt.startThreadParams).toHaveLength(1);
        // Restated as registered (never disabled), so the thread keeps it.
        expect(threadServers().local_tools).toEqual({
          command: "/opt/verified/local_tools", env: { TOOLS_HOME: "/opt/verified" },
        });
      } finally {
        await adapter.dispose();
      }
    },
  );

  it.each(["account", "local", "imported"] as const)(
    "carries admitted %s bridge provenance into the session inventory",
    async (source) => {
      vi.stubEnv("ZEROS_NATIVE_MCP_PASSTHROUGH", undefined);
      const adapter = makeAdapter();
      if (source === "local")
        rt.mcpServers = { codex_apps: { command: "local-apps" } };
      try {
        const { session } = await adapter.newSession({
          cwd: "/tmp/proj",
          mcpServers:
            source === "imported"
              ? [
                  {
                    name: "codex_apps",
                    transport: "stdio",
                    command: "imported-apps",
                  },
                ]
              : [],
        });
        const inventory = await adapter.capabilityPorts.sessionTools.inventory({
          sessionId: session.executionId,
        });
        const apps = inventory.groups!.find((group) => group.kind === "apps")!;
        expect(apps.entries[0].status).toBe(
          source === "account" ? "available" : "unavailable",
        );
      } finally {
        await adapter.dispose();
      }
    },
  );

  it("requires import for MCP from a local plugin without disabling account plugins", async () => {
    const adapter = makeAdapter();
    rt.plugins = [
      {
        name: "local-plugin",
        installed: true,
        enabled: true,
        source: { type: "local" },
        remotePluginId: null,
      },
      {
        name: "account-plugin",
        installed: true,
        enabled: true,
        source: { type: "remote" },
        remotePluginId: "remote",
      },
    ];
    await adapter.newSession({ cwd: "/tmp/proj" });
    expect(configOfThreadStart().mcp_servers).toMatchObject({
      local_plugin_mcp: {
        enabled: false,
        command: "zeros-disabled-mcp-server",
      },
    });
    expect(
      rt.methodOrder.filter((method) => method === "plugin/read"),
    ).toHaveLength(1);
  });

  it("excludes unimported local configs, including HTTP, while preserving account apps and Zeros", async () => {
    vi.stubEnv("ZEROS_NATIVE_MCP_PASSTHROUGH", undefined);
    const adapter = makeAdapter();
    rt.mcpServers = {
      local_notes: { command: "notes-server" },
      cloud_notes: { url: "https://notes.example/mcp" },
      disabled_notes: { enabled: false, command: "disabled-server" },
    };
    const injected = {
      name: "zeros",
      transport: "stdio" as const,
      command: "zeros-mcp",
    };
    await adapter.newSession({ cwd: "/tmp/proj", mcpServers: [injected] });
    expect(configOfThreadStart().mcp_servers).toEqual({
      zeros: { command: "zeros-mcp" },
      local_notes: { enabled: false, command: "zeros-disabled-mcp-server" },
      cloud_notes: { enabled: false, url: "https://notes.example/mcp" },
      ...COMPUTER_USE_OFF,
    });
    const { bootCodexAppServerRuntime } = await import("../app-server");
    expect(bootCodexAppServerRuntime).toHaveBeenLastCalledWith(
      expect.objectContaining({ mcpServers: [injected] }),
    );
    await adapter.dispose();
  });

  it.each([
    { command: "local-apps" },
    { url: "https://local-config.example/mcp" },
  ])(
    "requires import for a local MCP named codex_apps (%j)",
    async (transport) => {
      vi.stubEnv("ZEROS_NATIVE_MCP_PASSTHROUGH", undefined);
      const adapter = makeAdapter();
      rt.mcpServers = { codex_apps: transport };
      await adapter.newSession({ cwd: "/tmp/proj" });
      expect(configOfThreadStart().mcp_servers).toEqual({
        codex_apps: {
          enabled: false,
          ...("url" in transport
            ? transport
            : { command: "zeros-disabled-mcp-server" }),
        },
        ...COMPUTER_USE_OFF,
      });
      await adapter.dispose();
    },
  );
});

describe("CodexAppServerAdapter explicit native MCP opt-out", () => {
  beforeEach(() => vi.stubEnv("ZEROS_NATIVE_MCP_PASSTHROUGH", "0"));
  afterEach(() => vi.unstubAllEnvs());
  it(
    "preserves a disabled HTTP transport when a plugin claims its name on a chat thread",
    async () => {
      const codexHome = mkdtempSync(path.join(os.tmpdir(), "zeros-codex-mcp-"));
      const previousHome = process.env.CODEX_HOME;
      const manifest = path.join(
        codexHome,
        "plugins/cache/market/notes/1.0.0/.mcp.json",
      );
      try {
        mkdirSync(path.dirname(manifest), { recursive: true });
        writeFileSync(
          manifest,
          JSON.stringify({
            mcpServers: { notes: { command: "plugin-notes" } },
          }),
        );
        process.env.CODEX_HOME = codexHome;
        const adapter = makeAdapter();
        rt.mcpServers = {
          notes: { enabled: false, url: "https://notes.example/mcp" },
        };

        await adapter.newSession({ cwd: "/tmp/proj" });

        const servers = configOfThreadStart().mcp_servers as Record<
          string,
          Record<string, unknown>
        >;
        expect(servers.notes).toEqual({
          enabled: false,
          url: "https://notes.example/mcp",
        });
      } finally {
        if (previousHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = previousHome;
        rmSync(codexHome, { recursive: true, force: true });
      }
    },
  );

  it("honors the explicit host opt-out for account apps as well as local servers", async () => {
    const adapter = makeAdapter();
    rt.mcpServers = {
      directus: { command: "npx" },
      codex_apps: { url: "https://example.com/bridge" },
    };
    await adapter.newSession({ cwd: "/tmp/proj" });
    expect(configOfThreadStart().mcp_servers).toEqual({
      directus: { enabled: false, command: "zeros-disabled-mcp-server" },
      codex_apps: { enabled: false, url: "https://example.com/bridge" },
      ...COMPUTER_USE_OFF,
    });
  });

  it("disables native config servers on a new session", async () => {
    const adapter = makeAdapter();
    rt.mcpServers = { directus: { command: "npx" } };

    await adapter.newSession({ cwd: "/tmp/proj" });

    expect(configOfThreadStart()).toMatchObject({
      mcp_servers: {
        directus: { enabled: false, command: "zeros-disabled-mcp-server" },
      },
    });
  });

  it("disables a Streamable HTTP native server by repeating its url, never adding a command", async () => {
    const adapter = makeAdapter();
    // A hand-written `[mcp_servers.directus] url = "…"` entry. Codex infers the
    // transport from the keys, so a `command` merged into this table produced
    // "failed to load configuration: url is not supported for stdio in
    // `mcp_servers.directus`" on every thread/start — no Codex chat could open.
    rt.mcpServers = {
      directus: { url: "https://directus.example.com/mcp" },
      local_tool: { command: "npx", args: ["-y", "tool"] },
    };

    await adapter.newSession({ cwd: "/tmp/proj" });

    const servers = configOfThreadStart().mcp_servers as Record<
      string,
      Record<string, unknown>
    >;
    expect(servers.directus).toEqual({
      enabled: false,
      url: "https://directus.example.com/mcp",
    });
    expect(servers.directus).not.toHaveProperty("command");
    expect(servers.local_tool).toEqual({
      enabled: false,
      command: "zeros-disabled-mcp-server",
    });
  });

  it("restates Zeros' own servers in a thread table that disables native ones", async () => {
    // Codex lets a thread's `mcp_servers` table replace the `-c` servers it
    // was started with (verified on 0.166): without restating them, a Codex
    // chat silently loses zeros_browser, zeros_computer and the rest.
    const adapter = makeAdapter();
    rt.mcpServers = { directus: {} };
    const { session } = await adapter.newSession({
      cwd: "/tmp/proj",
      mcpServers: [
        {
          name: "zeros_browser", transport: "http", url: "http://127.0.0.1:43124/mcp",
          headersFromEnv: { Authorization: "ZEROS_BROWSER_TOOLS_CAPABILITY" }, toolTimeoutSec: 600,
        },
        { name: "local_tools", transport: "stdio", command: "/opt/local_tools", args: ["--serve"] },
      ],
    });
    const config = configOfThreadStart();
    expect(config.mcp_servers).toMatchObject({
      directus: { enabled: false, command: "zeros-disabled-mcp-server" },
      cua_repl: { enabled: false },
      zeros_browser: {
        url: "http://127.0.0.1:43124/mcp",
        env_http_headers: { Authorization: "ZEROS_BROWSER_TOOLS_CAPABILITY" },
        tool_timeout_sec: 600,
      },
      local_tools: { command: "/opt/local_tools", args: ["--serve"] },
    });
    expect(threadServers().zeros_browser).not.toHaveProperty("enabled");
    // Restated servers stay in the chat's Tools; disabled ones do not.
    rt.mcpStatus = [
      { name: "codex_apps", runtimeStatus: "connected" },
      { name: "zeros_browser", runtimeStatus: "connected" },
      { name: "directus", runtimeStatus: "connected" },
    ];
    const tools = await adapter.capabilityPorts.sessionTools.list({ sessionId: session.executionId });
    const ids = tools.entries.map((entry) => entry.id);
    expect(ids).toContain("zeros_browser");
    expect(ids).not.toContain("directus");
    await adapter.dispose();
  });

  it("never disables a server Zeros is registering under the same name", async () => {
    const adapter = makeAdapter();
    rt.mcpServers = { local_tools: { command: "/opt/local_tools" }, directus: {} };

    // Zeros' registry lands in the same `mcp_servers` table, so a same-name
    // entry merges. Disabling `local_tools` here would take Zeros' own
    // registered server down with the native one.
    await adapter.newSession({
      cwd: "/tmp/proj",
      mcpServers: [
        { name: "local_tools", transport: "stdio", command: "/opt/local_tools" },
      ],
    });

    const config = configOfThreadStart();
    expect(config.mcp_servers).toEqual({
      local_tools: { command: "/opt/local_tools" },
      directus: { enabled: false, command: "zeros-disabled-mcp-server" },
      codex_apps: { enabled: false, command: "zeros-disabled-mcp-server" },
      ...COMPUTER_USE_OFF,
    });
  });

  it("leaves the built-in plugin gates to codexBuiltInPluginsThreadConfig", async () => {
    const adapter = makeAdapter();
    rt.mcpServers = { directus: {} };

    await adapter.newSession({ cwd: "/tmp/proj" });

    // Nothing here writes a `plugins` table — disabling a plugin by id does
    // not stop its servers, so the built-in plugin gates own that namespace.
    const config = configOfThreadStart();
    expect(config.plugins).toBeUndefined();
    expect(config["plugins.browser@openai-bundled.enabled"]).toBe(false);
  });

  it("turns off Codex's built-in computer use on every thread", async () => {
    const adapter = makeAdapter();
    // A configured HTTP namesake stays a valid transport when disabled.
    rt.mcpServers = { "computer-use": { url: "https://cu.example/mcp" } };
    await adapter.newSession({
      cwd: "/tmp/proj",
    });
    const config = configOfThreadStart();
    expect(config.mcp_servers).toMatchObject({
      cua_repl: { enabled: false, command: "zeros-disabled-mcp-server" },
      "computer-use": { enabled: false, url: "https://cu.example/mcp" },
    });
    expect(config["plugins.computer-use@openai-bundled.enabled"]).toBe(false);
    expect(
      config["plugins.unified-computer-use@openai-bundled.enabled"],
    ).toBe(false);
    expect(config.plugins).toBeUndefined();
    await adapter.dispose();

    // Never disable a server Zeros itself registered under that name.
    const own = makeAdapter();
    rt.mcpServers = { cua_repl: { command: "own" } };
    await own.newSession({
      cwd: "/tmp/proj",
      mcpServers: [{ name: "cua_repl", transport: "stdio", command: "own" }],
    });
    expect(threadServers().cua_repl).toEqual({ command: "own" });
    await own.dispose();
  });

  it("does not start a chat with unimported local MCP when its configuration cannot be read", async () => {
    const adapter = makeAdapter();
    rt.mcpServers = { directus: {} };
    rt.configReadError = new Error("config/read timed out");

    await expect(adapter.newSession({ cwd: "/tmp/proj" })).rejects.toThrow(
      "MCP configuration",
    );
    expect(rt.startThreadParams).toHaveLength(0);
  });
});

describe("CodexAppServerAdapter MCP server names", () => {
  const bootedServerNames = async () => {
    const { bootCodexAppServerRuntime } = await import("../app-server");
    return vi.mocked(bootCodexAppServerRuntime).mock.calls.at(-1)![0].mcpServers!.map((server) => server.name);
  };
  const mcpRows = async (adapter: CodexAppServerAdapter, sessionId: string) => {
    const query = { sessionId };
    const inventory = await adapter.capabilityPorts.sessionTools.inventory(query);
    return [
      (await adapter.capabilityPorts.sessionTools.list(query)).entries,
      inventory.entries,
      inventory.groups!.find((group) => group.kind === "mcp")!.entries,
    ];
  };

  it("starts a server whose name Codex cannot take under the name Claude and Cursor use, listed by its own name", async () => {
    const adapter = makeAdapter();
    rt.mcpStatus = [
      { name: "probe_dots", runtimeStatus: "connected" },
      { name: "My_Tools", runtimeStatus: "connected" },
    ];
    try {
      const { session } = await adapter.newSession({
        cwd: "/tmp/proj",
        mcpServers: [
          { name: "probe.dots", transport: "stdio", command: "node", args: ["probe.mjs"] },
          { name: "My Tools", transport: "http", url: "https://tools.example/mcp" },
        ],
      });
      expect(await bootedServerNames()).toEqual(["probe_dots", "My_Tools"]);
      for (const rows of await mcpRows(adapter, session.executionId!)) {
        expect(rows).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: "probe_dots", name: "probe.dots", status: "connected" }),
          expect.objectContaining({ id: "My_Tools", name: "My Tools", status: "connected" }),
        ]));
      }
    } finally {
      await adapter.dispose();
    }
  });

  it("lists a server Codex cannot run, with the reason, instead of dropping it silently", async () => {
    const adapter = makeAdapter();
    rt.mcpStatus = [{ name: "probe_dots", runtimeStatus: "connected" }];
    try {
      const { session } = await adapter.newSession({
        cwd: "/tmp/proj",
        mcpServers: [
          { name: "probe.dots", transport: "stdio", command: "renamed" },
          { name: "probe_dots", transport: "stdio", command: "own" },
          { name: "events", transport: "sse", url: "https://example.test/sse" },
        ],
      });
      expect(await bootedServerNames()).toEqual(["probe_dots"]);
      for (const rows of await mcpRows(adapter, session.executionId!)) {
        expect(rows.filter((row) => row.name.startsWith("probe"))).toEqual([
          expect.objectContaining({ id: "probe_dots", name: "probe_dots", status: "connected" }),
          expect.objectContaining({ name: "probe.dots", status: "error", detail: expect.stringContaining("“probe_dots”") }),
        ]);
        expect(rows).toContainEqual(expect.objectContaining({ name: "events", status: "error", detail: expect.stringContaining("SSE") }));
      }
      const [rows] = await mcpRows(adapter, session.executionId!);
      const unavailable = rows!.find((row) => row.name === "probe.dots")!;
      await expect(adapter.capabilityPorts.sessionTools.authenticate({ sessionId: session.executionId!, toolId: unavailable.id }))
        .rejects.toThrow("This tool is not connected to the chat.");
    } finally {
      await adapter.dispose();
    }
  });
});

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
        return {
          data: [{ name: "codex_apps", runtimeStatus: "connected" }],
          nextCursor: null,
        };
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

function makeAdapter() {
  rt.startThreadParams = [];
  rt.methodOrder = [];
  rt.configReadError = null;
  rt.plugins = [];
  rt.mcpServers = {};
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
    },
  } as unknown as AgentAdapterContext;
  return new CodexAppServerAdapter(ctx);
}

const configOfThreadStart = (index = 0): Record<string, unknown> =>
  (rt.startThreadParams[index] as { config?: Record<string, unknown> })
    ?.config ?? {};

const generateTitle = (adapter: CodexAppServerAdapter) =>
  adapter.generateText({
    model: "gpt-5",
    systemPrompt: "Name this chat.",
    prompt: "hi",
  });

describe("CodexAppServerAdapter.generateText — native MCP stays out of a title", () => {
  it("starts the title thread with every native MCP server disabled", async () => {
    const adapter = makeAdapter();
    rt.mcpServers = { node_repl: { command: "node" } };

    await generateTitle(adapter);

    expect(rt.startThreadParams[0]).toMatchObject({
      config: {
        mcp_servers: {
          node_repl: { enabled: false, command: "zeros-disabled-mcp-server" },
          codex_apps: { enabled: false, command: "zeros-disabled-mcp-server" },
        },
      },
    });
    // Names must come from the runtime that is about to start the thread:
    // codex rejects a `mcp_servers.<unknown>` entry with no transport.
    expect(rt.methodOrder.indexOf("config/read")).toBeLessThan(
      rt.methodOrder.indexOf("thread/start"),
    );
  });

  it("still disables codex's internal servers when the user has none", async () => {
    const adapter = makeAdapter();

    await generateTitle(adapter);

    expect(rt.startThreadParams[0]).toMatchObject({
      config: {
        mcp_servers: {
          codex_apps: { enabled: false, command: "zeros-disabled-mcp-server" },
        },
      },
    });
  });

  it("does not start native MCP for a title when its configuration cannot be read", async () => {
    const adapter = makeAdapter();
    rt.configReadError = new Error("config/read timed out");
    await expect(generateTitle(adapter)).rejects.toThrow("MCP configuration");
    expect(rt.startThreadParams).toHaveLength(0);
  });
});

describe("CodexAppServerAdapter native extension loading", () => {
  afterEach(() => vi.unstubAllEnvs());

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
      local_notes: { enabled: false, command: "zeros-disabled-mcp-server" },
      cloud_notes: { enabled: false, url: "https://notes.example/mcp" },
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
      });
      await adapter.dispose();
    },
  );
});

describe("CodexAppServerAdapter explicit native MCP opt-out", () => {
  beforeEach(() => vi.stubEnv("ZEROS_NATIVE_MCP_PASSTHROUGH", "0"));
  afterEach(() => vi.unstubAllEnvs());
  it.each(["chat", "title"] as const)(
    "preserves a disabled HTTP transport when a plugin claims its name on a %s thread",
    async (kind) => {
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

        if (kind === "chat") await adapter.newSession({ cwd: "/tmp/proj" });
        else await generateTitle(adapter);

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

  it("keeps the http url on the title thread's disable fragment too", async () => {
    const adapter = makeAdapter();
    rt.mcpServers = { directus: { url: "https://directus.example.com/mcp" } };

    await generateTitle(adapter);

    const servers = configOfThreadStart().mcp_servers as Record<
      string,
      Record<string, unknown>
    >;
    expect(servers.directus).toEqual({
      enabled: false,
      url: "https://directus.example.com/mcp",
    });
  });

  it("never disables a server Zeros is injecting under the same name", async () => {
    const adapter = makeAdapter();
    rt.mcpServers = { node_repl: { command: "node" }, directus: {} };

    // Zeros' registry lands in the same `mcp_servers` table, so a same-name
    // entry merges. Disabling `node_repl` here would take Zeros' own injected
    // server — the one behind native Browser Use — down with the native one.
    await adapter.newSession({
      cwd: "/tmp/proj",
      mcpServers: [
        { name: "node_repl", transport: "stdio", command: "/opt/node_repl" },
      ],
    });

    const config = configOfThreadStart();
    expect(config.mcp_servers).toEqual({
      directus: { enabled: false, command: "zeros-disabled-mcp-server" },
      codex_apps: { enabled: false, command: "zeros-disabled-mcp-server" },
    });
  });

  it("leaves the Browser plugin gate to codexBrowserThreadConfig", async () => {
    const adapter = makeAdapter();
    rt.mcpServers = { directus: {} };

    await adapter.newSession({ cwd: "/tmp/proj" });

    // Nothing here writes a `plugins` table — disabling a plugin by id does
    // not stop its servers, so the browser gate owns that namespace alone.
    const config = configOfThreadStart();
    expect(config.plugins).toBeUndefined();
    expect(config["plugins.browser@openai-bundled.enabled"]).toBe(false);
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

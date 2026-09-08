// Native MCP pass-through is off for Codex: Settings → Customize → MCP is the
// whole set (adapters/shared/mcp-passthrough.ts). Enforcing that means
// disabling native servers by name on every thread the adapter starts.
//
// Real chat sessions and the throwaway title runtime differ in one way that
// matters: a chat must keep the servers Zeros itself injects, because they
// share the `mcp_servers` namespace with the native ones and a same-name
// disable would kill them. A title thread calls no tools and keeps nothing.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { AgentAdapterContext } from "../../../types";

const rt = vi.hoisted(() => ({
  /** Merged `config/read` payload the fake app-server reports. */
  mcpServers: {} as Record<string, unknown>,
  /** Set to make the surface reads fail, the way a timeout or old CLI would. */
  configReadError: null as null | Error,
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

  it("still produces a title when the surface reads fail", async () => {
    const adapter = makeAdapter();
    rt.mcpServers = { node_repl: { command: "node" } };
    rt.configReadError = new Error("config/read timed out");

    // A title is worth no MCP servers, but it is not worth failing over —
    // an unreadable config falls back to a plain thread rather than throwing.
    await expect(generateTitle(adapter)).resolves.toBe("");
    expect(rt.startThreadParams[0]).toMatchObject({ config: {} });
  });
});

describe("CodexAppServerAdapter session threads — Customize is the whole set", () => {
  it("preserves the native account app bridge without enabling unrelated native servers", async () => {
    const adapter = makeAdapter();
    rt.mcpServers = { directus: { command: "npx" }, codex_apps: { url: "https://example.com/bridge" } };
    await adapter.newSession({ cwd: "/tmp/proj" });
    expect(configOfThreadStart().mcp_servers).toEqual({ directus: { enabled: false, command: "zeros-disabled-mcp-server" } });
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

  it("starts the session normally when the surface reads fail", async () => {
    const adapter = makeAdapter();
    rt.mcpServers = { directus: {} };
    rt.configReadError = new Error("config/read timed out");

    // MCP hygiene must never be the reason a user cannot open a chat.
    await expect(
      adapter.newSession({ cwd: "/tmp/proj" }),
    ).resolves.toBeDefined();
    expect(configOfThreadStart().mcp_servers).toBeUndefined();
  });
});

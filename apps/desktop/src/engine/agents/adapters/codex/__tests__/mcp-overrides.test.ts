import { describe, expect, it } from "vitest";
import { buildMcpServerOverrides } from "../app-server";
import {
  mcpDisabledThreadConfig,
  readNativeMcpSurface,
  scopeNativeMcpSurface,
} from "../native-mcp";
import type { McpServerRegistration } from "../../../types";

describe("buildMcpServerOverrides — Codex -c MCP config", () => {
  it("emits url + http_headers for an http server (no `type` field)", () => {
    const args = buildMcpServerOverrides([
      {
        name: "tracker",
        transport: "http",
        url: "https://mcp.tracker.example/mcp",
        headers: { "X-Org": "acme" },
      },
    ]);
    expect(args).toEqual([
      "-c",
      'mcp_servers.tracker.url="https://mcp.tracker.example/mcp"',
      "-c",
      'mcp_servers.tracker.http_headers={ "X-Org" = "acme" }',
    ]);
    expect(args.join(" ")).not.toContain(".type=");
  });

  it("references secret HTTP headers by environment name without placing their value in argv", () => {
    const args = buildMcpServerOverrides([
      {
        name: "draft_api",
        transport: "http",
        url: "http://127.0.0.1:43123/mcp",
        headersFromEnv: { Authorization: "ZEROS_DESIGN_AGENT_CAPABILITY" },
      },
    ]);
    expect(args).toEqual([
      "-c",
      'mcp_servers.draft_api.url="http://127.0.0.1:43123/mcp"',
      "-c",
      'mcp_servers.draft_api.env_http_headers={ "Authorization" = "ZEROS_DESIGN_AGENT_CAPABILITY" }',
    ]);
    expect(args.join(" ")).not.toContain("Bearer");
  });

  it("emits command/args/env for a stdio server", () => {
    const args = buildMcpServerOverrides([
      {
        name: "ctx7",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
        env: { DEBUG: "1" },
        startupTimeoutSec: 120,
      },
    ]);
    expect(args).toContain('mcp_servers.ctx7.command="npx"');
    expect(args).toContain(
      'mcp_servers.ctx7.args=["-y", "@upstash/context7-mcp"]',
    );
    expect(args).toContain('mcp_servers.ctx7.env={ "DEBUG" = "1" }');
    expect(args).toContain("mcp_servers.ctx7.startup_timeout_sec=120");
  });

  it("skips a server whose name isn't TOML-key-safe (no injection)", () => {
    expect(
      buildMcpServerOverrides([
        {
          name: "a.b evil",
          transport: "http",
          url: "https://x",
        } as McpServerRegistration,
      ]),
    ).toEqual([]);
  });

  it("escapes control characters in values → valid TOML (no raw CR/NUL breaking the parse)", () => {
    const args = buildMcpServerOverrides([
      {
        name: "x",
        transport: "http",
        url: "https://x",
        headers: { K: "a\r\nb\tc\x00d\x08e" },
      },
    ]);
    const joined = args.join(" ");
    // No raw control characters survive into the emitted -c string.
    // eslint-disable-next-line no-control-regex
    expect(/[\x00-\x08\x0b\x0c\r]/.test(joined)).toBe(false);
    expect(joined).toContain("\\r");
    expect(joined).toContain("\\n");
    expect(joined).toContain("\\t");
    expect(joined).toContain("\\u0000");
    expect(joined).toContain("\\b");
  });

  it("escapes quotes + backslashes in a value", () => {
    const args = buildMcpServerOverrides([
      { name: "x", transport: "http", url: 'https://x/?q="a"\\b' },
    ]);
    expect(args.join(" ")).toContain('\\"a\\"\\\\b');
  });
});

describe("native MCP scoping — the Zeros registry is the whole set", () => {
  const runtime = (mcpServers: unknown, fail = false) => {
    const calls: Array<{ method: string; params: unknown }> = [];
    return {
      calls,
      requestTyped: async (method: string, params: unknown) => {
        calls.push({ method, params });
        if (fail) throw new Error("config/read failed");
        return { config: { mcp_servers: mcpServers } };
      },
    } as unknown as Parameters<typeof readNativeMcpSurface>[0] & {
      calls: Array<{ method: string; params: unknown }>;
    };
  };
  // Point the plugin half at an empty dir unless a case supplies one.
  const noPlugins = { codexHome: "/nonexistent-codex-home" };

  it("reads the merged config servers, scoped to cwd", async () => {
    const rt = runtime({
      directus: { command: "npx" },
      node_repl: { command: "node" },
    });

    await expect(
      readNativeMcpSurface(rt, "/repo/app", noPlugins),
    ).resolves.toEqual({
      serverNames: ["directus", "node_repl", "codex_apps"],
    });
    // config/read must see the project layers the thread will load, and must
    // not pay for the layer payload it does not use.
    expect(rt.calls).toEqual([
      {
        method: "config/read",
        params: { includeLayers: false, cwd: "/repo/app" },
      },
    ]);
  });

  it("omits servers the merged config already disables", async () => {
    // Naming something codex already skips buys nothing.
    await expect(
      readNativeMcpSurface(
        runtime({ live: { command: "npx" }, off: { enabled: false } }),
        undefined,
        noPlugins,
      ),
    ).resolves.toEqual({ serverNames: ["live", "codex_apps"] });
  });

  it("retains the transport of disabled HTTP servers for plugin name collisions", async () => {
    await expect(
      readNativeMcpSurface(
        runtime({
          notes: { enabled: false, url: "https://notes.example/mcp" },
        }),
        undefined,
        noPlugins,
      ),
    ).resolves.toEqual({
      serverNames: ["codex_apps"],
      httpServerUrls: { notes: "https://notes.example/mcp" },
    });
  });

  it("still reports plugin servers when the config read fails", async () => {
    await expect(
      readNativeMcpSurface(runtime({}, true), undefined, noPlugins),
    ).resolves.toEqual({ serverNames: ["codex_apps"] });
  });

  it.each([
    {},
    { config: null },
    { config: [] },
    { config: { mcp_servers: [] } },
  ])(
    "rejects malformed config metadata when a thread requires local MCP exclusion (%j)",
    async (response) => {
      const rt = {
        requestTyped: async () => response,
      } as unknown as Parameters<typeof readNativeMcpSurface>[0];
      await expect(
        readNativeMcpSurface(rt, "/repo/app", {
          ...noPlugins,
          requireConfig: true,
        }),
      ).rejects.toThrow("MCP configuration");
    },
  );

  it("still covers codex's internal servers when the user has none", async () => {
    // `codex_apps` appears in no config layer and no plugin manifest, so an
    // empty user surface is not an empty disable list.
    await expect(
      readNativeMcpSurface(runtime({}), undefined, noPlugins),
    ).resolves.toEqual({ serverNames: ["codex_apps"] });
    await expect(
      readNativeMcpSurface(runtime([]), undefined, noPlugins),
    ).resolves.toEqual({ serverNames: ["codex_apps"] });
  });

  it("records the url of a Streamable HTTP server so its disable keeps the transport", async () => {
    // Codex infers transport from the keys and rejects an entry with BOTH
    // `url` and `command` ("url is not supported for stdio"), which took down
    // every thread/start for a user with `[mcp_servers.directus] url = …`.
    await expect(
      readNativeMcpSurface(
        runtime({
          directus: { url: "https://directus.example.com/mcp" },
          local: { command: "npx" },
        }),
        undefined,
        noPlugins,
      ),
    ).resolves.toEqual({
      serverNames: ["directus", "local", "codex_apps"],
      httpServerUrls: { directus: "https://directus.example.com/mcp" },
    });
  });

  it("disables prototype-like server names and preserves their HTTP transport", async () => {
    const surface = await readNativeMcpSurface(
      runtime({
        ["__proto__"]: { url: "https://notes.example/mcp" },
        constructor: { command: "local-server" },
      }),
      undefined,
      noPlugins,
    );
    const override = mcpDisabledThreadConfig(
      scopeNativeMcpSurface(surface, { serverNames: ["codex_apps"] }),
    );
    expect(JSON.parse(JSON.stringify(override))).toEqual({
      mcp_servers: {
        ["__proto__"]: { enabled: false, url: "https://notes.example/mcp" },
        constructor: { enabled: false, command: "zeros-disabled-mcp-server" },
      },
    });
  });

  it("disables an http server by repeating its url, never adding a command", () => {
    expect(
      mcpDisabledThreadConfig({
        serverNames: ["directus", "local"],
        httpServerUrls: { directus: "https://directus.example.com/mcp" },
      }),
    ).toEqual({
      mcp_servers: {
        directus: { enabled: false, url: "https://directus.example.com/mcp" },
        local: { enabled: false, command: "zeros-disabled-mcp-server" },
      },
    });
  });

  it("disables by name with a placeholder transport, not by plugin id", () => {
    // Two verified facts are encoded here. `plugins.<id>.enabled = false` does
    // NOT stop a plugin's server (codex accepts the key and starts the server
    // anyway), so the disable has to name the SERVER. And codex validates an
    // entry's transport before it reads `enabled`, rejecting the whole config
    // with "invalid transport" when neither `command` nor `url` is present —
    // so a disabled entry still needs one.
    expect(
      mcpDisabledThreadConfig({
        serverNames: ["cloudflare-api", "my.server"],
      }),
    ).toEqual({
      mcp_servers: {
        "cloudflare-api": {
          enabled: false,
          command: "zeros-disabled-mcp-server",
        },
        // Nested, not a dotted key path: a server name is a user-authored TOML
        // key and a `.` would split it into the wrong table.
        "my.server": { enabled: false, command: "zeros-disabled-mcp-server" },
      },
    });
  });

  it("is an empty fragment when nothing needs disabling", () => {
    // Callers spread this unconditionally.
    expect(mcpDisabledThreadConfig({ serverNames: [] })).toEqual({});
  });
});

describe("scopeNativeMcpSurface — what a real chat thread must not shut off", () => {
  it("keeps a native name that Zeros itself injects", () => {
    // Zeros' registry rides `-c mcp_servers.<name>.…` into the SAME table
    // codex reads its native servers from, so a same-name entry MERGES rather
    // than shadowing. Disabling by name would take the Zeros server down too —
    // including `node_repl`, which is how native Browser Use survives.
    expect(
      scopeNativeMcpSurface(
        { serverNames: ["node_repl", "directus", "cloudflare-api"] },
        { serverNames: ["node_repl"] },
      ),
    ).toEqual({ serverNames: ["directus", "cloudflare-api"] });
  });

  it("carries the http url map through scoping", () => {
    expect(
      scopeNativeMcpSurface(
        {
          serverNames: ["node_repl", "directus"],
          httpServerUrls: { directus: "https://directus.example.com/mcp" },
        },
        { serverNames: ["node_repl"] },
      ),
    ).toEqual({
      serverNames: ["directus"],
      httpServerUrls: { directus: "https://directus.example.com/mcp" },
    });
  });

  it("disables everything when nothing is claimed", () => {
    const surface = { serverNames: ["directus"] };
    expect(scopeNativeMcpSurface(surface, {})).toEqual(surface);
  });
});

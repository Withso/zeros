import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readNativeMcpSurface } from "../native-mcp";
import type { CodexAppServerHandle } from "../app-server";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "zeros-cua-admission-"));
  roots.push(home);
  const source = join(
    home,
    ".tmp/bundled-marketplaces/openai-bundled/plugins/unified-computer-use",
  );
  const cache = join(
    home,
    "plugins/cache/openai-bundled/unified-computer-use/1.0.0",
  );
  await mkdir(join(cache, ".codex-plugin"), { recursive: true });
  await writeFile(
    join(cache, ".codex-plugin/plugin.json"),
    JSON.stringify({ name: "unified-computer-use", version: "1.0.0" }),
  );
  await mkdir(join(source, ".."), { recursive: true });
  await symlink(cache, source);
  const plugin = {
    id: "unified-computer-use@openai-bundled",
    name: "unified-computer-use",
    installed: true,
    enabled: true,
    remotePluginId: null,
    source: { type: "local", path: source },
  };
  const market = {
    name: "openai-bundled",
    path: join(
      home,
      ".tmp/bundled-marketplaces/openai-bundled/.plugin/marketplace.json",
    ),
    plugins: [plugin],
  };
  let configured: Record<string, unknown> = {};
  const requestTyped = vi.fn(async (method: string) => {
    if (method === "config/read")
      return { config: { mcp_servers: configured } };
    if (method === "plugin/installed")
      return { marketplaces: [market], marketplaceLoadErrors: [] };
    if (method === "plugin/read")
      return { plugin: { mcpServers: ["cua_repl"] } };
    throw new Error(method);
  });
  return {
    home,
    source,
    cache,
    plugin,
    market,
    requestTyped,
    read: () =>
      readNativeMcpSurface(
        { requestTyped } as unknown as CodexAppServerHandle,
        home,
        { includePlugins: false, codexHome: home, requireConfig: true },
      ),
    configure: (value: Record<string, unknown>) => {
      configured = value;
    },
  };
}

describe("Codex bundled runtime admission", () => {
  it("keeps the installed app-managed CUA runtime without importing its MCP", async () => {
    const f = await fixture();
    expect((await f.read()).serverNames).not.toContain("cua_repl");
    expect(f.requestTyped.mock.calls.map(([method]) => method)).not.toContain(
      "plugin/read",
    );
  });

  it("still excludes a config-declared MCP that shadows the bundled runtime", async () => {
    const f = await fixture();
    f.configure({ cua_repl: { command: "user-local-mcp" } });
    expect((await f.read()).serverNames).toContain("cua_repl");
  });

  it("accepts the directory copies used by current Desktop", async () => {
    const f = await fixture();
    await rm(f.source);
    await cp(f.cache, f.source, { recursive: true });
    await rm(f.cache, { recursive: true });
    expect((await f.read()).serverNames).not.toContain("cua_repl");
  });

  it("rejects a materialization linked outside the selected profile", async () => {
    const f = await fixture();
    const other = await fixture();
    await rm(f.source);
    await symlink(other.cache, f.source);
    expect((await f.read()).serverNames).toContain("cua_repl");
  });

  it.each(["other-home", "other-market", "other-name", "missing-cache"])(
    "rejects misleading bundled provenance: %s",
    async (scenario) => {
      const f = await fixture();
      if (scenario === "other-home")
        f.plugin.source.path = join(
          f.home,
          "other/plugins/unified-computer-use",
        );
      if (scenario === "other-market") f.market.name = "local";
      if (scenario === "other-name") f.plugin.name = "my-computer-use";
      if (scenario === "missing-cache") await rm(f.cache, { recursive: true });
      expect((await f.read()).serverNames).toContain("cua_repl");
    },
  );
});

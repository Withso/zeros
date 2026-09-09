import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { nativeExtensionInventory } from "../native-extensions";
import { createExtensionResource } from "../../../renderer/features/agent-extensions/extensions-cache";

describe("native extension declarations", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), "zeros-native-extensions-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));
  const write = (file: string, doc: unknown) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(doc));
  };
  it.each([
    {
      provider: "claude",
      file: ".claude.json",
      text: JSON.stringify({ mcpServers: { notes: { command: "node" } } }),
    },
    {
      provider: "codex",
      file: ".codex/config.toml",
      text: '[mcp_servers.notes]\ncommand = "node"\n',
    },
    {
      provider: "cursor",
      file: ".cursor/mcp.json",
      text: JSON.stringify({ mcpServers: { notes: { command: "node" } } }),
    },
  ] as const)(
    "retains confirmed $provider MCP rows across a malformed refresh, then clears a confirmed deletion",
    async ({ provider, file: relative, text }) => {
      const file = path.join(home, relative);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text);
      const resource = createExtensionResource(async (query) =>
        nativeExtensionInventory(query, { home, env: {} }),
      );
      const key = resource.key({ category: "mcp", provider });
      const refresh = async () => {
        resource.cache.invalidate(key);
        await resource.cache.load(key, () => resource.fetch(key));
        return resource.cache.getSnapshot(key).data!;
      };
      const first = await refresh();
      expect(first.entries.map((entry) => entry.name)).toEqual(["notes"]);

      writeFileSync(file, "[incomplete");
      const failed = await refresh();
      expect(failed.warnings).toEqual([`Could not read ${file}.`]);
      expect(failed.entries).toMatchObject([
        {
          name: "notes",
          statusDetail: expect.stringContaining("Last reported"),
        },
      ]);
      expect(failed.partial).toBe(true);

      const other = resource.key({
        category: "mcp",
        provider,
        repoRoot: path.join(home, "repo"),
      });
      await resource.cache.load(other, () => resource.fetch(other));
      expect(resource.cache.getSnapshot(other).data?.entries).toEqual([]);

      writeFileSync(file, text);
      const repaired = await refresh();
      expect(repaired.entries).toEqual(first.entries);
      expect(repaired.partial).not.toBe(true);
      expect(repaired.warnings).toEqual([]);

      rmSync(file);
      const removed = await refresh();
      expect(removed.entries).toEqual([]);
      expect(removed.partial).not.toBe(true);
    },
  );

  it.each(["unreadable", "oversized"])(
    "marks a %s native config read as partial",
    (failure) => {
      const file = path.join(home, ".cursor/mcp.json");
      if (failure === "unreadable") mkdirSync(file, { recursive: true });
      else {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, " ".repeat(4 * 1024 * 1024 + 1));
      }
      expect(
        nativeExtensionInventory(
          { category: "mcp", provider: "cursor" },
          { home, env: {} },
        ),
      ).toMatchObject({ partial: true, warnings: [`Could not read ${file}.`] });
    },
  );

  it("does not flatten Claude project configs into user inventory or expose credentials", () => {
    const repoRoot = path.join(home, "repo");
    write(path.join(home, ".claude.json"), {
      mcpServers: {
        global: { url: "https://server", headers: { Authorization: "SECRET" } },
      },
      projects: {
        [repoRoot]: {
          mcpServers: { local: { command: "node", env: { TOKEN: "SECRET" } } },
        },
        "/other": { mcpServers: { foreign: { command: "node" } } },
      },
    });
    const user = nativeExtensionInventory(
      { category: "mcp", provider: "claude" },
      { home, env: {} },
    );
    const repo = nativeExtensionInventory(
      { category: "mcp", provider: "claude", repoRoot },
      { home, env: {} },
    );
    expect(user.entries.map((entry) => entry.name)).toEqual(["global"]);
    expect(repo.entries.map((entry) => entry.name)).toEqual([
      "This repository / local",
    ]);
    expect(JSON.stringify([user, repo])).not.toContain("SECRET");
  });
  it("carries a disabled plugin's status to its MCP components without executing hooks", () => {
    const plugin = path.join(home, "installed");
    write(path.join(home, ".claude/settings.json"), {
      enabledPlugins: { "tools@market": false },
    });
    write(path.join(home, ".claude/plugins/installed_plugins.json"), {
      plugins: { "tools@market": [{ scope: "user", installPath: plugin }] },
    });
    write(path.join(plugin, ".mcp.json"), {
      mcpServers: { tools: { command: "must-never-execute" } },
    });
    expect(
      nativeExtensionInventory(
        { category: "mcp", provider: "claude" },
        { home, env: {} },
      ).entries[0]?.status,
    ).toBe("disabled");
    const plugins = nativeExtensionInventory(
      { category: "plugins", provider: "claude" },
      { home, env: {} },
    );
    expect(plugins.entries).toHaveLength(1);
    expect(plugins.entries[0]?.components).toContain("MCP");
  });
  it("honors custom provider homes and labels app config as declarations", () => {
    const native = path.join(home, "custom");
    mkdirSync(native);
    writeFileSync(
      path.join(native, "config.toml"),
      '[mcp_servers.tools]\ncommand="node"\nenabled=false\n[apps.notes]\nenabled=true\n',
    );
    const options = { home, env: { CODEX_HOME: native } };
    expect(
      nativeExtensionInventory({ category: "mcp", provider: "codex" }, options)
        .entries[0]?.status,
    ).toBe("disabled");
    expect(
      nativeExtensionInventory({ category: "apps", provider: "codex" }, options)
        .entries[0]?.name,
    ).toBe("notes");
    expect(
      nativeExtensionInventory(
        { category: "apps", provider: "cursor" },
        { home, env: {} },
      ).note,
    ).toContain("does not expose");
  });
});

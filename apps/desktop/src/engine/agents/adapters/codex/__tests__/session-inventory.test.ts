import { describe, expect, it, vi } from "vitest";
import { readCodexSessionInventory } from "../session-inventory";

function fixture() {
  const responses: Record<string, unknown> = {
    "mcpServerStatus/list": {
      data: [
        { name: "codex_apps", runtimeStatus: "connected" },
        {
          name: "cloudflare-api",
          runtimeStatus: "authenticationRequired",
          authStatus: "notLoggedIn",
        },
        { name: "local", runtimeStatus: "connected" },
      ],
      nextCursor: null,
    },
    "app/installed": {
      apps: [
        {
          id: "notes",
          runtimeName: "Notes runtime",
          enabled: true,
          callable: true,
        },
        {
          id: "blocked",
          runtimeName: "Blocked",
          enabled: false,
          callable: true,
        },
        {
          id: "unavailable",
          runtimeName: "Unavailable",
          enabled: true,
          callable: false,
        },
      ],
    },
    "app/read": {
      apps: [
        {
          id: "notes",
          name: "Notes",
          pluginDisplayNames: ["Notes plugin"],
          iconUrl: "SECRET",
          toolSummaries: [{ name: "SECRET" }],
        },
        {
          id: "catalogue-only",
          name: "Never installed",
          pluginDisplayNames: [],
        },
      ],
      missingAppIds: [],
    },
    "plugin/installed": {
      marketplaces: [
        {
          name: "fixture",
          path: "/private/market",
          plugins: [
            {
              id: "notes",
              name: "Notes plugin",
              installed: true,
              enabled: true,
              availability: "AVAILABLE",
            },
            {
              id: "disabled",
              name: "Disabled plugin",
              installed: true,
              enabled: true,
              availability: "DISABLED_BY_ADMIN",
            },
            {
              id: "uninstalled",
              name: "Uninstalled",
              installed: false,
              enabled: true,
              availability: "AVAILABLE",
            },
          ],
        },
      ],
      marketplaceLoadErrors: [],
    },
  };
  const requestTyped = vi.fn(async (method: string) => {
    if (!(method in responses)) throw new Error("Unexpected read");
    return responses[method];
  });
  const read = (enabled = true) =>
    readCodexSessionInventory({ requestTyped } as never, "thread-a", {
      cwd: "/fixture/chat",
      excludedMcpServers: new Set(["local"]),
      accountExtensionsEnabled: enabled,
      accountAppBridgeEnabled: enabled,
    });
  return { requestTyped, responses, read };
}

describe("Codex grouped session inventory", () => {
  it("separates installed plugins, thread-callable apps and admitted MCP connections", async () => {
    const f = fixture();
    const result = await f.read();
    expect(result.state).toBe("ready");
    const groups = Object.fromEntries(
      result.groups!.map((group) => [group.kind, group]),
    );
    expect(
      groups.plugins.entries.map((entry) => [entry.name, entry.status]),
    ).toEqual([
      ["Notes plugin", "enabled"],
      ["Disabled plugin", "disabled"],
    ]);
    expect(
      groups.apps.entries.map((entry) => [entry.name, entry.status]),
    ).toEqual([
      ["Notes", "available"],
      ["Blocked", "disabled"],
      ["Unavailable", "unavailable"],
    ]);
    expect(groups.apps.entries[0].detail).toContain("Notes plugin");
    expect(groups.mcp.entries.map((entry) => entry.name)).toEqual([
      "codex_apps",
      "cloudflare-api",
    ]);
    expect(groups.mcp.entries[1]).toMatchObject({
      status: "needs-auth",
      canAuthenticate: true,
    });
    expect(groups.apps.entries.every((entry) => !entry.canAuthenticate)).toBe(
      true,
    );
    expect(JSON.stringify(result)).not.toMatch(
      /SECRET|private\/market|Never installed|Uninstalled/,
    );
    expect(f.requestTyped).toHaveBeenCalledWith(
      "app/installed",
      { threadId: "thread-a", forceRefresh: true },
      expect.anything(),
    );
    expect(f.requestTyped).toHaveBeenCalledWith(
      "app/read",
      {
        threadId: "thread-a",
        appIds: ["notes", "blocked", "unavailable"],
        includeTools: false,
      },
      expect.anything(),
    );
    expect(f.requestTyped).toHaveBeenCalledWith(
      "plugin/installed",
      { cwds: ["/fixture/chat"] },
      expect.anything(),
    );
    expect(
      f.requestTyped.mock.calls.some(([method]) => method === "app/list"),
    ).toBe(false);
  });

  it.each(["app/installed", "plugin/installed", "mcpServerStatus/list"])(
    "keeps other categories when %s fails",
    async (failedMethod) => {
      const f = fixture();
      delete f.responses[failedMethod];
      const result = await f.read();
      expect(result.state).toBe("partial");
      expect(
        result.groups!.filter((group) => group.state === "partial"),
      ).toHaveLength(1);
      expect(
        result.groups!.filter((group) => group.state === "ready"),
      ).toHaveLength(2);
    },
  );

  it("retains exact app availability when optional naming metadata is unavailable", async () => {
    const f = fixture();
    delete f.responses["app/read"];
    const apps = (await f.read()).groups!.find(
      (group) => group.kind === "apps",
    )!;
    expect(apps.state).toBe("partial");
    expect(apps.entries[0]).toMatchObject({
      name: "Notes runtime",
      status: "available",
    });
  });

  it("does not claim callable apps are available while their shared MCP connection is failing", async () => {
    const f = fixture();
    f.responses["mcpServerStatus/list"] = {
      data: [{ name: "codex_apps", runtimeStatus: "failed" }],
      nextCursor: null,
    };
    const apps = (await f.read()).groups!.find(
      (group) => group.kind === "apps",
    )!;
    expect(apps.entries[0]).toMatchObject({ status: "unavailable" });
    expect(apps.entries[1]).toMatchObject({ status: "disabled" });
  });

  it("does not treat an imported MCP named codex_apps as the account app bridge", async () => {
    const f = fixture();
    const result = await readCodexSessionInventory(
      { requestTyped: f.requestTyped } as never,
      "thread-a",
      {
        cwd: "/fixture/chat",
        excludedMcpServers: new Set(["local"]),
        accountExtensionsEnabled: true,
        accountAppBridgeEnabled: false,
      },
    );
    const apps = result.groups!.find((group) => group.kind === "apps")!;
    const mcp = result.groups!.find((group) => group.kind === "mcp")!;
    expect(apps.entries[0]).toMatchObject({ status: "unavailable" });
    expect(mcp.entries[0]).toMatchObject({ status: "connected" });
    expect(mcp.entries[0].detail ?? "").not.toContain("Shared MCP connection");
  });

  it("keeps valid app receipts when a provider returns a malformed row", async () => {
    const f = fixture();
    const installed = f.responses["app/installed"] as { apps: unknown[] };
    installed.apps.push({
      id: "invalid",
      runtimeName: "Invalid",
      enabled: "true",
      callable: true,
    });
    installed.apps.push(null);
    installed.apps.push({
      id: "blank",
      runtimeName: "  ",
      enabled: true,
      callable: true,
    });
    const apps = (await f.read()).groups!.find(
      (group) => group.kind === "apps",
    )!;
    expect(apps.state).toBe("partial");
    expect(apps.entries).toHaveLength(4);
    expect(apps.entries.find((entry) => entry.id === "blank")?.name).toBe(
      "Unnamed app",
    );
    expect(apps.entries.some((entry) => entry.id === "invalid")).toBe(false);
  });

  it("does not start account inventory reads for restricted sessions", async () => {
    const f = fixture();
    const result = await f.read(false);
    expect(f.requestTyped.mock.calls.map(([method]) => method)).toEqual([
      "mcpServerStatus/list",
    ]);
    expect(
      result
        .groups!.slice(0, 2)
        .every((group) => group.state === "unsupported"),
    ).toBe(true);
  });

  it("keeps equal plugin names from different marketplaces distinct without returning paths", async () => {
    const f = fixture();
    const result = f.responses["plugin/installed"] as {
      marketplaces: Array<{ name: string; path: string; plugins: unknown[] }>;
    };
    result.marketplaces.push({
      ...result.marketplaces[0],
      path: "/private/other",
    });
    const plugins = (await f.read()).groups!.find(
      (group) => group.kind === "plugins",
    )!;
    expect(plugins.entries).toHaveLength(4);
    expect(new Set(plugins.entries.map((entry) => entry.id)).size).toBe(4);
    expect(JSON.stringify(plugins)).not.toContain("/private/");
  });
});

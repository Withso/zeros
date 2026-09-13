import { describe, expect, it, vi } from "vitest";
import {
  boundedCodexInventoryRuntime,
  readCodexExtensions,
} from "../extensions";
import type { CodexAppServerHandle } from "../app-server";

describe("Codex extension inventory", () => {
  it("bounds cumulative discovery time and stops issuing requests after the deadline", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const requestTyped = vi.fn().mockResolvedValue({ data: [] });
      const runtime = boundedCodexInventoryRuntime(
        { requestTyped } as unknown as Pick<
          CodexAppServerHandle,
          "requestTyped"
        >,
        4_000,
      );
      await runtime.requestTyped("skills/list", { cwds: ["/repo"] });
      expect(requestTyped).toHaveBeenCalledExactlyOnceWith(
        "skills/list",
        { cwds: ["/repo"] },
        { timeoutMs: 4_000 },
      );
      clock.mockReturnValue(5_000);
      await expect(
        runtime.requestTyped("skills/list", { cwds: ["/repo"] }),
      ).rejects.toThrow("timed out");
      expect(requestTyped).toHaveBeenCalledOnce();
    } finally {
      clock.mockRestore();
    }
  });
  it("reads effective skills including plugin ownership and disabled definitions", async () => {
    const requestTyped = vi.fn().mockResolvedValue({
      data: [
        {
          cwd: "/repo",
          skills: [
            {
              path: "/plugin/SKILL.md",
              name: "review",
              description: "Review",
              enabled: false,
              pluginId: "plugin",
            },
          ],
          errors: [{}],
        },
      ],
    });
    const result = await readCodexExtensions(
      { requestTyped } as unknown as Pick<CodexAppServerHandle, "requestTyped">,
      "skills",
      "/repo",
    );
    expect(result.entries).toMatchObject([
      { name: "review", status: "disabled", components: ["Plugin: plugin"] },
    ]);
    expect(result.partial).toBe(true);
    expect(requestTyped).toHaveBeenCalledExactlyOnceWith("skills/list", {
      cwds: ["/repo"],
      forceReload: true,
    });
  });
  it("discovers installed plugin MCP components while retaining config results when another plugin fails", async () => {
    const requestTyped = vi.fn(
      async (method: string, params: { pluginName?: string }) => {
        if (method === "config/read")
          return {
            config: {
              mcp_servers: {
                local: {
                  command: "never-run",
                  env: { KEY: "SECRET" },
                  enabled: false,
                },
              },
            },
          };
        if (method === "plugin/installed")
          return {
            marketplaces: [
              {
                name: "account",
                path: null,
                plugins: [
                  {
                    id: "tools",
                    name: "tools",
                    installed: true,
                    enabled: true,
                  },
                  {
                    id: "failed",
                    name: "failed",
                    installed: true,
                    enabled: true,
                  },
                ],
              },
            ],
            marketplaceLoadErrors: [],
          };
        if (params.pluginName === "failed") throw new Error("private failure");
        return { plugin: { mcpServers: ["notes"] } };
      },
    );
    const result = await readCodexExtensions(
      { requestTyped } as unknown as Pick<CodexAppServerHandle, "requestTyped">,
      "mcp",
      "/repo",
    );
    expect(result.entries.map((entry) => [entry.name, entry.status])).toEqual([
      ["local", "disabled"],
      ["tools / notes", "configured"],
    ]);
    expect(result.partial).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(
      /SECRET|private failure|never-run/,
    );
    expect(
      requestTyped.mock.calls.some(([method]) => method === "thread/start"),
    ).toBe(false);
  });
  it("paginates account apps, omits inaccessible catalog entries, and keeps native disabled state", async () => {
    const requestTyped = vi
      .fn()
      .mockResolvedValueOnce({
        data: [
          { id: "notes", name: "Notes", isAccessible: true, isEnabled: false },
          {
            id: "catalog",
            name: "Catalog",
            isAccessible: false,
            isEnabled: true,
          },
        ],
        nextCursor: "more",
      })
      .mockResolvedValueOnce({
        data: [
          {
            id: "calendar",
            name: "Calendar",
            isAccessible: true,
            isEnabled: true,
          },
        ],
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        apps: [
          { id: "calendar", enabled: true, callable: true },
          { id: "notes", enabled: false, callable: false },
        ],
      });
    const result = await readCodexExtensions(
      { requestTyped } as unknown as Pick<CodexAppServerHandle, "requestTyped">,
      "apps",
      "/repo",
    );
    expect(result.entries.map((entry) => [entry.id, entry.status])).toEqual([
      ["calendar", "available"],
      ["notes", "disabled"],
    ]);
    expect(requestTyped.mock.calls.map((call) => call[0])).toEqual([
      "app/list",
      "app/list",
      "app/installed",
    ]);
    expect(requestTyped.mock.calls[1]?.[1]).toMatchObject({
      cursor: "more",
      forceRefetch: false,
    });
  });
  it("does not claim an account app is callable just because it is accessible", async () => {
    const requestTyped = vi.fn(async (method: string) =>
      method === "app/list"
        ? {
            data: [
              {
                id: "desktop",
                name: "Desktop tool",
                isAccessible: true,
                isEnabled: true,
              },
              {
                id: "unknown",
                name: "Unverified",
                isAccessible: true,
                isEnabled: true,
              },
            ],
            nextCursor: null,
          }
        : { apps: [{ id: "desktop", enabled: true, callable: false }] },
    );
    const result = await readCodexExtensions(
      { requestTyped } as unknown as Pick<CodexAppServerHandle, "requestTyped">,
      "apps",
      "/repo",
    );
    expect(result.entries.map((entry) => [entry.id, entry.status])).toEqual([
      ["desktop", "unavailable"],
      ["unknown", "configured"],
    ]);
    expect(result.entries.every((entry) => entry.statusDetail)).toBe(true);
  });

  it("retains account inventory when runtime availability cannot be read", async () => {
    const requestTyped = vi.fn(async (method: string) => {
      if (method === "app/installed") throw new Error("unsupported");
      return {
        data: [
          { id: "cloud", name: "Cloud", isAccessible: true, isEnabled: true },
        ],
        nextCursor: null,
      };
    });
    const result = await readCodexExtensions(
      { requestTyped } as unknown as Pick<CodexAppServerHandle, "requestTyped">,
      "apps",
      "/repo",
    );
    expect(result.entries[0]?.status).toBe("configured");
    expect(result.warnings).toEqual([expect.stringContaining("availability")]);
  });

  it("shows installed plugins only, preserving partial marketplace failures", async () => {
    const requestTyped = vi.fn().mockResolvedValue({
      marketplaces: [
        {
          name: "native",
          path: null,
          plugins: [
            { id: "installed", name: "Tools", installed: true, enabled: false },
            { id: "catalog", name: "Other", installed: false, enabled: true },
          ],
        },
      ],
      marketplaceLoadErrors: [{}],
    });
    const result = await readCodexExtensions(
      { requestTyped } as unknown as Pick<CodexAppServerHandle, "requestTyped">,
      "plugins",
      "/repo",
    );
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.status).toBe("disabled");
    expect(result.warnings).toHaveLength(1);
    expect(requestTyped).toHaveBeenCalledExactlyOnceWith("plugin/installed", {
      cwds: ["/repo"],
    });
  });
});

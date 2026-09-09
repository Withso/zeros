import { describe, expect, it, vi } from "vitest";
import { readCodexExtensions } from "../extensions";
import type { CodexAppServerHandle } from "../app-server";

describe("Codex extension inventory", () => {
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

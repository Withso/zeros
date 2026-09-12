import { describe, expect, it, vi } from "vitest";
import { createExtensionResource } from "../extensions-cache";
import { decodeCustomizeSelection } from "../customize-model";
import {
  extensionProviders,
  type ExtensionInventory,
} from "@zeros/protocol/agent-extensions";

describe("customization ownership", () => {
  it("bounds selection to supported category/provider pairs", () => {
    expect(extensionProviders("mcp")).toEqual([
      "zeros",
      "claude",
      "codex",
      "cursor",
    ]);
    expect(extensionProviders("skills")).toBe(extensionProviders("mcp"));
    expect(extensionProviders("plugins")).toEqual([
      "claude",
      "codex",
      "cursor",
    ]);
    expect(extensionProviders("apps")).toBe(extensionProviders("plugins"));
    expect(
      decodeCustomizeSelection({ category: "plugins", provider: "zeros" }),
    ).toEqual({ category: "plugins", provider: "claude" });
    expect(
      decodeCustomizeSelection({ category: "removed", provider: "missing" }),
    ).toEqual({ category: "mcp", provider: "zeros" });
  });
  it("retains account entries after a partial refresh only under the same key, without claiming fresh availability", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({
        entries: [
          {
            id: "cloud",
            name: "Cloud",
            description: "",
            sourcePath: "Account",
            status: "available",
          },
        ],
        warnings: [],
      })
      .mockResolvedValue({
        entries: [],
        warnings: ["Native inventory unavailable"],
        partial: true,
      });
    const resource = createExtensionResource(read);
    const a = resource.key({
      category: "apps",
      provider: "codex",
      repoRoot: "/a",
    });
    const b = resource.key({
      category: "apps",
      provider: "codex",
      repoRoot: "/b",
    });
    await resource.cache.load(a, () => resource.fetch(a));
    resource.cache.invalidate(a);
    await resource.cache.load(a, () => resource.fetch(a));
    expect(resource.cache.getSnapshot(a).data?.entries).toMatchObject([
      {
        id: "cloud",
        status: "configured",
        statusDetail: expect.stringContaining("Last reported"),
      },
    ]);
    await resource.cache.load(b, () => resource.fetch(b));
    expect(resource.cache.getSnapshot(b).data?.entries).toEqual([]);
    read.mockResolvedValue({ entries: [], warnings: [] });
    resource.cache.invalidate(a);
    await resource.cache.load(a, () => resource.fetch(a));
    expect(resource.cache.getSnapshot(a).data?.entries).toEqual([]);
  });

  it("keeps late reads under their exact repository and provider and retains confirmed snapshots", async () => {
    const pending = new Map<string, (data: ExtensionInventory) => void>();
    const resource = createExtensionResource(
      (query) =>
        new Promise((resolve) =>
          pending.set(`${query.repoRoot}:${query.provider}`, resolve),
        ),
    );
    const a = resource.key({
      repoRoot: "/a",
      category: "skills",
      provider: "claude",
    });
    const b = resource.key({
      repoRoot: "/b",
      category: "skills",
      provider: "codex",
    });
    const first = resource.cache.load(a, () => resource.fetch(a));
    const second = resource.cache.load(b, () => resource.fetch(b));
    await Promise.resolve();
    const resultA = { entries: [], warnings: ["A"] },
      resultB = { entries: [], warnings: ["B"] };
    pending.get("/b:codex")!(resultB);
    await second;
    pending.get("/a:claude")!(resultA);
    await first;
    resource.cache.invalidate(a);
    expect(resource.cache.getSnapshot(a).data).toBe(resultA);
    expect(resource.cache.getSnapshot(b).data).toBe(resultB);
    await expect(
      createExtensionResource(async () => resultB).fetch(a),
    ).rejects.toThrow("connection changed");
  });
});

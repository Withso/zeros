import { describe, expect, it, vi } from "vitest";
import { createExtensionResource } from "../extensions-cache";
import { decodeCustomizeSelection } from "../customize-model";
import { providerAuthChanged } from "../../../platform/provider-auth-state";
import {
  extensionProviders,
  type ExtensionInventory,
} from "@zeros/protocol/agent-extensions";

describe("customization ownership", () => {
  it("makes late reads unreachable after an authentication change", async () => {
    let finish!: (value: ExtensionInventory) => void;
    const resource = createExtensionResource(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const query = { category: "apps", provider: "codex" } as const;
    const oldKey = resource.key(query);
    const pending = resource.cache.load(oldKey, () => resource.fetch(oldKey));
    await Promise.resolve();
    providerAuthChanged();
    const newKey = resource.key(query);
    expect(newKey).not.toBe(oldKey);
    finish({ entries: [], warnings: ["Old account"] });
    await pending;
    expect(resource.cache.getSnapshot(newKey).data).toBeUndefined();
    await expect(resource.fetch(oldKey)).rejects.toThrow("connection changed");
  });
  it("never retains entries from a different or unverified account after a partial refresh", async () => {
    const read = vi.fn().mockResolvedValue({
      identity: "account-a",
      sources: [{ id: "account", kind: "account", state: "complete" }],
      entries: [
        {
          id: "private",
          name: "Private",
          description: "",
          sourcePath: "Account",
          sourceId: "account",
          status: "available",
        },
      ],
      warnings: [],
    });
    const resource = createExtensionResource(read);
    const key = resource.key({ category: "apps", provider: "codex" });
    await resource.cache.load(key, () => resource.fetch(key));
    read.mockResolvedValue({
      identity: "account-b",
      sources: [{ id: "account", kind: "account", state: "partial" }],
      entries: [],
      warnings: [],
      partial: true,
    });
    resource.cache.invalidate(key);
    await resource.cache.load(key, () => resource.fetch(key));
    expect(resource.cache.getSnapshot(key).data?.entries).toEqual([]);
  });

  it("removes confirmed local deletions when only the account source failed", async () => {
    const read = vi.fn().mockResolvedValue({
      identity: "same-account",
      sources: [
        { id: "local", kind: "local", state: "complete" },
        { id: "account", kind: "account", state: "complete" },
      ],
      entries: [
        {
          id: "deleted",
          name: "Deleted",
          description: "",
          sourcePath: "/local",
          sourceId: "local",
          status: "configured",
        },
      ],
      warnings: [],
    });
    const resource = createExtensionResource(read);
    const key = resource.key({ category: "plugins", provider: "codex" });
    await resource.cache.load(key, () => resource.fetch(key));
    read.mockResolvedValue({
      identity: "same-account",
      sources: [
        { id: "local", kind: "local", state: "complete" },
        { id: "account", kind: "account", state: "partial" },
      ],
      entries: [],
      warnings: [],
      partial: true,
    });
    resource.cache.invalidate(key);
    await resource.cache.load(key, () => resource.fetch(key));
    expect(resource.cache.getSnapshot(key).data?.entries).toEqual([]);
  });

  it("keeps backend inventories available but restores Customize to Zeros-owned capabilities", () => {
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
    ).toEqual({ category: "mcp", provider: "zeros" });
    expect(
      decodeCustomizeSelection({ category: "skills", provider: "cursor" }),
    ).toEqual({ category: "skills", provider: "zeros" });
    expect(
      decodeCustomizeSelection({ category: "apps", provider: "codex" }),
    ).toEqual({ category: "mcp", provider: "zeros" });
    expect(
      decodeCustomizeSelection({ category: "removed", provider: "missing" }),
    ).toEqual({ category: "mcp", provider: "zeros" });
  });
  it("retains account entries after a partial refresh only under the same key, without claiming fresh availability", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({
        identity: "same-account",
        sources: [{ id: "account", kind: "account", state: "complete" }],
        entries: [
          {
            id: "cloud",
            name: "Cloud",
            description: "",
            sourcePath: "Account",
            sourceId: "account",
            status: "available",
          },
        ],
        warnings: [],
      })
      .mockResolvedValue({
        identity: "same-account",
        sources: [{ id: "account", kind: "account", state: "partial" }],
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

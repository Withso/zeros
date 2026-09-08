import type {
  ExtensionEntry,
  ExtensionInventory,
  ExtensionQuery,
} from "@zeros/protocol/agent-extensions";
import { KeyedAsyncCache } from "../../shared/lib/keyed-async-cache";
import { getActiveBridge } from "../../platform/bridge/active-bridge";
import { workspaceOp } from "../../platform/bridge/workspace-bridge";
import type { RuntimeClient } from "../../platform/bridge/ws-client";

let nextOwner = 0;
export function createExtensionResource(
  read: (query: ExtensionQuery) => Promise<ExtensionInventory>,
) {
  const owner = ++nextOwner;
  const cache = new KeyedAsyncCache<ExtensionInventory>({
    maxEntries: 48,
    maxWeight: 4 * 1024 * 1024,
    weightOf: (data) => JSON.stringify(data).length,
  });
  return {
    cache,
    key: (query: ExtensionQuery) =>
      JSON.stringify([
        owner,
        query.repoRoot ?? null,
        query.category,
        query.provider,
      ]),
    fetch: (key: string) => {
      const [keyOwner, root, category, provider] = JSON.parse(key) as [
        number,
        string | null,
        ExtensionQuery["category"],
        ExtensionQuery["provider"],
      ];
      if (keyOwner !== owner)
        return Promise.reject(
          new Error("The customization connection changed. Refresh to retry."),
        );
      const previous = cache.getSnapshot(key).data;
      return read({
        category,
        provider,
        ...(root ? { repoRoot: root } : {}),
      }).then((result) => {
        if (!result.partial || !previous?.entries.length) return result;
        const entries = new Map<string, ExtensionEntry>(
          previous.entries.map((entry) => [
            entry.id,
            {
              ...entry,
              status:
                entry.status === "available"
                  ? ("configured" as const)
                  : entry.status,
              statusDetail:
                "Last reported by the provider. Current availability could not be checked.",
            },
          ]),
        );
        for (const entry of result.entries)
          entries.set(entry.id, {
            ...entry,
            statusDetail:
              entry.statusDetail ??
              "Current local declaration; runtime availability may differ.",
          });
        return {
          ...result,
          entries: [...entries.values()].sort((a, b) =>
            a.name.localeCompare(b.name),
          ),
        };
      });
    },
  };
}
const resources = new WeakMap<
  RuntimeClient,
  ReturnType<typeof createExtensionResource>
>();
export function extensionResource(bridge: RuntimeClient) {
  let resource = resources.get(bridge);
  if (!resource) {
    resource = createExtensionResource((query) => {
      if (bridge.executionIdentity.kind !== "local")
        return Promise.reject(
          new Error("Personal customization belongs to this device."),
        );
      return workspaceOp(
        bridge,
        "extensions.list",
        query,
        30_000,
      ) as Promise<ExtensionInventory>;
    });
    resources.set(bridge, resource);
  }
  return resource;
}
export function prefetchExtensions(query: ExtensionQuery): void {
  const bridge = getActiveBridge();
  if (
    !bridge ||
    bridge.status !== "connected" ||
    bridge.executionIdentity.kind !== "local" ||
    (query.category === "mcp" && query.provider === "zeros")
  )
    return;
  const resource = extensionResource(bridge);
  const key = resource.key(query);
  void resource.cache
    .load(key, () => resource.fetch(key), { maxAgeMs: 30_000 })
    .catch(() => {});
}

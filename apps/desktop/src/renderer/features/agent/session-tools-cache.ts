import {
  sessionToolsInventorySnapshotSchema,
  SESSION_TOOL_GROUPS,
  type SessionToolQuery,
  type SessionToolsInventorySnapshot,
  type SessionToolGroup,
} from "@zeros/protocol/agent-extensions";
import { KeyedAsyncCache } from "../../shared/lib/keyed-async-cache";
import {
  runtimeExecutionKey,
  type RuntimeClient,
} from "../../platform/bridge/ws-client";
import { workspaceOp } from "../../platform/bridge/workspace-bridge";
import { providerAuthRevision } from "../../platform/provider-auth-state";

let nextOwner = 0;
export function createSessionToolsResource(
  read: (query: SessionToolQuery) => Promise<unknown>,
  identity: () => string = () => "local",
) {
  const owner = ++nextOwner;
  const cache = new KeyedAsyncCache<SessionToolsInventorySnapshot>({
    maxEntries: 32,
    maxWeight: 2 * 1024 * 1024,
    weightOf: (data) => JSON.stringify(data).length,
  });
  const key = (query: SessionToolQuery) =>
    JSON.stringify([owner, identity(), providerAuthRevision(), query]);
  const isCurrent = (candidate: string) => {
    const [keyOwner, keyIdentity, revision] = JSON.parse(candidate) as [
      number,
      string,
      number,
    ];
    return (
      keyOwner === owner &&
      keyIdentity === identity() &&
      revision === providerAuthRevision()
    );
  };
  return {
    cache,
    key,
    identity,
    isCurrent,
    fetch: async (candidate: string) => {
      if (!isCurrent(candidate))
        throw new Error("The chat connection changed.");
      const query = (
        JSON.parse(candidate) as [number, string, number, SessionToolQuery]
      )[3];
      const result = sessionToolsInventorySnapshotSchema.parse(
        await read(query),
      );
      if (!isCurrent(candidate))
        throw new Error("The chat connection changed.");
      const previous = cache.getSnapshot(candidate).data;
      const previousRows = new Map(
        previous?.entries.map((entry) => [entry.id, entry]),
      );
      const rows = new Map(result.entries.map((entry) => [entry.id, entry]));
      const mcpState =
        result.groups?.find((group) => group.kind === "mcp")?.state ??
        result.state;
      if (mcpState === "partial") {
        for (const entry of previous?.entries ?? []) {
          if (!rows.has(entry.id) && rows.size < 1000)
            rows.set(entry.id, {
              ...entry,
              status: "error",
              canAuthenticate: false,
              detail: "This tool could not be verified in the latest refresh.",
            });
        }
      }
      const entries = [...rows.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((entry) => {
          const prior = previousRows.get(entry.id);
          return prior && JSON.stringify(prior) === JSON.stringify(entry)
            ? prior
            : entry;
        });
      const groups = result.groups
        ?.slice()
        .sort(
          (a, b) =>
            SESSION_TOOL_GROUPS.indexOf(a.kind) -
            SESSION_TOOL_GROUPS.indexOf(b.kind),
        )
        .map((group): SessionToolGroup => {
          const prior = previous?.groups?.find(
            (candidate) => candidate.kind === group.kind,
          );
          const rows = new Map(group.entries.map((entry) => [entry.id, entry]));
          // Completeness belongs to a category. A failed plugin read must not
          // revive an app authoritatively removed from a successful app snapshot.
          if (group.state === "partial") {
            for (const entry of prior?.entries ?? []) {
              if (!rows.has(entry.id) && rows.size < 1000)
                rows.set(entry.id, {
                  ...entry,
                  status: "unverified",
                  canAuthenticate: false,
                  detail:
                    "This entry could not be verified in the latest refresh.",
                });
            }
          }
          const previousRows = new Map(
            prior?.entries.map((entry) => [entry.id, entry]),
          );
          const entries = [...rows.values()]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((entry) => {
              const previous = previousRows.get(entry.id);
              return previous &&
                JSON.stringify(previous) === JSON.stringify(entry)
                ? previous
                : entry;
            });
          if (
            prior &&
            prior.state === group.state &&
            prior.detail === group.detail &&
            prior.entries.length === entries.length &&
            entries.every((entry, index) => entry === prior.entries[index])
          )
            return prior;
          return { ...group, entries };
        });
      const sameGroups =
        groups === undefined
          ? previous?.groups === undefined
          : previous?.groups?.length === groups.length &&
            groups.every((group, index) => group === previous.groups![index]);
      if (
        previous &&
        previous.state === result.state &&
        previous.detail === result.detail &&
        sameGroups &&
        previous.entries.length === entries.length &&
        entries.every((entry, i) => entry === previous.entries[i])
      )
        return previous;
      return { ...result, entries, ...(groups ? { groups } : {}) };
    },
  };
}

/** Negotiate the additive inventory operation without changing the strict
 * legacy list response. Capability fallback is scoped to one engine identity;
 * transport, authentication and provider errors must still surface normally. */
export function createSessionInventoryReader(
  read: (op: string, query: SessionToolQuery) => Promise<unknown>,
  identity: () => string,
) {
  let legacyIdentity: string | undefined;
  return async (query: SessionToolQuery): Promise<unknown> => {
    const owner = identity();
    if (legacyIdentity !== owner) {
      try {
        return await read("tools.session.inventory", query);
      } catch (error) {
        const value = error as { code?: string; message?: string };
        const unsupported =
          value?.code === "REMOTE_OP_NOT_ALLOWED" ||
          (value?.code === "VALIDATION_FAILED" &&
            value.message === "unknown workspace op: tools.session.inventory");
        if (!unsupported || owner !== identity()) throw error;
        legacyIdentity = owner;
      }
    }
    return read("tools.session.list", query);
  };
}

/** Opening the slash picker can prepare the same control connection as Tools.
 * Admission owns session creation; this read never submits a prompt. */
export async function warmPreparedSessionTools(
  resource: ReturnType<typeof createSessionToolsResource>,
  prepare: () => Promise<void>,
  currentQuery: () => SessionToolQuery | null,
): Promise<void> {
  const identity = resource.identity();
  const authRevision = providerAuthRevision();
  await prepare();
  if (
    identity !== resource.identity() ||
    authRevision !== providerAuthRevision()
  )
    return;
  const query = currentQuery();
  if (!query) return;
  const key = resource.key(query);
  await resource.cache.load(key, () => resource.fetch(key), {
    maxAgeMs: 5_000,
  });
}

const resources = new WeakMap<
  RuntimeClient,
  ReturnType<typeof makeBridgeResource>
>();
function makeBridgeResource(bridge: RuntimeClient) {
  let epoch = 0;
  const listeners = new Set<() => void>();
  const identity = () =>
    JSON.stringify([
      runtimeExecutionKey(bridge.executionIdentity),
      epoch,
      bridge.status,
    ]);
  const changed = () => {
    epoch++;
    for (const listener of listeners) listener();
  };
  bridge.onStatusChange(changed);
  bridge.onExecutionIdentityChange(changed);
  const read = createSessionInventoryReader(
    (op, query) =>
      workspaceOp(
        bridge,
        op,
        {
          ...query,
          ...(bridge.executionIdentity.kind === "cloud"
            ? { workspaceId: bridge.executionIdentity.workspaceId }
            : {}),
        },
        12_000,
      ),
    identity,
  );
  return {
    ...createSessionToolsResource(read, identity),
    identity,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
export function sessionToolsResource(bridge: RuntimeClient) {
  let resource = resources.get(bridge);
  if (!resource) {
    resource = makeBridgeResource(bridge);
    resources.set(bridge, resource);
  }
  return resource;
}

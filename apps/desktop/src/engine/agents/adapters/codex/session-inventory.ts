import { createHash } from "node:crypto";
import type {
  SessionToolGroup,
  SessionToolsInventorySnapshot,
  SessionToolsSnapshot,
} from "@zeros/protocol/agent-extensions";
import type { CodexAppServerHandle } from "./app-server";
import type { AppsInstalledResponse } from "./generated/v2/AppsInstalledResponse";
import type { AppsReadResponse } from "./generated/v2/AppsReadResponse";
import type { PluginInstalledResponse } from "./generated/v2/PluginInstalledResponse";
import { boundedCodexInventoryRuntime } from "./extensions";
import { readCodexSessionTools } from "./session-tools";

type Runtime = Pick<CodexAppServerHandle, "requestTyped">;
const LIMIT = 1000;
const label = (value: string) => value.trim().slice(0, 512);

function unavailable(kind: SessionToolGroup["kind"]): SessionToolGroup {
  return {
    kind,
    state: "partial",
    entries: [],
    detail: `Could not refresh ${kind === "mcp" ? "MCP connections" : kind}. Refresh to retry.`,
  };
}

async function readApps(
  runtime: Runtime,
  threadId: string,
): Promise<SessionToolGroup> {
  // app/list includes directory entries the account has never connected.
  // Only the installed runtime, evaluated against this loaded thread, proves
  // membership and effective tool availability.
  const installed = await runtime.requestTyped<
    "app/installed",
    AppsInstalledResponse
  >("app/installed", { threadId, forceRefresh: true });
  let partial = installed.apps.length > LIMIT;
  const apps = new Map(
    installed.apps
      .slice(0, LIMIT)
      .filter((app) => {
        const valid =
          app != null &&
          typeof app.id === "string" &&
          app.id.length > 0 &&
          app.id.length <= 512 &&
          (app.runtimeName === null || typeof app.runtimeName === "string") &&
          typeof app.enabled === "boolean" &&
          typeof app.callable === "boolean";
        if (!valid) partial = true;
        return valid;
      })
      .map((app) => [app.id, app]),
  );
  const entries = new Map(
    [...apps.values()].map((app) => [
      app.id,
      {
        id: app.id,
        name: label(app.runtimeName || "") || "Unnamed app",
        status: !app.enabled
          ? ("disabled" as const)
          : app.callable
            ? ("available" as const)
            : ("unavailable" as const),
        detail: !app.enabled
          ? "Disabled by this chat’s effective app settings or policy."
          : !app.callable
            ? "Codex has not exposed usable tools for this app in this chat. Check its connection and permissions in Codex."
            : "Tools are available to this chat through codex_apps.",
      },
    ]),
  );
  const ids = [...apps.keys()];
  // Metadata only names installed rows. It never adds catalogue entries or
  // promotes a connected bridge into evidence that an individual app works.
  for (let offset = 0; offset < ids.length; offset += 100) {
    try {
      const metadata = await runtime.requestTyped<"app/read", AppsReadResponse>(
        "app/read",
        {
          threadId,
          appIds: ids.slice(offset, offset + 100),
          includeTools: false,
        },
      );
      for (const app of metadata.apps) {
        const entry = entries.get(app.id);
        if (!entry) continue;
        if (app.name?.trim()) entry.name = label(app.name);
        const plugins = app.pluginDisplayNames
          ?.slice(0, 4)
          .map(label)
          .filter(Boolean);
        if (plugins?.length)
          entry.detail = `${entry.detail} From ${plugins.join(", ")}.`.slice(
            0,
            1000,
          );
      }
    } catch {
      partial = true;
      break;
    }
  }
  return {
    kind: "apps",
    state: partial ? "partial" : "ready",
    entries: [...entries.values()],
    detail: partial
      ? "Some app details could not be read. Availability comes from this chat’s installed app runtime."
      : "Apps reported by this chat. Plugins can include apps; codex_apps is their shared MCP connection.",
  };
}

async function readPlugins(
  runtime: Runtime,
  cwd: string,
): Promise<SessionToolGroup> {
  const result = await runtime.requestTyped<
    "plugin/installed",
    PluginInstalledResponse
  >("plugin/installed", { cwds: [cwd] });
  const entries = new Map<string, SessionToolGroup["entries"][number]>();
  let partial = result.marketplaceLoadErrors.length > 0;
  for (const market of result.marketplaces) {
    for (const plugin of market.plugins) {
      if (plugin.installed !== true) continue;
      if (
        typeof plugin.name !== "string" ||
        !plugin.name.trim() ||
        typeof plugin.id !== "string" ||
        !plugin.id ||
        typeof plugin.enabled !== "boolean" ||
        !["AVAILABLE", "DISABLED_BY_ADMIN"].includes(plugin.availability)
      ) {
        partial = true;
        continue;
      }
      // Marketplace paths remain in the engine; only an opaque row identity
      // crosses the wire. Equal plugin names in different markets stay distinct.
      const id = createHash("sha256")
        .update(JSON.stringify([market.name, market.path, plugin.id]))
        .digest("hex");
      if (entries.size >= LIMIT && !entries.has(id)) {
        partial = true;
        continue;
      }
      const enabled = plugin.enabled && plugin.availability === "AVAILABLE";
      entries.set(id, {
        id,
        name: label(plugin.interface?.displayName || plugin.name),
        status: enabled ? "enabled" : "disabled",
        detail:
          plugin.availability === "DISABLED_BY_ADMIN"
            ? "Disabled by your organization."
            : enabled
              ? "Enabled for this workspace. App and MCP availability is shown in their groups."
              : "Installed, but disabled in Codex.",
      });
    }
  }
  return {
    kind: "plugins",
    state: partial ? "partial" : "ready",
    entries: [...entries.values()],
    detail:
      "Installed for this chat’s workspace. Codex reports plugin enablement separately from loaded app and MCP connections.",
  };
}

export async function readCodexSessionInventory(
  runtime: Runtime,
  threadId: string,
  {
    cwd,
    excludedMcpServers,
    accountExtensionsEnabled,
    accountAppBridgeEnabled,
  }: {
    cwd: string;
    excludedMcpServers: ReadonlySet<string>;
    accountExtensionsEnabled: boolean;
    accountAppBridgeEnabled: boolean;
  },
): Promise<SessionToolsInventorySnapshot> {
  const bounded = boundedCodexInventoryRuntime(runtime, 8_000);
  const notExposed = (kind: "plugins" | "apps"): SessionToolGroup => ({
    kind,
    state: "unsupported",
    entries: [],
    detail: `${kind === "apps" ? "Account apps" : "Plugin inventory"} are not exposed to this chat.`,
  });
  const [connections, apps, plugins] = await Promise.allSettled([
    readCodexSessionTools(bounded, threadId),
    accountExtensionsEnabled
      ? readApps(bounded, threadId)
      : Promise.resolve(notExposed("apps")),
    accountExtensionsEnabled
      ? readPlugins(bounded, cwd)
      : Promise.resolve(notExposed("plugins")),
  ]);
  const snapshot: SessionToolsSnapshot =
    connections.status === "fulfilled"
      ? connections.value
      : {
          state: "partial",
          entries: [],
          detail: "Could not refresh MCP connections. Refresh to retry.",
        };
  const entries = snapshot.entries.filter(
    (entry) => !excludedMcpServers.has(entry.id),
  );
  const groups: SessionToolGroup[] = [
    plugins.status === "fulfilled" ? plugins.value : unavailable("plugins"),
    apps.status === "fulfilled" ? apps.value : unavailable("apps"),
    {
      kind: "mcp",
      state: snapshot.state === "ready" ? "ready" : "partial",
      ...(snapshot.detail ? { detail: snapshot.detail } : {}),
      entries: entries.map((entry) =>
        accountAppBridgeEnabled && entry.id === "codex_apps"
          ? {
              ...entry,
              detail: [
                entry.detail,
                "Shared MCP connection for Codex apps. Individual app availability is listed in Apps.",
              ]
                .filter(Boolean)
                .join(" ")
                .slice(0, 1000),
            }
          : entry,
      ),
    },
  ];
  const bridge = accountAppBridgeEnabled
    ? entries.find((entry) => entry.id === "codex_apps")
    : undefined;
  const appGroup = groups.find((group) => group.kind === "apps")!;
  if (bridge?.status !== "connected") {
    appGroup.entries = appGroup.entries.map((entry) =>
      entry.status === "available"
        ? {
            ...entry,
            status: !accountAppBridgeEnabled
              ? "unavailable"
              : bridge?.status === "connecting"
                ? "connecting"
                : bridge
                  ? "unavailable"
                  : "unverified",
            detail: !accountAppBridgeEnabled
              ? "The Codex account app connection was not admitted to this chat. A local MCP with the same name does not provide it."
              : "Codex has not confirmed a working shared app connection for this chat. Check codex_apps in MCPs.",
          }
        : entry,
    );
  }
  return {
    entries,
    groups,
    state: groups.some((group) => group.state === "partial")
      ? "partial"
      : "ready",
  };
}

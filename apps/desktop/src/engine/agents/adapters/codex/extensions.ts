import type {
  ExtensionCategory,
  ExtensionInventory,
} from "@zeros/protocol/agent-extensions";
import type {
  CodexAppServerHandle,
  CodexClientRequestMethod,
  CodexClientRequestParams,
} from "./app-server";
import type { AppsInstalledResponse } from "./generated/v2/AppsInstalledResponse";
import type { AppsListResponse } from "./generated/v2/AppsListResponse";
import type { PluginInstalledResponse } from "./generated/v2/PluginInstalledResponse";
import type { PluginReadResponse } from "./generated/v2/PluginReadResponse";
import type { SkillsListResponse } from "./generated/v2/SkillsListResponse";
import type { ConfigReadResponse } from "./generated/v2/ConfigReadResponse";

/** One budget across pagination and per-plugin reads. New requests stop at
 * the deadline, and every in-flight RPC has a bounded timeout. */
export function boundedCodexInventoryRuntime(
  runtime: Pick<CodexAppServerHandle, "requestTyped">,
  timeoutMs = 15_000,
): Pick<CodexAppServerHandle, "requestTyped"> {
  const deadline = Date.now() + timeoutMs;
  return {
    requestTyped<Method extends CodexClientRequestMethod, Result = unknown>(
      method: Method,
      params: CodexClientRequestParams<Method>,
    ) {
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        return Promise.reject(new Error("Codex discovery timed out"));
      return runtime.requestTyped<Method, Result>(method, params, {
        timeoutMs: Math.min(5_000, remaining),
      });
    },
  };
}

/** Read provider inventories without starting a conversation or executing
 * plugin hooks/MCP tools. Runtime ownership and disposal stay with the adapter. */
export async function readCodexExtensions(
  runtime: Pick<CodexAppServerHandle, "requestTyped">,
  category: ExtensionCategory,
  cwd: string,
): Promise<ExtensionInventory> {
  const result: ExtensionInventory = {
    entries: [],
    warnings: [],
    note: "Managed in your Codex account. Available apps have tools exposed by Codex to Zeros; individual sessions can apply additional tool permissions.",
  };
  if (category === "skills") {
    const response = await runtime.requestTyped<
      "skills/list",
      SkillsListResponse
    >("skills/list", { cwds: [cwd], forceReload: true });
    for (const group of response.data) {
      if (group.errors.length) {
        result.partial = true;
        result.warnings.push(
          "Some Codex skills could not be read. Refresh to retry.",
        );
      }
      for (const skill of group.skills) {
        if (result.entries.some((entry) => entry.id === skill.path)) continue;
        result.entries.push({
          id: skill.path,
          name: skill.name,
          description: skill.description,
          sourcePath: skill.path,
          status: skill.enabled ? "configured" : "disabled",
          ...(skill.pluginId
            ? { components: [`Plugin: ${skill.pluginId}`] }
            : {}),
        });
      }
    }
    result.note =
      "Skills reported by Codex for this scope, including installed plugin skills. Account access does not make a skill available in every workspace.";
  } else if (category === "mcp") {
    // Both reads are metadata-only. Never start a thread/MCP server to populate Customize.
    const reads = await Promise.allSettled([
      runtime.requestTyped<"config/read", ConfigReadResponse>("config/read", {
        cwd,
        includeLayers: false,
      }),
      runtime.requestTyped<"plugin/installed", PluginInstalledResponse>(
        "plugin/installed",
        { cwds: [cwd] },
      ),
    ]);
    const configRead = reads[0];
    if (configRead.status === "fulfilled") {
      const servers = configRead.value.config.mcp_servers;
      if (servers && typeof servers === "object" && !Array.isArray(servers)) {
        for (const [name, config] of Object.entries(servers)) {
          if (!config || typeof config !== "object" || Array.isArray(config))
            continue;
          result.entries.push({
            id: `config:${name}`,
            name,
            description: "Effective Codex MCP configuration",
            sourcePath: "Codex configuration",
            status: config.enabled === false ? "disabled" : "configured",
          });
        }
      }
    } else result.partial = true;
    const pluginRead = reads[1];
    if (pluginRead.status === "fulfilled") {
      if (pluginRead.value.marketplaceLoadErrors.length) result.partial = true;
      const installed = pluginRead.value.marketplaces.flatMap((market) =>
        market.plugins
          .filter((plugin) => plugin.installed)
          .map((plugin) => ({ market, plugin })),
      );
      if (installed.length > 128) result.partial = true;
      const pending = installed.slice(0, 128);
      await Promise.all(
        Array.from({ length: Math.min(4, pending.length) }, async () => {
          for (;;) {
            const item = pending.shift();
            if (!item) return;
            const { market, plugin } = item;
            try {
              const detail = await runtime.requestTyped<
                "plugin/read",
                PluginReadResponse
              >("plugin/read", {
                pluginName: plugin.name,
                ...(market.path
                  ? { marketplacePath: market.path }
                  : { remoteMarketplaceName: market.name }),
              });
              for (const name of detail.plugin.mcpServers) {
                result.entries.push({
                  id: `plugin:${plugin.id}:${name}`,
                  name: `${plugin.name} / ${name}`,
                  description: "Installed Codex plugin MCP server",
                  sourcePath:
                    market.path || `Codex marketplace: ${market.name}`,
                  status:
                    !plugin.enabled ||
                    plugin.availability === "DISABLED_BY_ADMIN"
                      ? "disabled"
                      : "configured",
                  statusDetail:
                    "Reported by Codex. Native plugin MCP tools remain subject to the session's tool permissions.",
                });
              }
            } catch {
              result.partial = true;
            }
          }
        }),
      );
    } else result.partial = true;
    if (result.partial)
      result.warnings.push(
        "Some Codex MCP declarations or installed plugin details could not be read. Refresh to retry.",
      );
    result.note =
      "Effective Codex configuration and MCP components of installed account/local plugins. A declaration does not prove that a server is connected in a Zeros session.";
  } else if (category === "plugins") {
    const response = await runtime.requestTyped<
      "plugin/installed",
      PluginInstalledResponse
    >("plugin/installed", { cwds: [cwd] });
    for (const market of response.marketplaces)
      for (const plugin of market.plugins) {
        if (
          !plugin.installed ||
          result.entries.some((entry) => entry.id === plugin.id)
        )
          continue;
        result.entries.push({
          id: plugin.id,
          name: plugin.interface?.displayName || plugin.name,
          description: plugin.interface?.shortDescription || "",
          sourcePath:
            plugin.source?.type === "local"
              ? plugin.source.path
              : market.path || `Codex marketplace: ${market.name}`,
          components: plugin.interface?.capabilities,
          status:
            plugin.availability === "DISABLED_BY_ADMIN" || !plugin.enabled
              ? "disabled"
              : "configured",
          statusDetail:
            plugin.availability === "DISABLED_BY_ADMIN"
              ? "Disabled by your Codex organization."
              : plugin.enabled
                ? "Installed in Codex. Native plugin tools load according to Codex configuration, account access, and session permissions."
                : "Enable or manage this plugin in Codex.",
        });
      }
    result.note =
      "Installed plugins include account marketplaces and local packages. Manage installation in Codex. Individual plugin components depend on the tools supported by Zeros.";
    if (response.marketplaceLoadErrors.length) {
      result.partial = true;
      result.warnings.push(
        "Some Codex marketplaces could not be read. The inventory may be incomplete.",
      );
    }
  } else {
    let cursor: string | null = null;
    const seen = new Set<string>();
    for (let page = 0; page < 10; page++) {
      let response: AppsListResponse;
      try {
        response = await runtime.requestTyped<"app/list", AppsListResponse>(
          "app/list",
          { cursor, limit: 100, forceRefetch: page === 0 },
        );
      } catch (error) {
        if (page === 0) throw error;
        result.partial = true;
        result.warnings.push(
          "Some Codex account apps could not be read. Refresh to retry.",
        );
        break;
      }
      for (const app of response.data) {
        if (
          !app.isAccessible ||
          result.entries.some((entry) => entry.id === app.id)
        )
          continue;
        result.entries.push({
          id: app.id,
          name: app.name,
          description: app.description || "",
          sourcePath: "Codex account",
          status: app.isEnabled ? "configured" : "disabled",
        });
      }
      cursor = response.nextCursor;
      if (!cursor) break;
      if (seen.has(cursor) || page === 9) {
        result.partial = true;
        result.warnings.push(
          "The Codex app inventory was truncated. Refresh to retry.",
        );
        break;
      }
      seen.add(cursor);
    }
    // app/list is a catalog/access view; only app/installed reports whether the
    // committed connector runtime can call an app. Do not infer authentication
    // errors or desktop-only support from an absent/uncallable app.
    try {
      const installed = await runtime.requestTyped<
        "app/installed",
        AppsInstalledResponse
      >("app/installed", { forceRefresh: true });
      const byId = new Map(installed.apps.map((app) => [app.id, app]));
      for (const entry of result.entries) {
        const app = byId.get(entry.id);
        if (entry.status === "disabled" || app?.enabled === false) {
          entry.status = "disabled";
          entry.statusDetail = "Disabled in Codex. Manage this app in Codex.";
        } else if (app?.callable) {
          entry.status = "available";
        } else if (app) {
          entry.status = "unavailable";
          entry.statusDetail =
            "Codex reports no tools available to Zeros for this app. Check its connection and permissions in Codex; some native features require the native app.";
        } else {
          entry.statusDetail =
            "Connected account entry. Codex has not reported a callable runtime for this app.";
        }
      }
    } catch {
      result.warnings.push(
        "Codex app availability could not be checked. Account entries are shown without claiming their tools are callable.",
      );
    }
  }
  result.entries.sort((a, b) => a.name.localeCompare(b.name));
  if (result.entries.length > 1_024) {
    result.entries = result.entries.slice(0, 1_024);
    result.partial = true;
    result.warnings.push("The Codex extension inventory was truncated.");
  }
  result.sources = [
    {
      id: "account",
      kind: "account",
      state: result.partial ? "partial" : "complete",
      detail:
        "Codex reports the effective inventory for this scope, including account services and installed local packages.",
    },
  ];
  return result;
}

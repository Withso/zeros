import type { ExtensionInventory } from "@zeros/protocol/agent-extensions";
import type { CodexAppServerHandle } from "./app-server";
import type { AppsInstalledResponse } from "./generated/v2/AppsInstalledResponse";
import type { AppsListResponse } from "./generated/v2/AppsListResponse";
import type { PluginInstalledResponse } from "./generated/v2/PluginInstalledResponse";

/** Read provider inventories without starting a conversation or executing
 * plugin hooks/MCP tools. Runtime ownership and disposal stay with the adapter. */
export async function readCodexExtensions(
  runtime: Pick<CodexAppServerHandle, "requestTyped">,
  category: "apps" | "plugins",
  cwd: string,
): Promise<ExtensionInventory> {
  const result: ExtensionInventory = {
    entries: [],
    warnings: [],
    note: "Managed in your Codex account. Available apps have tools exposed by Codex to Zeros; individual sessions can apply additional tool permissions.",
  };
  if (category === "plugins") {
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
          sourcePath: market.path || `Codex marketplace: ${market.name}`,
          components: plugin.interface?.capabilities,
          status:
            plugin.availability === "DISABLED_BY_ADMIN" || !plugin.enabled
              ? "disabled"
              : "configured",
          statusDetail:
            plugin.availability === "DISABLED_BY_ADMIN"
              ? "Disabled by your Codex organization."
              : plugin.enabled
                ? "Installed in Codex. Plugin MCP tools are currently restricted in Zeros; installation alone does not make every native feature available here."
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
  return result;
}

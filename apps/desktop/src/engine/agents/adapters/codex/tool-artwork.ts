import { open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  safeToolImageSource,
  type ToolArtwork,
} from "@zeros/protocol/tool-artwork";
import type { CodexAppServerHandle } from "./app-server";
import type { AppsInstalledResponse } from "./generated/v2/AppsInstalledResponse";
import type { AppsReadResponse } from "./generated/v2/AppsReadResponse";
import type { PluginInstalledResponse } from "./generated/v2/PluginInstalledResponse";
import type { ListMcpServerStatusResponse } from "./generated/v2/ListMcpServerStatusResponse";

export interface CodexToolIdentity {
  server: string;
  tool: string;
  pluginId?: string | null;
  appContext?: {
    connectorId?: string;
    appName?: string | null;
    actionName?: string | null;
  } | null;
}

/** One cache per live runtime/thread. Reads are shared across calls, bounded,
 * and never block execution or emit connection noise. No global account cache. */
export function createCodexToolArtworkResolver(
  runtime: Pick<CodexAppServerHandle, "requestTyped">,
  threadId: string,
  cwd: string,
  codexHome?: string,
) {
  const home = resolve(
    codexHome || process.env.CODEX_HOME || join(homedir(), ".codex"),
  );
  const cache = new Map<
    string,
    { at: number; promise: Promise<ToolArtwork | undefined> }
  >();
  let inventory:
    | { at: number; promise: Promise<AppsInstalledResponse> }
    | undefined;
  let plugins:
    | { at: number; promise: Promise<PluginInstalledResponse> }
    | undefined;
  let servers:
    | { at: number; promise: Promise<ListMcpServerStatusResponse> }
    | undefined;
  const fresh = (at: number) => Date.now() - at < 30_000;
  const read = async (
    item: CodexToolIdentity,
  ): Promise<ToolArtwork | undefined> => {
    if (item.server === "codex_apps") {
      let connectorId = item.appContext?.connectorId;
      if (!connectorId) {
        if (!inventory || !fresh(inventory.at))
          inventory = {
            at: Date.now(),
            promise: runtime.requestTyped<
              "app/installed",
              AppsInstalledResponse
            >("app/installed", { threadId }, { timeoutMs: 4000 }),
          };
        const prefix = item.tool.split(".")[0];
        connectorId = (await inventory.promise).apps
          .slice(0, 1000)
          .find((app) => app.runtimeName === prefix && app.enabled)?.id;
      }
      if (!connectorId) return;
      const result = await runtime.requestTyped<"app/read", AppsReadResponse>(
        "app/read",
        { threadId, appIds: [connectorId], includeTools: false },
        { timeoutMs: 4000 },
      );
      const app = result.apps.find((app) => app.id === connectorId);
      return artwork(app?.iconUrl, app?.iconUrlDark, app?.name);
    }
    if (item.pluginId) {
      if (!plugins || !fresh(plugins.at))
        plugins = {
          at: Date.now(),
          promise: runtime.requestTyped<
            "plugin/installed",
            PluginInstalledResponse
          >("plugin/installed", { cwds: [cwd] }, { timeoutMs: 4000 }),
        };
      const matches = (await plugins.promise).marketplaces.flatMap((market) =>
        market.plugins.filter(
          (plugin) => plugin.id === item.pluginId && plugin.installed,
        ),
      );
      // Equal names from different marketplaces must not borrow one another's logo.
      if (matches.length === 1) {
        const plugin = matches[0]!;
        const ui = plugin.interface;
        const root =
          plugin.source.type === "local"
            ? plugin.source.path
            : join(home, "plugins/cache");
        const light =
          safeToolImageSource(ui?.logoUrl ?? ui?.composerIconUrl) ??
          (await localIcon(ui?.logo ?? ui?.composerIcon, root));
        const dark =
          safeToolImageSource(ui?.logoUrlDark) ??
          (await localIcon(ui?.logoDark, root));
        const result = artwork(light, dark, ui?.displayName ?? plugin.name);
        if (result) return result;
      }
    }
    if (!servers || !fresh(servers.at))
      servers = {
        at: Date.now(),
        promise: (async () => {
          const data: ListMcpServerStatusResponse["data"] = [];
          const seen = new Set<string>();
          let cursor: string | undefined;
          for (let page = 0; page < 10; page++) {
            const result = await runtime.requestTyped<
              "mcpServerStatus/list",
              ListMcpServerStatusResponse
            >(
              "mcpServerStatus/list",
              {
                threadId,
                detail: "toolsAndAuthOnly",
                limit: 100,
                ...(cursor ? { cursor } : {}),
              },
              { timeoutMs: 4000 },
            );
            data.push(...result.data.slice(0, 100));
            if (!result.nextCursor || seen.has(result.nextCursor)) break;
            cursor = result.nextCursor;
            seen.add(cursor);
          }
          return { data, nextCursor: null };
        })(),
      };
    const server = (await servers.promise).data.find(
      (server) =>
        server.name === item.server && server.runtimeStatus !== "disabled",
    );
    const tool = server?.tools[item.tool] as
      | { icons?: Array<{ src?: unknown; theme?: unknown }> }
      | undefined;
    const icons = tool?.icons ?? server?.serverInfo?.icons ?? [];
    const sources = icons.slice(0, 16).flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value))
        return [];
      const icon = value as { src?: unknown; theme?: unknown };
      const src = safeToolImageSource(icon.src);
      return src ? [{ src, theme: icon.theme }] : [];
    });
    return artwork(
      sources.find((icon) => icon.theme !== "dark")?.src ?? sources[0]?.src,
      sources.find((icon) => icon.theme === "dark")?.src,
      server?.serverInfo?.title ?? server?.name,
    );
  };
  return (item: CodexToolIdentity): Promise<ToolArtwork | undefined> => {
    if (["node_repl", "cua_repl", "computer-use"].includes(item.server))
      return Promise.resolve(undefined);
    const key = JSON.stringify([
      item.server,
      item.server === "codex_apps"
        ? (item.appContext?.connectorId ?? item.tool.split(".")[0])
        : item.tool,
      item.pluginId,
    ]);
    const prior = cache.get(key);
    if (prior && fresh(prior.at)) return prior.promise;
    const promise = read(item).catch(() => undefined);
    cache.set(key, { at: Date.now(), promise });
    while (cache.size > 256) cache.delete(cache.keys().next().value!);
    return promise;
  };
}

function artwork(
  light: unknown,
  dark: unknown,
  name?: string | null,
): ToolArtwork | undefined {
  const icon = safeToolImageSource(light) ?? safeToolImageSource(dark);
  if (!icon) return;
  const iconDark = safeToolImageSource(dark);
  return {
    icon,
    ...(iconDark ? { iconDark } : {}),
    ...(name?.trim() ? { name: name.trim().slice(0, 160) } : {}),
  };
}

async function localIcon(
  value: unknown,
  root: string,
): Promise<string | undefined> {
  if (typeof value !== "string" || !isAbsolute(value)) return;
  try {
    const [file, directory] = await Promise.all([
      realpath(value),
      realpath(root),
    ]);
    const child = relative(directory, file);
    if (!child || child.startsWith("..") || isAbsolute(child)) return;
    const handle = await open(file, "r");
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 64 * 1024) return;
      const buffer = Buffer.alloc(64 * 1024 + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 64 * 1024) return;
      const bytes = buffer.subarray(0, bytesRead);
      // Actual PNG signature, not an extension or a plugin-supplied MIME claim.
      const mime = bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        ? "image/png"
        : "image/svg+xml";
      return safeToolImageSource(
        `data:${mime};base64,${bytes.toString("base64")}`,
      );
    } finally {
      await handle.close();
    }
  } catch {
    return;
  }
}

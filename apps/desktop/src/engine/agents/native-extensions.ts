import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import type {
  ExtensionEntry,
  ExtensionInventory,
  ExtensionQuery,
} from "@zeros/protocol/agent-extensions";
import { listSkillDirectory, listZerosSkills } from "./zeros-skills";
import { readBoundedUtf8FileSync } from "../files/bounded-read-sync";

type Doc = Record<string, unknown>;
const object = (value: unknown): Doc =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Doc)
    : {};
const string = (value: unknown): string =>
  typeof value === "string" ? value : "";

/** Inspect declarations only. Never execute helpers, launch MCP servers, read
 * credential databases, or report a cache directory as a connected extension. */
export function nativeExtensionInventory(
  query: ExtensionQuery,
  options: { home?: string; env?: NodeJS.ProcessEnv } = {},
): ExtensionInventory {
  const result: ExtensionInventory = { entries: [], warnings: [] };
  const home = options.home ?? os.homedir();
  const env = options.env ?? process.env;
  const { provider, category, repoRoot } = query;
  if (provider === "zeros") {
    if (category === "skills") result.entries = listZerosSkills(repoRoot);
    return result;
  }
  const nativeRoot =
    provider === "claude"
      ? env.CLAUDE_CONFIG_DIR || path.join(home, ".claude")
      : provider === "codex"
        ? env.CODEX_HOME || path.join(home, ".codex")
        : env.CURSOR_CONFIG_DIR ||
          (env.XDG_CONFIG_HOME
            ? path.join(env.XDG_CONFIG_HOME, "cursor")
            : path.join(home, ".cursor"));
  const root = repoRoot ? path.join(repoRoot, `.${provider}`) : nativeRoot;
  const read = (file: string): Doc => {
    try {
      const text = readBoundedUtf8FileSync(file, 4 * 1024 * 1024);
      return object(
        file.endsWith(".toml") ? parseToml(text) : JSON.parse(text),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      // A failed read cannot confirm removal. Let the exact-key cache retain
      // the last declarations until a complete inventory succeeds.
      result.partial = true;
      result.warnings.push(`Could not read ${file}.`);
      return {};
    }
  };
  const add = (entry: ExtensionEntry) => {
    if (
      result.entries.length < 512 &&
      !result.entries.some((item) => item.id === entry.id)
    )
      result.entries.push(entry);
  };
  const addServers = (
    servers: unknown,
    sourcePath: string,
    prefix = "",
    parentStatus?: ExtensionEntry["status"],
  ) => {
    for (const [name, value] of Object.entries(object(servers))) {
      const config = object(value);
      const transport = config.command
        ? "Local MCP server"
        : config.url
          ? "Remote MCP server"
          : "MCP server";
      add({
        id: `${sourcePath}#${prefix}${name}`,
        name: prefix ? `${prefix} / ${name}` : name,
        description: transport,
        sourcePath,
        status:
          config.enabled === false ||
          config.disabled === true ||
          parentStatus === "disabled"
            ? "disabled"
            : (parentStatus ?? "configured"),
      });
    }
  };
  const configPath = path.join(
    root,
    provider === "codex" ? "config.toml" : "settings.json",
  );
  const config = read(configPath);
  const localConfig =
    repoRoot && provider === "claude"
      ? read(path.join(root, "settings.local.json"))
      : {};

  if (category === "mcp") {
    if (provider === "codex") addServers(config.mcp_servers, configPath);
    else if (provider === "cursor") {
      const file = path.join(root, "mcp.json");
      addServers(read(file).mcpServers, file);
    } else {
      const globalFile = env.CLAUDE_CONFIG_DIR
        ? path.join(nativeRoot, ".claude.json")
        : path.join(home, ".claude.json");
      const global = read(globalFile);
      if (repoRoot) {
        const file = path.join(repoRoot, ".mcp.json");
        addServers(read(file).mcpServers, file);
        addServers(
          object(object(global.projects)[repoRoot]).mcpServers,
          globalFile,
          "This repository",
        );
      } else addServers(global.mcpServers, globalFile);
    }
    result.note =
      "Native declarations are shown here without copying credentials. A configured server may still require sign-in or be excluded by this agent's session settings.";
  }

  if (category === "skills") {
    const roots =
      provider === "codex"
        ? [
            path.join(repoRoot ?? home, ".agents", "skills"),
            path.join(root, "skills"),
          ]
        : [path.join(root, "skills"), path.join(root, "commands")];
    const disabledPaths = new Set(
      (Array.isArray(object(config.skills).config)
        ? (object(config.skills).config as unknown[])
        : []
      )
        .filter((value) => object(value).enabled === false)
        .map((value) => string(object(value).path)),
    );
    for (const skillRoot of roots)
      for (const entry of listSkillDirectory(skillRoot)) {
        add({
          ...entry,
          body: undefined,
          revision: undefined,
          id: entry.sourcePath,
          status:
            disabledPaths.has(entry.sourcePath) ||
            disabledPaths.has(path.dirname(entry.sourcePath))
              ? "disabled"
              : "configured",
        });
      }
  }

  if (category === "apps") {
    if (provider === "codex") {
      for (const [id, value] of Object.entries(object(config.apps))) {
        if (id === "_default") continue;
        const app = object(value);
        add({
          id,
          name: string(app.name) || id,
          description: "Codex app configuration",
          sourcePath: configPath,
          status: app.enabled === false ? "disabled" : "configured",
        });
      }
      result.note =
        "App configuration is shown here. Connected account apps and sign-in are managed in Codex; the local file may not list every connected app.";
    } else {
      result.note =
        provider === "claude"
          ? "Claude account connectors require a provider-reported session inventory; they cannot be enumerated from local settings. Manage connections in Claude. The current native MCP scope can exclude automatic cloud connectors."
          : "Cursor integrations are managed in Cursor. MCP integrations appear under MCP; Cursor does not expose a separate account Apps inventory here.";
    }
    return result;
  }

  if (category === "plugins" && provider !== "codex")
    result.note =
      provider === "claude"
        ? "Local Claude installation records include downloaded marketplace plugins. Cloud-only entries have no standalone SDK inventory here; manage those in Claude. Configured does not mean every plugin component can run in Zeros."
        : "Cursor marketplace and team plugins appear when their packages are present locally. The SDK does not expose a cloud plugin inventory here. Some plugins require Cursor's native app; found packages may be inactive.";

  const pluginFlags =
    provider === "claude"
      ? {
          ...object(config.enabledPlugins),
          ...object(localConfig.enabledPlugins),
        }
      : object(config.plugins);
  if (category === "plugins") {
    for (const [id, value] of Object.entries(pluginFlags)) {
      add({
        id,
        name: id,
        description: "Native plugin configuration",
        sourcePath: configPath,
        status:
          value === false || object(value).enabled === false
            ? "disabled"
            : "configured",
      });
    }
  }

  // Installation records are preferable to cache discovery. Claude records
  // include the exact selected installation and scope; never flatten projects.
  const installedFile = path.join(
    nativeRoot,
    "plugins",
    "installed_plugins.json",
  );
  const installed =
    provider === "claude" ? object(read(installedFile).plugins) : {};
  const pluginRoots: Array<{
    id: string;
    root: string;
    status: ExtensionEntry["status"];
  }> = [];
  for (const [id, records] of Object.entries(installed)) {
    for (const record of Array.isArray(records) ? records : [records]) {
      const entry = object(record);
      const project = string(entry.projectPath);
      if (repoRoot ? project !== repoRoot : Boolean(project)) continue;
      const installPath = string(entry.installPath);
      if (installPath)
        pluginRoots.push({
          id,
          root: installPath,
          status:
            pluginFlags[id] === false
              ? "disabled"
              : pluginFlags[id] === true
                ? "configured"
                : "found",
        });
    }
  }
  // Codex/Cursor caches can contain old, disabled, or uninstalled versions.
  // Keep their source paths and label them "found", never "installed/active".
  if (!repoRoot && provider !== "claude") {
    const walk = (dir: string, depth: number): void => {
      if (depth > 3 || pluginRoots.length >= 128) return;
      try {
        const manifests = [
          path.join(dir, `.${provider}-plugin`, "plugin.json"),
          path.join(dir, "plugin.json"),
        ];
        const manifestPath = manifests.find((file) => existsSync(file));
        if (manifestPath) {
          const manifest = read(manifestPath);
          pluginRoots.push({
            id: string(manifest.name) || path.basename(dir),
            root: dir,
            status: "found",
          });
          return;
        }
        for (const entry of readdirSync(dir, { withFileTypes: true }).slice(
          0,
          128,
        ))
          if (entry.isDirectory()) walk(path.join(dir, entry.name), depth + 1);
      } catch {
        /* no plugin cache */
      }
    };
    walk(path.join(nativeRoot, "plugins", "cache"), 0);
  }
  for (const plugin of pluginRoots) {
    if (category === "plugins") {
      const manifestPath = [
        path.join(plugin.root, `.${provider}-plugin`, "plugin.json"),
        path.join(plugin.root, "plugin.json"),
      ].find((file) => existsSync(file));
      const manifest = manifestPath ? read(manifestPath) : {};
      const components = [
        "skills",
        "agents",
        "rules",
        "commands",
        "hooks",
      ].filter(
        (name) =>
          manifest[name] !== undefined ||
          existsSync(path.join(plugin.root, name)),
      );
      if (
        [".mcp.json", "mcp.json"].some((name) =>
          existsSync(path.join(plugin.root, name)),
        )
      )
        components.push("MCP");
      const configured = result.entries.findIndex(
        (entry) => entry.id === plugin.id,
      );
      if (configured >= 0) result.entries.splice(configured, 1);
      add({
        id: plugin.root,
        name: plugin.id,
        description: string(manifest.description),
        sourcePath: plugin.root,
        status: plugin.status,
        components,
      });
    } else if (category === "skills") {
      for (const skill of listSkillDirectory(path.join(plugin.root, "skills")))
        add({
          ...skill,
          body: undefined,
          revision: undefined,
          id: skill.sourcePath,
          name: `${plugin.id}:${skill.name}`,
          status: plugin.status,
        });
    } else if (category === "mcp") {
      for (const name of [".mcp.json", "mcp.json"]) {
        const file = path.join(plugin.root, name);
        addServers(read(file).mcpServers, file, plugin.id, plugin.status);
      }
    }
  }
  if (category === "plugins")
    result.note =
      "Managed in the native application. Found-on-disk entries may include cached versions; configuration does not prove a plugin is loaded in a Zeros session.";
  result.entries.sort(
    (a, b) =>
      a.name.localeCompare(b.name) || a.sourcePath.localeCompare(b.sourcePath),
  );
  return result;
}

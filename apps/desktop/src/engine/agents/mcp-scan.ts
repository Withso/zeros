// ──────────────────────────────────────────────────────────
// MCP adopt-scan — discover servers already configured in other tools
// ──────────────────────────────────────────────────────────
//
// The "promote what I already have → all agents" half of unified MCP. Reads the
// well-known native MCP config files (the user's home configs for Cursor, Claude
// Code, Codex, Factory) and normalizes each declared server into the Zeros
// registration shape, tagged with its source. The renderer then offers them for
// import (detect-then-offer, never silent — see McpImportDialog).
//
// Best-effort + read-only: a missing or malformed file yields an empty/warned
// source, never an error. Secrets in a discovered server's env/headers are left
// AS-IS here (the literal value the user already has on disk); the renderer
// decides what to move into the Keychain on import.
//
// Scans the user-level (home) configs AND, for any repo roots passed in, each
// repo's `.cursor/mcp.json` + `.mcp.json` (project-level), tagged per repo.
//
// Codex plugins are scanned too, and they are not an edge case: a connector
// installed from the ChatGPT/Codex desktop MCP-extensions sidebar ships its
// servers in the PLUGIN's own `.mcp.json`, never in `config.toml`. Since agents
// no longer load native MCP themselves (adapters/shared/mcp-passthrough.ts),
// leaving those out would strand exactly the servers a user is most likely to
// have and least likely to be able to find.
// ──────────────────────────────────────────────────────────

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import type { McpServerRegistration } from "./types";

/** A tool whose native MCP config Zeros can adopt from. */
interface SourceDef {
  source: string;
  label: string;
  /** Path relative to the home dir. */
  rel: string;
  format: "json" | "toml";
}

const SOURCES: readonly SourceDef[] = [
  { source: "cursor", label: "Cursor", rel: ".cursor/mcp.json", format: "json" },
  { source: "claude", label: "Claude Code", rel: ".claude.json", format: "json" },
  { source: "codex", label: "Codex", rel: ".codex/config.toml", format: "toml" },
  { source: "factory", label: "Factory", rel: ".factory/mcp.json", format: "json" },
  // Claude Desktop (macOS path; a no-op miss on other OSes — harmless).
  {
    source: "claude-desktop",
    label: "Claude Desktop",
    rel: "Library/Application Support/Claude/claude_desktop_config.json",
    format: "json",
  },
];

/** Per-repo native configs, scanned relative to each repo root (not home). */
const REPO_SOURCES: readonly SourceDef[] = [
  {
    source: "codex-project",
    label: "Codex (project)",
    rel: ".codex/config.toml",
    format: "toml",
  },
  { source: "cursor-project", label: "Cursor (project)", rel: ".cursor/mcp.json", format: "json" },
  { source: "project", label: "Project (.mcp.json)", rel: ".mcp.json", format: "json" },
];

/** Codex plugin bundles live under `$CODEX_HOME/plugins/cache/<marketplace>/
 *  <plugin>/<version>/.mcp.json`. */
const CODEX_PLUGIN_CACHE_REL = "plugins/cache";

/** Skip a pathological config file rather than block the scan on a huge parse. */
const MAX_CONFIG_BYTES = 8 * 1024 * 1024; // 8 MB

export interface DiscoveredMcpSource {
  source: string;
  label: string;
  /** Absolute path of the config file scanned (for display). */
  path: string;
  exists: boolean;
  servers: McpServerRegistration[];
  /** Non-fatal note (unreadable / unparseable / too large). */
  warning?: string;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string");
  return out.length > 0 ? out : undefined;
}

function asStringMap(v: unknown): Record<string, string> | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") out[k] = val;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Map one native server config object to a registration. A `url` makes it http
 *  (headers from `headers` (Cursor/Claude/Factory) or `http_headers` (Codex)); a
 *  `command` makes it stdio. Anything else (e.g. a name we can't classify) is
 *  dropped. */
function mapNativeServer(name: string, cfg: unknown): McpServerRegistration | null {
  if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg) || !name) return null;
  const c = cfg as Record<string, unknown>;
  const url = asString(c.url);
  if (url) {
    const headers = asStringMap(c.headers) ?? asStringMap(c.http_headers);
    return { name, transport: "http", url, ...(headers ? { headers } : {}) };
  }
  const command = asString(c.command);
  if (command) {
    const args = asStringArray(c.args);
    const env = asStringMap(c.env);
    return { name, transport: "stdio", command, ...(args ? { args } : {}), ...(env ? { env } : {}) };
  }
  return null;
}

/** Read a `{ "<name>": <config> }` map (mcpServers / mcp_servers) into registrations. */
function serversFromMap(map: unknown): McpServerRegistration[] {
  if (typeof map !== "object" || map === null || Array.isArray(map)) return [];
  const out: McpServerRegistration[] = [];
  for (const [name, cfg] of Object.entries(map as Record<string, unknown>)) {
    const reg = mapNativeServer(name, cfg);
    if (reg) out.push(reg);
  }
  return out;
}

function scanSource(baseDir: string, def: SourceDef): DiscoveredMcpSource {
  const filePath = path.join(baseDir, def.rel);
  const out: DiscoveredMcpSource = {
    source: def.source,
    label: def.label,
    path: filePath,
    exists: false,
    servers: [],
  };
  if (!existsSync(filePath)) return out;
  out.exists = true;
  try {
    if (statSync(filePath).size > MAX_CONFIG_BYTES) {
      out.warning = "config file too large — skipped";
      return out;
    }
  } catch {
    out.warning = "could not stat file";
    return out;
  }
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    out.warning = "could not read file";
    return out;
  }
  try {
    const doc = (def.format === "json" ? JSON.parse(text) : parseToml(text)) as Record<string, unknown>;
    // JSON tools nest under `mcpServers`; Codex TOML under `mcp_servers`.
    out.servers = serversFromMap(def.format === "json" ? doc.mcpServers : doc.mcp_servers);
    // Claude Code (~/.claude.json) ALSO nests LOCAL-scoped servers under
    // projects["<abs path>"].mcpServers — surface those too (top-level wins on a
    // name clash) so a user's project-local Claude MCP servers are importable.
    if (def.source === "claude" && typeof doc.projects === "object" && doc.projects !== null) {
      const seen = new Set(out.servers.map((s) => s.name));
      for (const proj of Object.values(doc.projects as Record<string, unknown>)) {
        const nested = (proj as { mcpServers?: unknown } | null)?.mcpServers;
        for (const s of serversFromMap(nested)) {
          if (seen.has(s.name)) continue;
          seen.add(s.name);
          out.servers.push(s);
        }
      }
    }
  } catch (err) {
    out.warning = `could not parse: ${err instanceof Error ? err.message : String(err)}`;
  }
  return out;
}

/** Scan every known native MCP config and return what each declares — the
 *  home-level configs (Cursor / Claude Code / Codex / Factory / Claude Desktop)
 *  plus each given repo's `.cursor/mcp.json`, `.codex/config.toml` and `.mcp.json`
 *  (only repos that actually have one are surfaced). */
export function scanNativeMcpConfigs(
  homeDir: string = os.homedir(),
  repoRoots: readonly string[] = [],
): DiscoveredMcpSource[] {
  const home = SOURCES.map((def) =>
    def.source === "codex" && process.env.CODEX_HOME?.trim()
      ? scanSource(process.env.CODEX_HOME.trim(), { ...def, rel: "config.toml" })
      : scanSource(homeDir, def),
  );
  const codexPlugins = scanCodexPluginMcp(homeDir);
  if (codexPlugins.servers.length > 0) home.push(codexPlugins);
  const perRepo: DiscoveredMcpSource[] = [];
  const seen = new Set<string>();
  for (const root of repoRoots) {
    if (!root || seen.has(root)) continue;
    seen.add(root);
    const base = path.basename(root) || root;
    for (const def of REPO_SOURCES) {
      // Unique source id per repo so the importer's dedup key never collides.
      const s = scanSource(root, { ...def, source: `${def.source}:${root}`, label: `${def.label} · ${base}` });
      if (s.exists) perRepo.push(s);
    }
  }
  return [...home, ...perRepo];
}

/** Discover the MCP servers Codex plugins declare. One aggregated source
 *  rather than one per plugin: the dialog groups by where a user would look,
 *  and "Codex plugins" is a single place in their head.
 *
 *  Only the newest version directory of each plugin is read — the cache keeps
 *  old ones, and offering three copies of the same server is worse than
 *  offering none.
 *
 *  A relative `command` is skipped. Those launchers resolve against the
 *  plugin's own directory (`"./bin/…"` with a `cwd` in the manifest), and the
 *  Zeros registration shape has no cwd to carry — importing one would create a
 *  server that cannot start. HTTP servers, which is what every user-installed
 *  connector actually is, carry a URL and are unaffected. */
export function scanCodexPluginMcp(
  homeDir: string = os.homedir(),
  codexHomeOverride?: string,
): DiscoveredMcpSource {
  const cacheRoot = codexPluginCacheRoot(homeDir, codexHomeOverride);
  const out: DiscoveredMcpSource = {
    source: "codex-plugins",
    label: "Codex plugins",
    path: cacheRoot,
    exists: existsSync(cacheRoot),
    servers: [],
  };
  if (!out.exists) return out;
  const seen = new Set<string>();
  try {
    for (const versionDir of codexPluginVersionDirs(cacheRoot)) {
      const manifest = scanSource(versionDir, {
        source: out.source,
        label: out.label,
        rel: ".mcp.json",
        format: "json",
      });
      for (const server of manifest.servers) {
        if (server.transport === "stdio" && !path.isAbsolute(server.command))
          continue;
        if (seen.has(server.name)) continue;
        seen.add(server.name);
        out.servers.push(server);
      }
    }
  } catch {
    out.warning = "could not read the Codex plugin cache";
  }
  return out;
}

/** Every MCP server name Codex plugins declare — including the ones
 *  `scanCodexPluginMcp` filters out as un-importable.
 *
 *  Disabling and importing want different sets. An import must be usable, so a
 *  launcher with a relative `command` is dropped there; a DISABLE only needs
 *  the name, and skipping such a server would leave it running. Deliberately
 *  unfiltered for that reason. */
export function codexPluginMcpServerNames(
  homeDir: string = os.homedir(),
  codexHomeOverride?: string,
): string[] {
  const cacheRoot = codexPluginCacheRoot(homeDir, codexHomeOverride);
  if (!existsSync(cacheRoot)) return [];
  const names = new Set<string>();
  try {
    for (const versionDir of codexPluginVersionDirs(cacheRoot)) {
      const file = path.join(versionDir, ".mcp.json");
      if (!existsSync(file)) continue;
      try {
        const doc = JSON.parse(readFileSync(file, "utf8")) as {
          mcpServers?: unknown;
        };
        const map = doc?.mcpServers;
        if (typeof map !== "object" || map === null || Array.isArray(map))
          continue;
        for (const name of Object.keys(map)) if (name) names.add(name);
      } catch {
        continue;
      }
    }
  } catch {
    return [...names];
  }
  return [...names];
}

/** `$CODEX_HOME/plugins/cache`, honouring an explicit override then the env. */
function codexPluginCacheRoot(homeDir: string, override?: string): string {
  const codexHome =
    override?.trim() ||
    process.env.CODEX_HOME?.trim() ||
    path.join(homeDir, ".codex");
  return path.join(codexHome, CODEX_PLUGIN_CACHE_REL);
}

/** Newest version directory of every plugin under the cache root. */
function* codexPluginVersionDirs(cacheRoot: string): Generator<string> {
  for (const marketplace of readdirSync(cacheRoot, { withFileTypes: true })) {
    if (!marketplace.isDirectory()) continue;
    const marketplaceDir = path.join(cacheRoot, marketplace.name);
    let plugins;
    try {
      plugins = readdirSync(marketplaceDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const plugin of plugins) {
      if (!plugin.isDirectory()) continue;
      const versionDir = newestVersionDir(
        path.join(marketplaceDir, plugin.name),
      );
      if (versionDir) yield versionDir;
    }
  }
}

/** Newest version directory under a plugin dir, by mtime — the cache has no
 *  "current" marker and version strings are not consistently comparable
 *  (`0.1.2` next to `26.901.41123`). */
function newestVersionDir(pluginDir: string): string | null {
  let newest: { dir: string; mtimeMs: number } | null = null;
  let entries;
  try {
    entries = readdirSync(pluginDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(pluginDir, entry.name);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(dir).mtimeMs;
    } catch {
      continue;
    }
    if (!newest || mtimeMs > newest.mtimeMs) newest = { dir, mtimeMs };
  }
  return newest?.dir ?? null;
}

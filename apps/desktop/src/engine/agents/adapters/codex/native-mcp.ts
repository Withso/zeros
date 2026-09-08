// ──────────────────────────────────────────────────────────
// Native MCP scoping for Codex threads
// ──────────────────────────────────────────────────────────
//
// Reading and shutting off the MCP servers codex would start for a thread on
// its own. Policy, deliberately kept out of app-server.ts: that module owns
// the child process and the JSON-RPC wire, and tests routinely replace it
// wholesale to fake a runtime. These helpers are pure enough to keep running
// under those tests, which is exactly when a session-boot path must not break.
//
// Why any of this exists: adapters/shared/mcp-passthrough.ts.
// ──────────────────────────────────────────────────────────

import { codexPluginMcpServerNames } from "../../mcp-scan";
import type { JsonValue as GenJsonValue } from "./generated/serde_json/JsonValue";
import type { CodexAppServerHandle } from "./app-server";

/** Placeholder transport paired with `enabled = false`.
 *
 *  Codex validates the SHAPE of every `mcp_servers` entry before it looks at
 *  `enabled`, and rejects the whole config — fatally, as a `-c` flag — with
 *  "invalid transport in `mcp_servers.<name>`" when an entry has neither
 *  `command` nor `url`. A disabled server is never spawned, so the value only
 *  has to exist. It is spelled to be self-explanatory in a config dump rather
 *  than to look like a real program. */
const DISABLED_SERVER_COMMAND = "zeros-disabled-mcp-server";

/** Servers codex registers itself, which no API enumerates before a thread
 *  exists: they are absent from `config/read` and from every plugin manifest,
 *  and `mcpServerStatus/list` answers for the thread being configured.
 *
 *  `codex_apps` is the account Apps bridge. Tool-free helper threads disable
 *  it. Normal chats explicitly keep it because Customize now enumerates its
 *  account entries and runtime availability through app/list and app/installed.
 *
 *  A hardcoded provider-internal name is a guess about codex's internals, and
 *  it is deliberately a SAFE one: an entry naming a server codex does not know
 *  is accepted and ignored, so a rename degrades this to a no-op rather than
 *  an error. Revisit if the list grows past a couple of entries. */
const CODEX_INTERNAL_SERVER_NAMES = ["codex_apps"] as const;

/** Every MCP server name that would come up in front of a codex thread on its
 *  own. Two independent registries, and a caller that reads only the first
 *  misses the servers most users actually have:
 *
 *    • `mcp_servers.*` in the merged config — hand-written `config.toml`
 *      entries plus whatever Zeros injected at spawn.
 *    • servers declared by installed PLUGINS, in the plugin's own `.mcp.json`.
 *      `cloudflare@openai-curated-remote` contributes a `cloudflare-api`
 *      server that never appears under `mcp_servers` at all. Anything added
 *      through the Codex/ChatGPT desktop MCP-extensions sidebar arrives this
 *      way, so this is the common case rather than the exotic one. */
export interface NativeMcpSurface {
  serverNames: string[];
  /** Config-declared servers that use the Streamable HTTP transport, by name →
   *  their `url`. Codex infers a server's transport from the keys present
   *  (`command` ⇒ stdio, `url` ⇒ http) and rejects an entry carrying BOTH with
   *  "url is not supported for stdio in `mcp_servers.<name>`" — fatally, for
   *  the whole thread. So the disable fragment for one of these must repeat its
   *  `url`, never add a `command`. Absent for names that come from plugins or
   *  codex's internals, which have no config entry to collide with. */
  httpServerUrls?: Record<string, string>;
}

/** Read the native MCP surface a thread rooted at `cwd` would start.
 *
 *  Config-declared names come from the LIVE runtime rather than our own parse
 *  of `config.toml`: a file parse misses the project-local layer and races the
 *  user editing the file.
 *
 *  Plugin-declared names come from the plugin cache on disk, because the
 *  app-server has no method that reports them before a thread exists —
 *  `config/read` omits them entirely and `mcpServerStatus/list` answers for
 *  the current thread, which is the one being configured. `CODEX_HOME` is
 *  ambient for both the engine and the codex child (config-isolation.ts), so
 *  they read the same cache.
 *
 *  Reading starts nothing: codex spins MCP servers up per `thread/start`, not
 *  at `initialize`. Each half degrades on its own. */
export async function readNativeMcpSurface(
  runtime: Pick<CodexAppServerHandle, "requestTyped">,
  cwd?: string,
  opts?: { timeoutMs?: number; codexHome?: string },
): Promise<NativeMcpSurface> {
  const configured = await runtime
    .requestTyped<"config/read", { config?: { mcp_servers?: unknown } | null }>(
      "config/read",
      { includeLayers: false, ...(cwd ? { cwd } : {}) },
      { timeoutMs: opts?.timeoutMs ?? 10_000 },
    )
    .then((r) => enabledMcpServers(r?.config?.mcp_servers))
    .catch(() => ({ names: [] as string[], httpUrls: {} as Record<string, string> }));
  let fromPlugins: string[] = [];
  try {
    fromPlugins = codexPluginMcpServerNames(undefined, opts?.codexHome);
  } catch {
    fromPlugins = [];
  }
  return {
    serverNames: [
      ...new Set([
        ...configured.names,
        ...fromPlugins,
        ...CODEX_INTERNAL_SERVER_NAMES,
      ]),
    ],
    // Only present when there is something to carry, so the common surface
    // stays the plain `{ serverNames }` shape.
    ...(Object.keys(configured.httpUrls).length > 0
      ? { httpServerUrls: configured.httpUrls }
      : {}),
  };
}

/** `mcp_servers` keys codex would actually start, plus the `url` of every one
 *  that is a Streamable HTTP server (see NativeMcpSurface.httpServerUrls). An
 *  entry already marked `enabled = false` is skipped — codex never starts it,
 *  so naming it buys nothing. */
function enabledMcpServers(servers: unknown): {
  names: string[];
  httpUrls: Record<string, string>;
} {
  const names: string[] = [];
  const httpUrls: Record<string, string> = {};
  if (typeof servers !== "object" || servers === null || Array.isArray(servers))
    return { names, httpUrls };
  for (const [name, cfg] of Object.entries(
    servers as Record<string, unknown>,
  )) {
    if (!name) continue;
    const entry =
      typeof cfg === "object" && cfg !== null && !Array.isArray(cfg)
        ? (cfg as { enabled?: unknown; url?: unknown })
        : undefined;
    if (entry?.enabled === false) continue;
    names.push(name);
    if (typeof entry?.url === "string" && entry.url.length > 0) {
      httpUrls[name] = entry.url;
    }
  }
  return { names, httpUrls };
}

/** Narrow a native surface to the entries a REAL chat thread should shut off.
 *
 *  A one-shot wants everything gone; a chat thread must not take down Zeros'
 *  own registry, which is injected as `-c mcp_servers.<name>.…` into the SAME
 *  table codex reads its native servers from. A name collision there is a
 *  merge, not a shadow — so disabling by name would kill a Zeros-registered
 *  server along with its native namesake. `keepServerNames` is the exact list
 *  handed to the spawn. */
export function scopeNativeMcpSurface(
  surface: NativeMcpSurface,
  keep: { serverNames?: readonly string[] },
): NativeMcpSurface {
  const kept = new Set(keep.serverNames ?? []);
  return {
    serverNames: surface.serverNames.filter((n) => !kept.has(n)),
    ...(surface.httpServerUrls
      ? { httpServerUrls: surface.httpServerUrls }
      : {}),
  };
}

/** `thread/start.config` fragment that leaves a thread with no native MCP
 *  servers — config-declared and plugin-provided alike.
 *
 *  `plugins.<id>.enabled = false` is NOT the lever, despite reading like it:
 *  verified against an installed `cloudflare@openai-curated-remote`, codex
 *  accepts that key and starts the plugin's server anyway (curated-remote
 *  plugins have no entry in `config.plugins` for it to apply to). Disabling
 *  the SERVER by name is what actually takes effect, which is why this reaches
 *  into `mcp_servers` for names that were never declared there.
 *
 *  Nested rather than the dotted-key form `codexBrowserThreadConfig` uses:
 *  server names are user-authored TOML keys and may contain a `.`, which a key
 *  path would silently split into the wrong table.
 *
 *  An empty surface yields an empty fragment, so a caller can spread this
 *  unconditionally. */
export function mcpDisabledThreadConfig(
  surface: NativeMcpSurface,
): Record<string, GenJsonValue> {
  if (surface.serverNames.length === 0) return {};
  const servers: Record<string, GenJsonValue> = {};
  for (const name of surface.serverNames) {
    // An http server keeps its own `url` as the placeholder transport. Adding
    // `command` to a table that already has `url` makes codex reject the whole
    // config ("url is not supported for stdio") and the thread never starts —
    // observed with a hand-written `[mcp_servers.directus] url = …` entry.
    const url = surface.httpServerUrls?.[name];
    servers[name] =
      typeof url === "string"
        ? { enabled: false, url }
        : { enabled: false, command: DISABLED_SERVER_COMMAND };
  }
  return { mcp_servers: servers };
}

import type { PluginInstalledResponse } from "./generated/v2/PluginInstalledResponse";
import type { PluginReadResponse } from "./generated/v2/PluginReadResponse";
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
import { isBundledCodexRuntimePlugin } from "./bundled-runtime-plugins";
import { isDeepStrictEqual } from "node:util";
import { parse as parseToml } from "smol-toml";
import { buildMcpServerOverrides } from "./mcp-overrides";
import type { McpServerRegistration } from "../../types";

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
 *  it. Normal chats keep it unless a local declaration shadows the name.
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
  registeredServerNames?: string[];
  /** Registered servers verified with inert keys from the user's own layer. */
  userLayerServerNames?: string[];
  /** Local declarations must not inherit an internal account bridge's exemption. */
  shadowedAccountServerNames?: string[];
  /** Config-declared servers that use the Streamable HTTP transport, by name →
   *  their `url`. Codex infers a server's transport from the keys present
   *  (`command` ⇒ stdio, `url` ⇒ http) and rejects an entry carrying BOTH with
   *  "url is not supported for stdio in `mcp_servers.<name>`" — fatally, for
   *  the whole thread. So the disable fragment for one of these must repeat its
   *  `url`, never add a `command`. Includes disabled config entries, since a
   *  plugin or internal server can declare the same name. */
  httpServerUrls?: Record<string, string>;
}

/** One Zeros-owned registration whose effective definition may keep inert
 * keys from the user's own Codex configuration (`$CODEX_HOME/config.toml`).
 * Repository `.codex/config.toml`, system and every other layer stay refused,
 * and Zeros' own values must still win every key it sets. */
export interface NativeDeclarationAllowance {
  serverName: string;
  /** `path` is `["env", name]` for an environment entry, else `[field]`. */
  acceptsUserKey(path: readonly string[], value: unknown): boolean;
}

/** Read the native MCP surface a thread rooted at `cwd` would start.
 *
 *  Config-declared names come from the LIVE runtime rather than our own parse
 *  of `config.toml`: a file parse misses the project-local layer and races the
 *  user editing the file.
 *
 *  Normal chats use plugin/installed provenance and plugin/read to exclude
 *  MCP from local packages while preserving account plugins. Helpers and
 *  restricted actors exclude the whole disk plugin surface. The disk scan is
 *  also a conservative fallback when provenance cannot be verified. Pass the
 *  same CODEX_HOME as the child so isolation cannot select a different cache.
 *
 *  Reading starts nothing: codex spins MCP servers up per `thread/start`, not
 *  at `initialize`. Each half degrades on its own. */
export async function readNativeMcpSurface(
  runtime: Pick<CodexAppServerHandle, "requestTyped">,
  cwd?: string,
  opts?: {
    timeoutMs?: number;
    codexHome?: string;
    includePlugins?: boolean;
    requireConfig?: boolean;
    registeredServers?: readonly McpServerRegistration[];
    nativeDeclarationAllowance?: NativeDeclarationAllowance;
  },
): Promise<NativeMcpSurface> {
  let merged: unknown;
  const configured = await runtime
    .requestTyped<"config/read", { config?: { mcp_servers?: unknown } | null }>(
      "config/read",
      { includeLayers: false, ...(cwd ? { cwd } : {}) },
      { timeoutMs: opts?.timeoutMs ?? 10_000 },
    )
    .then((r) => {
      const config = r?.config;
      if (
        opts?.requireConfig &&
        (!config ||
          typeof config !== "object" ||
          Array.isArray(config) ||
          (config.mcp_servers != null &&
            (typeof config.mcp_servers !== "object" ||
              Array.isArray(config.mcp_servers))))
      )
        throw new Error("Incomplete MCP configuration");
      merged = config?.mcp_servers;
      return enabledMcpServers(merged);
    })
    .catch(() => {
      if (opts?.requireConfig)
        throw new Error(
          "Could not read the MCP configuration. Retry opening this chat.",
        );
      return { names: [] as string[], httpUrls: {} as Record<string, string> };
    });
  const registered = opts?.registeredServers ?? [];
  const allowance = opts?.nativeDeclarationAllowance;
  let registeredServerNames: string[];
  let userLayerServerNames: string[] = [];
  try {
    registeredServerNames = verifiedRegistrations(merged, registered);
  } catch (error) {
    if (!allowance || !(error instanceof McpConfigurationConflictError) || error.serverName !== allowance.serverName)
      throw error;
    // Only a conflict on the allowed registration pays for the layer payload.
    const accepted = await userLayerExtras(runtime, cwd, merged, registered, allowance, opts?.timeoutMs)
      .catch(() => null);
    if (!accepted) throw error;
    registeredServerNames = verifiedRegistrations(merged, registered, { [allowance.serverName]: accepted });
    userLayerServerNames = [allowance.serverName];
  }
  let fromPlugins: string[] = [];
  try {
    fromPlugins =
      opts?.includePlugins === false
        ? await localPluginMcpServerNames(runtime, cwd, opts?.codexHome)
        : codexPluginMcpServerNames(undefined, opts?.codexHome);
  } catch {
    // Older/partially available providers cannot prove which plugins belong
    // to the account. Suppress their disk MCP surface until discovery works.
    fromPlugins = codexPluginMcpServerNames(undefined, opts?.codexHome);
  }
  const localNames = new Set([...configured.names, ...fromPlugins]);
  const shadowedAccountServerNames = CODEX_INTERNAL_SERVER_NAMES.filter(
    (name) => localNames.has(name),
  );
  return {
    ...(opts?.registeredServers ? { registeredServerNames } : {}),
    ...(userLayerServerNames.length ? { userLayerServerNames } : {}),
    serverNames: [
      ...new Set([
        ...configured.names,
        ...fromPlugins,
        ...CODEX_INTERNAL_SERVER_NAMES,
      ]),
    ],
    ...(shadowedAccountServerNames.length > 0
      ? { shadowedAccountServerNames }
      : {}),
    // Only present when there is something to carry, so the common surface
    // stays the plain `{ serverNames }` shape.
    ...(Object.keys(configured.httpUrls).length > 0
      ? { httpServerUrls: configured.httpUrls }
      : {}),
  };
}

/** The effective definition of a Zeros-registered server differs from the one
 * Zeros passed. `serverName` lets the owner of a registration retire it. */
export class McpConfigurationConflictError extends Error {
  constructor(readonly serverName: string) {
    super(`MCP configuration conflict for ${serverName}. Remove the conflicting native declaration or import its complete configuration before reopening this chat.`);
    this.name = "McpConfigurationConflictError";
  }
}

/** Codex 0.164 recursively merges even whole-table CLI overrides. A matching
 * name is not authority: verify the complete effective definition before
 * thread/start can spawn anything. Conflicts require an explicit native config
 * repair/import; never silently run a hybrid of two definitions. The single
 * exception is an allowance's verified user-layer extras (see userLayerExtras). */
function verifiedRegistrations(
  merged: unknown,
  servers: readonly McpServerRegistration[],
  accepted: Readonly<Record<string, AcceptedExtras>> = {},
): string[] {
  const expected = expectedDefinitions(servers);
  const configured = merged && typeof merged === "object" && !Array.isArray(merged) ? merged as Record<string, unknown> : {};
  const names: string[] = [];
  for (const [name, definition] of Object.entries(expected)) {
    const actual = Object.hasOwn(configured, name) ? configured[name] : undefined;
    if (actual === undefined) continue;
    const extras = Object.hasOwn(accepted, name) ? accepted[name] : undefined;
    const want = extras
      ? { ...definition, ...extras.fields, env: { ...(plainRecord(definition.env) ?? {}), ...extras.env } }
      : definition;
    if (!actual || typeof actual !== "object" || Array.isArray(actual) || !isDeepStrictEqual(normalizeDefinition(actual as Record<string, unknown>), normalizeDefinition(want)))
      throw new McpConfigurationConflictError(name);
    names.push(name);
  }
  return names;
}

interface AcceptedExtras {
  fields: Record<string, unknown>;
  env: Record<string, string>;
}

/** The complete definitions Zeros passes, as Codex parses them. smol-toml
 * creates null-prototype tables; config/read arrives as plain JSON objects.
 * Compare JSON values, never JS prototypes. */
function expectedDefinitions(servers: readonly McpServerRegistration[]): Record<string, Record<string, unknown>> {
  const overrides = buildMcpServerOverrides(servers).filter((_, index) => index % 2 === 1);
  return JSON.parse(JSON.stringify(parseToml(overrides.join("\n")).mcp_servers ?? {})) as Record<string, Record<string, unknown>>;
}

/** Drop the defaults Codex reports for omitted fields. */
function normalizeDefinition(input: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value == null || (key === "enabled" && value === true) || (key === "environment_id" && value === "local")) continue;
    if (["args", "env_vars", "disabled_tools"].includes(key) && Array.isArray(value) && value.length === 0) continue;
    if (["env", "http_headers", "env_http_headers"].includes(key) && value && typeof value === "object" && !Array.isArray(value) && !Object.keys(value).length) continue;
    result[key] = value;
  }
  return result;
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Explain every effective difference by the user's own layer, or refuse.
 * Exactly one non-session layer may declare the server, and it must be
 * `user`; each extra key must equal that layer's value and pass the allowance.
 * Keys Zeros sets must still have Zeros' value. */
async function userLayerExtras(
  runtime: Pick<CodexAppServerHandle, "requestTyped">,
  cwd: string | undefined,
  merged: unknown,
  servers: readonly McpServerRegistration[],
  allowance: NativeDeclarationAllowance,
  timeoutMs: number | undefined,
): Promise<AcceptedExtras | null> {
  const name = allowance.serverName;
  const definition = expectedDefinitions(servers)[name];
  const actual = plainRecord(plainRecord(merged)?.[name]);
  if (!definition || !actual) return null;
  const response = await runtime.requestTyped<
    "config/read",
    { layers?: Array<{ name?: { type?: unknown }; config?: unknown }> | null }
  >("config/read", { includeLayers: true, ...(cwd ? { cwd } : {}) }, { timeoutMs: timeoutMs ?? 10_000 });
  if (!Array.isArray(response?.layers)) return null;
  let user: Record<string, unknown> | undefined;
  for (const layer of response.layers) {
    const declared = plainRecord(plainRecord(layer?.config)?.mcp_servers);
    if (!declared || !Object.hasOwn(declared, name)) continue;
    const type = layer?.name?.type;
    if (type === "sessionFlags") continue;
    const declaration = plainRecord(declared[name]);
    if (type !== "user" || user || !declaration) return null;
    user = declaration;
  }
  if (!user) return null;
  const want = normalizeDefinition(definition);
  const have = normalizeDefinition(actual);
  const extras: AcceptedExtras = { fields: {}, env: {} };
  for (const key of new Set([...Object.keys(want), ...Object.keys(have)])) {
    if (key === "env" || isDeepStrictEqual(have[key], want[key])) continue;
    if (Object.hasOwn(want, key) || !isDeepStrictEqual(user[key], have[key]) || !allowance.acceptsUserKey([key], have[key]))
      return null;
    extras.fields[key] = have[key];
  }
  const wantEnv = plainRecord(want.env) ?? {};
  const haveEnv = plainRecord(have.env) ?? {};
  const userEnv = plainRecord(user.env) ?? {};
  for (const key of new Set([...Object.keys(wantEnv), ...Object.keys(haveEnv)])) {
    const value = haveEnv[key];
    if (isDeepStrictEqual(value, wantEnv[key])) continue;
    if (Object.hasOwn(wantEnv, key) || typeof value !== "string" || userEnv[key] !== value || !allowance.acceptsUserKey(["env", key], value))
      return null;
    extras.env[key] = value;
  }
  return extras;
}

/** Account-managed packages may be materialized on disk too. Use provider
 * provenance rather than filesystem location or an HTTP transport heuristic. */
async function localPluginMcpServerNames(
  runtime: Pick<CodexAppServerHandle, "requestTyped">,
  cwd?: string,
  codexHome?: string,
): Promise<string[]> {
  const response = await runtime.requestTyped<
    "plugin/installed",
    PluginInstalledResponse
  >(
    "plugin/installed",
    { ...(cwd ? { cwds: [cwd] } : {}) },
    { timeoutMs: 3_000 },
  );
  if (
    !Array.isArray(response.marketplaces) ||
    response.marketplaceLoadErrors?.length
  )
    throw new Error("Incomplete plugin provenance");
  const local = response.marketplaces.flatMap((market) =>
    market.plugins
      .filter(
        (plugin) =>
          plugin.installed &&
          plugin.enabled &&
          !plugin.remotePluginId &&
          plugin.source.type !== "remote",
      )
      .map((plugin) => ({ market, plugin })),
  );
  if (local.length > 128) throw new Error("Too many local plugins");
  const deadline = Date.now() + 5_000;
  const names: string[] = [];
  await Promise.all(
    Array.from({ length: Math.min(4, local.length) }, async () => {
      for (;;) {
        const item = local.shift();
        if (!item) return;
        if (
          await isBundledCodexRuntimePlugin(item.market, item.plugin, codexHome)
        )
          continue;
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("Plugin discovery timed out");
        const result = await runtime.requestTyped<
          "plugin/read",
          PluginReadResponse
        >(
          "plugin/read",
          {
            pluginName: item.plugin.name,
            ...(item.market.path
              ? { marketplacePath: item.market.path }
              : { remoteMarketplaceName: item.market.name }),
          },
          { timeoutMs: Math.min(2_000, remaining) },
        );
        names.push(...result.plugin.mcpServers);
      }
    }),
  );
  return names;
}

/** Enabled `mcp_servers` names, plus every configured HTTP transport. Disabled
 *  entries need no override on their own, but their URLs still constrain an
 *  override when a plugin or internal server contributes the same name. */
function enabledMcpServers(servers: unknown): {
  names: string[];
  httpUrls: Record<string, string>;
} {
  const names: string[] = [];
  const httpUrls: Record<string, string> = Object.create(null);
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
    if (typeof entry?.url === "string" && entry.url.length > 0) {
      httpUrls[name] = entry.url;
    }
    if (entry?.enabled === false) continue;
    names.push(name);
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
  const servers: Record<string, GenJsonValue> = Object.create(null);
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

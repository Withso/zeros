// ──────────────────────────────────────────────────────────
// MCP registry helpers — normalize before handing to adapters.
// ──────────────────────────────────────────────────────────
//
// The gateway holds one MCP server registry (AgentGateway.mcpServers) and
// fans it out to all three agent adapters. Before that fan-out we collapse
// duplicates so nothing double-loads — which matters because Cursor caps
// the total tool count (~40 across all servers), and because the agents
// key their injected MCP maps by name (a second same-name entry would
// silently overwrite the first on Claude/Cursor, or deep-merge oddly on
// Codex).

import { stat } from "node:fs/promises";

import { runFile } from "../git/git-exec";
import {
  managedSettingsPath,
  readSettingsFile,
  REPO_SETTINGS_DIRNAME,
  repoLocalSettingsPath,
  userSettingsPath,
} from "../settings/files";
import {
  mcpServerSchema,
  sanitizeLayer,
  type McpSettingsServer,
  type RawSettingsDoc,
  type SettingsLayerName,
} from "../settings/schema";
import type { McpServerRegistration } from "./types";

/** De-duplicate the MCP registry, FIRST-WINS (registry order = precedence,
 *  so a Zeros "shared" entry placed ahead of a later dupe wins). Two kinds
 *  of duplicate are dropped:
 *   - same `name` — agents key by name; a duplicate would clobber/merge.
 *   - same endpoint (`url`) under a different name — would connect to the
 *     same server twice, doubling its tools against Cursor's ~40-tool cap.
 *
 *  Scope note: this deduplicates the Zeros registry against itself. Native
 *  pass-through agent configuration remains outside this registry. */
export function dedupeMcpServers(
  servers: readonly McpServerRegistration[],
): McpServerRegistration[] {
  const seenNames = new Set<string>();
  const seenTargets = new Set<string>();
  const out: McpServerRegistration[] = [];
  for (const s of servers) {
    // Endpoint identity: the URL for http, the command line for stdio — two
    // entries pointing at the same server (under different names) are dupes.
    const target =
      s.transport === "http"
        ? `http:${s.url}`
        : `stdio:${JSON.stringify([s.command, ...(s.args ?? [])])}`;
    if (seenNames.has(s.name) || seenTargets.has(target)) continue;
    seenNames.add(s.name);
    seenTargets.add(target);
    out.push(s);
  }
  return out;
}

/** Sentinel an `env`/`headers` VALUE carries when its real value lives in the OS
 *  Keychain, not the settings file. The engine STRIPS these from the registry by
 *  construction (below), so a secret can never reach an adapter's MCP config —
 *  which for Codex would land on the `-c mcp_servers.x.env=…` command line (a
 *  `ps` leak). The renderer instead couriers the real value into the agent's
 *  PROCESS env; an stdio server inherits it (headers can't inherit → http
 *  secrets wait for the gateway). MUST match the renderer's copy
 *  (apps/desktop/src/renderer/features/agent/mcp-secrets.ts). */
export const MCP_SECRET_SENTINEL = "${zeros.secret}";

/** Drop any entry whose value is the Keychain sentinel — those are provided via
 *  the agent's process env (the renderer's courier), never written into config
 *  we hand an agent. Returns undefined when nothing survives. */
function stripSecretSentinels(
  map: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!map) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    if (v === MCP_SECRET_SENTINEL) continue;
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Map one validated settings entry to a gateway registration: drop the
 *  `enabled`/`transport` bookkeeping into the discriminated shape, strip any
 *  Keychain-sentinel secrets (never put a secret in MCP config — see above),
 *  omit empty optionals. */
function toRegistration(s: McpSettingsServer): McpServerRegistration {
  if (s.transport === "stdio") {
    const env = stripSecretSentinels(s.env);
    return {
      name: s.name,
      transport: "stdio",
      command: s.command,
      ...(s.args ? { args: s.args } : {}),
      ...(env ? { env } : {}),
    };
  }
  const headers = stripSecretSentinels(s.headers);
  return {
    name: s.name,
    transport: "http",
    url: s.url,
    ...(headers ? { headers } : {}),
  };
}

/** Project a single resolved/merged settings doc's `[[mcp.servers]]` into the
 *  registry shape. Each entry is re-validated against the same zod union the
 *  sanitizer used — cheap, and safe for any caller (a raw doc, a test fixture).
 *  An `enabled: false` entry is kept in the file but DROPPED here. Reads the
 *  MERGED doc, so for layered composition use `resolveMcpServers` instead
 *  (arrays replace whole on merge — the merged doc only has the top layer's). */
export function mcpServersFromSettings(
  effective:
    | RawSettingsDoc
    | { mcp?: { servers?: unknown } }
    | null
    | undefined,
): McpServerRegistration[] {
  const raw = (effective as { mcp?: { servers?: unknown } } | null | undefined)
    ?.mcp?.servers;
  if (!Array.isArray(raw)) return [];
  const out: McpServerRegistration[] = [];
  for (const entry of raw) {
    const parsed = mcpServerSchema.safeParse(entry);
    if (!parsed.success || parsed.data.enabled === false) continue;
    // Gateway-managed (auth:"oauth"|"header") servers are fronted by the gateway,
    // not injected directly — keep them out of the direct registry (mirrors the
    // resolveMcpServers partition).
    if (
      parsed.data.transport === "http" &&
      (parsed.data.auth === "oauth" || parsed.data.auth === "header")
    ) {
      continue;
    }
    out.push(toRegistration(parsed.data));
  }
  return out;
}

/** Layers that may declare MCP servers, HIGHEST precedence FIRST. Dedup is
 *  first-wins, so a server managed policy defines overrides a same-named one
 *  from the repo or user file, and a repo-local server overrides a same-named
 *  user one (the more specific scope wins — matching the settings resolver).
 *  `repo-local` only contributes when the caller passes a repoRoot (a
 *  per-session resolve); the committed repo file and workspace-local never
 *  carry MCP (the clone-borne-file gate — see schema.ts
 *  REPO_UNSUPPORTED_BY_LAYER). */
const MCP_LAYER_PRECEDENCE: readonly SettingsLayerName[] = [
  "managed",
  "repo-local",
  "user",
];

/** A server routed through the Zeros MCP gateway (auth:"oauth") rather than
 *  injected directly — the gateway brokers OAuth 2.1 once + holds the token +
 *  fronts the server's tools on localhost. Consumed by the gateway host and
 *  surfaced here so the partition stays stable and testable. */
export interface GatewayBackend {
  name: string;
  url: string;
  /** "oauth" = the gateway brokers OAuth 2.1; "header" = the gateway adds a static
   *  auth header whose VALUE lives in the engine vault (never in settings). */
  auth: "oauth" | "header";
  /** For auth:"header": the header name (e.g. "Authorization"). The value is held
   *  by the gateway vault, keyed by the backend's canonical resource URI. */
  headerName?: string;
  /** For auth:"header": any NON-secret plain headers to also send (e.g. a custom
   *  header alongside the brokered auth one — kept in settings, never secret). */
  headers?: Record<string, string>;
  /** For auth:"oauth": a pre-registered client_id (no-DCR providers). Non-secret. */
  clientId?: string;
  /** Tool NAMES to hide from agents (the Cursor 40-cap allowlist). The gateway
   *  filters these out of the aggregated set it serves. */
  disabledTools?: string[];
  source: SettingsLayerName;
}

export interface ResolvedMcpRegistry {
  /** Directly-injected servers (everything except auth:"oauth"). */
  servers: McpServerRegistration[];
  /** Parallel to `servers`: the layer each surviving server came from (badges). */
  sources: SettingsLayerName[];
  /** Gateway-managed (auth:"oauth") servers, partitioned out of direct injection. */
  gatewayBackends: GatewayBackend[];
  /** Human-readable notes (e.g. a committed-repo stdio server that was gated). */
  warnings: string[];
}

/** Read a settings file's parsed doc for resolution — a malformed layer
 *  contributes no servers (never fail the whole resolve / an agent spawn). */
function readLayerDoc(filePath: string): unknown {
  const r = readSettingsFile(filePath);
  return r.error ? undefined : r.doc;
}

const REPO_LOCAL_SETTINGS_RELPATH = `${REPO_SETTINGS_DIRNAME}/settings.local.toml`;

/** Cached `git check-ignore` verdicts, keyed by repoRoot and valid only while
 *  the settings file's mtime is unchanged. This resolver runs on EVERY agent
 *  spawn (gateway resolveSessionMcp), and before this cache each spawn shelled
 *  a synchronous `git check-ignore` — a per-spawn subprocess on the engine's
 *  single thread. Staleness posture:
 *   - a stale TRUSTED verdict is safe: "trusted" proves the file was ignored
 *     and UNTRACKED, and an untracked file can't be introduced by a
 *     clone/pull — it only becomes tracked via the user's own deliberate
 *     `git add -f` (self-inflicted, and any rewrite of the file re-checks).
 *   - a stale UNTRUSTED verdict is only a UX lag (e.g. the user just fixed
 *     .gitignore without touching the settings file), so negatives expire
 *     after a short TTL and re-shell git on the next resolve. */
interface RepoLocalTrustVerdict {
  mtimeMs: number;
  trusted: boolean;
  checkedAt: number;
}
const repoLocalTrustCache = new Map<string, RepoLocalTrustVerdict>();
const UNTRUSTED_VERDICT_TTL_MS = 30_000;
/** Repos-with-repo-local-settings count is tiny in practice; the cap only
 *  bounds a pathological long-lived engine. Eviction is oldest-insert. */
const TRUST_CACHE_MAX_ENTRIES = 256;

/** Run `git check-ignore` off the event loop. Exit 0 = trusted; any failure
 *  (exit 1 "not ignored", exit 128, timeout, missing git) = fail closed. */
async function gitConfirmsIgnoredUntracked(repoRoot: string): Promise<boolean> {
  try {
    await runFile(
      "git",
      [
        "-C",
        repoRoot,
        "check-ignore",
        "--quiet",
        "--",
        REPO_LOCAL_SETTINGS_RELPATH,
      ],
      { timeoutMs: 2_000 },
    );
    return true;
  } catch {
    return false;
  }
}

/** Read repo-local MCP only when Git confirms the file is personal state.
 * `.gitignore` cannot make an already-tracked file safe: `git check-ignore`
 * deliberately omits tracked paths, so status 0 proves both properties needed
 * here (ignored and not tracked). Fail closed when Git cannot establish that
 * trust boundary. Async on purpose: the engine is single-threaded under Bun,
 * and the old spawnSync here blocked ALL HTTP/WS handling for the duration of
 * a git subprocess on every agent-session spawn. */
async function readTrustedRepoLocalDoc(
  repoRoot: string,
  warnings: string[],
): Promise<unknown> {
  const filePath = repoLocalSettingsPath(repoRoot);
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    return undefined; // no repo-local file — the common case; no git needed
  }

  const cached = repoLocalTrustCache.get(repoRoot);
  let trusted: boolean;
  if (
    cached &&
    cached.mtimeMs === fileStat.mtimeMs &&
    (cached.trusted || Date.now() - cached.checkedAt < UNTRUSTED_VERDICT_TTL_MS)
  ) {
    trusted = cached.trusted;
  } else {
    trusted = await gitConfirmsIgnoredUntracked(repoRoot);
    if (repoLocalTrustCache.size >= TRUST_CACHE_MAX_ENTRIES) {
      const oldest = repoLocalTrustCache.keys().next().value;
      if (oldest !== undefined) repoLocalTrustCache.delete(oldest);
    }
    repoLocalTrustCache.set(repoRoot, {
      mtimeMs: fileStat.mtimeMs,
      trusted,
      checkedAt: Date.now(),
    });
  }

  if (!trusted) {
    warnings.push(
      `mcp.servers: ignored ${REPO_LOCAL_SETTINGS_RELPATH} because Git does not confirm it as an untracked, ignored personal settings file`,
    );
    return undefined;
  }
  return readLayerDoc(filePath);
}

/** Resolve the effective MCP registry from the USER file plus MANAGED policy
 *  — the boot/global view (engine boot-load, gateway backends, Customize tab).
 *  No repo layer, so no git subprocess: stays synchronous for its callers
 *  (engine index, workspace service). For a per-session resolve that also
 *  composes the repo's PERSONAL repo-local file, use
 *  `resolveMcpServersForRepo` — async, because establishing the repo-local
 *  trust boundary shells git. */
export function resolveMcpServers(): ResolvedMcpRegistry {
  return composeMcpRegistry(
    {
      user: readLayerDoc(userSettingsPath()),
      managed: readLayerDoc(managedSettingsPath()),
    },
    [],
  );
}

/** Resolve the effective MCP registry for one session: USER + MANAGED plus the
 *  repo's PERSONAL `.zeros/settings.local.toml`. Async on purpose — the
 *  repo-local trust check shells `git check-ignore` (cached, see
 *  `repoLocalTrustCache`), and the engine's single Bun thread must never block
 *  on a subprocess during an agent spawn. */
export async function resolveMcpServersForRepo(
  repoRoot: string,
): Promise<ResolvedMcpRegistry> {
  const warnings: string[] = [];
  const repoLocal = await readTrustedRepoLocalDoc(repoRoot, warnings);
  return composeMcpRegistry(
    {
      user: readLayerDoc(userSettingsPath()),
      managed: readLayerDoc(managedSettingsPath()),
      "repo-local": repoLocal,
    },
    warnings,
  );
}

/** Compose per-layer raw docs into the effective registry: highest precedence
 *  first, dedup first-wins. Unlike scalar/table settings, `mcp.servers` is an
 *  ARRAY that replaces whole on merge — so we read each layer's OWN array and
 *  concatenate.
 *
 *  The COMMITTED repo file and workspace-local never contribute (the
 *  2026-07-17 slimming's clone-borne stdio RCE gate): only a repo-local file
 *  that Git confirms is ignored and untracked — written by the Customize tab's
 *  repo scope on this machine — may add per-repo servers. Gateway-managed
 *  (auth oauth/header) entries are USER/MANAGED-level only: the one global
 *  gateway boot-loads its backends without a repo context, so a repo-local
 *  gateway entry is skipped with a warning rather than silently never mounted.
 *  The per-layer file model is kept local here to isolate it from this
 *  security-sensitive resolver. */
function composeMcpRegistry(
  rawByLayer: Partial<Record<SettingsLayerName, unknown>>,
  warnings: string[],
): ResolvedMcpRegistry {
  const servers: McpServerRegistration[] = [];
  const sources: SettingsLayerName[] = [];
  const gatewayBackends: GatewayBackend[] = [];
  const seenNames = new Set<string>();
  const seenTargets = new Set<string>();

  for (const layer of MCP_LAYER_PRECEDENCE) {
    const raw = rawByLayer[layer];
    if (raw === undefined) continue;
    const { doc } = sanitizeLayer(raw, layer);
    const list = (doc.mcp as { servers?: unknown } | undefined)?.servers;
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const parsed = mcpServerSchema.safeParse(entry);
      if (!parsed.success || parsed.data.enabled === false) continue;
      const s = parsed.data;
      // Gateway-managed (auth:"oauth"|"header") servers are NOT injected
      // directly — the global gateway brokers auth + fronts them. Partition
      // them out (same name/url dedup namespace as direct servers, so a name
      // can't be both).
      if (
        s.transport === "http" &&
        (s.auth === "oauth" || s.auth === "header")
      ) {
        // The gateway is user-global (boot-loaded with no repo context), so a
        // repo-local gateway entry would never be mounted — skip it loudly,
        // WITHOUT reserving its name (a same-named user/managed entry still
        // resolves).
        if (layer === "repo-local") {
          warnings.push(
            `mcp.servers: "${s.name}" uses gateway auth ("${s.auth}") — gateway servers are user-level only; move it to your user MCP servers`,
          );
          continue;
        }
        const target = `http:${s.url}`;
        if (seenNames.has(s.name) || seenTargets.has(target)) continue;
        seenNames.add(s.name);
        seenTargets.add(target);
        gatewayBackends.push({
          name: s.name,
          url: s.url,
          auth: s.auth,
          ...(s.auth === "header"
            ? {
                headerName: s.header_name || "Authorization",
                ...(s.headers && Object.keys(s.headers).length
                  ? { headers: s.headers }
                  : {}),
              }
            : {}),
          ...(s.auth === "oauth" && s.oauth_client_id
            ? { clientId: s.oauth_client_id }
            : {}),
          ...(s.disabled_tools && s.disabled_tools.length
            ? { disabledTools: s.disabled_tools }
            : {}),
          source: layer,
        });
        continue;
      }
      const reg = toRegistration(s);
      const target =
        reg.transport === "http"
          ? `http:${reg.url}`
          : `stdio:${JSON.stringify([reg.command, ...(reg.args ?? [])])}`;
      if (seenNames.has(reg.name) || seenTargets.has(target)) continue; // first-wins = higher precedence
      seenNames.add(reg.name);
      seenTargets.add(target);
      servers.push(reg);
      sources.push(layer);
    }
  }
  return { servers, sources, gatewayBackends, warnings };
}

// ──────────────────────────────────────────────────────────
// Customize page — pure helpers (no React/JSX, unit-tested)
// ──────────────────────────────────────────────────────────
//
// The Customize tab manages agent capabilities (MCP today; Skills / Plugins
// later) at two scopes: the USER (machine-wide, every repo inherits) and one
// REPO (that repo's personal `.zeros/settings.local.toml`). These helpers
// keep the scope encoding and the paste-a-JSON import parsing view-free so
// both are testable without a DOM. See customize-page.tsx for the views.
// ──────────────────────────────────────────────────────────

import { asString, type RawServer } from "./mcp-panel-helpers";

// ── Scope ────────────────────────────────────────────────

/** Where the Customize page is pointed: the user (global) layer, or one
 *  repo's personal repo-local layer (referenced by stable project id). */
export type CustomizeScope =
  | { kind: "user" }
  | { kind: "repo"; projectId: string };

/** Encode a scope for persistence (`customize:active-scope`). */
export function encodeCustomizeScope(scope: CustomizeScope): string {
  return scope.kind === "user" ? "user" : `repo:${scope.projectId}`;
}

/** Decode a persisted scope, validating a repo scope against the LIVE project
 *  ids — a removed/stale repo falls back to the user scope rather than a dead
 *  view (same contract as the repo page's activeRepoId validation). */
export function decodeCustomizeScope(
  raw: unknown,
  validProjectIds: ReadonlySet<string>,
): CustomizeScope {
  if (typeof raw === "string" && raw.startsWith("repo:")) {
    const projectId = raw.slice("repo:".length);
    if (projectId && validProjectIds.has(projectId)) {
      return { kind: "repo", projectId };
    }
  }
  return { kind: "user" };
}

// ── Paste-a-JSON import ──────────────────────────────────
//
// The form's "Import JSON" accepts the common MCP config shapes people copy
// from docs/other tools and maps them onto our raw settings entries:
//   { "mcpServers": { "<name>": { command|url, ... } } }   (Cursor/Claude)
//   { "<name>": { command|url, ... } }                     (bare name map)
//   { "name": "...", command|url|serverUrl, ... }          (single server)

export interface ParsedJsonImport {
  servers: RawServer[];
  /** Human-readable reasons entries were skipped (never silent). */
  warnings: string[];
  /** A fatal parse problem (nothing imported), or null. */
  error: string | null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Copy a `{string: string}` table, skipping non-string values. */
function stringMap(v: unknown): Record<string, string> | undefined {
  if (!isPlainObject(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === "string") out[k] = val;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Map one JSON server config onto a raw settings entry, or null (with a
 *  warning) when it declares neither a command nor a URL. */
function serverFromJson(
  name: string,
  cfg: Record<string, unknown>,
  warnings: string[],
): RawServer | null {
  const command = asString(cfg.command);
  const url = asString(cfg.url) || asString(cfg.serverUrl);
  if (!command && !url) {
    warnings.push(`${name || "(unnamed)"}: no "command" or "url" — skipped`);
    return null;
  }
  if (command) {
    const args = Array.isArray(cfg.args)
      ? cfg.args.filter((a): a is string => typeof a === "string")
      : [];
    const env = stringMap(cfg.env);
    return {
      name,
      transport: "stdio",
      command,
      ...(args.length ? { args } : {}),
      ...(env ? { env } : {}),
    };
  }
  const headers = stringMap(cfg.headers);
  return {
    name,
    transport: "http",
    url,
    ...(headers ? { headers } : {}),
  };
}

/** Parse pasted JSON into raw server entries. Tolerant of the three common
 *  shapes above; anything else is a clear error, never a guess. */
export function parseMcpJsonImport(text: string): ParsedJsonImport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { servers: [], warnings: [], error: "Not valid JSON." };
  }
  if (!isPlainObject(parsed)) {
    return {
      servers: [],
      warnings: [],
      error: "Expected a JSON object describing MCP server(s).",
    };
  }

  const warnings: string[] = [];
  const servers: RawServer[] = [];

  // Single-server shape: { name?, command|url|serverUrl, ... }
  if (
    typeof parsed.command === "string" ||
    typeof parsed.url === "string" ||
    typeof parsed.serverUrl === "string"
  ) {
    const one = serverFromJson(asString(parsed.name), parsed, warnings);
    if (one) servers.push(one);
    return {
      servers,
      warnings,
      error: servers.length || warnings.length ? null : "No servers found.",
    };
  }

  // Map shapes: { mcpServers: {...} } or a bare { name: {...} } map.
  const map = isPlainObject(parsed.mcpServers) ? parsed.mcpServers : parsed;
  for (const [name, cfg] of Object.entries(map)) {
    if (!isPlainObject(cfg)) {
      warnings.push(`${name}: not an object — skipped`);
      continue;
    }
    const entry = serverFromJson(name, cfg, warnings);
    if (entry) servers.push(entry);
  }
  return {
    servers,
    warnings,
    error:
      servers.length || warnings.length
        ? null
        : "No servers found — expected {\"mcpServers\": {…}} or a single {\"command\"/\"url\": …} object.",
  };
}

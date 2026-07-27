// ──────────────────────────────────────────────────────────
// MCP gateway — tool aggregation core (namespacing + merge + routing)
// ──────────────────────────────────────────────────────────
//
// The gateway is simultaneously an MCP SERVER (to the agents) and an MCP CLIENT
// (to each backend). On connect it lists every backend's tools and re-exposes
// the UNION under one endpoint, with each tool prefixed by its backend name so
// names from different backends never collide. An incoming `tools/call` for a
// namespaced name is routed back to the owning backend + its original tool name.
//
// This module is that logic, kept PURE (no transports, no async) so the
// collision/namespacing/routing rules are unit-tested before the networking
// host exists — the host just wires the MCP client/server transports around it.
//
// Namespacing convention: `<server>__<tool>` (double underscore) — the same
// shape Claude Code uses for MCP tools (`mcp__<server>__<tool>`), so it round-
// trips cleanly through all three agents' permission rules. Routing uses an
// explicit map (not string-splitting), so a server name is never mis-parsed.
// ──────────────────────────────────────────────────────────

/** The delimiter between a backend name and a tool name. */
export const NS_DELIM = "__";

/** Sanitize a backend name for use as a tool-name prefix: keep the namespace-
 *  safe set ([A-Za-z0-9-]), collapse every run of other characters (including
 *  underscores) to a single `_`, and trim leading/trailing `_`. Collapsing runs
 *  guarantees the sanitized name never itself contains the `__` delimiter. */
export function sanitizeServerName(name: string): string {
  return name.replace(/[^A-Za-z0-9-]+/g, "_").replace(/^_+|_+$/g, "") || "server";
}

/** The namespaced name a client sees for a backend's tool. */
export function gatewayToolName(serverName: string, toolName: string): string {
  return `${sanitizeServerName(serverName)}${NS_DELIM}${toolName}`;
}

/** A tool as listed by a backend (only `name` matters here; the rest is passed
 *  through verbatim so description/inputSchema/annotations survive). */
export interface McpToolLike {
  name: string;
  [k: string]: unknown;
}

export interface BackendToolSet {
  /** The backend's configured name (the namespace prefix). */
  server: string;
  tools: readonly McpToolLike[];
}

/** Where a namespaced tool routes: the owning backend + its ORIGINAL tool name. */
export interface ToolRoute {
  server: string;
  tool: string;
}

export interface AggregatedTools {
  /** The namespaced union, ready for the gateway's `tools/list` response. */
  tools: McpToolLike[];
  /** namespaced name → { backend, original tool name } for `tools/call` routing. */
  route: Map<string, ToolRoute>;
  /** Non-fatal notes (a name collision, a dropped malformed tool). */
  warnings: string[];
}

/** Merge every backend's tools into one namespaced, routable set. A namespaced-
 *  name collision (only possible when two backend names sanitize identically)
 *  keeps the first and warns; a tool with no string `name` is dropped. Order is
 *  preserved (backend order, then tool order) so `tools/list` is stable. */
export function aggregateTools(backends: readonly BackendToolSet[]): AggregatedTools {
  const tools: McpToolLike[] = [];
  const route = new Map<string, ToolRoute>();
  const warnings: string[] = [];
  for (const backend of backends) {
    for (const tool of backend.tools) {
      if (!tool || typeof tool.name !== "string" || tool.name.length === 0) {
        warnings.push(`server "${backend.server}": dropped a tool with no name`);
        continue;
      }
      const namespaced = gatewayToolName(backend.server, tool.name);
      if (route.has(namespaced)) {
        warnings.push(
          `tool "${namespaced}" (server "${backend.server}") collides with an earlier tool — kept the first`,
        );
        continue;
      }
      route.set(namespaced, { server: backend.server, tool: tool.name });
      tools.push({ ...tool, name: namespaced });
    }
  }
  return { tools, route, warnings };
}

/** Resolve a `tools/call` name back to its backend, or null if unknown (the
 *  client called a tool the gateway doesn't expose — surface a clean error). */
export function resolveToolCall(
  route: ReadonlyMap<string, ToolRoute>,
  namespacedName: string,
): ToolRoute | null {
  return route.get(namespacedName) ?? null;
}

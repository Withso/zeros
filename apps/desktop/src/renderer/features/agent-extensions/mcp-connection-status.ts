import { KeyedAsyncCache } from "../../shared/lib/keyed-async-cache";
import type { McpProbeResult } from "./mcp-server-editor";
import { secureDraftFromServer, serverFromDraft, type RawServer } from "./mcp-server-model";

/** Last confirmed checks, scoped to an exact runtime/account and config.
 * Memory only; no timer or request is needed to render a saved status. */
export const mcpConnectionCache = new KeyedAsyncCache<McpProbeResult>({
  maxEntries: 256,
  // Catalogs can contain thousands of names. Bound inactive payloads as well
  // as entry count, while keeping the active/latest complete catalog intact.
  maxWeight: 4 * 1024 * 1024,
  weightOf: result => 256 + (result.tools?.reduce((bytes, name) => bytes + name.length * 2 + 32, 0) ?? 0),
  retainNewest: true,
});
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)]));
  return value;
}
type DefinitionRevision = { id: string; revision: number };
export function mcpConnectionKey(owner: string, server: RawServer, definition?: DefinitionRevision): string {
  const { enabled: _enabled, description: _description, disabled_tools: _tools, ...connection } = serverFromDraft(secureDraftFromServer(server), server);
  return JSON.stringify([owner, canonical(connection), definition ? [definition.id, definition.revision] : null]);
}
export function rememberMcpConnection(owner: string, server: RawServer, result?: McpProbeResult, definition?: DefinitionRevision): void {
  const key = mcpConnectionKey(owner, server, definition);
  const previous = mcpConnectionCache.getSnapshot(key).data;
  // A failed refresh must not erase a confirmed exact-key inventory. An
  // unverified save still clears it, and an authoritative [] replaces it.
  mcpConnectionCache.setData(key, result ? { ...result,
    ...(result.tools === undefined && previous?.tools ? { tools: previous.tools } : {}),
  } : { status: "failed", stages: [] });
}

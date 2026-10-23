import { KeyedAsyncCache } from "../../shared/lib/keyed-async-cache";
import type { McpProbeResult } from "./mcp-server-editor";
import { secureDraftFromServer, serverFromDraft, type RawServer } from "./mcp-server-model";

/** Last confirmed checks, scoped to an exact runtime/account and config.
 * Memory only; no timer or request is needed to render a saved status. */
export const mcpConnectionCache = new KeyedAsyncCache<McpProbeResult>(256);
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
  mcpConnectionCache.setData(mcpConnectionKey(owner, server, definition), result ?? { status: "failed", stages: [] });
}

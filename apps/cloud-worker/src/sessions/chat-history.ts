// Wire fields and window behavior follow apps/desktop/src/engine/db/{chats,messages}.ts
// at 4baf69ec. Storage is worker-owned; no Local runtime is imported.
import { coerceProviderBinding, coerceProviderMetadata, type ProviderBinding, type ProviderMetadata } from "@zeros/protocol/identities";
import type { CloudV2MessageRow } from "@zeros/protocol/cloud-v2-relay";

export interface ChatRow {
  id: string;
  folder: string;
  composerMode: "code";
  composerModeRevision: number;
  agentId: string | null;
  agentName: string | null;
  model: string | null;
  effort: string;
  permissionMode: string;
  lastModeId: string | null;
  prePlanModeId: string | null;
  fast: boolean;
  additionalDirectories: string[];
  title: string;
  createdAt: number;
  updatedAt: number;
  sessionId: string | null;
  providerBinding: ProviderBinding | null;
  providerMetadata: ProviderMetadata | null;
  pinned: boolean;
  archived: boolean;
  sourceChatId: string | null;
  kind: string | null;
}

export function coerceChat(value: unknown): ChatRow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !row.id || row.id.length > 256) return null;
  const str = (value: unknown): string => typeof value === "string" ? value : "";
  const nullable = (value: unknown): string | null => typeof value === "string" ? value : null;
  const num = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : 0;
  const agentId = nullable(row.agentId);
  const binding = coerceProviderBinding(row.providerBinding);
  const providerBinding = binding?.providerId === agentId ? binding : null;
  return {
    id: row.id, folder: str(row.folder), composerMode: "code", composerModeRevision: 0,
    agentId, agentName: nullable(row.agentName), model: nullable(row.model),
    effort: str(row.effort), permissionMode: str(row.permissionMode),
    lastModeId: nullable(row.lastModeId), prePlanModeId: nullable(row.prePlanModeId), fast: row.fast === true,
    additionalDirectories: Array.isArray(row.additionalDirectories) ? row.additionalDirectories.filter((dir): dir is string => typeof dir === "string") : [],
    title: str(row.title), createdAt: num(row.createdAt), updatedAt: num(row.updatedAt),
    sessionId: nullable(row.sessionId), providerBinding,
    providerMetadata: providerBinding ? coerceProviderMetadata(row.providerMetadata) : null,
    pinned: row.pinned === true, archived: row.archived === true,
    sourceChatId: nullable(row.sourceChatId), kind: nullable(row.kind),
  };
}

export interface MessageWindow { messages: CloudV2MessageRow[]; turnOpening?: CloudV2MessageRow }
const WINDOW_MAX_ROWS = 1000;

function userRow(row: CloudV2MessageRow, openingOnly = false): boolean {
  if (row.kind !== "text") return false;
  try {
    const value = JSON.parse(row.payload);
    return value?.role === "user" && (!openingOnly || value.steeredTurnId == null);
  } catch { return false; }
}

/** Array position + 1 is the persisted insertion ordinal. Updating a row never
 * moves it. Tail reads snap contiguously; older pages retain their exact cursor. */
export function messageWindow(rows: CloudV2MessageRow[], limit = 200, before?: number): MessageWindow {
  const cap = Number.isFinite(limit) ? (limit < 0 ? WINDOW_MAX_ROWS : Math.min(WINDOW_MAX_ROWS, Math.floor(limit))) : 200;
  if (cap === 0) return { messages: [] };
  const end = before ? Math.max(0, Math.min(rows.length, Math.ceil(before) - 1)) : rows.length;
  let start = Math.max(0, end - cap);
  const anchor = (floor: number, ceiling: number): number => {
    for (const openingOnly of [true, false]) {
      for (let index = ceiling - 1; index >= floor; index--) if (userRow(rows[index], openingOnly)) return index;
    }
    return -1;
  };
  if (!before && rows[start] && !userRow(rows[start])) {
    const budget = WINDOW_MAX_ROWS - (end - start);
    const opening = anchor(Math.max(0, start - budget), start);
    if (opening >= 0) start = opening;
  }
  const result: MessageWindow = { messages: rows.slice(start, end) };
  if (!before && rows[start] && !userRow(rows[start])) {
    const opening = anchor(0, start);
    if (opening >= 0) result.turnOpening = rows[opening];
  }
  return structuredClone(result);
}

export function upsertRows(existing: CloudV2MessageRow[], incoming: CloudV2MessageRow[]): void {
  const indices = new Map(existing.map((row, index) => [row.msgId, index]));
  for (const row of incoming) {
    const index = indices.get(row.msgId);
    if (index !== undefined) existing[index] = row;
    else { indices.set(row.msgId, existing.length); existing.push(row); }
  }
}

import type { ChatRowWire } from "../features/agent/agent-history-client";
import { sanitizeChatDirectories } from "./chat-boot-cache";
import type { ChatThread } from "./store";

/** ChatThread → SQLite wire row. Every field stays JSON-safe, so IPC needs no
 *  custom serializer. */
export function threadToRow(c: ChatThread): ChatRowWire {
  return {
    id: c.id,
    folder: c.folder ?? "",
    agentId: c.agentId ?? null,
    agentName: c.agentName ?? null,
    model: c.model ?? null,
    effort: c.effort,
    permissionMode: c.permissionMode,
    lastModeId: c.lastModeId ?? null,
    prePlanModeId: c.prePlanModeId ?? null,
    fast: !!c.fast,
    additionalDirectories: sanitizeChatDirectories(c.additionalDirectories),
    title: c.title ?? "",
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    sessionId: c.sessionId ?? null,
    providerBinding: c.providerBinding ?? null,
    providerMetadata: c.providerMetadata ?? null,
    pinned: !!c.pinned,
    archived: !!c.archived,
    sourceChatId: c.sourceChatId ?? null,
    kind: c.kind ?? null,
  };
}

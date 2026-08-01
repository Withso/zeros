// ──────────────────────────────────────────────────────────
// Synchronous chat boot cache
// ──────────────────────────────────────────────────────────
//
// The durable chat database remains authoritative. This localStorage mirror is
// the exact last confirmed renderer snapshot, validated synchronously so the
// first React render can restore the last workspace + chat without a blank
// post-paint hydration commit. The engine copy revalidates in the background.

import { getSetting, setSetting } from "../../native/settings";
import { FALLBACK_AGENT_ID } from "../agent/default-agent-id";
import type { ChatEffort, ChatThread } from "./store";
import { normalizeChatPermissionMode } from "./chat-permission";
import {
  ACTIVE_CHAT_KEY,
  CHATS_BACKUP_KEY,
  CHATS_STORAGE_KEY,
  CHATS_TOMBSTONE_KEY,
} from "./chats-local-cache";

const VALID_EFFORTS = new Set<ChatEffort>([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultracode",
]);

/** Normalize persisted additional working directories at every hydration
 * boundary. Invalid/corrupt entries are dropped and order is preserved. */
export function sanitizeChatDirectories(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const directories: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const directory = raw.trim();
    if (!directory || seen.has(directory)) continue;
    seen.add(directory);
    directories.push(directory);
  }
  return directories;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Type-guard and migrate one cache row. A malformed row is omitted instead of
 * allowing one corrupt record to make the entire application boot fail. */
export function sanitizeCachedChat(value: unknown): ChatThread | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || raw.id.length === 0) return null;

  const kind = raw.kind === "terminal" ? "terminal" : "chat";
  const createdAt = finiteNumber(raw.createdAt, 0);
  const effort = VALID_EFFORTS.has(raw.effort as ChatEffort)
    ? (raw.effort as ChatEffort)
    : "medium";
  const legacyResume =
    typeof raw.resumeSessionId === "string" ? raw.resumeSessionId : undefined;

  return {
    id: raw.id,
    mode: raw.mode === "design" ? "design" : "code",
    folder: typeof raw.folder === "string" ? raw.folder : "",
    kind,
    agentId:
      typeof raw.agentId === "string"
        ? raw.agentId
        : kind === "terminal"
          ? null
          : FALLBACK_AGENT_ID,
    agentName: typeof raw.agentName === "string" ? raw.agentName : null,
    model: typeof raw.model === "string" ? raw.model : null,
    effort,
    fast: raw.fast === true,
    additionalDirectories: sanitizeChatDirectories(raw.additionalDirectories),
    permissionMode: normalizeChatPermissionMode(raw.permissionMode),
    ...(typeof raw.lastModeId === "string"
      ? { lastModeId: raw.lastModeId }
      : {}),
    ...(typeof raw.prePlanModeId === "string"
      ? { prePlanModeId: raw.prePlanModeId }
      : {}),
    title: typeof raw.title === "string" ? raw.title : "Untitled",
    createdAt,
    updatedAt: finiteNumber(raw.updatedAt, createdAt),
    ...(typeof raw.sessionId === "string"
      ? { sessionId: raw.sessionId }
      : legacyResume
        ? { sessionId: legacyResume }
        : {}),
    pinned: raw.pinned === true,
    archived: raw.archived === true,
    ...(typeof raw.sourceChatId === "string"
      ? { sourceChatId: raw.sourceChatId }
      : {}),
  };
}

function sanitizeCachedChats(value: unknown): ChatThread[] {
  if (!Array.isArray(value)) return [];
  const chats: ChatThread[] = [];
  const ids = new Set<string>();
  for (const row of value) {
    const chat = sanitizeCachedChat(row);
    if (!chat || ids.has(chat.id)) continue;
    ids.add(chat.id);
    chats.push(chat);
  }
  return chats;
}

/** Load the renderer's exact last confirmed chat list. A non-empty backup is
 * used only when the primary vanished unexpectedly and no intentional-empty
 * tombstone exists. */
export function loadCachedChatsForBoot(): ChatThread[] {
  const primary = sanitizeCachedChats(
    getSetting<unknown>(CHATS_STORAGE_KEY, []),
  );
  if (primary.length > 0) return primary;
  if (getSetting<boolean>(CHATS_TOMBSTONE_KEY, false)) return [];

  const backup = sanitizeCachedChats(getSetting<unknown>(CHATS_BACKUP_KEY, []));
  if (backup.length > 0) {
    console.warn(
      `[Zeros] primary chats empty — restored ${backup.length} from backup`,
    );
    setSetting(CHATS_STORAGE_KEY, backup);
  }
  return backup;
}

/** Legacy active-chat key used by builds before activeChatId joined the atomic
 * UI snapshot. Kept as the migration fallback for existing installations. */
export function loadLegacyActiveChatId(): string | null {
  const value = getSetting<unknown>(ACTIVE_CHAT_KEY, null);
  return typeof value === "string" && value.length > 0 ? value : null;
}

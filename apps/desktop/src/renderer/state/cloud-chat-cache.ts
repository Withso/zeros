import { getSetting, setSetting } from "../platform/settings";
import { isCloudWorkspace } from "../platform/bridge/cloud-workspace-key";
import { sanitizeCachedChats } from "./chat-boot-cache";
import type { ChatThread } from "./store";

const KEY = "cloud-chats:v1";
let owner: string | null = null;

/** One bounded device snapshot, released only after authentication confirms
 * its account. Durable cloud records remain authoritative on attachment. */
export function setCloudChatCacheOwner(next: string | null): void {
  owner = next;
}
export function loadCloudChatCache(): ChatThread[] {
  if (!owner) return [];
  const cached = getSetting<{ owner: string; chats: unknown } | null>(
    KEY,
    null,
  );
  return cached?.owner === owner
    ? sanitizeCachedChats(cached.chats).filter((row) =>
        isCloudWorkspace(row.folder),
      )
    : [];
}

export function persistWorkspaceChatCache(
  key: string,
  chats: ChatThread[],
): void {
  setSetting(
    key,
    chats.filter((row) => !isCloudWorkspace(row.folder)),
  );
  if (owner)
    setSetting(KEY, {
      owner,
      chats: chats.filter((row) => isCloudWorkspace(row.folder)).slice(-512),
    });
}

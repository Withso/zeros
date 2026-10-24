import { removeSetting, setSetting } from "../platform/settings";
import { cloudWorkspaceKey, isCloudWorkspace, parseCloudScopedId, parseCloudWorkspaceKey } from "../platform/bridge/cloud-workspace-key";
import { accountPresentationGeneration, CLOUD_CHATS_PRESENTATION_KEY, readAccountPresentation, writeAccountPresentation } from "../platform/account-presentation-cache";
import { sanitizeCachedChats } from "./chat-boot-cache";
import type { ChatThread } from "./store";

const MAX_BYTES = 1024 * 1024;
const MAX_CHATS = 512;
let owner: string | null = null;
let restored = false;

/** One bounded device snapshot, released only after authentication confirms
 * its account. Durable cloud records remain authoritative on attachment. */
export function setCloudChatCacheOwner(next: string | null): void {
  owner = next;
  restored = false;
  // v1 was never wired in production and has no backend fence. Do not promote
  // an unscoped record into an authorized account/backend presentation cache.
  removeSetting("cloud-chats:v1");
}

/** Call after the authorized boot rows have merged. Before then, a Local
 * snapshot must not erase the cloud cache during a slow sign-in/reconnect. */
export function completeCloudChatCacheRestore(expectedOwner: string): void {
  if (owner === expectedOwner) restored = true;
}
export function loadCloudChatCache(): ChatThread[] {
  if (!owner) return [];
  return cloudChats(readAccountPresentation(CLOUD_CHATS_PRESENTATION_KEY, owner, MAX_BYTES));
}

function cloudChats(value: unknown): ChatThread[] {
  if (!Array.isArray(value) || value.length > MAX_CHATS) return [];
  return sanitizeCachedChats(value).filter(row => {
    try {
      const folder = parseCloudWorkspaceKey(row.folder), id = parseCloudScopedId(row.id);
      const source = row.sourceChatId ? parseCloudScopedId(row.sourceChatId) : null;
      return folder && !folder.relativePath && id && cloudWorkspaceKey(id) === cloudWorkspaceKey(folder) &&
        (!row.sourceChatId || source && cloudWorkspaceKey(source) === cloudWorkspaceKey(folder));
    } catch { return false; }
  });
}

export function persistWorkspaceChatCache(
  key: string,
  chats: ChatThread[],
  generation = accountPresentationGeneration(),
  selectedChatId?: string | null,
): void {
  if (generation !== accountPresentationGeneration()) return;
  setSetting(
    key,
    chats.filter((row) => !isCloudWorkspace(row.folder)),
  );
  if (owner && restored) {
    const cloud = chats.filter(row => isCloudWorkspace(row.folder));
    const selected = cloud.find(row => row.id === selectedChatId);
    const retained = new Set([...new Set([...(selected ? [selected] : []), ...cloud.slice().reverse()])].slice(0, MAX_CHATS));
    writeAccountPresentation(CLOUD_CHATS_PRESENTATION_KEY, owner,
      cloudChats(cloud.filter(row => retained.has(row))), MAX_BYTES);
  }
}

export function pruneCloudChatCache(folders: readonly string[]): void {
  if (!owner || !restored || !folders.length) return;
  writeAccountPresentation(CLOUD_CHATS_PRESENTATION_KEY, owner,
    loadCloudChatCache().filter(chat => !folders.includes(chat.folder)), MAX_BYTES);
}

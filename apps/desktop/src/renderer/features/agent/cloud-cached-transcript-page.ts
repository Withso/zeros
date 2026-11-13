import { decodeNativeCloudTranscriptWindow, type LocalTranscriptWindow } from "../../state/local-transcript-cache";
import { cloudScopedId, parseCloudScopedId } from "../../platform/bridge/cloud-workspace-key";
import { nativeCloudChatCache } from "../../platform/cloud-chat-cache";
import { NativeCloudCacheError } from "../../platform/cloud-chat-cache-client";

export async function cachedWindowOlderMessages(
  chatId: string, limit: number, before: string, cached: NonNullable<LocalTranscriptWindow["cloudCache"]>,
): Promise<LocalTranscriptWindow | null> {
  const target = parseCloudScopedId(chatId);
  if (!target || cloudScopedId(target, target.id) !== chatId) throw new NativeCloudCacheError("unavailable");
  const current = () => {
    if (nativeCloudChatCache.owner !== cached.owner || nativeCloudChatCache.epoch !== cached.epoch)
      throw new NativeCloudCacheError("owner_changed");
  };
  current();
  const range = await nativeCloudChatCache.readBefore({ organizationId: target.organizationId, workspaceId: target.workspaceId,
    chatId: target.id }, cached.revision, before, limit);
  current();
  return range && decodeNativeCloudTranscriptWindow({ range, pending: null }, cached.owner, cached.epoch);
}

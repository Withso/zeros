import { parseCloudScopedId } from "../../platform/bridge/cloud-workspace-key";

/** Provisional history remains readable while its authoritative read is pending. */
export function CloudTranscriptCacheNotice({ chatId, cached }: { chatId: string; cached: boolean }) {
  if (!cached || !parseCloudScopedId(chatId)) return null;
  return <p className="text-muted-fg px-7 py-1 text-xs" role="status">Cached</p>;
}

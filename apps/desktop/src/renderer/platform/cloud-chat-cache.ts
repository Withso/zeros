import { nativeInvoke } from "./runtime";
import { NativeCloudChatCacheClient } from "./cloud-chat-cache-client";
import type { CloudCacheTarget } from "../../../shared/cloud-chat-cache";

type AccessLoss = (owner: string, target: CloudCacheTarget, scope: "workspace" | "chat") => void;
const accessLoss = new Set<AccessLoss>();
export const nativeCloudChatCache = new NativeCloudChatCacheClient({
  invoke: input => nativeInvoke("cloud_chat_cache", input),
  accessLost: (...args) => { for (const listener of accessLoss) listener(...args); },
});
export function subscribeCloudChatCacheAccessLoss(listener: AccessLoss): () => void {
  accessLoss.add(listener);
  return () => { accessLoss.delete(listener); };
}

const legacyRetirements = new WeakMap<IDBFactory, Promise<void>>();
export function retireLegacyCloudTranscriptStore(
  factory: IDBFactory | undefined = typeof indexedDB === "undefined" ? undefined : indexedDB,
): Promise<void> {
  if (!factory) return Promise.resolve();
  const existing = legacyRetirements.get(factory);
  if (existing) return existing;
  const flight = Promise.resolve().then(() => new Promise<void>((resolve, reject) => {
    const request = factory.deleteDatabase("zeros:cloud-transcripts:v1");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(new Error("Cloud transcript migration unavailable."));
  })).catch(() => { legacyRetirements.delete(factory); });
  legacyRetirements.set(factory, flight);
  return flight;
}

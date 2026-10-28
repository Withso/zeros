/** Files staged into an exact chat's composer through the same insertFiles
 * pipeline as paste, drop and the file picker. The composer, not the caller,
 * owns validation, workspace staging (local path or cloud upload) and draft
 * persistence, so a delivered pill is indistinguishable from a user-added one. */
export interface ComposerFileDelivery {
  /** Caller-owned identity; a repeated id replaces the queued entry. */
  id: string;
  files: File[];
  groupName?: string;
}

/** Returns false when the composer cannot accept files yet; the delivery then
 * stays queued for the next registration of the same chat. */
export type ComposerFileStager = (
  delivery: ComposerFileDelivery,
  options: { focus: boolean },
) => boolean;

export type ComposerFileDeliveryOutcome = "staged" | "queued";

const stagers = new Map<string, ComposerFileStager>();
const pending = new Map<string, Map<string, ComposerFileDelivery>>();
const MAX_PENDING_CHATS = 32;
const MAX_PENDING_PER_CHAT = 8;

/** Deliver to the mounted exact-chat composer, or retain a bounded keyed
 * intent until that chat's composer registers. Another chat's composer can
 * never drain it. Async producers revoke focus if newer input overtakes their
 * read; retained deliveries always lose their original focus authority. */
export function deliverFilesToChat(
  chatId: string,
  delivery: ComposerFileDelivery,
  options?: { focus?: boolean },
): ComposerFileDeliveryOutcome {
  const stage = stagers.get(chatId);
  if (stage?.(delivery, { focus: options?.focus !== false })) return "staged";
  let byId = pending.get(chatId);
  if (!byId) {
    byId = new Map();
    pending.set(chatId, byId);
  }
  byId.delete(delivery.id);
  byId.set(delivery.id, delivery);
  while (byId.size > MAX_PENDING_PER_CHAT) {
    const oldest = byId.keys().next().value as string | undefined;
    if (!oldest) break;
    byId.delete(oldest);
  }
  while (pending.size > MAX_PENDING_CHATS) {
    const oldestChat = pending.keys().next().value as string | undefined;
    if (!oldestChat) break;
    pending.delete(oldestChat);
  }
  return "queued";
}

export function registerLiveChatFileStager(
  chatId: string,
  stage: ComposerFileStager,
): () => void {
  stagers.set(chatId, stage);
  const queued = pending.get(chatId);
  if (queued) {
    for (const [id, delivery] of queued) {
      if (!stage(delivery, { focus: false })) break;
      queued.delete(id);
    }
    if (queued.size === 0) pending.delete(chatId);
  }
  return () => {
    if (stagers.get(chatId) === stage) stagers.delete(chatId);
  };
}

export function hasPendingFileDelivery(chatId: string): boolean {
  return (pending.get(chatId)?.size ?? 0) > 0;
}

/** Test cleanup only; production entries are exact-chat bounded and drain on
 * mount. */
export function clearPendingFileDeliveriesForTesting(): void {
  pending.clear();
  stagers.clear();
}

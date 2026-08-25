export interface LiveTextAttachmentInput {
  sourceKey: string;
  name: string;
  text: string;
}

type TextAttachmentStager = (input: LiveTextAttachmentInput) => boolean;

const stagers = new Map<string, TextAttachmentStager>();
const pending = new Map<string, Map<string, LiveTextAttachmentInput>>();
const inFlight = new Map<string, Set<Promise<unknown>>>();
const MAX_PENDING_CHATS = 32;
const MAX_PENDING_PER_CHAT = 8;

/** Track the asynchronous read that will produce a destination attachment.
 * The destination's Send commit waits for this exact-chat set, closing the
 * fast-click race without adding fork progress chrome. */
export function trackPendingTextAttachmentDelivery(
  chatId: string,
  work: Promise<unknown>,
): void {
  let workForChat = inFlight.get(chatId);
  if (!workForChat) {
    workForChat = new Set();
    inFlight.set(chatId, workForChat);
  }
  workForChat.add(work);
  const settle = () => {
    const current = inFlight.get(chatId);
    current?.delete(work);
    if (current?.size === 0) inFlight.delete(chatId);
  };
  void work.then(settle, settle);
}

export function hasPendingTextAttachmentDelivery(chatId: string): boolean {
  return (inFlight.get(chatId)?.size ?? 0) > 0;
}

/** Await until the exact chat's tracked set is empty. Looping also covers a
 * second delivery registered while an earlier one is settling. Failures are
 * surfaced by their owner; Send only needs the lifecycle barrier. */
export async function waitForPendingTextAttachmentDeliveries(
  chatId: string,
): Promise<void> {
  while (true) {
    const work = inFlight.get(chatId);
    if (!work || work.size === 0) return;
    await Promise.allSettled([...work]);
  }
}

/** Deliver to a mounted exact-chat composer or retain a bounded keyed intent
 * until that composer mounts. This lets tab creation remain synchronous while
 * the transcript read finishes, and appends the chip without replacing text
 * the user may already have typed in the destination. */
export function deliverTextAttachmentToChat(
  chatId: string,
  input: LiveTextAttachmentInput,
): void {
  const stage = stagers.get(chatId);
  if (stage?.(input)) return;
  let bySource = pending.get(chatId);
  if (!bySource) {
    bySource = new Map();
    pending.set(chatId, bySource);
  }
  bySource.set(input.sourceKey, input);
  while (bySource.size > MAX_PENDING_PER_CHAT) {
    const oldest = bySource.keys().next().value as string | undefined;
    if (!oldest) break;
    bySource.delete(oldest);
  }
  while (pending.size > MAX_PENDING_CHATS) {
    const oldestChat = pending.keys().next().value as string | undefined;
    if (!oldestChat) break;
    pending.delete(oldestChat);
  }
}

export function registerLiveChatTextAttachmentStager(
  chatId: string,
  stage: TextAttachmentStager,
): () => void {
  stagers.set(chatId, stage);
  const queued = pending.get(chatId);
  if (queued) {
    for (const [sourceKey, input] of queued) {
      if (stage(input)) queued.delete(sourceKey);
    }
    if (queued.size === 0) pending.delete(chatId);
  }
  return () => {
    if (stagers.get(chatId) === stage) stagers.delete(chatId);
  };
}

/** Test cleanup only; production entries are exact-chat bounded and drain on
 * mount. */
export function clearPendingTextAttachmentsForTesting(): void {
  pending.clear();
  stagers.clear();
  inFlight.clear();
}

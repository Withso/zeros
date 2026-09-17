import type { EditDraftStash } from "../../state/store";

const drafts = new Map<
  string,
  { chatId: string; draft: EditDraftStash | null }
>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.warn("[edit-live-drafts] listener failed:", error);
    }
  }
}

/** Only mounted editors retain a slot. Null masks a parked draft when the
 * user restores the original message or submits successfully. */
export function liveEditDraftEntries() {
  return drafts.entries();
}

export function subscribeToLiveEditDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function registerLiveEditDraft(
  key: string,
  chatId: string,
  draft: EditDraftStash | null,
) {
  const entry = { chatId, draft };
  drafts.set(key, entry);
  notify();
  const isCurrent = () => drafts.get(key) === entry;
  return {
    isCurrent,
    update(next: EditDraftStash | null) {
      if (!isCurrent()) return;
      entry.draft = next;
      notify();
    },
    dispose() {
      if (!isCurrent()) return;
      drafts.delete(key);
      notify();
    },
  };
}

export function pruneLiveEditDrafts(chatIds: ReadonlySet<string>): void {
  let changed = false;
  for (const [key, entry] of drafts) {
    if (!chatIds.has(entry.chatId)) {
      drafts.delete(key);
      changed = true;
    }
  }
  if (changed) notify();
}

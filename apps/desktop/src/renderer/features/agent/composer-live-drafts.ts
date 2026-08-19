// ──────────────────────────────────────────────────────────
// composer-live-drafts.ts — module-level live draft snapshots
// ──────────────────────────────────────────────────────────
//
// The workspace-store-backed draft
// persistence (state.chatComposerDrafts) only writes on UNMOUNT —
// saving on every keystroke would re-render all 50+ workspace
// consumers, which is too costly.
//
// But the sidebar's "New Agent" / "+" click handler needs to read
// the user's in-progress draft RIGHT NOW (before navigating away),
// not whatever was last unmount-flushed. Solution: every composer
// also mirrors its live state into this module-level ref. Mutations
// are synchronous and bypass React's render cycle entirely. The
// click handler reads from here.
//
// On unmount, the composer should call set*Draft(null) to drop its
// entry — the store-backed persistence has already taken over.
// ──────────────────────────────────────────────────────────

import type { ComposerDraft } from "../../state/store";

const liveChatDrafts = new Map<string, ComposerDraft>();

/** Mounted composer owners, keyed exactly by chat. A failed queued send must
 * restore through this owner so the TipTap document and its unmount-persisted
 * live ref change atomically with the module snapshot. */
type LiveChatDraftRestorer = (draft: ComposerDraft) => boolean;
const liveChatDraftRestorers = new Map<string, LiveChatDraftRestorer>();

/** Keystroke observers. Deliberately NOT a store subscription: these fire on
 *  every keystroke, so a listener must do something cheap and must not cause a
 *  render by itself. The one consumer today is the chat view, which uses the
 *  first keystroke as the signal that a deferred session spawn should start —
 *  typing is the earliest honest evidence that the user means to use this
 *  chat, and starting there keeps the admission overlapped with typing instead
 *  of stacked in front of Send. */
type LiveChatDraftListener = (
  chatId: string,
  draft: ComposerDraft | null,
) => void;

const liveChatDraftListeners = new Set<LiveChatDraftListener>();

export function subscribeToLiveChatDrafts(
  listener: LiveChatDraftListener,
): () => void {
  liveChatDraftListeners.add(listener);
  return () => {
    liveChatDraftListeners.delete(listener);
  };
}

export function setLiveChatDraft(
  chatId: string,
  draft: ComposerDraft | null,
): void {
  if (draft === null) {
    liveChatDrafts.delete(chatId);
  } else {
    liveChatDrafts.set(chatId, draft);
  }
  for (const listener of liveChatDraftListeners) {
    // One listener throwing must not stop the others, and must never break the
    // keystroke it rode in on.
    try {
      listener(chatId, draft);
    } catch (error) {
      console.warn("[composer-live-drafts] listener failed:", error);
    }
  }
}

/** Register the one mounted composer that owns a chat's editable document.
 * Identity-checked cleanup prevents an old retained surface from unregistering
 * a replacement that mounted for the same chat first. */
export function registerLiveChatDraftRestorer(
  chatId: string,
  restore: LiveChatDraftRestorer,
): () => void {
  liveChatDraftRestorers.set(chatId, restore);
  return () => {
    if (liveChatDraftRestorers.get(chatId) === restore) {
      liveChatDraftRestorers.delete(chatId);
    }
  };
}

function draftHasContent(draft: ComposerDraft | null): boolean {
  return Boolean(
    draft &&
      (draft.text.trim().length > 0 || draft.attachments.length > 0),
  );
}

/** Restore a dropped send only when no newer live edit exists. A mounted
 * composer gets first refusal; on success the shared live snapshot is updated
 * synchronously so navigation and later unmount persistence see the same text.
 * An unmounted chat has no editor owner, so its store-backed caller can retain
 * this snapshot until the next mount seeds from persistence. */
export function tryRestoreLiveChatDraft(
  chatId: string,
  draft: ComposerDraft,
): boolean {
  if (draftHasContent(getLiveChatDraft(chatId))) return false;
  const restorer = liveChatDraftRestorers.get(chatId);
  if (restorer && !restorer(draft)) return false;
  setLiveChatDraft(chatId, draft);
  return true;
}

/** Whether a draft carries anything the user actually typed. */
export function liveChatDraftHasText(draft: ComposerDraft | null): boolean {
  return (draft?.text ?? "").trim().length > 0;
}

/** The composer's CURRENT draft for a chat — the keystroke-fresh mirror,
 *  ahead of the unmount-flushed store copy. Used by handlers that replace a
 *  chat with another (the cross-agent model switch) so the typed prompt
 *  follows the user instead of dying with the old chat id. */
export function getLiveChatDraft(chatId: string): ComposerDraft | null {
  return liveChatDrafts.get(chatId) ?? null;
}

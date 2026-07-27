// ──────────────────────────────────────────────────────────
// composer-live-drafts.ts — module-level live draft snapshots
// ──────────────────────────────────────────────────────────
//
// Phase D3 (2026-05-08, refined): the workspace-store-backed draft
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

import type { ComposerDraft } from "../store/store";

const liveChatDrafts = new Map<string, ComposerDraft>();

export function setLiveChatDraft(
  chatId: string,
  draft: ComposerDraft | null,
): void {
  if (draft === null) {
    liveChatDrafts.delete(chatId);
    return;
  }
  liveChatDrafts.set(chatId, draft);
}

/** The composer's CURRENT draft for a chat — the keystroke-fresh mirror,
 *  ahead of the unmount-flushed store copy. Used by handlers that replace a
 *  chat with another (the cross-agent model switch) so the typed prompt
 *  follows the user instead of dying with the old chat id. */
export function getLiveChatDraft(chatId: string): ComposerDraft | null {
  return liveChatDrafts.get(chatId) ?? null;
}

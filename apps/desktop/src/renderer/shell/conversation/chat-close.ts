// ──────────────────────────────────────────────────────────
// conversation/chat-close — discard-vs-archive decision for tab close
// ──────────────────────────────────────────────────────────
//
// Closing a chat tab normally ARCHIVES it (a soft-delete: the tab leaves
// the strip but stays restorable from the History menu). That's the right
// behavior for any chat the user actually used — even a one-liner they might
// want back.
//
// But a brand-new "Untitled" tab that the user opened and closed WITHOUT
// ever typing a character or sending a turn is pure clutter: archiving it
// parks an empty "Untitled" row in History that can never be meaningfully
// restored (it's identical to pressing "+" again). For that case only, the
// close path DISCARDS the tab instead (DELETE_CHAT) so History stays clean.
//
// "Never used" is deliberately conservative — the moment the chat has ANY
// content it archives like everything else:
//   - a started conversation (≥1 message in the sessions store), OR
//   - a promoted title (renamed by the user, or the AI auto-title that only
//     ever fires AFTER a first send) — the title is also the durable tell
//     that survives an engine respawn while disk history hydrates, so a
//     resumed-from-disk thread (messages not yet loaded) is never mistaken
//     for empty. This mirrors the `pristine` check in agent-chat.tsx, OR
//   - an unsent composer draft — even a single typed character. The live
//     keystroke-fresh mirror covers the active tab; the unmount-flushed
//     store copy covers background tabs.
//
// Decision logic is a pure function (no store reads) so it unit-tests
// without a DOM/store harness; the caller (conversation/pane-layout handleCloseTab)
// gathers the four inputs from the live stores and dispatches accordingly.
// ──────────────────────────────────────────────────────────

import type { ChatThread, ComposerDraft } from "../../state/store";

/** The seeded title every fresh chat is born with (spawn-default-chat's
 *  bornChatThread) and the CAS expectation the AI auto-title races against.
 *  A tab still showing this exact string has never been renamed or titled. */
const UNTITLED_TITLE = "Untitled";

/** True when a composer draft holds anything worth keeping across a close —
 *  non-whitespace text (a lone space trims to empty) or at least one
 *  attachment. A null/undefined draft (the empty-composer sentinel the live
 *  mirror stores) is not content. */
export function draftHasContent(
  draft: ComposerDraft | null | undefined,
): boolean {
  if (!draft) return false;
  return draft.text.trim() !== "" || draft.attachments.length > 0;
}

export interface ChatCloseInputs {
  /** chat kind — terminals are never discarded (they carry a real PTY and a
   *  directory-derived title, never the pristine "Untitled" state). */
  kind: ChatThread["kind"];
  /** current tab title. */
  title: string;
  /** in-memory transcript length for this chat (sessions store). */
  messageCount: number;
  /** keystroke-fresh composer draft for the ACTIVE tab (null when empty or
   *  when the tab isn't the mounted one). */
  liveDraft: ComposerDraft | null;
  /** unmount-flushed composer draft from the store (covers background tabs
   *  whose composer already unmounted). */
  storedDraft: ComposerDraft | undefined;
}

/** Collapse the resident array + eviction-safe durable hint into the existing
 *  close contract's count. A cold used chat must archive, never be discarded
 *  merely because its message objects were released. */
export function messageCountForChatClose(
  slot:
    | { messages: readonly unknown[]; hasTranscript?: boolean }
    | null
    | undefined,
): number {
  return slot && (slot.messages.length > 0 || slot.hasTranscript === true)
    ? 1
    : 0;
}

/** Should closing this tab DISCARD it (delete → never reaches History) rather
 *  than ARCHIVE it (the default → restorable from History)?
 *
 *  Discard only when the tab was never used: a chat-kind, still-"Untitled",
 *  zero-message tab with no unsent draft (live or stored). Anything else —
 *  a message, a rename/auto-title, a typed draft, or a terminal — archives. */
export function isChatDiscardableOnClose(inputs: ChatCloseInputs): boolean {
  if (inputs.kind === "terminal") return false;
  // A started conversation or a promoted title both mean "used".
  if (inputs.messageCount > 0) return false;
  if (inputs.title !== UNTITLED_TITLE) return false;
  // Any unsent draft — live (active tab) or store-flushed (background tab).
  if (draftHasContent(inputs.liveDraft)) return false;
  if (draftHasContent(inputs.storedDraft)) return false;
  return true;
}

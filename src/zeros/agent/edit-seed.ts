// ──────────────────────────────────────────────────────────
// edit-seed — which document an edit-in-place composer opens with
// ──────────────────────────────────────────────────────────
//
// Three rungs, in order, and the middle one is the whole reason this is a
// named function rather than a ternary inside the component:
//
//   1. the stash's editor JSON — an in-progress edit, restored exactly;
//   2. the stash's plain-text mirror — the same edit, minus the pills;
//   3. the original message, reconstructed inline.
//
// Rung 2 exists because `persist-composer-drafts.ts` nulls `json` when a write
// hits the localStorage quota. It has to: the attachment NODES live in that
// document and their bytes are deliberately never persisted, so restoring the
// JSON alone would put chips in the composer with nothing behind them. `text`
// is the mirror that write keeps precisely so something survives.
//
// Without rung 2 a degraded stash fell through to rung 3, which is not lossy
// but DESTRUCTIVE — it discards the user's in-progress rewrite and re-seeds
// the box with the words they were editing away from. agent-chat.tsx has
// always had the equivalent fallback for chat drafts; the edit path did not,
// so one degraded write behaved differently in the two places that read it.
//
// Extracted from turn-container.tsx (React, the composer editor, the workspace
// store) so the choice is pinned by a test rather than by reading a component
// — the same reason turn-grouping.ts lives on its own.
// ──────────────────────────────────────────────────────────

/** Where the edit composer's opening document comes from. */
export type EditSeedSource = "stash-json" | "stash-text" | "original";

/** Just enough of an EditDraftStash to make the choice. */
export interface EditSeedStash {
  text: string;
  json?: object | null;
}

/** Pick the rung. `null`/absent stash, or one that carries neither a document
 *  nor any text, means there is no in-progress edit to restore.
 *
 *  An empty `text` deliberately does NOT count as a restorable edit: it is
 *  indistinguishable from "never typed anything", and the same call is already
 *  made for chat drafts (agent-chat.tsx seeds `null` for empty text). A stash
 *  that pristine is cleared rather than persisted anyway. */
export function editSeedSource(
  stash: EditSeedStash | null | undefined,
): EditSeedSource {
  if (stash?.json) return "stash-json";
  if (stash?.text) return "stash-text";
  return "original";
}

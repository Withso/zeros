// ──────────────────────────────────────────────────────────
// shortcut-priority — "an overlay owns the keyboard right now"
// ──────────────────────────────────────────────────────────
//
// Several surfaces care about the SAME keys (digits typed into the
// agent-model menu's search vs the question card's window-level option
// toggles; ⌘digits: the menu's row picks vs app shortcuts). Capture
// listeners on one target run in REGISTRATION order, so a long-mounted
// card would beat a just-opened menu no matter what the menu does with
// the event.
//
// While the composer's model dropdown is open, its shortcuts MUST win. This
// module is the tie-breaker: an overlay that owns
// the keyboard claims priority while open; lower-priority listeners check
// `hasShortcutPriorityClaim()` at the top of their handler and stand down.
// A counter (not a boolean) so overlapping claims compose; release is
// idempotent so effect-cleanup double-runs (StrictMode) can't underflow.
// ──────────────────────────────────────────────────────────

let claims = 0;

/** Claim keyboard-shortcut priority (an overlay opened). Returns the
 *  release function; call it when the overlay closes. Idempotent. */
export function claimShortcutPriority(): () => void {
  claims += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    claims -= 1;
  };
}

/** True while some overlay owns the keyboard — lower-priority global key
 *  handlers (question-card digits, etc.) should ignore the event. */
export function hasShortcutPriorityClaim(): boolean {
  return claims > 0;
}

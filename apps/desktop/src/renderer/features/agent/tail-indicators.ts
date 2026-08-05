// ──────────────────────────────────────────────────────────
// tail-indicators — what the live turn's tail advertises
// ──────────────────────────────────────────────────────────
//
// Two indicators sit at the tail of an active turn, and they answer DIFFERENT
// questions. Keeping the answers in one place is deliberate: the two were
// conflated once already, which hid a running workflow's Stop button behind an
// unrelated permission gate.
//
//   • shimmer  — "is the agent working?"      (agent shimmer + elapsed timer)
//   • workflow — "what is running, and how do I stop it?"
//
// The shimmer hides while the agent is PARKED ON THE USER — a blocking
// question, a permission gate, or Claude's plan review — because it isn't
// working then. The elapsed clock keeps running underneath, so when the user
// answers/approves the indicator returns with the true total.
//
// The workflow row must NOT inherit that suppression. A foreground workflow
// keeps running — or at minimum stays stoppable — while ONE of its helpers
// waits on an approval, and helper gates are exactly the scenario this surface
// exists alongside. Suppressing it removed the progress AND its Stop action at
// the very moment the user was deciding whether to let the run continue.
// ──────────────────────────────────────────────────────────

export interface TailIndicatorInput {
  /** This is the active turn AND the session is still streaming. */
  live: boolean;
  /** Only the newest visual segment of a steered turn owns the tail. */
  showActivity: boolean;
  /** A blocking question, permission gate, or plan review is pending. */
  awaitingUserInput: boolean;
}

export interface TailIndicators {
  shimmer: boolean;
  workflow: boolean;
}

/** Resolve both tail indicators from the turn's live state.
 *
 *  Whether a workflow actually EXISTS is the caller's business — this only
 *  decides whether the tail is the right place to show one. */
export function tailIndicators({
  live,
  showActivity,
  awaitingUserInput,
}: TailIndicatorInput): TailIndicators {
  const liveTail = live && showActivity;
  return {
    shimmer: liveTail && !awaitingUserInput,
    workflow: liveTail,
  };
}

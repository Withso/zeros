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

/** Whether the transcript's tail turn is still IN FLIGHT — the single input
 *  behind both the tail shimmer/timer and the suppression of the turn footer.
 *  One function because those two must never disagree: a shimmer with no footer
 *  is the "agent is working" reading, and a footer with no shimmer is the
 *  settled one. Rendering both from separate expressions is what let a reopened
 *  chat show the working state and hide its own STOPPED BY USER pill.
 *
 *  `pendingLocalTurn` is a real fact — the renderer holds an unsettled prompt
 *  for THIS turn — and it is what makes the answer survive a reopen. It used to
 *  be inferred from `session.status === "warming"`, which every chat passes
 *  through on a tab switch, a workspace switch, and an app reload; combined with
 *  "no events yet" (indistinguishable from a turn STOPPED before it produced
 *  any), that inference repainted a finished turn as live, with an elapsed timer
 *  counting from the original prompt, until the session finished resuming.
 *
 *  The empty-turn condition stays: it is what keeps a mid-turn rebuild from
 *  pulling an already-streamed answer back into the working feed. */
export function tailTurnInFlight(input: {
  /** The session has a live turn (streaming, or an adopted engine turn). */
  sessionStreaming: boolean;
  /** This exact turn is the one this renderer's in-flight send is running. */
  pendingLocalTurn: boolean;
  /** The turn has already rendered at least one agent event. */
  hasEvents: boolean;
}): boolean {
  if (input.sessionStreaming) return true;
  // A send pending session (re)creation: the prompt is committed to the
  // transcript but the agent has not started, so the turn is not settled and
  // must not render a "0s" footer.
  return input.pendingLocalTurn && !input.hasEvents;
}

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

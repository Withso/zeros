import type { SessionStatus } from "./use-agent-session";
import { isRecoverable, type AgentFailure } from "../../platform/bridge/failure";

/** The engine survives a local renderer reload. Its prompt activity is the
 * authoritative lifecycle signal; a successfully loaded active session must
 * not be flattened to `ready` merely because the new renderer has no send
 * promise of its own. */
export function loadedSessionStatus(promptActive: boolean): SessionStatus {
  return promptActive ? "streaming" : "ready";
}

/** Map a failure classification to the UI session status. The single
 * definition, shared by the RPC paths in <AgentSessionsProvider> and by the
 * store's turn-state settle — those two must not be able to disagree about
 * what a recorded failure means. */
export function statusForFailure(failure: AgentFailure): SessionStatus {
  if (failure.kind === "auth-required") return "auth-required";
  if (isRecoverable(failure)) return "reconnecting";
  return "failed";
}

/** How a terminal engine `turn_state` settles the slot.
 *
 * The engine emits terminal turn_state for EVERY turn, not just re-adopted
 * ones — and it rides the rAF-buffered update path, so for a locally-issued
 * prompt it lands a frame AFTER sendPrompt already recorded the classified
 * failure from AGENT_PROMPT_FAILED. Clearing error/failure here therefore
 * erased the real reason a turn died one frame after the user saw it: the chat
 * read as healthy with no explanation, and an auth-required turn lost its
 * Sign-in button (the footer derives it from `session.failure`).
 *
 * So the settle is non-destructive: a failure this renderer already classified
 * wins. A slot with nothing recorded — the genuinely re-adopted turn, which has
 * no local RPC result to recover a classification from — still flattens to
 * `ready` and lets the durable failed turn row tell the history. */
export function settledTurnStatus(slot: {
  error: string | null;
  failure: AgentFailure | null;
}): SessionStatus {
  if (slot.failure) return statusForFailure(slot.failure);
  return slot.error ? "failed" : "ready";
}

/** Decide whether a send belongs behind an already-owned/incomplete turn.
 * Local refs disappear on reload, so session status is an equal input rather
 * than a secondary check. A queue flush bypasses the gate by construction. */
export function shouldQueuePrompt(input: {
  status: SessionStatus;
  hasLocalSend: boolean;
  hasQueuedSends: boolean;
  queueHeld: boolean;
  flushing: boolean;
}): boolean {
  if (input.flushing) return false;
  return (
    input.hasLocalSend ||
    input.hasQueuedSends ||
    input.queueHeld ||
    input.status === "streaming" ||
    input.status === "warming"
  );
}

/** The counterpart to shouldQueuePrompt: what becomes of a parked queue once
 * whatever it was parked behind has finished.
 *
 * Every park site needs a release site. `warming` became a park reason above, and
 * the only automatic drain (drainNextQueued) requires `ready` — so a warm that
 * ends failed/auth-required/reconnecting would strand the queue AND freeze the
 * composer, because each later send parks behind a queue that can never drain.
 *
 * `drop` rather than `drain` for an unhealthy chat is the long-standing policy:
 * draining into a dead/rebuilding session makes every queued send force a
 * rebuild, so the queue turns into a spawn storm. The drop is announced. */
export function queueReleaseAction(input: {
  status: SessionStatus;
  queueHeld: boolean;
}): "hold" | "drain" | "drop" {
  // Parked mid-edit: releaseQueue() owns it — the edit target must not be sent
  // out from under the user, and a held queue survives an unhealthy settle.
  if (input.queueHeld) return "hold";
  return input.status === "ready" ? "drain" : "drop";
}

/** Remember that live pushes for an exact session arrived before its renderer
 * slot was bound. Refreshes insertion order and stays bounded across chats. */
export function markPrebindDirty(
  dirty: Map<string, string>,
  chatId: string,
  sessionId: string,
  limit = 64,
): void {
  dirty.delete(chatId);
  dirty.set(chatId, sessionId);
  while (dirty.size > limit) {
    const oldest = dirty.keys().next().value as string | undefined;
    if (!oldest) break;
    dirty.delete(oldest);
  }
}

/** Consume only an exact chat/session dirty mark. A terminal event from a
 * superseded session must not re-window or otherwise disturb its replacement. */
export function takePrebindDirty(
  dirty: Map<string, string>,
  chatId: string,
  sessionId: string,
): boolean {
  if (dirty.get(chatId) !== sessionId) return false;
  dirty.delete(chatId);
  return true;
}

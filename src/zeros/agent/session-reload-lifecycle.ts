import type { SessionStatus } from "./use-agent-session";

/** The engine survives a local renderer reload. Its prompt activity is the
 * authoritative lifecycle signal; a successfully loaded active session must
 * not be flattened to `ready` merely because the new renderer has no send
 * promise of its own. */
export function loadedSessionStatus(promptActive: boolean): SessionStatus {
  return promptActive ? "streaming" : "ready";
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

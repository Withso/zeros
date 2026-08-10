import type { SessionStatus } from "./use-agent-session";

export interface SessionCloseActivity {
  running: boolean;
  queuedCount: number;
}

interface CloseRouteSlot {
  executionId?: string | null;
  sessionId?: string | null;
}

/** Optional route fields for AGENT_CLOSE_SESSION. Missing slots are normal for
 * background tabs that have never mounted in this renderer run; chatId alone
 * remains the authoritative conversation-scoped close key. */
export function closeRouteForSession(slot: CloseRouteSlot | null | undefined): {
  executionId?: string;
  sessionId?: string;
} {
  const executionId = slot?.executionId ?? slot?.sessionId;
  if (!executionId) return {};
  return {
    executionId,
    // Protocol-v8 understands only sessionId. Both fields are spellings of
    // the same Zeros route, so normalizing here also keeps malformed/stale
    // renderer state from producing a bridge payload the trust boundary rejects.
    sessionId: executionId,
  };
}

interface CloseActivitySlot {
  status: SessionStatus;
  messages: ReadonlyArray<{ kind?: string; queued?: boolean }>;
  backgroundTasks: readonly unknown[];
  workflows: readonly unknown[];
  waitingForBackgroundTasks: boolean;
}

/** Fresh close-boundary activity snapshot. `localSendInFlight` covers the
 * narrow first-send window while session startup is still warming; provider
 * snapshots cover adopted turns and background work after renderer reload. */
export function closeActivityForSession(
  slot: CloseActivitySlot | null | undefined,
  local: { localSendInFlight: boolean; queuedCount: number },
): SessionCloseActivity {
  const queuedBubbles =
    slot?.messages.filter(
      (message) => message.kind === "text" && message.queued === true,
    ).length ?? 0;
  const queuedCount = Math.max(local.queuedCount, queuedBubbles);
  return {
    running:
      local.localSendInFlight ||
      slot?.status === "streaming" ||
      slot?.waitingForBackgroundTasks === true ||
      (slot?.backgroundTasks.length ?? 0) > 0 ||
      (slot?.workflows.length ?? 0) > 0,
    queuedCount,
  };
}

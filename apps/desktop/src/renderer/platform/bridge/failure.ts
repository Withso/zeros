
import type { BridgeAgentFailure } from "./messages";

export type AgentFailure = BridgeAgentFailure;

// Cursor can return a bare "Authentication required" message.
const AUTH_RX =
  /\b(login|signed?\s*in|credentials?|unauthori[sz]ed|api[-\s]?key|oauth|authentic\w*|please\s+sign|access\s+token|permission\s+denied)\b/i;
// The bridge rejects requests with the literal wording "Request timeout".
const TIMEOUT_RX = /\b(?:timeouts?|timed?\s*out)\b/i;
// Match reconnect, abort, and engine-swap rejection wording so callers can recover without a hard error.
const TRANSPORT_RX =
  /\bconnection\s*(?:closed|reset)|transport\s+closed|broken\s*pipe|engine\s+swapping|request\s+aborted|\breconnecting\b/i;
const RATE_LIMIT_RX =
  /\b(?:429|rate[\s_-]*limit(?:ed)?|too many requests|resource exhausted)\b/i;
// ws-client rejects an older queued create/load when a newer exact-chat copy
// replaces it. That is a local ownership race, not a dead provider thread.
const LIFECYCLE_SUPERSEDED_RX =
  /\b(?:superseded by newer queued copy|conversation was closed or superseded while its agent session was starting)\b/i;
/** Keep source and flags in sync with STALE_THREAD_RX and SESSION_EXPIRED_KEYWORDS; the regex-parity test enforces it. */
export const SESSION_EXPIRED_RX =
  /\b(?:no\s+rollout\s+(?:found|exists?|available)|no\s+longer\s+has\s+(?:a\s+)?rollout|lost\s+the\s+rollout|rollout\s+not\s+found|thread\s+(?:not\s+found|does\s+not\s+exist)|unknown\s+thread|missing\s+thread|no\s+such\s+thread|thread\/resume\s+failed|resume\s+failed|session\s+(?:not\s+found|does\s+not\s+exist|expired)|chat\s+(?:not\s+found|does\s+not\s+exist)|conversation\s+(?:not\s+found|expired)|no\s+conversation\s+found|agent\s+(?:\S+\s+){0,3}(?:not\s+found|does\s+not\s+exist|no\s+longer\s+exists)|no\s+such\s+agent)\b/i;

export function classifyRpcError(
  arg:
    | unknown
    | { agentId?: string; stage?: AgentFailure["stage"]; error: unknown },
  stageHint?: AgentFailure["stage"],
): AgentFailure {
  let err: unknown;
  let agentId: string | undefined;
  let stage: AgentFailure["stage"] | undefined = stageHint;
  if (
    arg &&
    typeof arg === "object" &&
    "error" in (arg as Record<string, unknown>)
  ) {
    const o = arg as {
      agentId?: string;
      stage?: AgentFailure["stage"];
      error: unknown;
    };
    err = o.error;
    agentId = o.agentId;
    if (o.stage) stage = o.stage;
  } else {
    err = arg;
  }
  const message = err instanceof Error ? err.message : String(err);
  // Use the engine-swap marker first; TRANSPORT_RX matches its message as a fallback.
  const errCode =
    err instanceof Error ? (err as Error & { code?: string }).code : undefined;
  const base = { stage, agentId } as Pick<AgentFailure, "stage" | "agentId">;
  if (errCode === "ENGINE_SWAPPING") {
    return { kind: "transport-closed", message, ...base };
  }
  if (errCode === "WORKSPACE_READ_SUPERSEDED" || LIFECYCLE_SUPERSEDED_RX.test(message)) {
    return { kind: "lifecycle-superseded", message, ...base };
  }
  if (SESSION_EXPIRED_RX.test(message)) {
    return { kind: "session-expired", message, ...base };
  }
  // A provider throttle can mention a timed-out retry or reset connection.
  // Keep it terminal before the recoverable timeout/transport fallbacks so the
  // renderer never amplifies a 429 with an automatic resend.
  if (RATE_LIMIT_RX.test(message)) {
    return {
      kind: "rate-limited",
      message,
      advice: "The provider is rate-limiting requests. Try again shortly.",
      ...base,
    };
  }
  if (TIMEOUT_RX.test(message)) {
    return { kind: "timeout", message, ...base };
  }
  if (TRANSPORT_RX.test(message)) {
    return { kind: "transport-closed", message, ...base };
  }
  if (AUTH_RX.test(message)) {
    return { kind: "auth-required", message, ...base };
  }
  return { kind: "protocol-error", message, ...base };
}

/** Catch unclassified disconnects before the renderer surfaces a hard error. */
export function isTransportShaped(message: string | undefined | null): boolean {
  if (!message) return false;
  return /\b(?:engine\s+swapping|request\s+aborted|transport\s+closed|connection\s+(?:closed|reset)|broken\s*pipe|reconnecting)\b/i.test(
    message,
  );
}

/** Cloud failures use their own recovery contract; an expired Local provider session can start fresh without deleting the transcript. */
export function isRecoverable(failure: AgentFailure): boolean {
  if (failure.cloud) return false;
  return (
    failure.kind === "timeout" ||
    failure.kind === "transport-closed" ||
    failure.kind === "session-expired"
  );
}

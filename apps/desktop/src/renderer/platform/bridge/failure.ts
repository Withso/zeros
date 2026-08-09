// ──────────────────────────────────────────────────────────
// Failure classification — UI-side
// ──────────────────────────────────────────────────────────
//
// The engine now owns all failure classification (in the per-agent
// adapters + adapters/shared/session-expiry.ts). This module exists only for
// the handful of UI sites that still need to classify an error string
// they caught locally (e.g. a network round-trip that never reached
// the engine). It replaces the retired engine-side failure classifier.
//
// Keep in sync with BridgeAgentFailure in messages.ts — same kinds,
// same stages.
//
// ──────────────────────────────────────────────────────────

import type { BridgeAgentFailure } from "./messages";

/** Public alias of the bridge-level failure shape. Lets browser-side
 *  callers spell it `AgentFailure` while the wire-format type stays
 *  `BridgeAgentFailure`. Identical shape, no runtime cost. */
export type AgentFailure = BridgeAgentFailure;

// `authentic\w*` matches both "authenticate" AND "Authentication required"
// (Cursor's bare signed-out message). Mirrors the engine adapters'
// auth-keyword matching.
const AUTH_RX =
  /\b(login|signed?\s*in|credentials?|unauthori[sz]ed|api[-\s]?key|oauth|authentic\w*|please\s+sign|access\s+token|permission\s+denied)\b/i;
// Matches "timed out", "timed-out", and (most common in our code paths)
// the bare word "timeout" used in ws-client's "Request timeout: …"
// rejection messages. The prior `\btimed?\s*out\b` required whitespace
// between "time" and "out", so "Request timeout: AGENT_PROMPT (queue full)"
// dropped through to "protocol-error" and surfaced as a hard toast.
const TIMEOUT_RX = /\b(?:timeouts?|timed?\s*out)\b/i;
// "engine swapping" + "request aborted" cover the renderer-side rejections
// fired by ws-client.forceReconnect() during a watchdog respawn or in-place
// project swap. "reconnecting" covers the ws-client's grace-window timeouts
// ("Request timeout: <TYPE> (reconnecting)"). Treat all of these as
// transport-closed so sendPrompt's recoverable branch rebuilds the session
// instead of surfacing a hard error toast.
const TRANSPORT_RX =
  /\bconnection\s*(?:closed|reset)|transport\s+closed|broken\s*pipe|engine\s+swapping|request\s+aborted|\breconnecting\b/i;
const RATE_LIMIT_RX =
  /\b(?:429|rate[\s_-]*limit(?:ed)?|too many requests|resource exhausted)\b/i;
/** Mirrors SESSION_EXPIRED_KEYWORDS in
 *  apps/desktop/src/engine/agents/adapters/shared/session-expiry.ts. The engine usually classifies
 *  these on its side, but RPC errors that bubble up to the renderer
 *  still need the same classification (e.g. when the bridge proxies a
 *  bare error string from the agent's stderr).
 *
 *  Covers the Codex adapter's user-facing wording ("no longer has a rollout",
 *  "lost the rollout") plus generic
 *  stale-thread snippets. Keep in sync
 *  with STALE_THREAD_RX in codex/app-server-adapter.ts and
 *  SESSION_EXPIRED_KEYWORDS in adapters/shared/session-expiry.ts. */
// Exported for the regex-parity test in app-server-adapter-failures.test.ts.
// The `agent … not found` / `no such agent` family covers @cursor/sdk's
// Agent.resume "Agent <uuid> not found" — the renderer-side fallback must
// classify it as session-expired too. Keep in parity with
// SESSION_EXPIRED_KEYWORDS (base.ts) + STALE_THREAD_RX (codex).
export const SESSION_EXPIRED_RX =
  /\b(?:no\s+rollout\s+(?:found|exists?|available)|no\s+longer\s+has\s+(?:a\s+)?rollout|lost\s+the\s+rollout|rollout\s+not\s+found|thread\s+(?:not\s+found|does\s+not\s+exist)|unknown\s+thread|missing\s+thread|no\s+such\s+thread|thread\/resume\s+failed|resume\s+failed|session\s+(?:not\s+found|does\s+not\s+exist|expired)|chat\s+(?:not\s+found|does\s+not\s+exist)|conversation\s+(?:not\s+found|expired)|no\s+conversation\s+found|agent\s+(?:\S+\s+){0,3}(?:not\s+found|does\s+not\s+exist|no\s+longer\s+exists)|no\s+such\s+agent)\b/i;

/** Classify an error that was raised in the browser (e.g. WebSocket
 *  request rejection, RPC-level timeout) into an AgentFailure.
 *
 *  Accepts both call shapes used in the codebase:
 *    classifyRpcError(err)
 *    classifyRpcError({ agentId, stage, error })
 *  The object form was the original API and every caller uses it; the
 *  positional form was an earlier refactor pass that left the callers
 *  silently broken — String({...}) on the object yielded "[object Object]"
 *  as the user-visible failure message. */
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
  // Engine-swap rejections from ws-client.forceReconnect carry a typed
  // `code: "ENGINE_SWAPPING"` marker. Checking the marker first avoids
  // depending on the message string surviving any future wording
  // change — the TRANSPORT_RX path below catches it on the fallback.
  const errCode =
    err instanceof Error ? (err as Error & { code?: string }).code : undefined;
  const base = { stage, agentId } as Pick<AgentFailure, "stage" | "agentId">;
  if (errCode === "ENGINE_SWAPPING") {
    return { kind: "transport-closed", message, ...base };
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

/** Defensive backstop. Returns true if a free-form error string looks
 *  like a transport-layer disconnect / engine swap — the kind of
 *  "noise" we never want surfaced as a hard "Agent error" toast even
 *  if it slipped past `classifyRpcError` somewhere upstream. Used by
 *  `agent-chat.tsx`'s toast-firing effect as a last-line filter and
 *  could be reused on the engine side if future classifiers need to
 *  share the same definition of "transport-shaped" without depending
 *  on `classifyRpcError`'s full machinery. */
export function isTransportShaped(message: string | undefined | null): boolean {
  if (!message) return false;
  return /\b(?:engine\s+swapping|request\s+aborted|transport\s+closed|connection\s+(?:closed|reset)|broken\s*pipe|reconnecting)\b/i.test(
    message,
  );
}

/** Recoverable kinds are transient: the UI can silently retry once
 *  without user intervention. Terminal kinds surface immediately.
 *
 *  `session-expired` is recoverable. When the provider's persisted session is
 *  gone (Codex "no rollout found", Claude "session not found"), the
 *  fix is to clear the stale session id and start a fresh one — the
 *  retry path in sessions-provider already does this via `ensureSession
 *  + force:true`.
 *  The rebuild discards the stale id; the next CLI spawn omits
 *  `--resume`, starts cold. We don't replay history into the fresh
 *  session yet. The user keeps visible chat history in SQLite and sees a small
 *  "Started fresh" chip; the agent simply has no in-memory context
 *  from the prior conversation. Acceptable trade-off given how rare
 *  this case is in practice (mostly resuming after weeks). */
export function isRecoverable(failure: AgentFailure): boolean {
  return (
    failure.kind === "timeout" ||
    failure.kind === "transport-closed" ||
    failure.kind === "session-expired"
  );
}

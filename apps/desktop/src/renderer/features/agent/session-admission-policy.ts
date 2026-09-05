import type { AgentFailure } from "../../platform/bridge/failure";

/** Provider startup and a cold optional kernel boundary can approach 90s.
 * Keep the user-visible request alive for bounded cleanup rather than timing
 * out early and starting an overlapping session admission. */
export const AGENT_NEW_SESSION_TIMEOUT_MS = 2 * 60_000;

/** A timed-out create may still be unwinding inside the engine. Retrying it
 * automatically would overlap another provider/boundary admission. Genuine
 * transport replacement and an expired provider binding are safe to retry. */
export function shouldRetrySessionAdmission(
  kind: AgentFailure["kind"],
): boolean {
  return kind === "transport-closed" || kind === "session-expired";
}

/** A renderer RPC timeout does not cancel work already accepted by the
 * engine. Invalidate that exact conversation bind so a boundary/provider that
 * finishes late is torn down instead of becoming an invisible orphan. Other
 * failures either have an engine response (and completed cleanup) or are safe
 * application-level retries. */
export function shouldCancelStalledSessionAdmission(
  kind: AgentFailure["kind"],
): boolean {
  return kind === "timeout";
}

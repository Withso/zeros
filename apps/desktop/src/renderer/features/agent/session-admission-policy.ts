import type { AgentFailure } from "../../platform/bridge/failure";

/** A real, first-use OrbStack 2.2.1 admission is qualified at roughly 70s.
 * Keep the user-visible request alive for that bounded engine operation rather
 * than timing out at 10s and starting overlapping private machines. */
export const AGENT_NEW_SESSION_TIMEOUT_MS = 2 * 60_000;

/** A timed-out create may still be unwinding inside the engine. Retrying it
 * automatically would overlap another expensive boundary admission. Genuine
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

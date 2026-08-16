import type { AgentFailure } from "../../platform/bridge/failure";

/** The exact Design-boundary preflight runs no provider or container worker,
 * but a cold native helper/Seatbelt probe can exceed the old generic 10s RPC
 * cap on a busy Mac. */
export const AGENT_PREFLIGHT_TIMEOUT_MS = 30_000;

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

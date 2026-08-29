import type { SessionStatus } from "./use-agent-session";

/** Let an interactive admission or turn own provider, disk, and network
 * startup. Registry auth/version probes are useful freshness work, but their
 * provider subprocesses and ZSR canaries must not race the work the user just
 * asked for. */
export function canVerifyAgentRegistryInBackground(
  status: SessionStatus,
): boolean {
  return (
    status === "ready" ||
    status === "auth-required" ||
    status === "failed"
  );
}

/** Gives an immediately queued first prompt time to move ready → streaming,
 * at which point the effect is cancelled and verification waits for the turn. */
export const AGENT_REGISTRY_VERIFICATION_DELAY_MS = 500;

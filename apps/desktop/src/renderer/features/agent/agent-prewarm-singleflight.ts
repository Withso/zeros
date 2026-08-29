// Renderer boot and window-focus warmups can overlap immediately after an
// engine reconnect. The state lives on globalThis because Vite re-evaluates a
// directly edited module during HMR; an ordinary module variable does not, in
// fact, survive that replacement and used to re-fire every provider warmup.
interface AgentPrewarmState {
  claimedForEngineSession: boolean;
  inFlightByAgent: Map<string, Promise<void>>;
}

type AgentPrewarmGlobal = typeof globalThis & {
  __zerosAgentPrewarmStateV1__?: AgentPrewarmState;
};

const prewarmGlobal = globalThis as AgentPrewarmGlobal;
const state =
  prewarmGlobal.__zerosAgentPrewarmStateV1__ ??
  (prewarmGlobal.__zerosAgentPrewarmStateV1__ = {
    claimedForEngineSession: false,
    inFlightByAgent: new Map<string, Promise<void>>(),
  });

/** Claim the once-per-real-engine-session boot warmup. Module replacement is
 * not a new engine session and therefore cannot claim it again. */
export function claimAgentPrewarmForEngineSession(): boolean {
  if (state.claimedForEngineSession) return false;
  state.claimedForEngineSession = true;
  return true;
}

export function prewarmAgentOnce(
  agentId: string,
  initialize: (agentId: string) => Promise<unknown>,
): Promise<void> {
  const existing = state.inFlightByAgent.get(agentId);
  if (existing) return existing;

  let started: Promise<void>;
  try {
    started = Promise.resolve(initialize(agentId)).then(() => undefined);
  } catch (error) {
    started = Promise.reject(error);
  }

  const tracked = started.finally(() => {
    // A real engine reconnect can reset the coordinator while the old bridge
    // request is still settling. Never let that stale completion clear the new
    // engine's replacement request.
    if (state.inFlightByAgent.get(agentId) === tracked) {
      state.inFlightByAgent.delete(agentId);
    }
  });
  state.inFlightByAgent.set(agentId, tracked);
  return tracked;
}

/** Rearm only when the bridge observed the engine become unavailable. */
export function resetAgentPrewarmForEngineSession(): void {
  state.claimedForEngineSession = false;
  state.inFlightByAgent.clear();
}

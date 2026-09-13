/** Compatibility API for chat/default callers. Connection state now controls
 * availability; the persisted `zeros.agent.enabledAgents` preference is retired
 * and deliberately left untouched so older installations can still read it. */
export function isAgentEnabled(_id: string, _isBeta?: boolean): boolean {
  return true;
}

const enabledAgents = { isEnabled: isAgentEnabled };
export function useEnabledAgents() {
  return enabledAgents;
}

import {
  initialAgentControlAvailability,
  sameAgentControlAvailability,
  type AgentControlAvailability,
} from "@zeros/protocol/agent-control-rollout";

// Main's copy of the agent control rollout: what the trusted renderer last
// pushed, or only the features on for everyone before its first push. The
// sidecar seeds every engine it spawns from it.
let current: AgentControlAvailability = initialAgentControlAvailability();

export function agentControlAvailability(): AgentControlAvailability {
  return current;
}

/** True when `next` changed what main had. */
export function setAgentControlAvailability(
  next: AgentControlAvailability,
): boolean {
  if (sameAgentControlAvailability(current, next)) return false;
  current = next;
  return true;
}

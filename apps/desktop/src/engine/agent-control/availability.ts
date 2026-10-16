import {
  initialAgentControlAvailability,
  type AgentControlAvailability,
  type AgentControlFeature,
} from "@zeros/protocol/agent-control-rollout";

// The desktop app pushes its rollout when it spawns this engine and on every
// change. Before that, and in an engine without the desktop app, only the
// features on for everyone are open.
let current: AgentControlAvailability = initialAgentControlAvailability();

export function agentControlAvailability(): AgentControlAvailability {
  return current;
}

export function agentControlFeatureAvailable(
  feature: AgentControlFeature,
): boolean {
  return current[feature];
}

export function setAgentControlAvailability(
  next: AgentControlAvailability,
): void {
  current = next;
}

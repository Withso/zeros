import { useMemo } from "react";
import {
  AGENT_CONTROL_FEATURES,
  AGENT_CONTROL_ROLLOUT,
  agentControlFeatureOpen,
  type AgentControlAvailability,
  type AgentControlFeature,
  type AgentControlRolloutStage,
} from "@zeros/protocol/agent-control-rollout";

import { isLocalDevelopment } from "../../platform/runtime";
import {
  isExperimentalEnabled,
  useExperimentalFeature,
} from "./experimental-features";
import {
  isInternalFeatureActive,
  isInternalFeatureEnabled,
  useInternalFeature,
  useInternalFeatureActive,
} from "./internal-features";

export const AGENT_CONTROL_FEATURE_ROWS: Readonly<
  Record<AgentControlFeature, { label: string; hint: string }>
> = {
  zerosBrowser: {
    label: "Zeros browser",
    hint: "Agents can use the in-app browser.",
  },
  computerUse: {
    label: "Computer use",
    hint: "Agents can see and control apps on this Mac.",
  },
  simulators: {
    label: "Simulators",
    hint: "Simulator tabs, simulator tools for agents and key frames from dropped videos.",
  },
  localOrchestration: {
    label: "Zeros Local CLI",
    hint: "Agents in Local chats can start, message and follow other chats with zeros local.",
  },
};

export function agentControlFeaturesAt(
  stage: AgentControlRolloutStage,
): AgentControlFeature[] {
  return AGENT_CONTROL_FEATURES.filter(
    (feature) => AGENT_CONTROL_ROLLOUT[feature] === stage,
  );
}

// Unpackaged native development has no staff account; shipped builds cannot use that path.
function internalAccess(staffFlagActive: boolean, flagOn: boolean): boolean {
  return staffFlagActive || (isLocalDevelopment() && flagOn);
}

export function isAgentControlFeatureActive(
  feature: AgentControlFeature,
): boolean {
  return agentControlFeatureOpen(AGENT_CONTROL_ROLLOUT[feature], {
    internal: internalAccess(
      isInternalFeatureActive(feature),
      isInternalFeatureEnabled(feature),
    ),
    experimental: isExperimentalEnabled(feature),
  });
}

export function useAgentControlFeatureActive(
  feature: AgentControlFeature,
): boolean {
  const staffFlagActive = useInternalFeatureActive(feature);
  const [flagOn] = useInternalFeature(feature);
  const [experimental] = useExperimentalFeature(feature);
  return agentControlFeatureOpen(AGENT_CONTROL_ROLLOUT[feature], {
    internal: internalAccess(staffFlagActive, flagOn),
    experimental,
  });
}

// This is rollout availability, not a substitute for tool approval or managed policy.
export function agentControlAvailability(): AgentControlAvailability {
  return {
    zerosBrowser: isAgentControlFeatureActive("zerosBrowser"),
    computerUse: isAgentControlFeatureActive("computerUse"),
    simulators: isAgentControlFeatureActive("simulators"),
    localOrchestration: isAgentControlFeatureActive("localOrchestration"),
  };
}

export function useAgentControlAvailability(): AgentControlAvailability {
  const zerosBrowser = useAgentControlFeatureActive("zerosBrowser");
  const computerUse = useAgentControlFeatureActive("computerUse");
  const simulators = useAgentControlFeatureActive("simulators");
  const localOrchestration = useAgentControlFeatureActive("localOrchestration");
  return useMemo(
    () => ({ zerosBrowser, computerUse, simulators, localOrchestration }),
    [zerosBrowser, computerUse, simulators, localOrchestration],
  );
}

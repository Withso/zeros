// ──────────────────────────────────────────────────────────
// Agent control rollout — who gets the staged agent control features
// ──────────────────────────────────────────────────────────
//
// The Zeros browser, computer use and simulators reach users in stages
// (AGENT_CONTROL_ROLLOUT in @zeros/protocol/agent-control-rollout): staff
// first, behind Settings → Internal switches that start on; then an opt-in
// under Settings → Experimental; then everyone. Every surface of a closed
// feature is hidden or returns to its behavior from before the feature, and
// BrowserSessionController pushes the result to Electron main, which applies
// it to the control bars and forwards it to the engine for tool admission and
// routing.
//
// Like internal-features.ts this is a rollout gate, not an authority
// boundary: each feature keeps its own Settings switches, approvals and
// managed policy.
// ──────────────────────────────────────────────────────────

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

/** The switch rows under Settings → Internal or Settings → Experimental. */
export const AGENT_CONTROL_FEATURE_ROWS: Readonly<
  Record<AgentControlFeature, { label: string; hint: string }>
> = {
  zerosBrowser: {
    label: "Zeros browser",
    hint: "Claude Code and Cursor can use the in-app browser, and Codex can switch to it.",
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

/** The features whose switch lives at `stage`, in display order. */
export function agentControlFeaturesAt(
  stage: AgentControlRolloutStage,
): AgentControlFeature[] {
  return AGENT_CONTROL_FEATURES.filter(
    (feature) => AGENT_CONTROL_ROLLOUT[feature] === stage,
  );
}

// A local development build never loads a staff account (the team store does
// not fetch there), yet it is where these features are built. Main reports
// local development only for an unpackaged dev-channel build, so a shipped
// app cannot claim it.
function internalAccess(staffFlagActive: boolean, flagOn: boolean): boolean {
  return staffFlagActive || (isLocalDevelopment() && flagOn);
}

/** Synchronous gate for non-React call sites. */
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

/** Hook: re-renders when the account, a switch or the build changes the
 *  answer. */
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

export function agentControlAvailability(): AgentControlAvailability {
  return {
    zerosBrowser: isAgentControlFeatureActive("zerosBrowser"),
    computerUse: isAgentControlFeatureActive("computerUse"),
    simulators: isAgentControlFeatureActive("simulators"),
    localOrchestration: isAgentControlFeatureActive("localOrchestration"),
  };
}

/** Hook: every feature at once, as one stable object per answer. */
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

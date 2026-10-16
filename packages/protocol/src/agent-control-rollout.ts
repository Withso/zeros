import type { BrowserRouteSettings } from "./browser-tools";
import type { ComputerUseSettings } from "./computer-use-tools";

/** Agent control features that reach users in stages. The Codex browser fixes
 * (plan Phase 0) ship to everyone and are not listed. */
export const AGENT_CONTROL_FEATURES = [
  /** The in-app browser for Claude Code and Cursor, and Codex's switch to it. */
  "zerosBrowser",
  /** Zeros computer use on this Mac. */
  "computerUse",
  /** Simulator tabs, agent simulator tools and video key frames. */
  "simulators",
] as const;
export type AgentControlFeature = (typeof AGENT_CONTROL_FEATURES)[number];

/** - `internal`: staff accounts and local development builds, behind a switch
 *   under Settings > Internal that starts on.
 * - `experimental`: anyone who turns it on under Settings > Experimental.
 * - `default`: everyone. */
export type AgentControlRolloutStage = "internal" | "experimental" | "default";

/** Where each feature is in its rollout. Moving a feature to its next stage
 * is a change to this table alone. */
export const AGENT_CONTROL_ROLLOUT: Readonly<
  Record<AgentControlFeature, AgentControlRolloutStage>
> = Object.freeze({
  zerosBrowser: "internal",
  computerUse: "internal",
  simulators: "internal",
});

/** Which staged features this copy of Zeros has open. The renderer decides
 * and pushes it; Electron main and the engine enforce the last push. */
export type AgentControlAvailability = Readonly<
  Record<AgentControlFeature, boolean>
>;

export interface AgentControlRolloutAccess {
  /** A staff account or local development build whose Internal switch for
   * the feature is on. */
  internal: boolean;
  /** The user turned the feature on under Settings > Experimental. */
  experimental: boolean;
}

/** One switch per stage, so a feature never has two places to turn it off. */
export function agentControlFeatureOpen(
  stage: AgentControlRolloutStage,
  access: AgentControlRolloutAccess,
): boolean {
  switch (stage) {
    case "default":
      return true;
    case "experimental":
      return access.experimental;
    case "internal":
      return access.internal;
  }
}

/** What main and the engine assume before the renderer's first push: only
 * features that are on for everyone. */
export function initialAgentControlAvailability(
  rollout: Readonly<
    Record<AgentControlFeature, AgentControlRolloutStage>
  > = AGENT_CONTROL_ROLLOUT,
): AgentControlAvailability {
  return {
    zerosBrowser: rollout.zerosBrowser === "default",
    computerUse: rollout.computerUse === "default",
    simulators: rollout.simulators === "default",
  };
}

/** Main and the engine read a push strictly: a missing or malformed feature
 * rejects all of it, so a bad update never half-applies. */
export function readAgentControlAvailability(
  value: unknown,
): AgentControlAvailability | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.zerosBrowser !== "boolean" ||
    typeof record.computerUse !== "boolean" ||
    typeof record.simulators !== "boolean"
  ) {
    return null;
  }
  return {
    zerosBrowser: record.zerosBrowser,
    computerUse: record.computerUse,
    simulators: record.simulators,
  };
}

export function sameAgentControlAvailability(
  a: AgentControlAvailability,
  b: AgentControlAvailability,
): boolean {
  return AGENT_CONTROL_FEATURES.every((feature) => a[feature] === b[feature]);
}

/** Browser routing while the Zeros browser is closed is the routing from
 * before it: Codex keeps its built-in browser with no fallback, Claude Code
 * keeps Chrome, and Cursor gets no browser. */
export function gateBrowserRouteSettings(
  settings: BrowserRouteSettings,
  availability: Pick<AgentControlAvailability, "zerosBrowser">,
): BrowserRouteSettings {
  return availability.zerosBrowser
    ? settings
    : { ...settings, codexNative: true, inAppEnabled: false };
}

/** While Zeros computer use is closed, Codex keeps its built-in computer use
 * and no other agent gets any. */
export function gateComputerUseSettings<T extends ComputerUseSettings>(
  settings: T,
  availability: Pick<AgentControlAvailability, "computerUse">,
): T {
  return availability.computerUse
    ? settings
    : { ...settings, enabled: false, codexNative: true };
}

/** While simulators are closed, no agent gets the simulator tools. */
export function gateSimulatorSettings<T extends { enabled: boolean }>(
  settings: T,
  availability: Pick<AgentControlAvailability, "simulators">,
): T {
  return availability.simulators ? settings : { ...settings, enabled: false };
}

const UNAVAILABLE_REASONS: Record<AgentControlFeature, string> = {
  zerosBrowser: "The Zeros browser isn't available in this copy of Zeros.",
  computerUse: "Computer use isn't available in this copy of Zeros.",
  simulators: "Simulators aren't available in this copy of Zeros.",
};

/** What a tool call or request hears while its feature is closed. It names no
 * switch, because most users don't have one. */
export function agentControlUnavailableReason(
  feature: AgentControlFeature,
): string {
  return UNAVAILABLE_REASONS[feature];
}

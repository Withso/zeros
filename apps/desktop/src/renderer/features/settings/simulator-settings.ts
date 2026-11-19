import {
  gateSimulatorSettings,
  type AgentControlAvailability,
} from "@zeros/protocol/agent-control-rollout";
import type { DeviceToolRoute } from "@zeros/protocol/device-tools";
import {
  SIMULATOR_IDLE_SHUTDOWN_CHOICES,
  simulatorPreferencesFromSettings,
  simulatorSettings,
  type SimulatorIdleShutdown,
  type SimulatorPreferences,
  type SimulatorSettings,
} from "@zeros/protocol/simulators";

import type { SettingsDoc } from "../../platform/bridge/workspace-bridge";

export type SimulatorSettingKey = keyof SimulatorSettings;
export type SimulatorBooleanSetting = "enabled" | "show_agent_touches";

export const SIMULATOR_SETTINGS_ROWS = {
  enabled: {
    label: "Let agents use simulators",
    hint: "Each chat asks before it uses a device.",
  },
  idle_shutdown: {
    label: "Shut down idle simulators after",
    hint: "Only simulators Zeros started.",
  },
  show_agent_touches: {
    label: "Show agent touches",
    hint: undefined,
  },
} as const;

const IDLE_SHUTDOWN_LABELS: Record<SimulatorIdleShutdown, string> = {
  "15m": "15 minutes",
  "30m": "30 minutes",
  "1h": "1 hour",
  "2h": "2 hours",
  never: "Never",
};

export const SIMULATOR_IDLE_SHUTDOWN_OPTIONS: ReadonlyArray<{
  value: SimulatorIdleShutdown;
  label: string;
}> = SIMULATOR_IDLE_SHUTDOWN_CHOICES.map((value) => ({
  value,
  label: IDLE_SHUTDOWN_LABELS[value],
}));

export function simulatorSettingsFromEffective(
  effective: SettingsDoc | null | undefined,
): SimulatorSettings {
  return simulatorSettings(effective?.simulators);
}

// Apply the rollout gate before sending preferences to the Electron DeviceHub.
export function simulatorPreferencesFromEffective(
  effective: SettingsDoc | null | undefined,
  availability: Pick<AgentControlAvailability, "simulators">,
): SimulatorPreferences {
  return simulatorPreferencesFromSettings(
    gateSimulatorSettings(simulatorSettingsFromEffective(effective), availability),
  );
}

export function simulatorToolRouteFromEffective(
  effective: SettingsDoc | null | undefined,
  availability: Pick<AgentControlAvailability, "simulators">,
): DeviceToolRoute {
  return gateSimulatorSettings(simulatorSettingsFromEffective(effective), availability)
    .enabled
    ? "zeros"
    : "off";
}

export function simulatorSettingPatch<K extends SimulatorSettingKey>(
  key: K,
  value: SimulatorSettings[K],
): SettingsDoc {
  return { simulators: { [key]: value } };
}

export function simulatorSettingIsManaged(
  sources: Record<string, unknown> | null | undefined,
  key: SimulatorSettingKey,
): boolean {
  return sources?.[`simulators.${key}`] === "managed";
}

// A settled edit yields only to a new matching snapshot or managed policy, not an intermediate write.
export function simulatorSettingSnapshotSupersedesPending<K extends SimulatorSettingKey>(input: {
  key: K;
  value: SimulatorSettings[K];
  settled: boolean;
  baseline: unknown;
  resolved: unknown;
}): boolean {
  if (
    !input.settled ||
    !input.resolved ||
    typeof input.resolved !== "object" ||
    input.resolved === input.baseline
  ) {
    return false;
  }
  const snapshot = input.resolved as {
    effective?: SettingsDoc;
    sources?: Record<string, unknown>;
  };
  if (simulatorSettingIsManaged(snapshot.sources, input.key)) return true;
  return simulatorSettingsFromEffective(snapshot.effective)[input.key] === input.value;
}

// Shared rail and command palette gates; the palette catalog separately omits internal entries.
export interface SettingsSectionAvailability {
  local: boolean;
  cloudEnabled: boolean;
  terminalAgentsEnabled: boolean;
  computerUseSectionActive: boolean;
  simulatorsActive: boolean;
  internalUser: boolean;
}

export function isSettingsSectionAvailable(
  id: string,
  context: SettingsSectionAvailability,
): boolean {
  return (
    (context.local
      ? id !== "cloud-computer"
      : [
          "general",
          "providers",
          "integrations",
          "cloud-computer",
          "browser-use",
          "simulators",
        ].includes(id)) &&
    (context.cloudEnabled || id !== "cloud-computer") &&
    (context.terminalAgentsEnabled || id !== "terminal-agents") &&
    (context.local || context.computerUseSectionActive || id !== "general") &&
    (context.simulatorsActive || id !== "simulators") &&
    (context.internalUser || id !== "internal")
  );
}

/** Shared by Settings navigation and command discovery. Internal entries never
 * enter the public command catalog, even when the Settings rail admits them. */
export interface SettingsSectionAvailability {
  local: boolean;
  cloudEnabled: boolean;
  terminalAgentsEnabled: boolean;
  /** `computerUseSectionOpen`: the only rows an organization's General has. */
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
          // An organization's General holds only this Mac's computer use and
          // privacy controls.
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

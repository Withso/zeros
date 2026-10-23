/** Shared by Settings navigation and command discovery. Internal entries never
 * enter the public command catalog, even when the Settings rail admits them. */
export interface SettingsSectionAvailability {
  local: boolean;
  cloudEnabled: boolean;
  terminalAgentsEnabled: boolean;
  computerUseActive: boolean;
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
          "providers",
          "integrations",
          "cloud-computer",
          "browser-use",
          "computer-use",
          "simulators",
        ].includes(id)) &&
    (context.cloudEnabled || id !== "cloud-computer") &&
    (context.terminalAgentsEnabled || id !== "terminal-agents") &&
    (context.computerUseActive || id !== "computer-use") &&
    (context.simulatorsActive || id !== "simulators") &&
    (context.internalUser || id !== "internal")
  );
}

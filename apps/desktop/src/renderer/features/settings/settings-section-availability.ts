// Shared rail and command palette gates; the palette catalog separately omits internal entries.
export interface SettingsSectionAvailability {
  local: boolean;
  cloudEnabled: boolean;
  terminalAgentsEnabled: boolean;
  computerUseSectionActive: boolean;
  simulatorsActive: boolean;
  internalUser: boolean;
  /** Local Storage describes this Mac: every owner, macOS app only. */
  localStorageSupported: boolean;
  /** `unified-workspaces`: Personal pages under every owner, organization pages in their own group. */
  unified?: boolean;
  /** Unified only: the organization has General rows of its own. */
  organizationGeneral?: boolean;
}

/** Personal pages are the same under every owner. Order is the rail order. */
export const UNIFIED_PERSONAL_SECTIONS = [
  "general",
  "appearance",
  "models",
  "providers",
  "git",
  "integrations",
  "environment",
  "computer-use",
  "browser-use",
  "simulators",
  "local-storage",
  "account",
  "experimental",
  "internal",
] as const;

export const UNIFIED_ORGANIZATION_SECTIONS = [
  "org-general",
  "cloud-computer",
] as const;

/** Section IDs that exist only in the unified rail. */
const UNIFIED_ONLY_SECTIONS = new Set<string>(["computer-use", "org-general"]);

/**
 * Saved selections and deep links keep their IDs whichever rail is showing;
 * this maps an ID to the page that shows it without rewriting what was saved,
 * so turning the flag off and on again restores the same page.
 */
export function settingsSectionForRail(id: string, unified: boolean): string {
  if (unified) return id === "terminal-agents" ? "providers" : id;
  return UNIFIED_ONLY_SECTIONS.has(id) ? "general" : id;
}

function legacySectionAvailable(
  id: string,
  context: SettingsSectionAvailability,
): boolean {
  return (
    !UNIFIED_ONLY_SECTIONS.has(id) &&
    (context.local
      ? id !== "cloud-computer"
      : [
          "general",
          "providers",
          "integrations",
          "cloud-computer",
          "browser-use",
          "simulators",
          "local-storage",
        ].includes(id)) &&
    (context.cloudEnabled || id !== "cloud-computer") &&
    (context.terminalAgentsEnabled || id !== "terminal-agents") &&
    (context.local || context.computerUseSectionActive || id !== "general") &&
    (context.simulatorsActive || id !== "simulators") &&
    (context.internalUser || id !== "internal") &&
    (context.localStorageSupported || id !== "local-storage")
  );
}

export function isSettingsSectionAvailable(
  id: string,
  context: SettingsSectionAvailability,
): boolean {
  if (!context.unified) return legacySectionAvailable(id, context);
  switch (id) {
    case "cloud-computer":
      return !context.local && context.cloudEnabled;
    case "org-general":
      return !context.local && context.organizationGeneral === true;
    case "simulators":
      return context.simulatorsActive;
    case "internal":
      return context.internalUser;
    case "local-storage":
      return context.localStorageSupported;
    default:
      return (UNIFIED_PERSONAL_SECTIONS as readonly string[]).includes(id);
  }
}

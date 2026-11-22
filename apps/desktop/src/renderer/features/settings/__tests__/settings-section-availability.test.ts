import { describe, expect, it } from "vitest";
import {
  isSettingsSectionAvailable,
  settingsSectionForRail,
  UNIFIED_PERSONAL_SECTIONS,
  type SettingsSectionAvailability,
} from "../settings-section-availability";

const ALL_SECTIONS = [
  "general",
  "computer-use",
  "org-general",
  "appearance",
  "models",
  "local-storage",
  "cloud-computer",
  "providers",
  "browser-use",
  "simulators",
  "terminal-agents",
  "environment",
  "git",
  "integrations",
  "account",
  "experimental",
  "internal",
];

const base: SettingsSectionAvailability = {
  local: true,
  cloudEnabled: true,
  terminalAgentsEnabled: true,
  computerUseSectionActive: true,
  simulatorsActive: true,
  internalUser: false,
  localStorageSupported: true,
};

const available = (context: SettingsSectionAvailability) =>
  ALL_SECTIONS.filter((id) => isSettingsSectionAvailable(id, context));

describe("settings sections without unified-workspaces", () => {
  it("keeps the Personal and organization rails exactly as before", () => {
    expect(available(base)).toEqual([
      "general",
      "appearance",
      "models",
      "local-storage",
      "providers",
      "browser-use",
      "simulators",
      "terminal-agents",
      "environment",
      "git",
      "integrations",
      "account",
      "experimental",
    ]);
    expect(available({ ...base, local: false })).toEqual([
      "general",
      "local-storage",
      "cloud-computer",
      "providers",
      "browser-use",
      "simulators",
      "integrations",
    ]);
    expect(
      available({ ...base, local: false, unified: false, organizationGeneral: true }),
    ).toEqual(available({ ...base, local: false }));
  });

  it("opens the unified-only pages on the General page they came from", () => {
    expect(settingsSectionForRail("computer-use", false)).toBe("general");
    expect(settingsSectionForRail("org-general", false)).toBe("general");
    expect(settingsSectionForRail("terminal-agents", false)).toBe("terminal-agents");
    expect(settingsSectionForRail("providers", false)).toBe("providers");
  });
});

describe("settings sections with unified-workspaces", () => {
  const unified = { ...base, unified: true };

  it("shows the same Personal pages under the Personal owner and an organization", () => {
    const personal = available(unified);
    expect(personal).toEqual([
      "general",
      "computer-use",
      "appearance",
      "models",
      "local-storage",
      "providers",
      "browser-use",
      "simulators",
      "environment",
      "git",
      "integrations",
      "account",
      "experimental",
    ]);
    expect(
      available({ ...unified, local: false, organizationGeneral: true }),
    ).toEqual([...personal.slice(0, 2), "org-general", ...personal.slice(2, 5), "cloud-computer", ...personal.slice(5)]);
  });

  it("keeps Local Storage right after Appearance in the rail, as the Local Storage smoke expects", () => {
    expect(UNIFIED_PERSONAL_SECTIONS.indexOf("local-storage")).toBe(
      UNIFIED_PERSONAL_SECTIONS.indexOf("appearance") + 1,
    );
  });

  it("shows the organization's GitHub page only with two GitHub levels and more than one member", () => {
    const context = { local: false, cloudEnabled: true, terminalAgentsEnabled: true, computerUseSectionActive: true, simulatorsActive: true,
      internalUser: false, localStorageSupported: true, unified: true };
    expect(isSettingsSectionAvailable("org-github", { ...context, organizationGithub: true })).toBe(true);
    expect(isSettingsSectionAvailable("org-github", { ...context, organizationGithub: false })).toBe(false);
    expect(isSettingsSectionAvailable("org-github", { ...context, organizationGithub: true, local: true })).toBe(false);
    expect(isSettingsSectionAvailable("org-github", { ...context, organizationGithub: true, unified: false })).toBe(false);
  });

  it("omits organization pages under the Personal owner and when the organization has none", () => {
    expect(isSettingsSectionAvailable("org-general", { ...unified, organizationGeneral: true })).toBe(false);
    expect(isSettingsSectionAvailable("cloud-computer", unified)).toBe(false);
    const organization = { ...unified, local: false };
    expect(isSettingsSectionAvailable("org-general", organization)).toBe(false);
    expect(isSettingsSectionAvailable("cloud-computer", { ...organization, cloudEnabled: false })).toBe(false);
  });

  it("shows the Cloud Computer under Personal only for its own cloud with Pro, and never the organization pages", () => {
    expect(isSettingsSectionAvailable("cloud-computer", { ...unified, personalCloud: true })).toBe(true);
    expect(isSettingsSectionAvailable("cloud-computer", { ...unified, personalCloud: false })).toBe(false);
    expect(isSettingsSectionAvailable("cloud-computer", { ...unified, personalCloud: true, cloudEnabled: false })).toBe(false);
    expect(isSettingsSectionAvailable("org-general", { ...unified, personalCloud: true, organizationGeneral: true })).toBe(false);
    expect(isSettingsSectionAvailable("org-github", { ...unified, personalCloud: true, organizationGithub: true })).toBe(false);
  });

  it("folds Terminal Agents into Agents and keeps the other gates", () => {
    expect(isSettingsSectionAvailable("terminal-agents", unified)).toBe(false);
    expect(settingsSectionForRail("terminal-agents", true)).toBe("providers");
    expect(settingsSectionForRail("computer-use", true)).toBe("computer-use");
    expect(isSettingsSectionAvailable("internal", unified)).toBe(false);
    expect(isSettingsSectionAvailable("internal", { ...unified, internalUser: true })).toBe(true);
    expect(isSettingsSectionAvailable("simulators", { ...unified, simulatorsActive: false })).toBe(false);
    expect(isSettingsSectionAvailable("local-storage", { ...unified, localStorageSupported: false })).toBe(false);
    expect(isSettingsSectionAvailable("retired-page", unified)).toBe(false);
  });
});

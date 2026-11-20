import { describe, expect, it } from "vitest";
import {
  selectPaletteEntries,
  settingsPaletteEntries,
} from "../command-palette-model";
import type { SettingsSectionAvailability } from "../../features/settings/settings-section-availability";

const context: SettingsSectionAvailability = {
  local: true,
  cloudEnabled: true,
  terminalAgentsEnabled: true,
  computerUseSectionActive: true,
  simulatorsActive: true,
  internalUser: false,
  localStorageSupported: true,
};
const settings = (overrides: Partial<SettingsSectionAvailability>) =>
  settingsPaletteEntries({ ...context, ...overrides }).filter(
    (entry) => entry.target.type === "settings",
  );

describe("settings palette entries follow the unified rail", () => {
  it("offers the same Personal pages under every owner and organization pages only in an organization", () => {
    const personal = settings({ unified: true }).map((entry) => entry.id);
    expect(personal).toEqual(
      expect.arrayContaining([
        "settings:general",
        "settings:computer-use",
        "settings:environment",
        "settings:integrations",
        "settings:appearance",
      ]),
    );
    expect(personal).not.toContain("settings:terminal-agents");
    expect(personal).not.toContain("settings:org-general");
    expect(personal).not.toContain("settings:cloud-computer");
    const organization = settings({ unified: true, local: false, organizationGeneral: true }).map(
      (entry) => entry.id,
    );
    expect([...organization].sort()).toEqual(
      [...personal, "settings:org-general", "settings:cloud-computer"].sort(),
    );
  });

  it("names GitHub and finds Computer use and Terminal Agents on their new pages", () => {
    const entries = settings({ unified: true });
    expect(entries.find((entry) => entry.id === "settings:integrations")?.label).toBe("GitHub");
    const find = (query: string) =>
      selectPaletteEntries(entries, "settings", query).map((entry) => entry.id);
    expect(find("blocked apps")[0]).toBe("settings:computer-use");
    expect(find("terminal agents")[0]).toBe("settings:providers");
    expect(find("blocked apps")).not.toContain("settings:general");
  });

  it("keeps the legacy labels and pages with the flag off", () => {
    const entries = settings({ unified: false });
    expect(entries.find((entry) => entry.id === "settings:integrations")?.label).toBe("Integrations");
    expect(entries.map((entry) => entry.id)).toContain("settings:terminal-agents");
    expect(entries.map((entry) => entry.id)).not.toContain("settings:computer-use");
    expect(entries.map((entry) => entry.id)).not.toContain("settings:org-general");
  });
});

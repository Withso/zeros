import { DEFAULT_COMPUTER_BLOCKED_APPS } from "@zeros/protocol/computer-use-tools";
import { describe, expect, it } from "vitest";

import {
  COMPUTER_PERMISSION_ROWS,
  COMPUTER_USE_SETTINGS_ROWS,
  KNOWN_COMPUTER_APP_NAMES,
  computerUseBlockedAppsPatch,
  computerUsePreferencesFromEffective,
  computerUseRoutesFromEffective,
  computerUseSectionOpen,
  computerUseSettingIsManaged,
  computerUseSettingPatch,
  computerUseSettingSnapshotSupersedesPending,
  computerUseSettingValue,
  computerUseSettingsFromEffective,
  knownComputerAppName,
  withBlockedApp,
  withoutBlockedApp,
} from "../computer-use-settings";

describe("Computer use settings", () => {
  it("enables computer use and the agent cursor by default", () => {
    expect(computerUseSettingsFromEffective({})).toEqual({
      enabled: true,
      showAgentCursor: true,
      blockedApps: [...DEFAULT_COMPUTER_BLOCKED_APPS],
    });
    expect(computerUseSettingsFromEffective(null).enabled).toBe(true);
  });

  it("gives every agent Zeros computer use while it is on, Codex included", () => {
    const open = { computerUse: true };
    expect(computerUseRoutesFromEffective({}, open)).toEqual({
      codex: "zeros",
      claude: "zeros",
      cursor: "zeros",
    });
    // A retired codex_native key left in the file changes nothing.
    expect(
      computerUseRoutesFromEffective(
        { computer_use: { enabled: true, codex_native: true } },
        open,
      ),
    ).toEqual({ codex: "zeros", claude: "zeros", cursor: "zeros" });
    expect(
      computerUseRoutesFromEffective({ computer_use: { enabled: false } }, open),
    ).toEqual({ codex: "off", claude: "off", cursor: "off" });
    expect(
      computerUseRoutesFromEffective(
        { computer_use: { enabled: true } },
        { computerUse: false },
      ),
    ).toEqual({ codex: "off", claude: "off", cursor: "off" });
  });

  it("keeps General's Computer use section while either of its features is open", () => {
    expect(computerUseSectionOpen({ computerUse: true, zerosBrowser: false })).toBe(true);
    // The agent cursor also serves the Zeros browser.
    expect(computerUseSectionOpen({ computerUse: false, zerosBrowser: true })).toBe(true);
    expect(computerUseSectionOpen({ computerUse: false, zerosBrowser: false })).toBe(false);
  });

  it("pushes only what Electron main enforces", () => {
    const effective = {
      computer_use: {
        enabled: true,
        show_agent_cursor: false,
        app_access: "ask",
        blocked_apps: ["com.example.Mail", "com.EXAMPLE.mail", "not a bundle"],
      },
    };
    expect(
      computerUsePreferencesFromEffective(effective, { computerUse: true }),
    ).toEqual({
      enabled: true,
      showAgentCursor: false,
      blockedApps: ["com.example.Mail"],
    });
    expect(
      computerUsePreferencesFromEffective(effective, { computerUse: false }),
    ).toEqual({
      enabled: false,
      showAgentCursor: false,
      blockedApps: ["com.example.Mail"],
    });
  });

  it("writes single keys and replaces the whole blocked list", () => {
    expect(computerUseSettingPatch("enabled", true)).toEqual({
      computer_use: { enabled: true },
    });
    expect(computerUseSettingPatch("show_agent_cursor", false)).toEqual({
      computer_use: { show_agent_cursor: false },
    });
    const apps = ["com.apple.Safari"];
    const patch = computerUseBlockedAppsPatch(apps);
    expect(patch).toEqual({ computer_use: { blocked_apps: ["com.apple.Safari"] } });
    expect((patch.computer_use as { blocked_apps: string[] }).blocked_apps).not.toBe(
      apps,
    );
  });

  it("adds a blocked app once, compares bundle IDs without case, and rejects non-IDs", () => {
    expect(withBlockedApp(["com.apple.Safari"], "com.apple.Notes")).toEqual([
      "com.apple.Safari",
      "com.apple.Notes",
    ]);
    expect(withBlockedApp(["com.apple.Safari"], "COM.APPLE.SAFARI")).toBeNull();
    expect(withBlockedApp([], "Safari")).toBeNull();
    expect(withBlockedApp([], "")).toBeNull();
    expect(
      withoutBlockedApp(["com.apple.Safari", "com.apple.Notes"], "com.apple.safari"),
    ).toEqual(["com.apple.Notes"]);
  });

  it("names every shipped blocked app before Launch Services answers", () => {
    for (const bundleId of DEFAULT_COMPUTER_BLOCKED_APPS) {
      expect(knownComputerAppName(bundleId)).toBe(KNOWN_COMPUTER_APP_NAMES[bundleId]);
    }
    expect(knownComputerAppName("COM.APPLE.KEYCHAINACCESS")).toBe("Keychain Access");
    expect(knownComputerAppName("com.example.unknown")).toBeNull();
  });

  it("keeps row copy short and names the permissions macOS shows", () => {
    for (const row of [
      ...Object.values(COMPUTER_USE_SETTINGS_ROWS),
      ...Object.values(COMPUTER_PERMISSION_ROWS),
    ]) {
      expect(row.hint.length).toBeLessThanOrEqual(48);
    }
    expect(COMPUTER_USE_SETTINGS_ROWS.enabled).toEqual({
      label: "Enable computer use",
      hint: "Agents can use any app except blocked apps.",
    });
    expect(COMPUTER_USE_SETTINGS_ROWS.show_agent_cursor.label).toBe("Show agent cursor");
    expect(Object.keys(COMPUTER_USE_SETTINGS_ROWS).sort()).toEqual([
      "blocked_apps",
      "enabled",
      "show_agent_cursor",
    ]);
    expect(COMPUTER_PERMISSION_ROWS.accessibility.label).toBe("Accessibility");
    expect(COMPUTER_PERMISSION_ROWS["screen-recording"].label).toBe(
      "Screen Recording",
    );
  });

  it("recognizes managed computer use leaves", () => {
    expect(
      computerUseSettingIsManaged({ "computer_use.enabled": "managed" }, "enabled"),
    ).toBe(true);
    expect(
      computerUseSettingIsManaged({ "computer_use.enabled": "user" }, "enabled"),
    ).toBe(false);
    expect(
      computerUseSettingIsManaged(
        { "computer_use.blocked_apps": "managed" },
        "blocked_apps",
      ),
    ).toBe(true);
    expect(computerUseSettingIsManaged(undefined, "enabled")).toBe(false);
  });

  it("reads each key's effective value", () => {
    const effective = {
      computer_use: {
        enabled: true,
        show_agent_cursor: false,
        blocked_apps: ["com.apple.Safari"],
      },
    };
    expect(computerUseSettingValue(effective, "enabled")).toBe(true);
    expect(computerUseSettingValue(effective, "show_agent_cursor")).toBe(false);
    expect(computerUseSettingValue(effective, "blocked_apps")).toEqual([
      "com.apple.Safari",
    ]);
  });

  it("ignores an older write broadcast and yields to a matching or managed snapshot", () => {
    const baseline = {};
    const resolved = (computer_use: Record<string, unknown>, source = "user") => ({
      effective: { computer_use },
      sources: Object.fromEntries(
        Object.keys(computer_use).map((key) => [`computer_use.${key}`, source]),
      ),
    });
    expect(
      computerUseSettingSnapshotSupersedesPending({
        key: "enabled",
        value: true,
        settled: true,
        baseline,
        resolved: resolved({ enabled: true }),
      }),
    ).toBe(true);
    expect(
      computerUseSettingSnapshotSupersedesPending({
        key: "enabled",
        value: true,
        settled: true,
        baseline,
        resolved: resolved({ enabled: false }),
      }),
    ).toBe(false);
    expect(
      computerUseSettingSnapshotSupersedesPending({
        key: "enabled",
        value: true,
        settled: true,
        baseline,
        resolved: resolved({ enabled: false }, "managed"),
      }),
    ).toBe(true);
    expect(
      computerUseSettingSnapshotSupersedesPending({
        key: "enabled",
        value: true,
        settled: false,
        baseline,
        resolved: resolved({ enabled: true }),
      }),
    ).toBe(false);
    expect(
      computerUseSettingSnapshotSupersedesPending({
        key: "enabled",
        value: true,
        settled: true,
        baseline,
        resolved: baseline,
      }),
    ).toBe(false);
    expect(
      computerUseSettingSnapshotSupersedesPending({
        key: "blocked_apps",
        value: ["com.apple.Safari", "com.apple.Notes"],
        settled: true,
        baseline,
        resolved: resolved({ blocked_apps: ["com.apple.Safari"] }),
      }),
    ).toBe(false);
    expect(
      computerUseSettingSnapshotSupersedesPending({
        key: "blocked_apps",
        value: ["com.apple.Safari", "com.apple.Notes"],
        settled: true,
        baseline,
        resolved: resolved({ blocked_apps: ["com.apple.Safari", "com.apple.Notes"] }),
      }),
    ).toBe(true);
  });
});

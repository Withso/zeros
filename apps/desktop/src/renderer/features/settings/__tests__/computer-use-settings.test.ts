import { DEFAULT_COMPUTER_BLOCKED_APPS } from "@zeros/protocol/computer-use-tools";
import { describe, expect, it } from "vitest";

import {
  COMPUTER_PERMISSION_ROWS,
  COMPUTER_USE_SETTINGS_ROWS,
  KNOWN_COMPUTER_APP_NAMES,
  computerUseBlockedAppsPatch,
  computerUsePreferencesFromEffective,
  computerUseRoutesFromEffective,
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
  it("enables Zeros computer use by default while keeping Codex's native route", () => {
    expect(computerUseSettingsFromEffective({})).toEqual({
      enabled: true,
      codexNative: true,
      showAgentCursor: true,
      blockedApps: [...DEFAULT_COMPUTER_BLOCKED_APPS],
    });
    expect(computerUseSettingsFromEffective(null).enabled).toBe(true);
  });

  it("routes each agent the way the engine does", () => {
    const open = { computerUse: true };
    expect(computerUseRoutesFromEffective({}, open)).toEqual({
      codex: "codex-native",
      claude: "zeros",
      cursor: "zeros",
    });
    expect(
      computerUseRoutesFromEffective({ computer_use: { enabled: true } }, open),
    ).toEqual({ codex: "codex-native", claude: "zeros", cursor: "zeros" });
    expect(
      computerUseRoutesFromEffective(
        { computer_use: { enabled: true, codex_native: false } },
        open,
      ),
    ).toEqual({ codex: "zeros", claude: "zeros", cursor: "zeros" });
    expect(
      computerUseRoutesFromEffective(
        { computer_use: { enabled: false, codex_native: false } },
        open,
      ),
    ).toEqual({ codex: "off", claude: "off", cursor: "off" });
  });

  it("keeps Codex on its own computer use while Zeros computer use is not available", () => {
    expect(
      computerUseRoutesFromEffective(
        { computer_use: { enabled: true, codex_native: false } },
        { computerUse: false },
      ),
    ).toEqual({ codex: "codex-native", claude: "off", cursor: "off" });
  });

  it("pushes only what Electron main enforces", () => {
    const effective = {
      computer_use: {
        enabled: true,
        codex_native: false,
        show_agent_cursor: false,
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
    expect(computerUseSettingPatch("codex_native", false)).toEqual({
      computer_use: { codex_native: false },
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
    for (const row of Object.values(COMPUTER_USE_SETTINGS_ROWS)) {
      expect(row.hint.length).toBeLessThanOrEqual(96);
    }
    expect(COMPUTER_USE_SETTINGS_ROWS.enabled.label).toBe("Enable computer use");
    expect(COMPUTER_USE_SETTINGS_ROWS.codex_native.label).toBe(
      "Use Codex’s built-in computer use",
    );
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
        codex_native: false,
        show_agent_cursor: false,
        blocked_apps: ["com.apple.Safari"],
      },
    };
    expect(computerUseSettingValue(effective, "enabled")).toBe(true);
    expect(computerUseSettingValue(effective, "codex_native")).toBe(false);
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

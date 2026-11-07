import { describe, expect, it } from "vitest";

import {
  BROWSER_SETTINGS_ROWS,
  CLAUDE_CHROME_DOCS_URL,
  CLAUDE_CHROME_EXTENSION_URL,
  browserRoutesFromEffective,
  browserSettingIsManaged,
  browserSettingPatch,
  browserSettingSnapshotSupersedesPending,
  browserSettingsFromEffective,
} from "../browser-use-settings";

describe("Browser use settings", () => {
  it("writes the three Browser keys", () => {
    expect(browserSettingPatch("enabled", false)).toEqual({
      browser: { enabled: false },
    });
    expect(browserSettingPatch("claude_enabled", true)).toEqual({
      browser: { claude_enabled: true },
    });
    expect(browserSettingPatch("auto_open", false)).toEqual({
      browser: { auto_open: false },
    });
  });

  it("enables browser use for every agent and keeps Claude in Chrome opt-in", () => {
    expect(browserSettingsFromEffective({})).toEqual({
      enabled: true,
      claude_enabled: false,
      auto_open: true,
    });
    expect(
      browserSettingsFromEffective({
        browser: { enabled: false, claude_enabled: true, auto_open: "no" },
      }),
    ).toEqual({ enabled: false, claude_enabled: true, auto_open: true });
  });

  it("routes each agent the way the engine does, Codex included", () => {
    const open = { zerosBrowser: true };
    expect(browserRoutesFromEffective({}, open)).toEqual({
      codex: "zeros",
      claude: "zeros",
      cursor: "zeros",
    });
    expect(
      browserRoutesFromEffective({ browser: { claude_enabled: true } }, open),
    ).toEqual({ codex: "zeros", claude: "claude-chrome", cursor: "zeros" });
    // One switch decides for every agent, Claude's Chrome included.
    expect(
      browserRoutesFromEffective(
        { browser: { enabled: false, claude_enabled: true } },
        open,
      ),
    ).toEqual({ codex: "off", claude: "off", cursor: "off" });
    // Retired keys left in a file change nothing.
    expect(
      browserRoutesFromEffective(
        { browser: { codex_native: true, codex_enabled: false, in_app_enabled: false } },
        open,
      ),
    ).toEqual({ codex: "zeros", claude: "zeros", cursor: "zeros" });
  });

  it("leaves only Claude in Chrome while the Zeros browser is not available", () => {
    const closed = { zerosBrowser: false };
    expect(browserRoutesFromEffective({}, closed)).toEqual({
      codex: "off",
      claude: "off",
      cursor: "off",
    });
    expect(
      browserRoutesFromEffective({ browser: { claude_enabled: true } }, closed),
    ).toEqual({ codex: "off", claude: "claude-chrome", cursor: "off" });
  });

  it("keeps row copy short, with the Claude in Chrome links", () => {
    expect(Object.keys(BROWSER_SETTINGS_ROWS).sort()).toEqual([
      "auto_open",
      "claude_enabled",
      "enabled",
    ]);
    expect(BROWSER_SETTINGS_ROWS.enabled.label).toBe("Enable browser use");
    expect(BROWSER_SETTINGS_ROWS.claude_enabled.label).toBe("Use Claude Code with Chrome");
    expect(BROWSER_SETTINGS_ROWS.auto_open.label).toBe(
      "Open the Browser tab automatically",
    );
    for (const row of Object.values(BROWSER_SETTINGS_ROWS)) {
      expect((row.hint ?? "").length).toBeLessThanOrEqual(48);
    }
    expect(CLAUDE_CHROME_EXTENSION_URL).toMatch(/^https:\/\/chromewebstore\.google\.com\//);
    expect(CLAUDE_CHROME_DOCS_URL).toBe("https://code.claude.com/docs/en/chrome");
  });

  it("recognizes managed browser leaves", () => {
    expect(browserSettingIsManaged({ "browser.enabled": "managed" }, "enabled")).toBe(true);
    expect(browserSettingIsManaged({ "browser.enabled": "user" }, "enabled")).toBe(false);
    expect(browserSettingIsManaged(undefined, "auto_open")).toBe(false);
  });

  it("ignores an older write broadcast and yields to a matching or managed snapshot", () => {
    const baseline = {};
    const resolved = (browser: Record<string, unknown>, source = "user") => ({
      effective: { browser },
      sources: Object.fromEntries(
        Object.keys(browser).map((key) => [`browser.${key}`, source]),
      ),
    });
    const supersedes = (value: boolean, snapshot: unknown, settled = true) =>
      browserSettingSnapshotSupersedesPending({
        key: "enabled",
        value,
        settled,
        baseline,
        resolved: snapshot,
      });
    expect(supersedes(false, resolved({ enabled: false }))).toBe(true);
    expect(supersedes(false, resolved({ enabled: true }))).toBe(false);
    expect(supersedes(false, resolved({ enabled: true }, "managed"))).toBe(true);
    expect(supersedes(false, resolved({ enabled: false }), false)).toBe(false);
    expect(supersedes(false, baseline)).toBe(false);
  });
});

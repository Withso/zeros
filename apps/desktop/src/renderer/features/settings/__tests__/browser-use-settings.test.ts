import { describe, expect, it } from "vitest";

import {
  BROWSER_SETTINGS_ROWS,
  CLAUDE_CHROME_DOCS_URL,
  CLAUDE_CHROME_EXTENSION_URL,
  browserSettingIsManaged,
  browserSettingPatch,
  browserSettingSnapshotSupersedesPending,
  browserSettingsFromEffective,
  browserStringSettingPatch,
} from "../browser-use-settings";

describe("Browser use settings", () => {
  it("writes provider-specific browser settings", () => {
    expect(browserSettingPatch("codex_enabled", false)).toEqual({
      browser: { codex_enabled: false },
    });
    expect(browserSettingPatch("claude_enabled", true)).toEqual({
      browser: { claude_enabled: true },
    });
    expect(browserSettingPatch("auto_open", false)).toEqual({
      browser: { auto_open: false },
    });
  });

  it("keeps Claude external-Chrome access off until explicitly enabled", () => {
    expect(browserSettingsFromEffective({})).toEqual({
      codex_enabled: true,
      claude_enabled: false,
      auto_open: true,
      show_agent_cursor: true,
      navigation_approval: "always-ask",
    });
    expect(
      browserSettingsFromEffective({
        browser: { enabled: true, claude_enabled: true },
      }).claude_enabled,
    ).toBe(true);
    expect(
      browserSettingsFromEffective({
        browser: {
          enabled: false,
          codex_enabled: true,
          auto_open: "no",
          show_agent_cursor: false,
        },
      }),
    ).toEqual({
      codex_enabled: true,
      claude_enabled: false,
      auto_open: true,
      show_agent_cursor: false,
      navigation_approval: "always-ask",
    });
  });

  it("persists the website-opening approval policy separately from consequential actions", () => {
    expect(
      browserStringSettingPatch("navigation_approval", "always-allow"),
    ).toEqual({
      browser: { navigation_approval: "always-allow" },
    });
    expect(
      browserSettingsFromEffective({
        browser: { navigation_approval: "always-allow" },
      }).navigation_approval,
    ).toBe("always-allow");
  });

  it("keeps the Browser page to three concise Codex rows and one Claude row", () => {
    expect(BROWSER_SETTINGS_ROWS.codex).toHaveLength(3);
    expect(BROWSER_SETTINGS_ROWS.claude).toHaveLength(1);
    expect(BROWSER_SETTINGS_ROWS.codex.map(({ label }) => label)).toEqual([
      "Enable browser use",
      "Open the Browser tab automatically",
      "Approval for opening websites",
    ]);
    expect(BROWSER_SETTINGS_ROWS.claude[0]?.label).toBe(
      "Use Claude Code with Chrome",
    );
    expect(BROWSER_SETTINGS_ROWS.claude[0]?.hint).toBe(
      "Requires a Claude login and Chrome extension.",
    );
    for (const row of [
      ...BROWSER_SETTINGS_ROWS.codex,
      ...BROWSER_SETTINGS_ROWS.claude,
    ]) {
      expect(row.hint.length).toBeLessThanOrEqual(64);
    }
  });

  it("uses only Anthropic's official Chrome setup destinations", () => {
    expect(CLAUDE_CHROME_EXTENSION_URL).toBe(
      "https://chromewebstore.google.com/detail/claude/fcoeoabgfenejglbffodgkkbkcdhcgfn",
    );
    expect(CLAUDE_CHROME_DOCS_URL).toBe(
      "https://code.claude.com/docs/en/chrome",
    );
  });

  it("recognizes managed browser leaves that the user UI must not override", () => {
    expect(
      browserSettingIsManaged(
        { "browser.codex_enabled": "managed" },
        "codex_enabled",
      ),
    ).toBe(true);
    expect(
      browserSettingIsManaged(
        { "browser.codex_enabled": "user" },
        "codex_enabled",
      ),
    ).toBe(false);
  });

  it("ignores an older write broadcast and yields to a matching or managed snapshot", () => {
    const baseline = {};
    expect(
      browserSettingSnapshotSupersedesPending({
        key: "codex_enabled",
        value: false,
        settled: true,
        baseline,
        resolved: {
          effective: { browser: { codex_enabled: false } },
          sources: { "browser.codex_enabled": "user" },
        },
      }),
    ).toBe(true);
    expect(
      browserSettingSnapshotSupersedesPending({
        key: "codex_enabled",
        value: true,
        settled: true,
        baseline,
        resolved: {
          effective: { browser: { codex_enabled: false } },
          sources: { "browser.codex_enabled": "user" },
        },
      }),
    ).toBe(false);
    expect(
      browserSettingSnapshotSupersedesPending({
        key: "codex_enabled",
        value: true,
        settled: true,
        baseline,
        resolved: {
          effective: { browser: { codex_enabled: false } },
          sources: { "browser.codex_enabled": "managed" },
        },
      }),
    ).toBe(true);
    expect(
      browserSettingSnapshotSupersedesPending({
        key: "codex_enabled",
        value: true,
        settled: false,
        baseline,
        resolved: {
          effective: { browser: { codex_enabled: true } },
          sources: { "browser.codex_enabled": "user" },
        },
      }),
    ).toBe(false);
    expect(
      browserSettingSnapshotSupersedesPending({
        key: "codex_enabled",
        value: true,
        settled: true,
        baseline,
        resolved: baseline,
      }),
    ).toBe(false);
  });
});

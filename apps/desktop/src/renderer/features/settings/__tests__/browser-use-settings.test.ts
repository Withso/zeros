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
  browserStringSettingPatch,
  inAppBrowserInUse,
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
    expect(browserSettingPatch("codex_native", false)).toEqual({
      browser: { codex_native: false },
    });
    expect(browserSettingPatch("in_app_enabled", false)).toEqual({
      browser: { in_app_enabled: false },
    });
    expect(browserSettingPatch("show_agent_cursor", false)).toEqual({
      browser: { show_agent_cursor: false },
    });
  });

  it("keeps Claude external-Chrome access off until explicitly enabled", () => {
    expect(browserSettingsFromEffective({ browser: { enabled: false } }).codex_enabled).toBe(false);
    expect(browserSettingsFromEffective({ browser: { enabled: true } }).claude_enabled).toBe(false);
    expect(browserSettingsFromEffective({})).toEqual({
      codex_enabled: true,
      codex_native: true,
      in_app_enabled: true,
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
      codex_native: true,
      in_app_enabled: true,
      claude_enabled: false,
      auto_open: true,
      show_agent_cursor: false,
      navigation_approval: "always-ask",
    });
    expect(
      browserSettingsFromEffective({
        browser: { codex_native: false, in_app_enabled: "no" },
      }),
    ).toMatchObject({ codex_native: false, in_app_enabled: true });
  });

  it("routes each agent the way the engine does", () => {
    const open = { zerosBrowser: true };
    expect(browserRoutesFromEffective({}, open)).toEqual({
      codex: "codex-native",
      claude: "zeros",
      cursor: "zeros",
    });
    expect(
      browserRoutesFromEffective(
        { browser: { codex_native: false, claude_enabled: true } },
        open,
      ),
    ).toEqual({ codex: "zeros", claude: "claude-chrome", cursor: "zeros" });
    expect(
      browserRoutesFromEffective(
        { browser: { enabled: false, in_app_enabled: false } },
        open,
      ),
    ).toEqual({ codex: "off", claude: "off", cursor: "off" });
    expect(
      browserRoutesFromEffective(
        {
          browser: {
            codex_enabled: false,
            in_app_enabled: false,
            claude_enabled: true,
          },
        },
        open,
      ),
    ).toEqual({ codex: "off", claude: "claude-chrome", cursor: "off" });
  });

  it("routes as before the Zeros browser while it is not available", () => {
    const closed = { zerosBrowser: false };
    expect(browserRoutesFromEffective({}, closed)).toEqual({
      codex: "codex-native",
      claude: "off",
      cursor: "off",
    });
    expect(
      browserRoutesFromEffective(
        { browser: { codex_native: false, claude_enabled: true } },
        closed,
      ),
    ).toEqual({ codex: "codex-native", claude: "claude-chrome", cursor: "off" });
  });

  it("applies the shared Browser rows while any agent can use the in-app browser", () => {
    const open = { zerosBrowser: true };
    expect(inAppBrowserInUse({ codex_enabled: true, in_app_enabled: false }, open)).toBe(true);
    expect(inAppBrowserInUse({ codex_enabled: false, in_app_enabled: true }, open)).toBe(true);
    expect(inAppBrowserInUse({ codex_enabled: false, in_app_enabled: false }, open)).toBe(false);
    // Only Codex has the in-app browser while the Zeros browser is closed.
    expect(
      inAppBrowserInUse(
        { codex_enabled: false, in_app_enabled: true },
        { zerosBrowser: false },
      ),
    ).toBe(false);
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

  it("groups the Browser page into Codex, Claude and Cursor, and every-agent rows", () => {
    expect(BROWSER_SETTINGS_ROWS.codex.map(({ key, label }) => [key, label])).toEqual([
      ["codex_enabled", "Enable browser use"],
      ["codex_native", "Use Codex’s built-in browser"],
    ]);
    expect(BROWSER_SETTINGS_ROWS.inApp.map(({ key, label }) => [key, label])).toEqual([
      ["in_app_enabled", "Allow Claude and Cursor to use the in-app browser"],
      ["claude_enabled", "Use Claude Code with Chrome"],
    ]);
    expect(BROWSER_SETTINGS_ROWS.shared.map(({ key, label }) => [key, label])).toEqual([
      ["auto_open", "Open the Browser tab automatically"],
      ["navigation_approval", "Approval for opening websites"],
      ["show_agent_cursor", "Show agent cursor"],
    ]);
    // Existing rows keep their meaning and wording; the every-agent rows no
    // longer name Codex.
    expect(BROWSER_SETTINGS_ROWS.codex[0].hint).toBe(
      "Allow Codex to use the in-app browser.",
    );
    expect(BROWSER_SETTINGS_ROWS.inApp[1].hint).toBe(
      "Requires a Claude login and Chrome extension.",
    );
    const rows = [
      ...BROWSER_SETTINGS_ROWS.codex,
      ...BROWSER_SETTINGS_ROWS.inApp,
      ...BROWSER_SETTINGS_ROWS.shared,
    ];
    for (const row of rows) {
      expect(row.hint.length).toBeLessThanOrEqual(64);
    }
    for (const row of BROWSER_SETTINGS_ROWS.shared) {
      expect(row.hint).not.toContain("Codex");
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

import type { SettingsDoc } from "../../platform/bridge/workspace-bridge";

export const CLAUDE_CHROME_EXTENSION_URL =
  "https://chromewebstore.google.com/detail/claude/fcoeoabgfenejglbffodgkkbkcdhcgfn";
export const CLAUDE_CHROME_DOCS_URL = "https://code.claude.com/docs/en/chrome";

export type BrowserBooleanSetting =
  | "codex_enabled"
  | "claude_enabled"
  | "auto_open"
  | "show_agent_cursor";
export type BrowserStringSetting = "navigation_approval";
export type BrowserNavigationApproval = "always-ask" | "always-allow";

export interface BrowserUseSettingsValue {
  codex_enabled: boolean;
  claude_enabled: boolean;
  auto_open: boolean;
  show_agent_cursor: boolean;
  navigation_approval: BrowserNavigationApproval;
}

/** The compact Settings → Agents → Browser surface. Keeping the user-facing
 * copy beside its behavioral keys makes the intentionally small four-row
 * contract easy to test without mounting the settings bridge. */
export const BROWSER_SETTINGS_ROWS = {
  codex: [
    {
      key: "codex_enabled",
      label: "Enable browser use",
      hint: "Allow Codex to use the in-app browser.",
    },
    {
      key: "auto_open",
      label: "Open the Browser tab automatically",
      hint: "Show the Browser tab when Codex starts browsing.",
    },
    {
      key: "navigation_approval",
      label: "Approval for opening websites",
      hint: "Choose whether Codex asks before opening websites.",
    },
  ],
  claude: [
    {
      key: "claude_enabled",
      label: "Use Claude Code with Chrome",
      hint: "Requires a Claude login and Chrome extension.",
    },
  ],
} as const;

export function browserSettingsFromEffective(
  effective: SettingsDoc | null | undefined,
): BrowserUseSettingsValue {
  const browser =
    effective?.browser &&
    typeof effective.browser === "object" &&
    !Array.isArray(effective.browser)
      ? (effective.browser as Record<string, unknown>)
      : {};
  // `enabled` predates provider-specific switches. Retain it as the fallback
  // so existing settings and managed deployments preserve their behavior.
  const legacyEnabled =
    typeof browser.enabled === "boolean" ? browser.enabled : true;
  return {
    codex_enabled:
      typeof browser.codex_enabled === "boolean"
        ? browser.codex_enabled
        : legacyEnabled,
    claude_enabled:
      typeof browser.claude_enabled === "boolean"
        ? browser.claude_enabled
        : false,
    auto_open:
      typeof browser.auto_open === "boolean" ? browser.auto_open : true,
    show_agent_cursor:
      typeof browser.show_agent_cursor === "boolean"
        ? browser.show_agent_cursor
        : true,
    navigation_approval:
      browser.navigation_approval === "always-allow"
        ? "always-allow"
        : "always-ask",
  };
}

export function browserStringSettingPatch(
  key: BrowserStringSetting,
  value: BrowserNavigationApproval,
): SettingsDoc {
  return { browser: { [key]: value } };
}

export function browserSettingPatch(
  key: BrowserBooleanSetting,
  value: boolean,
): SettingsDoc {
  return { browser: { [key]: value } };
}

export function browserSettingIsManaged(
  sources: Record<string, unknown> | null | undefined,
  key: BrowserBooleanSetting | BrowserStringSetting,
): boolean {
  return sources?.[`browser.${key}`] === "managed";
}

export function browserSettingSnapshotSupersedesPending(input: {
  key: BrowserBooleanSetting;
  value: boolean;
  settled: boolean;
  baseline: unknown;
  resolved: unknown;
}): boolean {
  if (
    !input.settled ||
    !input.resolved ||
    typeof input.resolved !== "object" ||
    input.resolved === input.baseline
  ) {
    return false;
  }
  const snapshot = input.resolved as {
    effective?: SettingsDoc;
    sources?: Record<string, unknown>;
  };
  if (browserSettingIsManaged(snapshot.sources, input.key)) return true;
  return (
    browserSettingsFromEffective(snapshot.effective)[input.key] === input.value
  );
}

export function browserStringSettingSnapshotSupersedesPending(input: {
  key: BrowserStringSetting;
  value: BrowserNavigationApproval;
  settled: boolean;
  baseline: unknown;
  resolved: unknown;
}): boolean {
  if (
    !input.settled ||
    !input.resolved ||
    typeof input.resolved !== "object" ||
    input.resolved === input.baseline
  ) {
    return false;
  }
  const snapshot = input.resolved as {
    effective?: SettingsDoc;
    sources?: Record<string, unknown>;
  };
  if (browserSettingIsManaged(snapshot.sources, input.key)) return true;
  return (
    browserSettingsFromEffective(snapshot.effective)[input.key] === input.value
  );
}

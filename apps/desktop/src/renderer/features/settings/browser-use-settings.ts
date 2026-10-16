import {
  gateBrowserRouteSettings,
  type AgentControlAvailability,
} from "@zeros/protocol/agent-control-rollout";
import {
  browserRouteSettings,
  resolveBrowserRoute,
  type BrowserRoute,
} from "@zeros/protocol/browser-tools";

import type { SettingsDoc } from "../../platform/bridge/workspace-bridge";

export const CLAUDE_CHROME_EXTENSION_URL =
  "https://chromewebstore.google.com/detail/claude/fcoeoabgfenejglbffodgkkbkcdhcgfn";
export const CLAUDE_CHROME_DOCS_URL = "https://code.claude.com/docs/en/chrome";

export type BrowserBooleanSetting =
  | "codex_enabled"
  | "codex_native"
  | "in_app_enabled"
  | "claude_enabled"
  | "auto_open"
  | "show_agent_cursor";
export type BrowserStringSetting = "navigation_approval";
export type BrowserNavigationApproval = "always-ask" | "always-allow";
export type BrowserAgentFamily = "codex" | "claude" | "cursor";

export interface BrowserUseSettingsValue {
  codex_enabled: boolean;
  codex_native: boolean;
  in_app_enabled: boolean;
  claude_enabled: boolean;
  auto_open: boolean;
  show_agent_cursor: boolean;
  navigation_approval: BrowserNavigationApproval;
}

/** The Settings → Agents → Browser surface: Codex's rows, then Claude's and
 * Cursor's, then the rows that apply to every agent. Keeping the user-facing
 * copy beside its behavioral keys keeps the contract testable without
 * mounting the settings bridge. */
export const BROWSER_SETTINGS_ROWS = {
  codex: [
    {
      key: "codex_enabled",
      label: "Enable browser use",
      hint: "Allow Codex to use the in-app browser.",
    },
    {
      key: "codex_native",
      label: "Use Codex’s built-in browser",
      hint: "When off, Codex uses the Zeros browser tools.",
    },
  ],
  inApp: [
    {
      key: "in_app_enabled",
      label: "Allow Claude and Cursor to use the in-app browser",
      hint: "Claude uses Chrome instead when Claude Code with Chrome is on.",
    },
    {
      key: "claude_enabled",
      label: "Use Claude Code with Chrome",
      hint: "Requires a Claude login and Chrome extension.",
    },
  ],
  shared: [
    {
      key: "auto_open",
      label: "Open the Browser tab automatically",
      hint: "Show the Browser tab when an agent starts browsing.",
    },
    {
      key: "navigation_approval",
      label: "Approval for opening websites",
      hint: "Choose whether agents ask before opening websites.",
    },
    {
      key: "show_agent_cursor",
      label: "Show agent cursor",
      hint: "Show where the agent points and clicks on the page.",
    },
  ],
} as const;

function browserTable(
  effective: SettingsDoc | null | undefined,
): Record<string, unknown> {
  return effective?.browser &&
    typeof effective.browser === "object" &&
    !Array.isArray(effective.browser)
    ? (effective.browser as Record<string, unknown>)
    : {};
}

/** Which browser each agent uses, by the same table the engine applies when
 * it boots a provider and on every `zeros_browser` call. */
export function browserRoutesFromEffective(
  effective: SettingsDoc | null | undefined,
  availability: Pick<AgentControlAvailability, "zerosBrowser">,
): Record<BrowserAgentFamily, BrowserRoute> {
  const settings = gateBrowserRouteSettings(
    browserRouteSettings(browserTable(effective)),
    availability,
  );
  return {
    codex: resolveBrowserRoute("codex", settings),
    claude: resolveBrowserRoute("claude", settings),
    cursor: resolveBrowserRoute("cursor", settings),
  };
}

/** Whether any agent can drive the in-app browser, which is when the
 * every-agent rows (auto-open, website approval, cursor) apply. */
export function inAppBrowserInUse(
  values: Pick<BrowserUseSettingsValue, "codex_enabled" | "in_app_enabled">,
  availability: Pick<AgentControlAvailability, "zerosBrowser">,
): boolean {
  return (
    values.codex_enabled || (availability.zerosBrowser && values.in_app_enabled)
  );
}

export function browserSettingsFromEffective(
  effective: SettingsDoc | null | undefined,
): BrowserUseSettingsValue {
  const browser = browserTable(effective);
  // `enabled` predates provider-specific switches. Retain it as the fallback
  // so existing settings and managed deployments preserve their behavior.
  const legacyEnabled =
    typeof browser.enabled === "boolean" ? browser.enabled : true;
  return {
    codex_enabled:
      typeof browser.codex_enabled === "boolean"
        ? browser.codex_enabled
        : legacyEnabled,
    codex_native:
      typeof browser.codex_native === "boolean" ? browser.codex_native : true,
    in_app_enabled:
      typeof browser.in_app_enabled === "boolean"
        ? browser.in_app_enabled
        : true,
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

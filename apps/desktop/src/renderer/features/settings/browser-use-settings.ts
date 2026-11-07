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

export type BrowserBooleanSetting = "enabled" | "claude_enabled" | "auto_open";
export type BrowserAgentFamily = "codex" | "claude" | "cursor";

export type BrowserUseSettingsValue = Record<BrowserBooleanSetting, boolean>;

/** Settings → Browser, with its copy beside the keys it writes so the
 * contract stays testable without mounting the settings bridge. One switch
 * decides for every agent; Claude in Chrome stays opt-in. */
export const BROWSER_SETTINGS_ROWS: Record<
  BrowserBooleanSetting,
  { label: string; hint?: string }
> = {
  enabled: {
    label: "Enable browser use",
    hint: "Agents can use the Zeros browser.",
  },
  claude_enabled: {
    label: "Use Claude Code with Chrome",
    hint: "Requires a Claude login and Chrome extension.",
  },
  auto_open: {
    label: "Open the Browser tab automatically",
  },
};

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

export function browserSettingsFromEffective(
  effective: SettingsDoc | null | undefined,
): BrowserUseSettingsValue {
  const browser = browserTable(effective);
  const routing = browserRouteSettings(browser);
  return {
    enabled: routing.enabled,
    claude_enabled: routing.claudeChrome,
    auto_open:
      typeof browser.auto_open === "boolean" ? browser.auto_open : true,
  };
}

export function browserSettingPatch(
  key: BrowserBooleanSetting,
  value: boolean,
): SettingsDoc {
  return { browser: { [key]: value } };
}

export function browserSettingIsManaged(
  sources: Record<string, unknown> | null | undefined,
  key: BrowserBooleanSetting,
): boolean {
  return sources?.[`browser.${key}`] === "managed";
}

/** An optimistic value yields once a newer resolved snapshot shows it, or
 * managed policy takes the key. Serialized writes can broadcast an older
 * intermediate value first, which must not flicker back. */
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

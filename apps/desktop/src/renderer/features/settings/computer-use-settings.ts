import {
  gateComputerUseSettings,
  type AgentControlAvailability,
} from "@zeros/protocol/agent-control-rollout";
import {
  computerUseSettings,
  isComputerBundleId,
  resolveComputerUseRoute,
  sameComputerBundleId,
  type ComputerUsePreferences,
  type ComputerUseRoute,
  type ComputerUseSettings,
} from "@zeros/protocol/computer-use-tools";

import type { SettingsDoc } from "../../platform/bridge/workspace-bridge";
import type { BrowserAgentFamily } from "./browser-use-settings";

export type ComputerUseBooleanSetting =
  | "enabled"
  | "codex_native"
  | "show_agent_cursor";
export type ComputerUseSettingKey = ComputerUseBooleanSetting | "blocked_apps";
export type ComputerPermissionKind = "accessibility" | "screen-recording";

/** Settings → Agents → Computer use, with its copy beside the keys it writes
 * so the contract stays testable without mounting the settings bridge. */
export const COMPUTER_USE_SETTINGS_ROWS = {
  enabled: {
    label: "Enable computer use",
    hint: "Let agents see and control apps on this Mac. Each chat asks before it uses an app.",
  },
  codex_native: {
    label: "Use Codex’s built-in computer use",
    hint: "When off, Codex uses Zeros computer use.",
  },
  blocked_apps: {
    label: "Blocked apps",
    hint: "Agents can never see or control these apps. Zeros is always blocked.",
  },
  show_agent_cursor: {
    label: "Show agent cursor",
    hint: "Show where the agent points and clicks.",
  },
} as const;

export const COMPUTER_PERMISSION_ROWS: Record<
  ComputerPermissionKind,
  { label: string; hint: string }
> = {
  accessibility: {
    label: "Accessibility",
    hint: "Lets Zeros click, type and scroll in apps.",
  },
  "screen-recording": {
    label: "Screen Recording",
    hint: "Lets Zeros see the windows of apps it uses.",
  },
};

/** Names for the shipped blocked apps, shown until Launch Services answers. */
export const KNOWN_COMPUTER_APP_NAMES: Readonly<Record<string, string>> = {
  "com.apple.keychainaccess": "Keychain Access",
  "com.apple.Passwords": "Passwords",
  "com.apple.systempreferences": "System Settings",
  "com.1password.1password": "1Password",
  "com.agilebits.onepassword7": "1Password 7",
  "com.bitwarden.desktop": "Bitwarden",
};

export function knownComputerAppName(bundleId: string): string | null {
  for (const [known, name] of Object.entries(KNOWN_COMPUTER_APP_NAMES)) {
    if (sameComputerBundleId(known, bundleId)) return name;
  }
  return null;
}

export function computerUseSettingsFromEffective(
  effective: SettingsDoc | null | undefined,
): ComputerUseSettings {
  return computerUseSettings(effective?.computer_use);
}

/** Which computer use each agent gets, by the same table the engine applies
 * when it boots a provider and on every `zeros_computer` call. */
export function computerUseRoutesFromEffective(
  effective: SettingsDoc | null | undefined,
  availability: Pick<AgentControlAvailability, "computerUse">,
): Record<BrowserAgentFamily, ComputerUseRoute> {
  const settings = gateComputerUseSettings(
    computerUseSettingsFromEffective(effective),
    availability,
  );
  return {
    codex: resolveComputerUseRoute("codex", settings),
    claude: resolveComputerUseRoute("claude", settings),
    cursor: resolveComputerUseRoute("cursor", settings),
  };
}

/** What Electron main enforces on every call. */
export function computerUsePreferencesFromEffective(
  effective: SettingsDoc | null | undefined,
  availability: Pick<AgentControlAvailability, "computerUse">,
): ComputerUsePreferences {
  const settings = gateComputerUseSettings(
    computerUseSettingsFromEffective(effective),
    availability,
  );
  return {
    enabled: settings.enabled,
    showAgentCursor: settings.showAgentCursor,
    blockedApps: settings.blockedApps,
  };
}

export function computerUseSettingPatch(
  key: ComputerUseBooleanSetting,
  value: boolean,
): SettingsDoc {
  return { computer_use: { [key]: value } };
}

/** Arrays replace in a settings patch, so this writes the whole list. */
export function computerUseBlockedAppsPatch(
  bundleIds: readonly string[],
): SettingsDoc {
  return { computer_use: { blocked_apps: [...bundleIds] } };
}

/** Add a bundle ID unless it is already blocked or not a bundle ID. */
export function withBlockedApp(
  current: readonly string[],
  bundleId: string,
): string[] | null {
  if (
    !isComputerBundleId(bundleId) ||
    current.some((known) => sameComputerBundleId(known, bundleId))
  ) {
    return null;
  }
  return [...current, bundleId];
}

export function withoutBlockedApp(
  current: readonly string[],
  bundleId: string,
): string[] {
  return current.filter((known) => !sameComputerBundleId(known, bundleId));
}

export function computerUseSettingIsManaged(
  sources: Record<string, unknown> | null | undefined,
  key: ComputerUseSettingKey,
): boolean {
  return sources?.[`computer_use.${key}`] === "managed";
}

type ComputerUseSettingValue<K extends ComputerUseSettingKey> =
  K extends "blocked_apps" ? readonly string[] : boolean;

function settingValue<K extends ComputerUseSettingKey>(
  settings: ComputerUseSettings,
  key: K,
): ComputerUseSettingValue<K> {
  switch (key) {
    case "enabled":
      return settings.enabled as ComputerUseSettingValue<K>;
    case "codex_native":
      return settings.codexNative as ComputerUseSettingValue<K>;
    case "show_agent_cursor":
      return settings.showAgentCursor as ComputerUseSettingValue<K>;
    default:
      return settings.blockedApps as unknown as ComputerUseSettingValue<K>;
  }
}

export function computerUseSettingValue<K extends ComputerUseSettingKey>(
  effective: SettingsDoc | null | undefined,
  key: K,
): ComputerUseSettingValue<K> {
  return settingValue(computerUseSettingsFromEffective(effective), key);
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => item === b[index]);
  }
  return a === b;
}

/** An optimistic value yields once a newer resolved snapshot shows it, or
 * managed policy takes the key. Serialized writes can broadcast an older
 * intermediate value first, which must not flicker back. */
export function computerUseSettingSnapshotSupersedesPending<
  K extends ComputerUseSettingKey,
>(input: {
  key: K;
  value: ComputerUseSettingValue<K>;
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
  if (computerUseSettingIsManaged(snapshot.sources, input.key)) return true;
  return sameValue(
    computerUseSettingValue(snapshot.effective, input.key),
    input.value,
  );
}

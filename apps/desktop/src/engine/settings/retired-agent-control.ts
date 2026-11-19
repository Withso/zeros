// Fold retired keys in the layer that set them so an existing opt-out never grants access.

import type { RawSettingsDoc, SettingsLayerName } from "./schema";

export const RETIRED_BROWSER_KEYS = [
  "codex_enabled",
  "in_app_enabled",
  "codex_native",
  "provider",
  "show_agent_cursor",
  "navigation_approval",
] as const;

export const RETIRED_COMPUTER_USE_KEYS = ["app_access", "codex_native"] as const;

function table(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export interface RetiredAgentControlKeys {
  readonly browser: readonly string[];
  readonly computerUse: readonly string[];
  readonly browserOff: boolean;
  readonly cursorOff: boolean;
  readonly browserOffBecause: string | null;
}

/** A managed always-ask website policy becomes a denial because per-site prompts no longer exist. */
export function retiredAgentControlKeys(
  doc: RawSettingsDoc,
  layer: SettingsLayerName,
): RetiredAgentControlKeys {
  const browser = table(doc.browser) ?? {};
  const computer = table(doc.computer_use) ?? {};
  const optOut =
    browser.codex_enabled === false
      ? "codex_enabled"
      : browser.in_app_enabled === false
        ? "in_app_enabled"
        : null;
  const askEveryWebsite =
    layer === "managed" && browser.navigation_approval === "always-ask";
  return {
    browser: RETIRED_BROWSER_KEYS.filter((key) => Object.hasOwn(browser, key)),
    computerUse: RETIRED_COMPUTER_USE_KEYS.filter((key) => Object.hasOwn(computer, key)),
    // An opt-out for either old browser route disables the shared switch.
    browserOff: optOut !== null || askEveryWebsite,
    browserOffBecause: optOut ?? (askEveryWebsite ? "navigation_approval" : null),
    cursorOff: browser.show_agent_cursor === false,
  };
}

export function foldRetiredAgentControl(
  raw: unknown,
  layer: SettingsLayerName,
): { doc: unknown; warnings: string[] } {
  const doc = table(raw);
  if (!doc) return { doc: raw, warnings: [] };
  const retired = retiredAgentControlKeys(doc, layer);
  if (retired.browser.length === 0 && retired.computerUse.length === 0) {
    return { doc: raw, warnings: [] };
  }
  const warnings: string[] = [];
  const out: RawSettingsDoc = { ...doc };
  if (retired.browser.length > 0) {
    const browser = { ...table(doc.browser) };
    for (const key of retired.browser) {
      delete browser[key];
      warnings.push(
        key === retired.browserOffBecause
          ? `browser.${key}: retired — browser use is off for every agent (browser.enabled = false)`
          : key === "show_agent_cursor" && retired.cursorOff
            ? "browser.show_agent_cursor: retired — the agent cursor is hidden (computer_use.show_agent_cursor = false)"
            : `browser.${key}: retired — ignored`,
      );
    }
    if (retired.browserOff) browser.enabled = false;
    out.browser = browser;
  }
  const computer = table(doc.computer_use);
  if (retired.computerUse.length > 0 || retired.cursorOff) {
    const next = { ...computer };
    for (const key of retired.computerUse) {
      delete next[key];
      warnings.push(`computer_use.${key}: retired — ignored`);
    }
    if (retired.cursorOff) next.show_agent_cursor = false;
    // A malformed table stays malformed for the sanitizer to report.
    if (computer || doc.computer_use === undefined) out.computer_use = next;
  }
  return { doc: out, warnings };
}

/** Null values instruct the settings writer to delete retired keys. */
export function retiredAgentControlPatch(doc: RawSettingsDoc): RawSettingsDoc | null {
  const retired = retiredAgentControlKeys(doc, "user");
  if (retired.browser.length === 0 && retired.computerUse.length === 0) return null;
  const patch: RawSettingsDoc = {};
  if (retired.browser.length > 0) {
    const next: Record<string, unknown> = Object.fromEntries(retired.browser.map((key) => [key, null]));
    if (retired.browserOff) next.enabled = false;
    patch.browser = next;
  }
  const computer: Record<string, unknown> = Object.fromEntries(retired.computerUse.map((key) => [key, null]));
  if (retired.cursorOff) computer.show_agent_cursor = false;
  if (Object.keys(computer).length > 0) patch.computer_use = computer;
  return patch;
}

/** Explicit user edits take precedence if retired keys reappear after startup. */
export function withRetiredAgentControlCleared(
  current: RawSettingsDoc,
  patch: RawSettingsDoc,
): RawSettingsDoc {
  const retired = retiredAgentControlPatch(current);
  if (!retired) return patch;
  const merged: RawSettingsDoc = { ...patch };
  for (const key of ["browser", "computer_use"] as const) {
    const fold = retired[key];
    if (!fold) continue;
    const own = patch[key];
    if (own === undefined) merged[key] = fold;
    else if (table(own)) merged[key] = { ...(fold as Record<string, unknown>), ...table(own) };
  }
  return merged;
}

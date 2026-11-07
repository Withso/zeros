// Browser and computer-use settings used to have switches with no Settings
// row (per-app approval, website approval, Codex's built-in browser and
// computer use, per-provider browser switches). Every key now has a row. The
// retired keys are folded into the keys that replaced them when each layer is
// read, so an opt-out stays in force in the layer that set it (an
// organization's managed file included). The user's file loses them at engine
// start (agent-control-migration.ts) and on any Settings change, which then
// wins over them. An explicit opt-out never turns into access.

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
  /** Turn browser use off for every agent in this layer. */
  readonly browserOff: boolean;
  /** Hide the agent cursor in this layer. */
  readonly cursorOff: boolean;
  /** Why `browserOff`, for the layer's warning. */
  readonly browserOffBecause: string | null;
}

/** What one layer's retired keys still decide. `layer` matters only for
 * `navigation_approval`: an organization that required asking before every
 * website keeps browser use off, since Zeros no longer asks; the user's own
 * file follows the product's choice not to ask. */
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
    // One switch now covers every agent: browser use some agent was denied
    // stays off for all of them.
    browserOff: optOut !== null || askEveryWebsite,
    browserOffBecause: optOut ?? (askEveryWebsite ? "navigation_approval" : null),
    // "Show agent cursor" now covers the browser's pointer too.
    cursorOff: browser.show_agent_cursor === false,
  };
}

/** One raw layer with its retired keys folded into their replacements and
 * removed. Pure: the input is never mutated. */
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

/** The patch that retires the old keys in the user's raw settings document,
 * or null when it has none. `null` values delete keys in `opSettingsWrite`. */
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

/** A user-file write that also retires any old keys still in the file, with
 * the caller's own values winning: turning browser use on in Settings sticks
 * even if a hand edit brought `in_app_enabled = false` back mid-session. */
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

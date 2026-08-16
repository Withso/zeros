// ──────────────────────────────────────────────────────────
// Settings foundation — layered merge with per-leaf provenance
// ──────────────────────────────────────────────────────────
//
// Pure functions only (no fs). Precedence, weakest → strongest:
//   defaults < user < repo (shared) < repo-local (main checkout, machine-wide)
//            < workspace-local (this worktree) < managed
//
// Merge semantics: plain tables deep-merge per key; scalars and arrays
// replace whole. Every winning leaf records WHICH layer set it — that
// provenance is what renders "Inherited from User" in the repo settings UI.
// ──────────────────────────────────────────────────────────

import {
  sanitizeLayer,
  type RawSettingsDoc,
  type SettingsLayerName,
} from "./schema";

/** Resolver-level fallbacks. Deliberately minimal: only values the product
 *  treats as universal defaults today; behavior toggles stay undefined until
 *  the feature reading them ships. */
export const DEFAULT_SETTINGS: RawSettingsDoc = {
  git: {
    remote: "origin",
    base_branch: "main",
  },
  scripts: {
    run_mode: "concurrent",
  },
  browser: {
    enabled: true,
    codex_enabled: true,
    // External Chrome shares the user's signed-in browser profile. Unlike the
    // isolated Codex host, it is opt-in until the user explicitly enables it.
    claude_enabled: false,
    provider: "isolated",
    auto_open: true,
    show_agent_cursor: true,
    navigation_approval: "always-ask",
  },
};

export interface SettingsLayers {
  user?: RawSettingsDoc | null;
  /** Team defaults from the cloud control plane (couriered into the
   *  engine in-memory — see team-context.ts). Weaker than every repo layer:
   *  team sets the baseline, a repo can always specialize. */
  team?: RawSettingsDoc | null;
  repo?: RawSettingsDoc | null;
  /** Personal per-repo override from the MAIN checkout — machine-wide for the
   *  repo, so it reaches every worktree. */
  repoLocal?: RawSettingsDoc | null;
  /** Personal override from a single worktree's own `.zeros/settings.local.toml`
   *  — per-workspace, wins over repo-local. */
  workspaceLocal?: RawSettingsDoc | null;
  managed?: RawSettingsDoc | null;
}

export interface ResolvedSettings {
  /** Deep-merged effective document (no $schema, no provenance wrappers). */
  effective: RawSettingsDoc;
  /** Dot-path → the layer that supplied the winning value (leaves only). */
  sources: Record<string, SettingsLayerName>;
  /** Sanitizer warnings from every layer, prefixed with the layer name. */
  warnings: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Keys that, if assigned/recursed-into, can poison Object.prototype. `smol-toml`
 *  parses tables into null-prototype objects where `__proto__` is an OWN
 *  enumerable key, so a committed `[x."__proto__"]` table would otherwise reach
 *  `Object.prototype` during merge/clone. Always skipped. */
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function clone<T>(v: T): T {
  if (Array.isArray(v)) return v.map((x) => clone(x)) as T;
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (DANGEROUS_KEYS.has(k)) continue;
      out[k] = clone(x);
    }
    return out as T;
  }
  return v;
}

/** Remove provenance entries at and under `path` (a leaf being replaced by a
 *  table, or a table being replaced by a leaf, must not leave stale entries). */
function clearSourcesUnder(
  sources: Record<string, SettingsLayerName>,
  path: string,
): void {
  delete sources[path];
  const prefix = `${path}.`;
  for (const key of Object.keys(sources)) {
    if (key.startsWith(prefix)) delete sources[key];
  }
}

function mergeLayer(
  target: RawSettingsDoc,
  doc: RawSettingsDoc,
  layer: SettingsLayerName,
  sources: Record<string, SettingsLayerName>,
  basePath = "",
): void {
  for (const [key, value] of Object.entries(doc)) {
    if (value === undefined) continue;
    if (DANGEROUS_KEYS.has(key)) continue; // prototype-pollution guard
    if (basePath === "" && key === "$schema") continue; // file metadata, not a setting
    const path = basePath ? `${basePath}.${key}` : key;
    if (isPlainObject(value)) {
      if (!isPlainObject(target[key])) {
        clearSourcesUnder(sources, path);
        target[key] = {};
      }
      mergeLayer(target[key] as RawSettingsDoc, value, layer, sources, path);
    } else {
      clearSourcesUnder(sources, path);
      target[key] = clone(value);
      sources[path] = layer;
    }
  }
}

/** Resolve raw (untrusted) layer documents into the effective settings tree.
 *  Each layer is per-leaf sanitized first; user-only keys in repo layers are
 *  dropped there. Pure: inputs are never mutated. */
export function resolveSettings(layers: SettingsLayers): ResolvedSettings {
  const effective: RawSettingsDoc = {};
  const sources: Record<string, SettingsLayerName> = {};
  const warnings: string[] = [];

  const ordered: Array<[SettingsLayerName, RawSettingsDoc | null | undefined]> =
    [
      ["default", DEFAULT_SETTINGS],
      ["user", layers.user],
      ["team", layers.team],
      ["repo", layers.repo],
      ["repo-local", layers.repoLocal],
      ["workspace-local", layers.workspaceLocal],
      ["managed", layers.managed],
    ];

  for (const [layer, raw] of ordered) {
    if (!raw) continue;
    if (layer === "default") {
      mergeLayer(effective, raw, layer, sources);
      continue;
    }
    const { doc, warnings: layerWarnings } = sanitizeLayer(raw, layer);
    for (const w of layerWarnings) warnings.push(`${layer}: ${w}`);
    mergeLayer(effective, doc, layer, sources);
  }

  materializeBrowserProviderSettings(effective, sources, ordered);

  return { effective, sources, warnings };
}

/** `browser.enabled` was the original isolated-browser switch. It remains a
 * compatibility fallback for Codex and a fail-closed master disable for both
 * providers, but a legacy true value must not silently opt users into Claude's
 * external signed-in Chrome profile. Provider-specific leaves otherwise win at
 * the same or a stronger layer. */
function materializeBrowserProviderSettings(
  effective: RawSettingsDoc,
  sources: Record<string, SettingsLayerName>,
  ordered: Array<[SettingsLayerName, RawSettingsDoc | null | undefined]>,
): void {
  const browser = effective.browser;
  if (!isPlainObject(browser)) return;
  const ranks = new Map(ordered.map(([layer], index) => [layer, index]));
  const legacySource = sources["browser.enabled"];
  const legacyRank =
    legacySource === undefined ? -1 : (ranks.get(legacySource) ?? -1);
  const legacyValue = browser.enabled !== false;

  for (const key of ["codex_enabled", "claude_enabled"] as const) {
    const path = `browser.${key}`;
    const providerSource = sources[path];
    const providerRank =
      providerSource === undefined ? -1 : (ranks.get(providerSource) ?? -1);
    if (providerRank >= legacyRank && typeof browser[key] === "boolean") {
      continue;
    }
    if (key === "claude_enabled" && legacyValue) continue;
    browser[key] = legacyValue;
    if (legacySource) sources[path] = legacySource;
  }
}

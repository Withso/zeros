
import { DEFAULT_COMPUTER_BLOCKED_APPS } from "@zeros/protocol/computer-use-tools";
import { DEFAULT_SIMULATOR_SETTINGS } from "@zeros/protocol/simulators";
import {
  sanitizeLayer,
  type RawSettingsDoc,
  type SettingsLayerName,
} from "./schema";

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
    // External Chrome shares the user's signed-in browser profile, so it is
    // opt-in until the user explicitly enables it.
    claude_enabled: false,
    auto_open: true,
  },
  computer_use: {
    // Application access still requires macOS permissions; user or managed policy can disable it.
    enabled: true,
    show_agent_cursor: true,
    blocked_apps: [...DEFAULT_COMPUTER_BLOCKED_APPS],
  },
  simulators: { ...DEFAULT_SIMULATOR_SETTINGS },
};

export interface SettingsLayers {
  user?: RawSettingsDoc | null;
  /** Cloud team defaults arrive in memory and personal repository settings can override them. */
  team?: RawSettingsDoc | null;
  /** Retired input retained for source compatibility; never merged. */
  repo?: RawSettingsDoc | null;
  /** The main checkout's personal repository settings apply to all worktrees. */
  repoLocal?: RawSettingsDoc | null;
  workspaceLocal?: RawSettingsDoc | null;
  managed?: RawSettingsDoc | null;
}

export interface ResolvedSettings {
  effective: RawSettingsDoc;
  /** Dot-path → the layer that supplied the winning value (leaves only). */
  sources: Record<string, SettingsLayerName>;
  warnings: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** TOML can produce own prototype keys in null-prototype tables; never merge them into ordinary objects. */
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

/** When a layer replaces a table or leaf, discard provenance for the old shape. */
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
  if (basePath === "design") {
    // Path and stable ID are alternative representations of ONE selection.
    if (
      Object.hasOwn(doc, "directory") &&
      !Object.hasOwn(doc, "directory_id")
    ) {
      delete target.directory_id;
      clearSourcesUnder(sources, "design.directory_id");
    } else if (
      Object.hasOwn(doc, "directory_id") &&
      !Object.hasOwn(doc, "directory")
    ) {
      delete target.directory;
      clearSourcesUnder(sources, "design.directory");
    }
  }
  for (const [key, value] of Object.entries(doc)) {
    if (value === undefined) continue;
    if (DANGEROUS_KEYS.has(key)) continue;
    if (basePath === "" && key === "$schema") continue;
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

/** Sanitize each untrusted layer before merging values and their provenance. */
export function resolveSettings(layers: SettingsLayers): ResolvedSettings {
  const effective: RawSettingsDoc = {};
  const sources: Record<string, SettingsLayerName> = {};
  const warnings: string[] = [];

  const ordered: Array<[SettingsLayerName, RawSettingsDoc | null | undefined]> =
    [
      ["default", DEFAULT_SETTINGS],
      ["user", layers.user],
      ["team", layers.team],
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

  return { effective, sources, warnings };
}

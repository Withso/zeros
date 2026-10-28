import type { VariantBehaviorManifest, VariantBehaviorHint, VariantScriptRef } from "./variant-types";

const kinds = new Set(["gsap", "framer-motion", "webgl-loop", "canvas-raster", "lottie", "svg-animation", "video-playback", "interactive-widget", "react-component", "data-driven"]);
const modes = new Set(["static", "static-with-live-layer", "live-scripts", "live-app"]);
const confidences = new Set(["high", "medium", "low"]);
const frozen = new Set(["png", "poster", "none"]);

/** Rebuild this fixed-depth schema. Never stringify, enumerate, or recursively
 * copy a page-controlled object: structured clone permits shared graphs. */
export function sanitizeForkBehavior(value: unknown): VariantBehaviorManifest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  let budget = 512 * 1024;
  const string = (value: unknown, max = 8192): value is string => {
    if (typeof value !== "string" || value.length > max) return false;
    // Worst-case JSON escaping plus property/punctuation overhead. All work
    // and strings are charged before any output is constructed.
    budget -= value.length * 6 + 64;
    return budget >= 0;
  };
  if (raw.formatVersion !== 1 || !string(raw.runtimeMode, 32) || !modes.has(raw.runtimeMode) || !string(raw.sourceUrl) ||
      !Array.isArray(raw.behaviors) || raw.behaviors.length > 2000 ||
      !Array.isArray(raw.scriptRefs) || raw.scriptRefs.length > 500 ||
      !Array.isArray(raw.platformHints) || raw.platformHints.length > 100) return undefined;
  const seen = new Set<object>([raw]);
  const behaviors: VariantBehaviorHint[] = [];
  const scriptRefs: VariantScriptRef[] = [];
  const platformHints: string[] = [];
  for (const entry of raw.behaviors) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || seen.has(entry)) return undefined;
    seen.add(entry);
    const row = entry as Record<string, unknown>;
    if (!string(row.kind, 64) || !kinds.has(row.kind) || !string(row.selector) || !string(row.confidence, 16) || !confidences.has(row.confidence) ||
        (row.detail != null && !string(row.detail)) ||
        (row.frozenSnapshot !== undefined && (!string(row.frozenSnapshot, 16) || !frozen.has(row.frozenSnapshot)))) return undefined;
    behaviors.push({ kind: row.kind as VariantBehaviorHint["kind"], selector: row.selector, confidence: row.confidence as VariantBehaviorHint["confidence"],
      ...(row.detail !== undefined ? { detail: row.detail as string | null } : {}),
      ...(row.frozenSnapshot !== undefined ? { frozenSnapshot: row.frozenSnapshot as VariantBehaviorHint["frozenSnapshot"] } : {}) });
  }
  for (const entry of raw.scriptRefs) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || seen.has(entry)) return undefined;
    seen.add(entry);
    const row = entry as Record<string, unknown>;
    if (!string(row.url) || !string(row.kind, 128) || (row.async !== undefined && typeof row.async !== "boolean") ||
        (row.defer !== undefined && typeof row.defer !== "boolean")) return undefined;
    scriptRefs.push({ url: row.url, kind: row.kind, ...(row.async !== undefined ? { async: row.async as boolean } : {}), ...(row.defer !== undefined ? { defer: row.defer as boolean } : {}) });
  }
  for (const hint of raw.platformHints) { if (!string(hint, 256)) return undefined; platformHints.push(hint); }
  return { formatVersion: 1, runtimeMode: raw.runtimeMode as VariantBehaviorManifest["runtimeMode"], sourceUrl: raw.sourceUrl, behaviors, scriptRefs, platformHints };
}

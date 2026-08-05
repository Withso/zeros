// ──────────────────────────────────────────────────────────
// Variant artifact — fork manifest field helpers
// ──────────────────────────────────────────────────────────
//
// Foundation for future Design Mode: normalizes a fork snapshot's
// behavior manifest onto the persisted browser-tab variant fields.

import type { BrowserTabVariant } from "./variant-types";
import { VARIANT_FORMAT_VERSION } from "./variant-types";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/** Default artifacts/components/<slug>.tsx path for a variant name. */
export function defaultTsxModulePath(variantName: string): string {
  const slug = slugify(variantName) || "variant";
  return `artifacts/components/${slug}.tsx`;
}

/** Normalize fork snapshot manifest onto a new BrowserTabVariant fields. */
export function applyForkManifestFields(
  snapshot: Pick<
    BrowserTabVariant,
    "behaviorManifest" | "runtimeMode" | "tsxModulePath"
  > & { name: string },
): Pick<
  BrowserTabVariant,
  "formatVersion" | "runtimeMode" | "behaviorManifest" | "tsxModulePath"
> {
  const manifest = snapshot.behaviorManifest;
  const runtimeMode =
    snapshot.runtimeMode ??
    manifest?.runtimeMode ??
    "static";

  return {
    formatVersion: VARIANT_FORMAT_VERSION,
    runtimeMode,
    behaviorManifest: manifest,
    tsxModulePath:
      snapshot.tsxModulePath ??
      (manifest && manifest.behaviors.length > 0
        ? defaultTsxModulePath(snapshot.name)
        : null),
  };
}

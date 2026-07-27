// ──────────────────────────────────────────────────────────
// Browser tab variant types — tab-scoped forks (not global store)
// ──────────────────────────────────────────────────────────

/** Schema version for persisted variant + artifact payloads. */
export const VARIANT_FORMAT_VERSION = 1;

/**
 * How the variant preview runs today / in the future.
 *
 * - `static` — HTML+CSS srcdoc only (current default preview).
 * - `static-with-live-layer` — static preview + behavior manifest for a
 *   future `.tsx` live layer (GSAP, Framer, WebGL, etc.).
 * - `live-scripts` — (future) sandboxed iframe with `allow-scripts`.
 * - `live-app` — (future) full runtime shell (React/Vue host).
 */
export type VariantRuntimeMode =
  | "static"
  | "static-with-live-layer"
  | "live-scripts"
  | "live-app";

/** Detected JS / runtime behavior kinds catalogued at fork time. */
export type VariantBehaviorKind =
  | "gsap"
  | "framer-motion"
  | "webgl-loop"
  | "canvas-raster"
  | "lottie"
  | "svg-animation"
  | "video-playback"
  | "interactive-widget"
  | "react-component"
  | "data-driven";

export type VariantBehaviorConfidence = "high" | "medium" | "low";

/** What the static fork did for this node (PNG poster, etc.). */
export type VariantFrozenSnapshot = "png" | "poster" | "none";

/** One detected behavior inside the forked subtree. */
export interface VariantBehaviorHint {
  kind: VariantBehaviorKind;
  /** Document selector for the node (same scheme as sourceSelector). */
  selector: string;
  confidence: VariantBehaviorConfidence;
  /** Optional human-readable detail (Framer layer name, input type, etc.). */
  detail?: string | null;
  /** How static extraction represented this node. */
  frozenSnapshot?: VariantFrozenSnapshot;
}

/** Script loaded on the source page, relevant to live replay. */
export interface VariantScriptRef {
  url: string;
  kind: string;
  async?: boolean;
  defer?: boolean;
}

/**
 * Catalog of runtime behaviors detected during fork extraction.
 * Drives future Design Mode `.tsx` islands — not executed in static preview.
 */
export interface VariantBehaviorManifest {
  formatVersion: number;
  runtimeMode: VariantRuntimeMode;
  behaviors: VariantBehaviorHint[];
  scriptRefs: VariantScriptRef[];
  /** e.g. framer, react, next — page-level platform hints. */
  platformHints: string[];
  sourceUrl: string;
}

/** Static HTML+CSS fork captured from the live iframe picker. */
export interface BrowserTabVariant {
  id: string;
  name: string;
  html: string;
  css: string;
  sourceSelector: string;
  sourceUrl: string;
  componentName?: string | null;
  sourceViewportWidth: number;
  /** Viewport height of the variant frame (scroll inside when content is taller). */
  sourceContentHeight: number;
  /** Drag offset from the flex strip position (canvas logical px). */
  offsetX?: number;
  offsetY?: number;
  createdAt: number;
  parentVariantId?: string | null;
  /** Schema version — omitted on legacy forks (treat as v0). */
  formatVersion?: number;
  /** How this variant is intended to run (static now; live layer later). */
  runtimeMode?: VariantRuntimeMode;
  /** JS/GSAP/Framer/WebGL behaviors detected at fork time. */
  behaviorManifest?: VariantBehaviorManifest;
  /** Future path under artifacts/ for the live `.tsx` wrapper module. */
  tsxModulePath?: string | null;
}

/** Payload returned by the in-iframe picker on fork-request. */
export interface ForkSnapshotPayload {
  html: string;
  css: string;
  sourceSelector: string;
  sourceOuterHTML: string;
  contentHeight: number;
  contentWidth: number;
  mockData: { images: string[]; texts: string[] };
  componentName?: string | null;
  /** True when CSS exceeded FORK_CSS_MAX_BYTES and was truncated. */
  cssTruncated?: boolean;
  /** precision-local = full stylesheets on localhost; matched = subset. */
  extractionMode?: "precision-local" | "matched";
  behaviorManifest?: VariantBehaviorManifest;
}

export const BROWSER_VARIANT_GAP_PX = 64;
export const BROWSER_VARIANT_MIN_WIDTH = 240;
export const BROWSER_VARIANT_MIN_HEIGHT = 120;

/** Total logical width of live frame unit + variant strip (incl. preset rail). */
export function browserCanvasStripWidth(
  liveFrameWidth: number,
  variants: BrowserTabVariant[],
): number {
  const RAIL_W = 80;
  const RAIL_GAP = 24;
  let w = liveFrameWidth + RAIL_GAP + RAIL_W;
  for (const v of variants) {
    w += BROWSER_VARIANT_GAP_PX + v.sourceViewportWidth;
  }
  return w;
}

/** True when fork detected behaviors that need a future live `.tsx` layer. */
export function variantNeedsLiveLayer(variant: BrowserTabVariant): boolean {
  const mode = variant.runtimeMode ?? variant.behaviorManifest?.runtimeMode;
  if (mode === "static-with-live-layer") return true;
  const behaviors = variant.behaviorManifest?.behaviors ?? [];
  const liveKinds: VariantBehaviorKind[] = [
    "gsap",
    "framer-motion",
    "webgl-loop",
    "lottie",
    "svg-animation",
    "video-playback",
    "react-component",
  ];
  return behaviors.some((b) => liveKinds.includes(b.kind));
}

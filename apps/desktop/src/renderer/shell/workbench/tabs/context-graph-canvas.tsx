// ============================================
// COMPONENT: ContextGraphCanvas
// PURPOSE: Lightweight pan/zoom canvas over the workspace's .context-graph —
//          auto-laid-out cards (attachments + docs) the user can look around
//          but never drag. Pan: drag / trackpad scroll / space+drag. Zoom:
//          pinch or ⌘/Ctrl+scroll, anchored at the cursor.
// USED IN: ContextSurface (the pinned Context tab body)
// ============================================

// --- IMPORTS ---
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Image as ImageIcon, StickyNote } from "lucide-react";

import type { ContextGraphItemWire } from "@/renderer/platform/context-graph";
import {
  readWorkspaceImageThumbnail,
  type ReadImageThumbnailResult,
} from "@/renderer/platform/files";
import { FileTypeIcon } from "@/renderer/features/agent/composer-editor/file-type-icon";
import { Button, Checkbox } from "@/renderer/shared/ui/primitives";

// --- TYPES ---

interface ContextGraphCanvasProps {
  /** Workspace folder the items belong to (image reads resolve against it). */
  cwd: string;
  /** Canvas cards, already sorted oldest-first (stable identities/order). */
  items: ContextGraphItemWire[];
  /** Only the visible tab binds wheel/key listeners and loads images. */
  active: boolean;
  /** Share-checkbox commit; resolves when the engine finished the move. */
  onToggleShared: (attachmentId: string, shared: boolean) => Promise<void>;
  /** Attachment ids with an in-flight toggle (checkbox disabled). */
  pendingToggles: ReadonlySet<string>;
  /** Harness seam; production uses the bounded Electron thumbnail command. */
  imageThumbnailLoader?: typeof readWorkspaceImageThumbnail;
}

/** One placed card: the item plus its canvas-space slot. */
interface PlacedItem {
  item: ContextGraphItemWire;
  /** Scope-independent normally; scope-qualified only for an on-disk duplicate. */
  itemKey: string;
  x: number;
  y: number;
  /** Logical diamond row, exposed so layout invariants stay testable. */
  row: number;
  /** Position inside the row (every row/column pair is unique). */
  column: number;
  /** One of five bounded compositor planes, far (0) through near (4). */
  depthPlane: number;
}

/** React identity for a placed card. Kept as a pure helper so layout reflow
 *  cannot accidentally become component identity. */
export function contextGraphCardRenderKey(
  placed: Pick<PlacedItem, "itemKey" | "row" | "column">,
): string {
  return placed.itemKey;
}

/** Revision used by the decoded-thumbnail cache. */
export function contextGraphItemContentRevision(item: {
  mtimeMs: number;
  bytes: number;
  ctimeMs?: number;
}): string {
  return `${item.mtimeMs}:${item.ctimeMs ?? "unknown"}:${item.bytes}`;
}

/** A category band's floating label. */
interface SectionLabel {
  key: string;
  label: string;
  x: number;
  y: number;
}

interface ViewportTransform {
  x: number;
  y: number;
  scale: number;
}

type ObserveImage = (element: HTMLElement, onVisible: () => void) => () => void;

export interface ContextGraphLayout {
  placed: PlacedItem[];
  sections: SectionLabel[];
  /** Canvas-space bounding size, used by the fit-to-view math. */
  width: number;
  height: number;
}

// --- LAYOUT CONSTANTS ---
// Card geometry is fixed so layout is pure math (no measure pass). Every item
// owns the same square footprint; a contained image may look portrait,
// landscape, or panoramic inside it without changing the graph geometry.
const CARD_SIZE = 224;
// FLAG: 352px square slots leave a 104px minimum card gutter after jitter. The
// two furthest close-up planes can consume 108px, capping intrusion at 4px.
const SLOT_X = 352;
const SLOT_Y = 352;
const JITTER_X = 12;
const JITTER_Y = 12;
const CANVAS_PAD = 96;
const MIN_ZOOM = 0.08;
// A 200% ceiling keeps close inspection useful without letting one 224px
// footprint dominate the viewport. Depth motion is tuned independently.
const MAX_ZOOM = 2;
// A fitted 400-item graph reaches the 8% zoom floor, where a card is only
// ~18 CSS pixels wide. It still needs recognizable pixels: skipping the load
// entirely leaves every newly attached image as a permanent placeholder while
// older cached cards happen to remain visible. Tiny buckets keep that overview
// inexpensive; the existing visibility observer and four-flight queue still
// bound how much work can start at once.
const THUMBNAIL_DIMENSIONS = [64, 128, 256, 512, 1024, 1536] as const;
// Slight close-up oversampling keeps screenshot text crisp through fractional
// compositor scales instead of aiming for the bare physical-pixel minimum.
const THUMBNAIL_DETAIL_OVERSAMPLE = 1.35;
export type ContextGraphThumbnailDimension =
  | 0
  | (typeof THUMBNAIL_DIMENSIONS)[number];
/** Five translation-only planes create depth without independently scaling
 *  cards or allowing one plane to bury another. */
const DEPTH_FACTORS = [-1, -0.5, 0, 0.5, 1] as const;
const DEPTH_SEQUENCE = [2, 4, 0, 3, 1] as const;
// FLAG: opposite close-up planes can consume at most 108px of the 104px card
// gutter. The resulting 4px maximum edge intrusion is intentional: depth is
// unmistakable, while cards never stack deeply enough to hide their content.
const MIN_PARALLAX_CANVAS_OFFSET = 6;
const MAX_PARALLAX_CANVAS_OFFSET = 54;
const MIN_PARALLAX_STRENGTH = 0.035;
const MAX_PARALLAX_STRENGTH = 0.24;
const ZOOM_DEPTH_BIAS_X = 26;
const ZOOM_DEPTH_BIAS_Y = -18;
const MAX_SHARE_CONTROL_COMPENSATION = 8;
const COMPOSITOR_SETTLE_MS = 140;
/** Wheel-tick zoom sensitivity — matches the Browser tab's canvas mode. */
const ZOOM_SENSITIVITY = 0.005;

function smoothstep(value: number): number {
  const clamped = Math.max(0, Math.min(1, value));
  return clamped * clamped * (3 - 2 * clamped);
}

/** Depth increases with zoom relative to the exact fitted overview. Two
 * doublings reach full strength; the smoothstep avoids a visible threshold. */
function contextGraphDepthIntensity(
  scale: number,
  overviewScale: number,
): number {
  const safeOverview = Math.max(MIN_ZOOM, overviewScale);
  const doublings = Math.log2(Math.max(1, scale / safeOverview));
  return smoothstep(doublings / 2);
}

function boundedParallaxOffset(
  displacement: number,
  intensity: number,
): number {
  const maxOffset =
    MIN_PARALLAX_CANVAS_OFFSET +
    (MAX_PARALLAX_CANVAS_OFFSET - MIN_PARALLAX_CANVAS_OFFSET) * intensity;
  const strength =
    MIN_PARALLAX_STRENGTH +
    (MAX_PARALLAX_STRENGTH - MIN_PARALLAX_STRENGTH) * intensity;
  return maxOffset * Math.tanh((displacement * strength) / maxOffset);
}

/** Active image cards always receive at least the tiny overview preview. */
export function shouldLoadImageThumbnailsAtScale(scale: number): boolean {
  return Number.isFinite(scale) && scale > 0;
}

/** Choose the smallest bounded preview that covers the card's physical-pixel
 * footprint. This is the local equivalent of a responsive-image `srcset`:
 * overview cards stay cheap, while close zoom and Retina displays upgrade. */
export function contextGraphThumbnailDimension(
  scale: number,
  devicePixelRatio: number,
): ContextGraphThumbnailDimension {
  if (!shouldLoadImageThumbnailsAtScale(scale)) {
    return 0;
  }
  const density = Number.isFinite(devicePixelRatio)
    ? Math.max(1, Math.min(3, devicePixelRatio))
    : 1;
  const requiredPixels =
    CARD_SIZE * scale * density * THUMBNAIL_DETAIL_OVERSAMPLE;
  for (const dimension of THUMBNAIL_DIMENSIONS) {
    if (requiredPixels <= dimension) return dimension;
  }
  return THUMBNAIL_DIMENSIONS.at(-1)!;
}

/** Counter the canvas shrink only until the control reaches its native screen
 * scale. It then grows naturally with close zoom. The cap prevents one hover
 * affordance from swallowing an ultra-dense 400-card overview. */
export function contextGraphShareControlCompensation(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) {
    return MAX_SHARE_CONTROL_COMPENSATION;
  }
  return Math.max(1, Math.min(MAX_SHARE_CONTROL_COMPENSATION, 1 / scale));
}

/** Resolve the full-strength plane offset once per frame. It is expressed in
 *  canvas pixels so the reserved gutter and visual strength scale together. */
function computeParallaxCanvasOffset(
  viewport: ViewportTransform,
  viewportSize: { width: number; height: number },
  canvasSize: { width: number; height: number },
  reducedMotion: boolean,
): { x: number; y: number } {
  if (reducedMotion) return { x: 0, y: 0 };
  const overviewScale = fitContextGraphViewport(canvasSize, viewportSize).scale;
  const intensity = contextGraphDepthIntensity(viewport.scale, overviewScale);
  const cameraCenterX = (viewportSize.width / 2 - viewport.x) / viewport.scale;
  const cameraCenterY = (viewportSize.height / 2 - viewport.y) / viewport.scale;
  const maxOffset =
    MIN_PARALLAX_CANVAS_OFFSET +
    (MAX_PARALLAX_CANVAS_OFFSET - MIN_PARALLAX_CANVAS_OFFSET) * intensity;
  const clampOffset = (value: number) =>
    Math.max(-maxOffset, Math.min(maxOffset, value));
  return {
    x: clampOffset(
      boundedParallaxOffset(canvasSize.width / 2 - cameraCenterX, intensity) +
        ZOOM_DEPTH_BIAS_X * intensity,
    ),
    y: clampOffset(
      boundedParallaxOffset(canvasSize.height / 2 - cameraCenterY, intensity) +
        ZOOM_DEPTH_BIAS_Y * intensity,
    ),
  };
}

/** Project one depth plane without scaling its geometry independently. Camera
 * displacement drives a smooth offset whose bounded envelope grows from 6px
 * in overview to 54px close-up. Every plane keeps the same scale, so
 * cursor-focused zoom visibly pushes neighbouring depth planes apart. */
export function projectParallaxViewport(
  viewport: ViewportTransform,
  viewportSize: { width: number; height: number },
  canvasSize: { width: number; height: number },
  depthFactor: number,
  reducedMotion: boolean,
): ViewportTransform {
  if (reducedMotion || depthFactor === 0) return viewport;
  const offset = computeParallaxCanvasOffset(
    viewport,
    viewportSize,
    canvasSize,
    false,
  );
  return {
    x: viewport.x + offset.x * depthFactor * viewport.scale,
    y: viewport.y + offset.y * depthFactor * viewport.scale,
    scale: viewport.scale,
  };
}

/** Pure fit math keeps the centered overview an exact diamond: all depth
 *  offsets resolve to zero because the camera and graph centers coincide. */
export function fitContextGraphViewport(
  canvasSize: { width: number; height: number },
  viewportSize: { width: number; height: number },
): ViewportTransform {
  const scale = Math.min(
    1,
    Math.max(
      MIN_ZOOM,
      Math.min(
        viewportSize.width / canvasSize.width,
        viewportSize.height / canvasSize.height,
      ),
    ),
  );
  return {
    x: (viewportSize.width - canvasSize.width * scale) / 2,
    y: (viewportSize.height - canvasSize.height * scale) / 2,
    scale,
  };
}

/** Exponential zoom is stable for both tiny trackpad deltas and coarse mouse
 *  wheels. Re-anchoring the translation preserves the canvas point under the
 *  cursor, producing the requested zoom-through/parallax feel without a
 *  per-card animation or React render. */
export function zoomViewportAtPoint(
  viewport: ViewportTransform,
  anchorX: number,
  anchorY: number,
  deltaY: number,
): ViewportTransform {
  const scale = Math.max(
    MIN_ZOOM,
    Math.min(MAX_ZOOM, viewport.scale * Math.exp(-deltaY * ZOOM_SENSITIVITY)),
  );
  if (scale === viewport.scale) return viewport;
  const ratio = scale / viewport.scale;
  return {
    x: anchorX - (anchorX - viewport.x) * ratio,
    y: anchorY - (anchorY - viewport.y) * ratio,
    scale,
  };
}

// --- LAYOUT ---

/** Deterministic per-item jitter so the grid reads as a loose canvas rather
 *  than a table. Attachment identity survives the local/shared path move, so
 *  toggling scope cannot make a card jump beneath the pointer. */
function jitterFor(seed: string): { dx: number; dy: number } {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const a = ((h >>> 0) % 1000) / 1000;
  const b = ((h >>> 10) % 1000) / 1000;
  return {
    dx: Math.round((a * 2 - 1) * JITTER_X),
    dy: Math.round((b * 2 - 1) * JITTER_Y),
  };
}

/** Scope-independent identity for layout. A normal share move keeps its seed,
 * while a duplicate present in both scopes is disambiguated below. */
function stableItemKey(item: ContextGraphItemWire): string {
  return item.attachmentId ? `${item.attachmentId}/${item.name}` : item.relPath;
}

/** Scope-aware identity for React and thumbnail data. Two divergent on-disk
 * copies must never reuse one component or decoded bitmap. */
function scopedItemKey(item: ContextGraphItemWire): string {
  return `${item.scope}|${stableItemKey(item)}`;
}

/** Split `count` across a compact diamond envelope. A full envelope has row
 *  capacities 1,3,5,…,5,3,1. Hamilton apportionment scales that envelope to
 *  an arbitrary item count without gaps, while keeping small sets useful
 *  (3 → 1/2, 4 → 1/2/1) and large sets tapered at both ends. */
export function computeDiamondRowCounts(count: number): number[] {
  const total = Math.max(0, Math.floor(count));
  if (total === 0) return [];

  let rowCount = 1;
  const capacityFor = (rows: number) => Math.ceil((rows * rows) / 2);
  while (capacityFor(rowCount) < total) rowCount += 1;

  const capacities = Array.from(
    { length: rowCount },
    (_, row) => rowCount - Math.abs(2 * row - (rowCount - 1)),
  );
  const capacity = capacities.reduce((sum, value) => sum + value, 0);
  const apportioned = capacities.map((value, row) => {
    const exact = (value * total) / capacity;
    return { row, count: Math.floor(exact), remainder: exact % 1 };
  });
  let remaining =
    total - apportioned.reduce((sum, entry) => sum + entry.count, 0);
  const byRemainder = [...apportioned].sort(
    (a, b) =>
      b.remainder - a.remainder ||
      Math.abs(a.row - (rowCount - 1) / 2) -
        Math.abs(b.row - (rowCount - 1) / 2) ||
      a.row - b.row,
  );
  for (const entry of byRemainder) {
    if (remaining === 0) break;
    apportioned[entry.row]!.count += 1;
    remaining -= 1;
  }

  // Zero-cap edge rows can appear only in the smallest partial diamonds.
  // Trimming them gives the intended triangular 3-card result, never a blank
  // row that inflates fit-to-view.
  const counts = apportioned.map((entry) => entry.count);
  while (counts[0] === 0) counts.shift();
  while (counts.at(-1) === 0) counts.pop();
  return counts;
}

/** Auto-place every graph item in one diamond — scope/category never creates
 *  a visual group. Items stay in the authoritative oldest-first list order,
 *  and each row is centered around the same canvas axis. */
export function computeContextGraphLayout(
  items: ContextGraphItemWire[],
): ContextGraphLayout {
  const rowCounts = computeDiamondRowCounts(items.length);
  const placed: PlacedItem[] = [];
  const widestRow = Math.max(1, ...rowCounts);
  let itemIndex = 0;
  const identityCounts = new Map<string, number>();
  for (const item of items) {
    const key = stableItemKey(item);
    identityCounts.set(key, (identityCounts.get(key) ?? 0) + 1);
  }

  rowCounts.forEach((rowSize, row) => {
    const rowOffset = ((widestRow - rowSize) * SLOT_X) / 2;
    for (let column = 0; column < rowSize; column += 1) {
      const index = itemIndex;
      const item = items[itemIndex++];
      if (!item) break;
      const stableKey = stableItemKey(item);
      const itemKey =
        (identityCounts.get(stableKey) ?? 0) > 1
          ? scopedItemKey(item)
          : stableKey;
      const { dx, dy } = jitterFor(itemKey);
      placed.push({
        item,
        itemKey,
        x: rowOffset + column * SLOT_X + dx,
        y: row * SLOT_Y + dy,
        row,
        column,
        depthPlane: DEPTH_SEQUENCE[index % DEPTH_SEQUENCE.length],
      });
    }
  });

  const minX = Math.min(0, ...placed.map((entry) => entry.x));
  const minY = Math.min(0, ...placed.map((entry) => entry.y));
  for (const entry of placed) {
    entry.x += CANVAS_PAD - minX;
    entry.y += CANVAS_PAD - minY;
  }
  const maxX = Math.max(0, ...placed.map((entry) => entry.x + CARD_SIZE));
  const maxY = Math.max(0, ...placed.map((entry) => entry.y + CARD_SIZE));

  return {
    placed,
    sections: [],
    width: Math.max(maxX + CANVAS_PAD, CANVAS_PAD * 2 + CARD_SIZE),
    height: Math.max(maxY + CANVAS_PAD, CANVAS_PAD * 2 + CARD_SIZE),
  };
}

// --- IMAGE CACHE ---
// Small module-level LRU of decoded data URLs so revisiting the tab (or
// panning back to a card) doesn't re-read the file. Deliberately NOT the
// shared workspace-file-data-cache: a graph can hold hundreds of images and
// subscribed entries there are unevictable — this cache caps by count and
// skips oversized payloads instead.
interface CachedImageThumbnail {
  dataUrl: string;
  requestedDimension: Exclude<ContextGraphThumbnailDimension, 0>;
  width?: number;
  height?: number;
  sourceWidth?: number;
  sourceHeight?: number;
  orientation?: number;
}

const imageUrlCache = new Map<string, CachedImageThumbnail | null>();
const IMAGE_THUMBNAIL_CACHE_VERSION = 5;
const IMAGE_CACHE_MAX = 160;
const IMAGE_CACHE_MAX_URL_CHARS = 24_000_000;

function cachedImageUrl(key: string): CachedImageThumbnail | null | undefined {
  if (!imageUrlCache.has(key)) return undefined;
  const value = imageUrlCache.get(key);
  imageUrlCache.delete(key);
  imageUrlCache.set(key, value ?? null);
  return value;
}

function cacheImageUrl(key: string, value: CachedImageThumbnail | null): void {
  imageUrlCache.delete(key);
  imageUrlCache.set(key, value);
  const chars = () =>
    [...imageUrlCache.values()].reduce(
      (sum, entry) => sum + (entry?.dataUrl.length ?? 0),
      0,
    );
  while (
    imageUrlCache.size > IMAGE_CACHE_MAX ||
    chars() > IMAGE_CACHE_MAX_URL_CHARS
  ) {
    const oldest = imageUrlCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    imageUrlCache.delete(oldest);
  }
}

interface QueuedImageLoad {
  cancelled: boolean;
  priority: number;
  sequence: number;
  run: () => Promise<CachedImageThumbnail | null | undefined>;
  resolve: (value: CachedImageThumbnail | null | undefined) => void;
}

/** New/modified images jump ahead of an existing overview backlog. Four
 *  already-active decodes remain bounded and are never interrupted. */
export function contextGraphImageLoadPriority(item: {
  mtimeMs: number;
  ctimeMs?: number;
}): number {
  const mtimeMs = Number.isFinite(item.mtimeMs) ? item.mtimeMs : 0;
  const ctimeMs = Number.isFinite(item.ctimeMs) ? (item.ctimeMs ?? 0) : 0;
  return Math.max(mtimeMs, ctimeMs);
}

/** Only a deterministic size-policy refusal is permanent for an exact mtime.
 * Missing/rewritten files and decode failures get another chance on re-entry. */
export function contextGraphThumbnailFailureIsPermanent(
  result: ReadImageThumbnailResult | null,
): boolean {
  return result?.kind === "too-large";
}

const imageLoadQueue: QueuedImageLoad[] = [];
let activeImageLoads = 0;
let imageLoadSequence = 0;
const MAX_CONCURRENT_IMAGE_LOADS = 4;

/** Bound native decode/IPC work globally so fit-to-view over a large graph
 *  progressively fills thumbnails instead of launching hundreds at once. */
function pumpImageLoads(): void {
  while (
    activeImageLoads < MAX_CONCURRENT_IMAGE_LOADS &&
    imageLoadQueue.length > 0
  ) {
    const task = imageLoadQueue.shift()!;
    if (task.cancelled) {
      task.resolve(undefined);
      continue;
    }
    activeImageLoads += 1;
    void task
      .run()
      .then((value) => task.resolve(task.cancelled ? undefined : value))
      .catch(() => task.resolve(undefined))
      .finally(() => {
        activeImageLoads -= 1;
        pumpImageLoads();
      });
  }
}

function scheduleImageLoad(
  priority: number,
  run: QueuedImageLoad["run"],
): {
  promise: Promise<CachedImageThumbnail | null | undefined>;
  cancel: () => void;
} {
  let resolve!: QueuedImageLoad["resolve"];
  const promise = new Promise<CachedImageThumbnail | null | undefined>(
    (done) => {
      resolve = done;
    },
  );
  const task: QueuedImageLoad = {
    cancelled: false,
    priority,
    sequence: imageLoadSequence++,
    run,
    resolve,
  };
  imageLoadQueue.push(task);
  imageLoadQueue.sort(
    (a, b) => b.priority - a.priority || a.sequence - b.sequence,
  );
  pumpImageLoads();
  return {
    promise,
    cancel: () => {
      task.cancelled = true;
    },
  };
}

function imageCacheKey(
  baseKey: string,
  dimension: Exclude<ContextGraphThumbnailDimension, 0>,
): string {
  return `${baseKey}|${dimension}`;
}

/** Prefer an already decoded sharper image, otherwise retain the best lower
 * preview while an upgrade is in flight. A cached failure is never returned. */
function bestCachedImage(
  baseKey: string,
  desiredDimension: ContextGraphThumbnailDimension,
): CachedImageThumbnail | null {
  if (desiredDimension === 0) return null;
  for (const dimension of [...THUMBNAIL_DIMENSIONS].reverse()) {
    const candidate = cachedImageUrl(imageCacheKey(baseKey, dimension));
    if (candidate) return candidate;
  }
  return null;
}

/** Decode off-DOM before swapping the progressive preview. This avoids a
 * close-zoom frame stalling on a new high-detail bitmap. */
async function decodeThumbnail(
  result: ReadImageThumbnailResult,
): Promise<boolean> {
  if (result.kind !== "image" || !result.dataUrl) return false;
  if (typeof window === "undefined" || typeof window.Image !== "function") {
    return true;
  }
  const candidate = new window.Image();
  candidate.decoding = "async";
  candidate.src = result.dataUrl;
  try {
    await candidate.decode();
    return true;
  } catch {
    return false;
  }
}

/** NativeImage's direct JPEG decoder does not apply EXIF orientation. The IPC
 * response marks only those raw previews; rotating inside the square keeps
 * their honest aspect ratio without another bitmap allocation. */
export function contextGraphImageOrientationTransform(
  orientation?: number,
): string | undefined {
  switch (orientation) {
    case 2:
      return "scaleX(-1)";
    case 3:
      return "rotate(180deg)";
    case 4:
      return "scaleY(-1)";
    case 5:
      return "rotate(90deg) scaleY(-1)";
    case 6:
      return "rotate(90deg)";
    case 7:
      return "rotate(90deg) scaleX(-1)";
    case 8:
      return "rotate(-90deg)";
    default:
      return undefined;
  }
}

// --- COMPONENT ---

export function ContextGraphCanvas({
  cwd,
  items,
  active,
  onToggleShared,
  pendingToggles,
  imageThumbnailLoader = readWorkspaceImageThumbnail,
}: ContextGraphCanvasProps) {
  // --- STATE ---
  // Space bar held → hand-tool affordance (pan still works without it; the
  // key exists because muscle memory from design tools expects it).
  const [spaceHeld, setSpaceHeld] = useState(false);

  // Scroll container element — wheel/pointer listeners + fit math live here.
  const viewportRef = useRef<HTMLDivElement | null>(null);
  // ResizeObserver owns this hot-path size snapshot. Pan frames should never
  // force a layout read merely to re-project around the same center.
  const viewportSizeRef = useRef({ width: 0, height: 0 });
  // Five transformed groups, never one layer per card: pan/zoom does a fixed
  // amount of compositor work even for the 400-card stress case.
  const depthLayerRefs = useRef<Array<HTMLDivElement | null>>([]);
  const reducedMotionRef = useRef(false);
  // Zoom readout element — textContent is written directly per apply().
  const zoomPillRef = useRef<HTMLButtonElement | null>(null);
  // The viewport (canvas → screen): translate + uniform scale. A ref, not
  // state: pan/zoom mutates it at pointer-move rate and paints via rAF —
  // React re-renders would make the canvas feel like a spreadsheet.
  const vp = useRef<ViewportTransform>({ x: 0, y: 0, scale: 1 });
  // Pending rAF handle so a burst of wheel events paints once per frame.
  const rafHandle = useRef<number | null>(null);
  // Chromium keeps a `will-change: transform` layer as one fixed bitmap. That
  // is ideal while a gesture is moving but remains visibly soft afterward.
  // Promote only during navigation and release once input settles so the five
  // layers re-raster at the final scale (constant work, independent of cards).
  const compositorSettleTimerRef = useRef<number | null>(null);
  // The folder whose content was last auto-fit — refit only on real change.
  const fittedForRef = useRef<string | null>(null);
  // Item count represented by the latest automatic overview fit.
  const fittedItemCountRef = useRef(0);
  // Once the user navigates, new graph writes must not steal their viewport.
  const userNavigatedRef = useRef(false);
  // One shared observer handles every image card under this canvas; hundreds
  // of per-card observers are unnecessary work for a large graph.
  const imageObserverRef = useRef<IntersectionObserver | null>(null);
  const imageVisibilityCallbacksRef = useRef(new Map<Element, () => void>());
  // The workspace whose transform has completed its first real fit.
  const viewportReadyForCwdRef = useRef<string | null>(null);
  // Last responsive-image decision, mirrored to avoid a state dispatch per
  // frame. React is notified only when zoom crosses responsive detail buckets.
  const thumbnailPolicyRef = useRef<{
    cwd: string;
    maxDimension: ContextGraphThumbnailDimension;
  }>({ cwd: "", maxDimension: 0 });
  const [thumbnailPolicy, setThumbnailPolicy] = useState({
    cwd: "",
    maxDimension: 0 as ContextGraphThumbnailDimension,
  });
  const lastShareCompensationRef = useRef<number | null>(null);

  const layout = useMemo(() => computeContextGraphLayout(items), [items]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const placedByDepth = useMemo(() => {
    const groups = DEPTH_FACTORS.map(() => [] as PlacedItem[]);
    for (const placed of layout.placed) {
      groups[placed.depthPlane]!.push(placed);
    }
    return groups;
  }, [layout]);
  const depthLayerRefCallbacks = useMemo(
    () =>
      DEPTH_FACTORS.map((_, index) => (element: HTMLDivElement | null) => {
        depthLayerRefs.current[index] = element;
      }),
    [],
  );

  // --- WORKFLOWS ---

  const settleDepthLayerRaster = useCallback(() => {
    if (compositorSettleTimerRef.current != null) {
      window.clearTimeout(compositorSettleTimerRef.current);
      compositorSettleTimerRef.current = null;
    }
    viewportRef.current?.removeAttribute("data-navigating");
  }, []);

  const promoteDepthLayersForNavigation = useCallback(() => {
    // One parent attribute promotes all five planes through a static selector;
    // no per-card or per-plane style writes are added to hot frames.
    const viewport = viewportRef.current;
    if (viewport && !viewport.hasAttribute("data-navigating")) {
      viewport.setAttribute("data-navigating", "");
    }
    if (compositorSettleTimerRef.current != null) {
      window.clearTimeout(compositorSettleTimerRef.current);
    }
    compositorSettleTimerRef.current = window.setTimeout(
      settleDepthLayerRaster,
      COMPOSITOR_SETTLE_MS,
    );
  }, [settleDepthLayerRaster]);

  /** Publish only responsive-detail bucket changes, not every wheel frame. */
  const syncThumbnailPolicy = useCallback(() => {
    if (viewportReadyForCwdRef.current !== cwd) return;
    const maxDimension = contextGraphThumbnailDimension(
      vp.current.scale,
      typeof window === "undefined" ? 1 : window.devicePixelRatio,
    );
    const current = thumbnailPolicyRef.current;
    if (current.cwd === cwd && current.maxDimension === maxDimension) {
      return;
    }
    const next = { cwd, maxDimension };
    thumbnailPolicyRef.current = next;
    setThumbnailPolicy(next);
  }, [cwd]);

  /** Paint vp onto five depth groups (five compositor-only writes per frame,
   *  independent of card count). */
  const apply = useCallback(() => {
    const viewport = viewportRef.current;
    if (viewport) {
      const shareCompensation = contextGraphShareControlCompensation(
        vp.current.scale,
      );
      if (lastShareCompensationRef.current !== shareCompensation) {
        viewport.style.setProperty(
          "--context-share-compensation",
          String(shareCompensation),
        );
        viewport.style.setProperty(
          "--context-share-offset",
          `${8 * (1 - shareCompensation)}px`,
        );
        lastShareCompensationRef.current = shareCompensation;
      }
      let viewportSize = viewportSizeRef.current;
      if (viewportSize.width <= 0 || viewportSize.height <= 0) {
        const rect = viewport.getBoundingClientRect();
        viewportSize = { width: rect.width, height: rect.height };
        viewportSizeRef.current = viewportSize;
      }
      const canvasSize = layoutRef.current;
      const parallaxOffset = computeParallaxCanvasOffset(
        vp.current,
        viewportSize,
        canvasSize,
        reducedMotionRef.current,
      );
      for (let index = 0; index < DEPTH_FACTORS.length; index += 1) {
        const layer = depthLayerRefs.current[index];
        if (!layer) continue;
        const depthFactor = DEPTH_FACTORS[index]!;
        const projectedX =
          vp.current.x + parallaxOffset.x * depthFactor * vp.current.scale;
        const projectedY =
          vp.current.y + parallaxOffset.y * depthFactor * vp.current.scale;
        layer.style.transform = `translate3d(${projectedX}px, ${projectedY}px, 0) scale(${vp.current.scale})`;
      }
    }
    const pill = zoomPillRef.current;
    if (pill) pill.textContent = `${Math.round(vp.current.scale * 100)}%`;
    syncThumbnailPolicy();
  }, [syncThumbnailPolicy]);

  const scheduleApply = useCallback(() => {
    promoteDepthLayersForNavigation();
    if (rafHandle.current != null) return;
    rafHandle.current = requestAnimationFrame(() => {
      rafHandle.current = null;
      apply();
    });
  }, [apply, promoteDepthLayersForNavigation]);

  /** Center the whole graph in the viewport at a comfortable zoom. */
  const fitToView = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) return;
    viewportSizeRef.current = { width: rect.width, height: rect.height };
    vp.current = fitContextGraphViewport(layoutRef.current, {
      width: rect.width,
      height: rect.height,
    });
    viewportReadyForCwdRef.current = cwd;
    userNavigatedRef.current = false;
    apply();
  }, [apply, cwd]);

  // Respect the OS preference without removing navigation. Collapsing the
  // depth offsets removes differential drift while leaving the base
  // canvas transform intact. Listener exists only for the active surface.
  useEffect(() => {
    if (!active || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      reducedMotionRef.current = query.matches;
      apply();
    };
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [active, apply]);

  // Projection is relative to the viewport center, so a panel resize must
  // update the five matrices even when the user's base transform is retained.
  useEffect(() => {
    if (
      !active ||
      !viewportRef.current ||
      typeof ResizeObserver === "undefined"
    ) {
      return;
    }
    const observer = new ResizeObserver(([entry]) => {
      if (entry) {
        viewportSizeRef.current = {
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        };
      }
      if (userNavigatedRef.current) scheduleApply();
      else fitToView();
    });
    observer.observe(viewportRef.current);
    return () => observer.disconnect();
  }, [active, fitToView, scheduleApply]);

  /** Register one image with the canvas's shared visibility observer. */
  const observeImage = useCallback<ObserveImage>((element, onVisible) => {
    const root = viewportRef.current;
    if (!root || typeof IntersectionObserver === "undefined") {
      onVisible();
      return () => {};
    }
    if (!imageObserverRef.current) {
      imageObserverRef.current = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const callback = imageVisibilityCallbacksRef.current.get(
              entry.target,
            );
            if (!callback) continue;
            imageVisibilityCallbacksRef.current.delete(entry.target);
            imageObserverRef.current?.unobserve(entry.target);
            callback();
          }
        },
        { root, rootMargin: "192px" },
      );
    }
    imageVisibilityCallbacksRef.current.set(element, onVisible);
    imageObserverRef.current.observe(element);
    return () => {
      imageVisibilityCallbacksRef.current.delete(element);
      imageObserverRef.current?.unobserve(element);
    };
  }, []);

  // --- EVENT HANDLERS ---

  /** Drag anywhere (cards aren't movable) = pan. Interactive card controls
   *  opt out via data-context-card-control. */
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0 && e.button !== 1) return;
      const hit = e.target as HTMLElement;
      if (hit.closest("[data-context-card-control]")) return;
      e.preventDefault();
      userNavigatedRef.current = true;
      const target = e.currentTarget as HTMLElement;
      target.setPointerCapture(e.pointerId);
      target.dataset.panning = "true";
      const startX = e.clientX;
      const startY = e.clientY;
      const startVX = vp.current.x;
      const startVY = vp.current.y;
      const onMove = (ev: PointerEvent) => {
        vp.current.x = startVX + (ev.clientX - startX);
        vp.current.y = startVY + (ev.clientY - startY);
        scheduleApply();
      };
      const onUp = () => {
        delete target.dataset.panning;
        try {
          target.releasePointerCapture(e.pointerId);
        } catch {
          /* already released */
        }
        target.removeEventListener("pointermove", onMove);
        target.removeEventListener("pointerup", onUp);
        target.removeEventListener("pointercancel", onUp);
      };
      target.addEventListener("pointermove", onMove);
      target.addEventListener("pointerup", onUp);
      target.addEventListener("pointercancel", onUp);
    },
    [scheduleApply],
  );

  // Wheel: pinch (ctrlKey) and ⌘/Ctrl+scroll zoom to the cursor — the
  // "everything flows out from under your fingers" feel — while a plain
  // two-finger scroll pans. passive:false is required for preventDefault.
  useEffect(() => {
    if (!active) return;
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      userNavigatedRef.current = true;
      const v = vp.current;
      if (e.ctrlKey || e.metaKey) {
        const rect = el.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        vp.current = zoomViewportAtPoint(v, cx, cy, e.deltaY);
      } else {
        v.x -= e.deltaX;
        v.y -= e.deltaY;
      }
      scheduleApply();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [active, scheduleApply]);

  // Space-key tracking — active tab only, never while typing, and ONLY while
  // the pointer is over the canvas. Unlike the Browser tab's transient canvas
  // mode, this surface is ALWAYS a canvas, so an unconditional preventDefault
  // would permanently swallow Space-activation of focused buttons and
  // Space-to-scroll everywhere else in the window (review 2026-08-02 #1).
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && t.matches("input, textarea, [contenteditable]")) return;
      if (!viewportRef.current?.matches(":hover")) return;
      if (e.code === "Space" && !e.repeat) {
        e.preventDefault();
        setSpaceHeld(true);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpaceHeld(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      setSpaceHeld(false);
    };
  }, [active]);

  // First fit frames everything. While the user remains in overview mode, a
  // newly attached file expands that fit so it appears immediately; after any
  // user pan/zoom, refreshes preserve their exact viewpoint.
  useEffect(() => {
    if (!active || items.length === 0) return;
    const folderChanged = fittedForRef.current !== cwd;
    const overviewChanged =
      !userNavigatedRef.current && fittedItemCountRef.current !== items.length;
    if (!folderChanged && !overviewChanged) return;
    if (folderChanged) userNavigatedRef.current = false;
    fittedForRef.current = cwd;
    fittedItemCountRef.current = items.length;
    const frame = requestAnimationFrame(fitToView);
    return () => cancelAnimationFrame(frame);
  }, [active, cwd, items.length, fitToView]);

  // Hidden retained canvases are inert: release their observer immediately;
  // card effects also cancel any queued (not-yet-started) thumbnail decodes.
  useEffect(() => {
    if (active) return;
    settleDepthLayerRaster();
    imageObserverRef.current?.disconnect();
    imageObserverRef.current = null;
    imageVisibilityCallbacksRef.current.clear();
  }, [active, settleDepthLayerRaster]);

  // Re-assert the transforms + zoom readout after EVERY commit: React owns the
  // pill's text child, while newly mounted depth groups need the current
  // matrices without resetting the user's viewport.
  useEffect(() => {
    if (!active) return;
    apply();
  });

  // Cancel any queued paint on unmount.
  useEffect(
    () => () => {
      if (rafHandle.current != null) cancelAnimationFrame(rafHandle.current);
      if (compositorSettleTimerRef.current != null) {
        window.clearTimeout(compositorSettleTimerRef.current);
      }
      imageObserverRef.current?.disconnect();
      imageVisibilityCallbacksRef.current.clear();
    },
    [],
  );

  // --- RENDER ---
  const thumbnailDimension =
    active && thumbnailPolicy.cwd === cwd ? thumbnailPolicy.maxDimension : 0;
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <div
        ref={viewportRef}
        onPointerDown={onPointerDown}
        data-space-held={spaceHeld || undefined}
        className="group/context-canvas bg-bg1 relative min-h-0 min-w-0 flex-1 touch-none overflow-hidden select-none data-[panning]:cursor-grabbing data-[space-held]:cursor-grab"
        style={
          {
            "--context-share-compensation": 1,
            "--context-share-offset": "0px",
          } as React.CSSProperties
        }
        role="application"
        aria-label="Context canvas"
      >
        {DEPTH_FACTORS.map((depthFactor, depthPlane) => (
          <div
            key={depthFactor}
            ref={depthLayerRefCallbacks[depthPlane]}
            data-context-parallax-layer=""
            data-context-depth-plane={depthPlane}
            className="pointer-events-none absolute top-0 left-0 origin-top-left group-data-[navigating]/context-canvas:will-change-transform"
            // Runtime-computed canvas extent; transform is written directly.
            style={{ width: layout.width, height: layout.height }}
          >
            {placedByDepth[depthPlane]!.map((placed) => {
              const { item, itemKey, x, y } = placed;
              return (
                <ContextGraphCard
                  key={contextGraphCardRenderKey(placed)}
                  cwd={cwd}
                  item={item}
                  itemKey={itemKey}
                  x={x}
                  y={y}
                  thumbnailDimension={thumbnailDimension}
                  observeImage={observeImage}
                  imageThumbnailLoader={imageThumbnailLoader}
                  onToggleShared={onToggleShared}
                  togglePending={
                    !!item.attachmentId && pendingToggles.has(item.attachmentId)
                  }
                />
              );
            })}
          </div>
        ))}
        <Button
          ref={zoomPillRef}
          type="button"
          size="sm"
          variant="secondary"
          data-context-card-control=""
          onClick={fitToView}
          className="absolute right-3 bottom-3"
          aria-label="Zoom level — click to fit the canvas"
        >
          100%
        </Button>
      </div>
    </div>
  );
}

// ── Cards ──────────────────────────────────────────────────

interface CardProps {
  cwd: string;
  item: ContextGraphItemWire;
  /** Stable render/cache key, scope-qualified only for duplicate identities. */
  itemKey: string;
  x: number;
  y: number;
  thumbnailDimension: ContextGraphThumbnailDimension;
  observeImage: ObserveImage;
  imageThumbnailLoader: typeof readWorkspaceImageThumbnail;
  onToggleShared: (attachmentId: string, shared: boolean) => Promise<void>;
  togglePending: boolean;
}

const ContextGraphCard = React.memo(function ContextGraphCard({
  cwd,
  item,
  itemKey,
  x,
  y,
  thumbnailDimension,
  observeImage,
  imageThumbnailLoader,
  onToggleShared,
  togglePending,
}: CardProps) {
  const isImage = item.kind === "image";
  const shareControl = item.attachmentId ? (
    <div
      data-context-card-control=""
      data-context-share-control=""
      data-shared={item.scope === "shared" || undefined}
      className={[
        "absolute [bottom:calc(100%+var(--context-share-offset))] -left-2 z-[2] flex h-9 origin-bottom-left [transform:scale(var(--context-share-compensation))] items-start transition-opacity",
        item.scope === "shared"
          ? "opacity-100"
          : "pointer-events-none opacity-0 group-focus-within/context-card:pointer-events-auto group-focus-within/context-card:opacity-100 group-hover/context-card:pointer-events-auto group-hover/context-card:opacity-100",
        togglePending ? "opacity-55" : "",
      ].join(" ")}
    >
      <label
        data-context-share-label=""
        className={[
          "text-fg2 bg-bg2 border-border2 text-2xxs flex h-7 items-center gap-2 rounded-sm border px-2.5",
          togglePending ? "cursor-default" : "cursor-pointer",
        ].join(" ")}
      >
        <span data-context-share-checkbox="" className="flex shrink-0">
          <Checkbox
            className="size-4"
            checked={item.scope === "shared"}
            disabled={togglePending}
            onChange={() =>
              void onToggleShared(item.attachmentId!, item.scope !== "shared")
            }
            aria-label={`Share ${item.name} in the repo`}
          />
        </span>
        Shared
      </label>
    </div>
  ) : null;

  return (
    <div
      data-context-card-kind={isImage ? "image" : "document"}
      data-context-card-scope={item.scope}
      className="group/context-card pointer-events-auto absolute size-[224px]"
      // Runtime-computed slot from the auto-layout. FLAG: 224px is the canvas's
      // fixed square card geometry; every file owns this footprint regardless
      // of content or image aspect ratio.
      style={{ left: x, top: y }}
    >
      <div
        aria-hidden="true"
        data-context-card-halo=""
        className="bg-bg2-hover pointer-events-none absolute -inset-2 rounded-lg opacity-0 transition-opacity group-focus-within/context-card:opacity-100 group-hover/context-card:opacity-100"
      />
      {shareControl}
      {isImage ? (
        <ImageCardMedia
          key={`${cwd}|${itemKey}|${contextGraphItemContentRevision(item)}`}
          cwd={cwd}
          item={item}
          itemKey={itemKey}
          thumbnailDimension={thumbnailDimension}
          observeImage={observeImage}
          imageThumbnailLoader={imageThumbnailLoader}
        />
      ) : (
        <DocumentCardBody item={item} />
      )}
    </div>
  );
});

/** Every non-image uses the same square document card. Text/markdown take the
 *  note glyph from the reference; code/data formats reuse the exact colored
 *  resolver already used by the Files tab, including its generic fallback. */
function DocumentCardBody({ item }: { item: ContextGraphItemWire }) {
  const noteLike = item.kind === "markdown" || item.kind === "text";
  return (
    <div className="bg-bg2 border-border1 group-hover/context-card:border-border3 relative z-[1] flex size-full min-h-0 flex-col overflow-hidden rounded-lg border p-4 transition-colors">
      <div className="flex min-w-0 shrink-0 items-center gap-2">
        {noteLike ? (
          <StickyNote className="text-fg2 size-5 shrink-0" strokeWidth={1.7} />
        ) : (
          <FileTypeIcon name={item.name} size={20} />
        )}
        <div
          data-context-card-title=""
          className="text-fg2 group-hover/context-card:text-fg1 min-w-0 truncate text-xs font-medium transition-colors"
          title={item.name}
        >
          {item.name}
        </div>
      </div>
      {item.previewText ? (
        <div className="mt-4 min-h-0 flex-1 overflow-hidden">
          <pre className="text-fg2 text-2xxs font-mono leading-relaxed break-words whitespace-pre-wrap">
            {item.previewText}
          </pre>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          {noteLike ? (
            <StickyNote className="text-muted-fg size-10" strokeWidth={1.4} />
          ) : (
            <FileTypeIcon name={item.name} size={44} className="opacity-55" />
          )}
        </div>
      )}
    </div>
  );
}

/** Image media has no filename/footer: the image keeps its natural aspect
 *  ratio inside the same square footprint as every document. A shared
 *  observer starts a bounded native-thumbnail decode only near the viewport. */
function ImageCardMedia({
  cwd,
  item,
  itemKey,
  thumbnailDimension,
  observeImage,
  imageThumbnailLoader,
}: Omit<CardProps, "x" | "y" | "onToggleShared" | "togglePending">) {
  const baseCacheKey = `${IMAGE_THUMBNAIL_CACHE_VERSION}|${cwd}|${itemKey}|${contextGraphItemContentRevision(item)}`;
  const imageLoadPriority = contextGraphImageLoadPriority(item);
  // Keep the last confirmed preview visible while a sharper bucket loads.
  const [thumbnail, setThumbnail] = useState<CachedImageThumbnail | null>(() =>
    bestCachedImage(baseCacheKey, thumbnailDimension),
  );
  // The media element the observer watches.
  const mediaRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (
      thumbnailDimension === 0 ||
      (thumbnail?.requestedDimension ?? 0) >= thumbnailDimension
    ) {
      return;
    }
    const exactCacheKey = imageCacheKey(baseCacheKey, thumbnailDimension);
    const cached = cachedImageUrl(exactCacheKey);
    if (cached !== undefined) {
      if (cached) setThumbnail(cached);
      return;
    }
    const el = mediaRef.current;
    if (!el) return;
    let cancelled = false;
    let scheduled: ReturnType<typeof scheduleImageLoad> | null = null;
    const stopObserving = observeImage(el, () => {
      scheduled = scheduleImageLoad(
        imageLoadPriority,
        async () => {
          const res = await imageThumbnailLoader(
            cwd,
            item.relPath,
            thumbnailDimension,
          );
          if (!res) return undefined;
          if (res.kind !== "image") {
            return contextGraphThumbnailFailureIsPermanent(res)
              ? null
              : undefined;
          }
          if (!(await decodeThumbnail(res)) || !res.dataUrl) return undefined;
          return {
            dataUrl: res.dataUrl,
            requestedDimension: res.fullResolution
              ? THUMBNAIL_DIMENSIONS.at(-1)!
              : thumbnailDimension,
            width: res.width,
            height: res.height,
            sourceWidth: res.sourceWidth,
            sourceHeight: res.sourceHeight,
            orientation: res.orientation,
          };
        },
      );
      void scheduled.promise.then((next) => {
        // `undefined` is cancellation/transport failure: leave the key
        // retryable when this tab becomes active again.
        if (cancelled || next === undefined) return;
        cacheImageUrl(exactCacheKey, next);
        if (next) setThumbnail(next);
      });
    });
    return () => {
      cancelled = true;
      stopObserving();
      scheduled?.cancel();
    };
  }, [
    thumbnailDimension,
    thumbnail,
    baseCacheKey,
    imageLoadPriority,
    cwd,
    item.relPath,
    observeImage,
    imageThumbnailLoader,
  ]);

  return (
    <div
      ref={mediaRef}
      className="relative z-[1] flex size-full items-center justify-center"
      role="img"
      aria-label={item.name}
    >
      {thumbnail ? (
        <img
          src={thumbnail.dataUrl}
          alt=""
          width={thumbnail.width}
          height={thumbnail.height}
          data-context-thumbnail-dimension={thumbnail.requestedDimension}
          style={{
            transform: contextGraphImageOrientationTransform(
              thumbnail.orientation,
            ),
          }}
          decoding="async"
          draggable={false}
          className="border-border1 group-hover/context-card:border-border4 h-auto max-h-full w-auto max-w-full rounded-lg border object-contain transition-colors"
        />
      ) : (
        <div className="bg-bg2 border-border1 flex size-full items-center justify-center rounded-lg border">
          <ImageIcon className="text-muted-fg size-8" />
        </div>
      )}
    </div>
  );
}

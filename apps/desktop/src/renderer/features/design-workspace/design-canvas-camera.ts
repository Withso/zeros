import type { CSSProperties } from "react";
import type { DesignViewport, DesignViewportSize } from "./design-canvas-math";
import { DesignCanvasPointer } from "./design-canvas-pointer";
export const DESIGN_CANVAS_INVERSE_ZOOM = "var(--design-canvas-inverse-zoom)";

const viewportSizes = new WeakMap<HTMLDivElement, DesignViewportSize>();
const paintedViews = new WeakMap<HTMLDivElement, DesignViewport>();
type CameraPainter = (view: DesignViewport, size: DesignViewportSize) => void;
const cameraPainters = new WeakMap<HTMLDivElement, Set<CameraPainter>>();
const paintingWorlds = new WeakSet<HTMLDivElement>();
const canvasPointers = new WeakMap<HTMLDivElement, DesignCanvasPointer>();
const pendingChromePaints = new WeakMap<HTMLDivElement, number>();
const frameGeometry = new WeakMap<HTMLElement, { style: string | null; bounds: DesignCanvasFrameBounds | null }>();
export interface DesignCanvasFrameBounds { x: number; y: number; width: number; height: number; z: number }

/** Inline geometry is the direct-manipulation authority. Share its parsed
 * snapshot between visibility and pixels, including same-task resize writes.
 * Camera-only paints need one attribute read, no layout or repeated parsing. */
export function readDesignCanvasFrameBounds(element: HTMLElement): DesignCanvasFrameBounds | null {
  const style = element.getAttribute("style"), cached = frameGeometry.get(element);
  if (cached && cached.style === style) return cached.bounds;
  const x = Number.parseFloat(element.style.left), y = Number.parseFloat(element.style.top);
  const width = Number.parseFloat(element.style.width), height = Number.parseFloat(element.style.height);
  const bounds = [x, y, width, height].every(Number.isFinite)
    ? { x, y, width, height, z: Number(element.style.zIndex) || 0 } : null;
  frameGeometry.set(element, { style, bounds });
  return bounds;
}

/** Pixel backends share the exact imperative camera and geometry transaction.
 * A subscription owns no timer or layout observer, and a hidden canvas removes
 * its painters along with its source display leases. */
export function observeDesignCanvasPaint(world: HTMLDivElement, paint: CameraPainter): () => void {
  let painters = cameraPainters.get(world);
  if (!painters) { painters = new Set(); cameraPainters.set(world, painters); }
  painters.add(paint);
  repaintDesignCanvasPixels(world);
  return () => { painters.delete(paint); if (!painters.size) cameraPainters.delete(world); };
}

export function repaintDesignCanvasPixels(world: HTMLDivElement): void {
  const view = paintedViews.get(world), size = viewportSizes.get(world);
  if (view && size) for (const paint of cameraPainters.get(world) ?? []) paint(view, size);
}

// Labels, handles and badges can extend past an artboard. Keep that nearby
// chrome current as well as the pixels, without retaining a browser observer.
const CHROME_OVERSCAN_PIXELS = 96;

function paintChromeScale(element: HTMLElement, zoom: number): void {
  for (const [name, value] of [["--design-canvas-zoom", zoom], ["--design-canvas-inverse-zoom", 1 / zoom]] as const) {
    const next = String(value);
    if (element.style.getPropertyValue(name) !== next) element.style.setProperty(name, next);
  }
}

export function paintDesignFrameVisibility(element: HTMLElement): void {
  const world = element.parentElement;
  if (!(world instanceof HTMLDivElement)) return;
  const viewport = paintedViews.get(world);
  if (!viewport) return;
  if (!element.hasAttribute("data-design-frame")) {
    paintChromeScale(element, viewport.zoom);
    return;
  }
  const size = viewportSizes.get(world);
  const focused = world.ownerDocument.activeElement;
  const bounds = readDesignCanvasFrameBounds(element);
  let outside = false, sourceOutside = false;
  if (size && size.width > 0 && size.height > 0) {
    // Inline geometry is also the authoritative in-progress resize/move.
    // offset*/getBoundingClientRect would flush the preceding wheel paint.
    if (bounds && bounds.width >= 0 && bounds.height >= 0) {
      const left = bounds.x * viewport.zoom + viewport.panX, top = bounds.y * viewport.zoom + viewport.panY;
      const width = bounds.width * viewport.zoom, height = bounds.height * viewport.zoom;
      sourceOutside = left + width < 0 || top + height < 0 || left > size.width || top > size.height;
      if (!element.hasAttribute("data-design-frame-chrome-protected") &&
          !element.hasAttribute("data-design-nest-target") && !element.contains(focused))
        outside = left + width < -CHROME_OVERSCAN_PIXELS || top + height < -CHROME_OVERSCAN_PIXELS ||
          left > size.width + CHROME_OVERSCAN_PIXELS || top > size.height + CHROME_OVERSCAN_PIXELS;
    }
  }
  // React owns selection/editing policy, while this transaction owns the
  // screen size. Reading transient zoom in a React render can leave every
  // overview control expanded until the next render after a zoom-out.
  // Distant automatic controls stay compact until the same paint admits
  // their nearby chrome. Expanding all retained roots at a zoom threshold
  // makes layout/paint cost depend on document size instead of the viewport.
  const controls = element.getAttribute("data-design-frame-controls");
  if (controls) element.toggleAttribute("data-design-frame-compact-controls",
    controls === "automatic" && !!bounds && (outside || bounds.width * viewport.zoom < 128));
  element.toggleAttribute("data-design-frame-chrome-outside", outside);
  // Ready source paint follows the camera in this write, including a return
  // before React runs. Cold documents still lay out and caches stay mounted.
  element.toggleAttribute("data-design-frame-source-outside", sourceOutside);
  const compact = element.hasAttribute("data-design-frame-tiled") &&
    element.hasAttribute("data-design-frame-compact-controls") && !element.hasAttribute("data-design-frame-chrome-protected") &&
    !element.hasAttribute("data-design-nest-target") && !element.hasAttribute("data-design-frame-pointer") &&
    !element.matches(":hover") && !element.contains(focused);
  paintChromeScale(element, outside || compact ? 1 : viewport.zoom);
  if (!paintingWorlds.has(world)) repaintDesignCanvasPixels(world);
}

function paintCanvasChrome(world: HTMLDivElement): void {
  const pending = pendingChromePaints.get(world);
  if (pending !== undefined) { window.cancelAnimationFrame(pending); pendingChromePaints.delete(world); }
  paintingWorlds.add(world);
  try {
    canvasPointers.get(world)?.update(paintedViews.get(world));
    for (const element of world.children) {
      if (element instanceof HTMLElement) paintDesignFrameVisibility(element);
    }
  } finally { paintingWorlds.delete(world); }
}

/** The camera is not an inherited document-wide style invalidation. Only
 * current chrome receives its scale. Intent and newly inserted overlays adopt
 * the painted camera before their first visible frame, without a React wait. */
export function observeDesignCanvasChrome(world: HTMLDivElement): () => void {
  const refresh = () => { paintCanvasChrome(world); repaintDesignCanvasPixels(world); };
  const schedule = () => {
    if (pendingChromePaints.has(world)) return;
    pendingChromePaints.set(world, window.requestAnimationFrame(() => {
      pendingChromePaints.delete(world); refresh();
    }));
  };
  const viewport = world.closest<HTMLElement>("[data-design-canvas-viewport]");
  const pointer = viewport ? new DesignCanvasPointer(world, viewport, () => paintedViews.get(world), readDesignCanvasFrameBounds,
    immediate => immediate ? refresh() : schedule()) : null;
  if (pointer) {
    canvasPointers.set(world, pointer);
    const size = viewportSizes.get(world);
    if (size) pointer.resize(size);
  }
  const observer = new MutationObserver(records => {
    if (records.some(record => record.type === "childList" ? record.target === world :
      record.target instanceof HTMLElement && record.target.parentElement === world)) refresh();
  });
  observer.observe(world, { subtree: true, childList: true, attributes: true,
    attributeFilter: ["class", "data-design-frame-tiled", "data-design-frame-controls", "data-design-frame-compact-controls",
      "data-design-frame-chrome-protected", "data-design-nest-target"] });
  // Hover transitions can follow a wheel paint in the same display interval.
  // Batch hover-only work; the next camera write adopts it before composing.
  // Focus/actions remain synchronous for keyboard and edits.
  for (const event of ["pointerover", "pointerout"]) world.addEventListener(event, schedule);
  for (const event of ["focusin", "focusout"]) world.addEventListener(event, refresh);
  refresh();
  return () => {
    observer.disconnect();
    pointer?.dispose(); canvasPointers.delete(world);
    const pending = pendingChromePaints.get(world);
    if (pending !== undefined) { window.cancelAnimationFrame(pending); pendingChromePaints.delete(world); }
    for (const event of ["pointerover", "pointerout"]) world.removeEventListener(event, schedule);
    for (const event of ["focusin", "focusout"]) world.removeEventListener(event, refresh);
  };
}

type DesignCanvasWorldStyle = CSSProperties & {
  "--design-canvas-zoom": number;
  "--design-canvas-inverse-zoom": number;
};

/** Canvas chrome is authored in world coordinates but keeps a stable physical
 * size through the scale published to its own frame or overlay root. */
export function designCanvasScreenPixels(pixels: number): string {
  return `calc(${pixels}px * ${DESIGN_CANVAS_INVERSE_ZOOM})`;
}

export function designCanvasCameraStyle(
  viewport: DesignViewport,
): DesignCanvasWorldStyle {
  return {
    transform: `translate(${viewport.panX}px, ${viewport.panY}px) scale(${viewport.zoom})`,
    "--design-canvas-zoom": 1,
    "--design-canvas-inverse-zoom": 1,
  };
}

export function paintDesignCanvasCamera(
  world: HTMLDivElement | null,
  viewport: DesignViewport,
  gestureActive: boolean,
  size?: DesignViewportSize,
): void {
  if (!world) return;
  if (size) { viewportSizes.set(world, size); canvasPointers.get(world)?.resize(size); }
  paintedViews.set(world, viewport);
  paintCanvasChrome(world);
  const style = designCanvasCameraStyle(viewport);
  world.style.transform = String(style.transform);
  world.toggleAttribute("data-design-camera-gesture", gestureActive);
  repaintDesignCanvasPixels(world);
}

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
/** Screen widths below which a frame's name, and its 16px Play control, no
 * longer fit above it. */
const FRAME_NAME_MIN_PIXELS = 24;
const FRAME_PLAY_MIN_PIXELS = 64;
/** Up to this many mounted frames, a small frame keeps its name. A crowded
 * overview hides names and controls together below this width: each visible
 * name is a transformed layer and a DOM hit box per frame, which a
 * 1,000-frame page cannot afford. */
const FRAME_NAME_BUDGET = 64;
const CROWDED_FRAME_NAME_MIN_PIXELS = 128;

/** The scale this module last wrote and the inline style text it left. An
 * unchanged attribute proves no other writer replaced those values, so a camera
 * paint of an unchanged frame performs no declaration reads or writes. */
const writtenScales = new WeakMap<HTMLElement, { zoom: number; style: string | null }>();

/** Inside a live camera gesture, chrome keeps its written scale until the
 * zoom moves this far from it. Rewriting every visible frame's scale on each
 * step restyled each frame subtree per display frame; rest writes it exactly. */
const CHROME_SCALE_GESTURE_HOLD = 0.15;

/** A frame's name and Play roots. At rest they take the exact camera scale.
 * Writing that scale restyles and re-lays out the name, so on every gesture
 * step across all visible names it missed the display deadline. Hiding the
 * names instead made every label blink out while zooming. Through a gesture
 * an automatic name keeps its laid-out scale and a `scale` property, a
 * compositor-only change, corrects it to the exact screen size; it re-lays
 * out only past the same hold the frame scale uses. */
const chromeRoots = new WeakMap<HTMLElement, { count: number; roots: HTMLElement[]; zoom?: number | null; scale?: number }>();

/** Null leaves a root to inherit its frame's scale, as hidden chrome must. */
function paintFrameChromeRoots(frame: HTMLElement, zoom: number | null, gesture = false): void {
  let entry = chromeRoots.get(frame);
  if (!entry || entry.count !== frame.childElementCount || !entry.roots.every(root => root.parentElement === frame)) {
    entry = { count: frame.childElementCount, roots: [...frame.children].filter((child): child is HTMLElement =>
      child instanceof HTMLElement && child.hasAttribute("data-design-frame-chrome")) };
    chromeRoots.set(frame, entry);
  }
  const laidOut = entry.zoom;
  const held = gesture && zoom !== null && typeof laidOut === "number" &&
    Math.abs(zoom / laidOut - 1) < CHROME_SCALE_GESTURE_HOLD;
  const scale = held ? laidOut / zoom : 1;
  if (entry.scale !== scale) {
    entry.scale = scale;
    for (const root of entry.roots) {
      // A held frame has no selection, playback or focus, so its Play is clipped.
      if (root.hasAttribute("data-design-frame-play-chrome")) continue;
      if (scale === 1) root.style.removeProperty("scale");
      else root.style.setProperty("scale", String(scale));
    }
  }
  // Most frames keep their chrome scale across a step: off-screen and
  // compact ones stay null. Skip them without reading any declaration.
  if (held || entry.zoom === zoom) return;
  entry.zoom = zoom;
  for (const root of entry.roots) {
    for (const [name, value] of [["--design-canvas-zoom", zoom], ["--design-canvas-inverse-zoom", zoom === null ? null : 1 / zoom]] as const) {
      if (value === null) root.style.removeProperty(name);
      else root.style.setProperty(name, String(value));
    }
  }
}
function paintChromeScale(element: HTMLElement, zoom: number, gesture = false): void {
  const style = element.getAttribute("style"), written = writtenScales.get(element);
  if (written && written.zoom === zoom && written.style === style) return;
  if (gesture && written && written.style === style && written.zoom !== 1 && zoom !== 1 &&
    Math.abs(zoom / written.zoom - 1) < CHROME_SCALE_GESTURE_HOLD) return;
  for (const [name, value] of [["--design-canvas-zoom", zoom], ["--design-canvas-inverse-zoom", 1 / zoom]] as const) {
    const next = String(value);
    if (element.style.getPropertyValue(name) !== next) element.style.setProperty(name, next);
  }
  const after = element.getAttribute("style");
  writtenScales.set(element, { zoom, style: after });
  // Camera scale is not geometry. Keep the parsed bounds for the new text so
  // the next paint does not reparse four CSSOM lengths per frame.
  const geometry = frameGeometry.get(element);
  if (geometry && geometry.style === style && after !== style) frameGeometry.set(element, { style: after, bounds: geometry.bounds });
}

/** Chrome owned by one camera paint: the focused and hovered frames resolve
 * once for the whole world instead of per frame. */
interface ChromePaintContext { focusedFrame: Element | null; hoveredFrame: Element | null; gesture?: boolean; childCount?: number }
const hoveredFrames = new WeakMap<HTMLDivElement, HTMLElement | null>();

function frameOf(world: HTMLDivElement, node: EventTarget | null): HTMLElement | null {
  const frame = node instanceof Element ? node.closest<HTMLElement>("[data-design-frame]") : null;
  return frame?.parentElement === world ? frame : null;
}

function chromePaintContext(world: HTMLDivElement): ChromePaintContext {
  const focused = world.ownerDocument.activeElement;
  const tracked = hoveredFrames.get(world) ?? null;
  return { focusedFrame: frameOf(world, focused),
    hoveredFrame: tracked?.parentElement === world && tracked.matches(":hover") ? tracked : null };
}

/** Whether chrome observation (and with it hover tracking) owns this world. */
export function canvasChromeObserved(world: HTMLDivElement): boolean {
  return hoveredFrames.has(world);
}

/** The frame under pointer intent, else the frame whose chrome is hovered. */
export function designCanvasPointerFrame(world: HTMLDivElement): HTMLElement | null {
  return canvasPointers.get(world)?.intentFrame ?? chromePaintContext(world).hoveredFrame as HTMLElement | null;
}

type PaintedFrameVisibility = {
  zoom: number; width: number; height: number;
  style: string | null; bounds: DesignCanvasFrameBounds | null; controls: string | null; childCount: number; frameChildCount: number;
  pointer: boolean; tiled: boolean; chromeProtected: boolean; nestTarget: boolean;
  focused: boolean; hovered: boolean; gesture: boolean;
  compactControls: boolean | undefined; compactPlay: boolean | undefined; outside: boolean; sourceOutside: boolean;
  scaleZoom: number; rootsZoom: number | null; rootsGesture: boolean;
};
const paintedFrameVisibility = new WeakMap<HTMLElement, PaintedFrameVisibility>();
function paintedPanVisibilityUnchanged(painted: PaintedFrameVisibility, bounds: DesignCanvasFrameBounds,
  viewport: DesignViewport, width: number, height: number, pointer: boolean, focused: boolean,
  hovered: boolean, gesture: boolean, chromeProtected: boolean, nestTarget: boolean): boolean {
  if (painted.zoom !== viewport.zoom || painted.width !== width || painted.height !== height ||
    painted.pointer !== pointer || painted.focused !== focused || painted.hovered !== hovered ||
    painted.gesture !== gesture) return false;
  const left = bounds.x * viewport.zoom + viewport.panX, top = bounds.y * viewport.zoom + viewport.panY;
  const scaledWidth = bounds.width * viewport.zoom, scaledHeight = bounds.height * viewport.zoom;
  const sourceOutside = left + scaledWidth < 0 || top + scaledHeight < 0 || left > width || top > height;
  const outside = chromeProtected || nestTarget || focused ? false :
    left + scaledWidth < -CHROME_OVERSCAN_PIXELS || top + scaledHeight < -CHROME_OVERSCAN_PIXELS ||
    left > width + CHROME_OVERSCAN_PIXELS || top > height + CHROME_OVERSCAN_PIXELS;
  return painted.outside === outside && painted.sourceOutside === sourceOutside;
}

export function paintDesignFrameVisibility(element: HTMLElement, context?: ChromePaintContext): void {
  const world = element.parentElement;
  if (!(world instanceof HTMLDivElement)) return;
  const viewport = paintedViews.get(world);
  if (!viewport) return;
  if (!element.hasAttribute("data-design-frame")) {
    paintChromeScale(element, viewport.zoom);
    return;
  }
  const size = viewportSizes.get(world);
  const focusedFrame = context ? context.focusedFrame : frameOf(world, world.ownerDocument.activeElement);
  const worldChildCount = context?.childCount ?? world.childElementCount;
  const style = element.getAttribute("style");
  const painted = paintedFrameVisibility.get(element);
  const frameChildCount = element.childElementCount;
  const structureDirty = painted?.frameChildCount !== frameChildCount;
  const styleDirty = !painted || painted.style !== style;
  const staticInputs = painted && painted.style === style &&
    painted.childCount === worldChildCount && painted.frameChildCount === frameChildCount;
  const bounds = staticInputs ? painted.bounds : readDesignCanvasFrameBounds(element);
  const controls = element.getAttribute("data-design-frame-controls");
  const pointer = element.hasAttribute("data-design-frame-pointer");
  const tiled = element.hasAttribute("data-design-frame-tiled");
  const chromeProtected = element.hasAttribute("data-design-frame-chrome-protected");
  const nestTarget = element.hasAttribute("data-design-nest-target");
  const focused = focusedFrame === element;
  const hovered = context ? context.hoveredFrame === element : element.matches(":hover");
  const gestureInput = !chromeProtected && !!(context ? context.gesture : world.hasAttribute("data-design-camera-gesture"));
  if (staticInputs && painted && painted.controls === controls && painted.tiled === tiled &&
    painted.chromeProtected === chromeProtected && painted.nestTarget === nestTarget &&
    bounds && bounds.width >= 0 && bounds.height >= 0 && size &&
    paintedPanVisibilityUnchanged(painted, bounds, viewport, size.width, size.height,
      pointer, focused, hovered, gestureInput, chromeProtected, nestTarget)) {
    // Child replacement is not synchronously observable; let the root cache
    // validate parentage without rewriting unchanged chrome.
    paintFrameChromeRoots(element, painted.rootsZoom, painted.rootsGesture);
    return;
  }
  let outside = false, sourceOutside = false;
  if (size && size.width > 0 && size.height > 0) {
    // Inline geometry is also the authoritative in-progress resize/move.
    // offset*/getBoundingClientRect would flush the preceding wheel paint.
    if (bounds && bounds.width >= 0 && bounds.height >= 0) {
      const left = bounds.x * viewport.zoom + viewport.panX, top = bounds.y * viewport.zoom + viewport.panY;
      const width = bounds.width * viewport.zoom, height = bounds.height * viewport.zoom;
      sourceOutside = left + width < 0 || top + height < 0 || left > size.width || top > size.height;
      if (!chromeProtected && !nestTarget && !focused)
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
  let compactControlsOutput: boolean | undefined;
  let compactPlayOutput: boolean | undefined;
  if (controls) {
    const automatic = controls === "automatic" && !!bounds;
    const width = bounds ? bounds.width * viewport.zoom : 0;
    compactControlsOutput = automatic && (outside ||
      width < (worldChildCount > FRAME_NAME_BUDGET ? CROWDED_FRAME_NAME_MIN_PIXELS : FRAME_NAME_MIN_PIXELS));
    // Between the two widths the name stays and only Play waits for intent.
    compactPlayOutput = automatic && !compactControlsOutput && width < FRAME_PLAY_MIN_PIXELS;
  }
  const intent = pointer || focused || hovered;
  const compactControls = (compactControlsOutput ?? element.hasAttribute("data-design-frame-compact-controls")) && !intent;
  const compact = tiled && compactControls && !chromeProtected && !nestTarget;
  // A protected frame is one or a few frames whose selection geometry and
  // size label must not drift either; its subtree is cheap to restyle.
  const scaleZoom = outside || compact ? 1 : viewport.zoom;
  const rootsZoom = outside || compactControls ? null : viewport.zoom;
  const rootsGesture = gestureInput && controls === "automatic" && !focused;
  // Most frames keep the same output through a pan: distant frames remain
  // outside/compact and visible frames keep one constant scale while only the
  // world transform moves. Do not allocate or touch their DOM state again.
  if (staticInputs && !structureDirty && painted && painted.outside === outside && painted.sourceOutside === sourceOutside &&
    painted.compactControls === compactControlsOutput && painted.compactPlay === compactPlayOutput &&
    painted.scaleZoom === scaleZoom && painted.gesture === gestureInput &&
    painted.rootsZoom === rootsZoom && painted.rootsGesture === rootsGesture) {
    // Outputs can survive a zoom or resize unchanged. Adopt the current
    // inputs or those frames would miss the pan fast path forever.
    painted.zoom = viewport.zoom; painted.width = size?.width ?? 0; painted.height = size?.height ?? 0;
    painted.style = style; painted.bounds = bounds; painted.controls = controls;
    painted.childCount = worldChildCount; painted.frameChildCount = frameChildCount;
    painted.pointer = pointer; painted.tiled = tiled; painted.chromeProtected = chromeProtected;
    painted.nestTarget = nestTarget; painted.focused = focused; painted.hovered = hovered; painted.gesture = gestureInput;
    // Child replacement is not synchronously observable here either.
    paintFrameChromeRoots(element, painted.rootsZoom, painted.rootsGesture);
    return;
  }
  const next: PaintedFrameVisibility = { zoom: viewport.zoom,
    width: size?.width ?? 0, height: size?.height ?? 0, style, bounds, controls,
    childCount: worldChildCount, frameChildCount, pointer, tiled,
    chromeProtected, nestTarget, focused, hovered, gesture: gestureInput,
    compactControls: compactControlsOutput, compactPlay: compactPlayOutput,
    outside, sourceOutside, scaleZoom, rootsZoom, rootsGesture };
  if (controls) {
    if (!painted || painted.compactControls !== compactControlsOutput)
      element.toggleAttribute("data-design-frame-compact-controls", compactControlsOutput);
    if (!painted || painted.compactPlay !== compactPlayOutput)
      element.toggleAttribute("data-design-frame-compact-play", compactPlayOutput);
  }
  if (!painted || painted.outside !== outside) element.toggleAttribute("data-design-frame-chrome-outside", outside);
  // Ready source paint follows the camera in this write, including a return
  // before React runs. Cold documents still lay out and caches stay mounted.
  if (!painted || painted.sourceOutside !== sourceOutside) element.toggleAttribute("data-design-frame-source-outside", sourceOutside);
  if (!painted || styleDirty || painted.scaleZoom !== scaleZoom || painted.gesture !== gestureInput)
    paintChromeScale(element, scaleZoom, gestureInput);
  if (!painted || structureDirty || painted.rootsZoom !== rootsZoom || painted.rootsGesture !== rootsGesture)
    paintFrameChromeRoots(element, rootsZoom, rootsGesture);
  // paintChromeScale writes camera variables onto this same inline style.
  // Cache the post-paint text so unchanged frames do not look mutated forever.
  next.style = element.getAttribute("style");
  paintedFrameVisibility.set(element, next);
  if (!paintingWorlds.has(world)) repaintDesignCanvasPixels(world);
}

function paintCanvasChrome(world: HTMLDivElement, gesture = world.hasAttribute("data-design-camera-gesture")): void {
  const pending = pendingChromePaints.get(world);
  if (pending !== undefined) { window.cancelAnimationFrame(pending); pendingChromePaints.delete(world); }
  paintingWorlds.add(world);
  try {
    canvasPointers.get(world)?.update(paintedViews.get(world));
    const context = { ...chromePaintContext(world), gesture, childCount: world.childElementCount };
    for (const element of world.children) {
      if (element instanceof HTMLElement) paintDesignFrameVisibility(element, context);
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
  // Compact controls are this painter's own output: observing them repeated
  // every camera paint that changed one, a second pass over the whole world.
  observer.observe(world, { subtree: true, childList: true, attributes: true,
    attributeFilter: ["class", "data-design-frame-tiled", "data-design-frame-controls",
      "data-design-frame-chrome-protected", "data-design-nest-target"] });
  // Hover transitions can follow a wheel paint in the same display interval.
  // Batch hover-only work; the next camera write adopts it before composing.
  // Focus/actions remain synchronous for keyboard and edits.
  // Track the hovered frame from the events that change it, so camera paints
  // test one candidate instead of matching :hover on every retained frame.
  hoveredFrames.set(world, null);
  const hover = (event: Event) => {
    const frame = frameOf(world, event.type === "pointerout" ? (event as PointerEvent).relatedTarget : event.target);
    hoveredFrames.set(world, frame);
    schedule();
  };
  for (const event of ["pointerover", "pointerout"]) world.addEventListener(event, hover);
  for (const event of ["focusin", "focusout"]) world.addEventListener(event, refresh);
  refresh();
  return () => {
    observer.disconnect();
    pointer?.dispose(); canvasPointers.delete(world);
    hoveredFrames.delete(world);
    const pending = pendingChromePaints.get(world);
    if (pending !== undefined) { window.cancelAnimationFrame(pending); pendingChromePaints.delete(world); }
    for (const event of ["pointerover", "pointerout"]) world.removeEventListener(event, hover);
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
  paintCanvasChrome(world, gestureActive);
  const style = designCanvasCameraStyle(viewport);
  world.style.transform = String(style.transform);
  world.toggleAttribute("data-design-camera-gesture", gestureActive);
  repaintDesignCanvasPixels(world);
}

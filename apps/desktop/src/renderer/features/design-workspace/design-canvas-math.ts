import { clampDesignZoom } from "./state/design-workspace-ui";

export interface DesignViewport {
  zoom: number;
  panX: number;
  panY: number;
}

export interface DesignViewportSize {
  width: number;
  height: number;
}

export interface DesignCanvasRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesignCanvasFrameRect extends DesignCanvasRect {
  file: string;
}

export interface DesignHighResolutionViewportTile {
  /** Frame-local logical region covered by the resolution-matched tile. */
  crop: DesignCanvasRect;
  /** Requested intrinsic bitmap size. Runtime limits may reduce this safely. */
  outputWidth: number;
  outputHeight: number;
}

/** Rebase a potentially enormous transformed frame into the small logical
 * region that is actually visible. Chromium cannot allocate a compositor
 * surface hundreds of thousands of pixels wide at 25,600% zoom; a bounded
 * viewport tile lets the runtime rerasterize HTML, text, SVG, and CSS directly
 * at the final device resolution instead of magnifying cached frame pixels. */
export function designHighResolutionViewportTile(input: {
  frame: DesignCanvasRect;
  view: DesignViewport;
  viewport: DesignViewportSize;
  devicePixelRatio: number;
  overscan?: number;
}): DesignHighResolutionViewportTile | null {
  const { frame, view, viewport } = input;
  if (
    !Number.isFinite(view.zoom) ||
    view.zoom <= 0 ||
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0 ||
    !Number.isFinite(frame.x) ||
    !Number.isFinite(frame.y) ||
    !Number.isFinite(frame.width) ||
    !Number.isFinite(frame.height) ||
    frame.width <= 0 ||
    frame.height <= 0
  ) {
    return null;
  }
  const overscan = Math.max(
    0,
    Number.isFinite(input.overscan ?? 0) ? (input.overscan ?? 0) : 0,
  );
  // A 1:1 screenshot exposes canvas/foreignObject raster edges even on a 1x
  // monitor. Request a 2x backing tile on every display; the runtime's strict
  // dimension and pixel budgets remain the final memory guard.
  const pixelRatio = 2;
  const screenLeft = view.panX + frame.x * view.zoom;
  const screenTop = view.panY + frame.y * view.zoom;
  const screenRight = screenLeft + frame.width * view.zoom;
  const screenBottom = screenTop + frame.height * view.zoom;
  const tileLeft = Math.max(-overscan, screenLeft);
  const tileTop = Math.max(-overscan, screenTop);
  const tileRight = Math.min(viewport.width + overscan, screenRight);
  const tileBottom = Math.min(viewport.height + overscan, screenBottom);
  if (tileRight <= tileLeft || tileBottom <= tileTop) return null;

  const crop = {
    x: (tileLeft - screenLeft) / view.zoom,
    y: (tileTop - screenTop) / view.zoom,
    width: (tileRight - tileLeft) / view.zoom,
    height: (tileBottom - tileTop) / view.zoom,
  };
  return {
    crop,
    outputWidth: Math.max(1, Math.ceil((tileRight - tileLeft) * pixelRatio)),
    outputHeight: Math.max(1, Math.ceil((tileBottom - tileTop) * pixelRatio)),
  };
}

export interface DesignSnapResult {
  rect: DesignCanvasRect;
  guides: { x?: number; y?: number };
}

/** Convert a client point into the unscaled canvas world. Pointer tools use
 * this single inverse transform so pan/zoom cannot skew creation geometry. */
export function designCanvasPointFromClient(
  client: { x: number; y: number },
  viewportBounds: { left: number; top: number },
  viewport: DesignViewport,
): { x: number; y: number } {
  const zoom =
    Number.isFinite(viewport.zoom) && viewport.zoom > 0 ? viewport.zoom : 1;
  return {
    x: (client.x - viewportBounds.left - viewport.panX) / zoom,
    y: (client.y - viewportBounds.top - viewport.panY) / zoom,
  };
}

/** Normalize either drag direction into one exact positive-size canvas box. */
export function designCanvasRectFromPoints(
  start: { x: number; y: number },
  end: { x: number; y: number },
): DesignCanvasRect {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

export interface DesignSpacingMeasurement {
  side: "left" | "right" | "top" | "bottom";
  axis: "horizontal" | "vertical";
  x: number;
  y: number;
  length: number;
  distance: number;
}

/** Dashed projection drawn along the measured target's edge so a measurement
 * line that leaves the target's span still visibly terminates on it. */
export interface DesignMeasureExtension {
  axis: "horizontal" | "vertical";
  x: number;
  y: number;
  length: number;
}

export interface DesignMeasureSpacing {
  lines: DesignSpacingMeasurement[];
  extensions: DesignMeasureExtension[];
}

export interface DesignGridTrackSegment {
  start: number;
  end: number;
  label: string;
}

export type DesignInlineGapProperty = "gap" | "row-gap" | "column-gap";

export interface DesignInlineGapChild {
  id: string;
  rect: DesignCanvasRect;
  position?: string;
}

export interface DesignInlineGapRegion extends DesignCanvasRect {
  key: string;
  property: DesignInlineGapProperty;
  axis: "x" | "y";
  leadingId: string;
  trailingId: string;
}

/** Resolve a one-axis direct-manipulation gesture into a CSS spacing value.
 * The direction flips right/bottom handles, and an optional step supports the
 * familiar Shift-to-snap workflow without letting spacing become negative. */
export function designInlineSpacingValue(
  initialValue: number,
  pointerDelta: number,
  direction: 1 | -1,
  step = 1,
): number {
  const safeStep = Number.isFinite(step) ? Math.max(0.1, step) : 1;
  const raw = Math.max(0, initialValue + pointerDelta * direction);
  const snapped = Math.round(raw / safeStep) * safeStep;
  return Math.round(snapped * 10) / 10;
}

/** Keep a forgiving pointer target around thin and zero-size gaps without
 * inflating the visible spacing highlight. `visualRect` is local to the hit
 * target so the same geometry can be painted by React and live gestures. */
export function designInlineGapGeometry(
  region: DesignInlineGapRegion,
  zoom: number,
): {
  hitRect: DesignCanvasRect;
  visualRect: DesignCanvasRect;
} {
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const minimumHit = 18 / safeZoom;
  const width = Math.max(region.width, minimumHit);
  const height = Math.max(region.height, minimumHit);
  const hitRect = {
    x: region.x + (region.width - width) / 2,
    y: region.y + (region.height - height) / 2,
    width,
    height,
  };
  return {
    hitRect,
    visualRect: {
      x: region.x - hitRect.x,
      y: region.y - hitRect.y,
      width: region.width,
      height: region.height,
    },
  };
}

const INLINE_GAP_GEOMETRY_EPSILON = 0.5;

function finiteGapChild(child: DesignInlineGapChild): boolean {
  const { x, y, width, height } = child.rect;
  return (
    child.position !== "absolute" &&
    child.position !== "fixed" &&
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0
  );
}

function roundedGapCoordinate(value: number): number {
  return Math.round(value * 10) / 10;
}

function designInlineGapRegionsForAxis(
  container: DesignCanvasRect,
  children: readonly DesignInlineGapChild[],
  axis: "x" | "y",
  property: DesignInlineGapProperty,
  fullCrossSpan = false,
): DesignInlineGapRegion[] {
  const horizontal = axis === "x";
  const mainStart = (child: DesignInlineGapChild) =>
    horizontal ? child.rect.x : child.rect.y;
  const mainEnd = (child: DesignInlineGapChild) =>
    mainStart(child) + (horizontal ? child.rect.width : child.rect.height);
  const crossStart = (child: DesignInlineGapChild) =>
    horizontal ? child.rect.y : child.rect.x;
  const crossEnd = (child: DesignInlineGapChild) =>
    crossStart(child) + (horizontal ? child.rect.height : child.rect.width);
  const sorted = children
    .filter(finiteGapChild)
    .slice(0, 64)
    .sort(
      (left, right) =>
        mainStart(left) - mainStart(right) ||
        mainEnd(left) - mainEnd(right) ||
        left.id.localeCompare(right.id),
    );
  const containerMainStart = horizontal ? container.x : container.y;
  const containerMainEnd =
    containerMainStart + (horizontal ? container.width : container.height);
  const containerCrossStart = horizontal ? container.y : container.x;
  const containerCrossEnd =
    containerCrossStart + (horizontal ? container.height : container.width);
  // A non-wrapping flex line has one shared cross-axis lane. Its gap affordance
  // should therefore span the complete rendered content envelope, even when
  // one adjacent child is very narrow or centered. Wrapped flex and grid keep
  // their local overlap logic below so controls do not bridge separate lanes.
  const contentCrossStart = Math.max(
    containerCrossStart,
    Math.min(...sorted.map(crossStart)),
  );
  const contentCrossEnd = Math.min(
    containerCrossEnd,
    Math.max(...sorted.map(crossEnd)),
  );
  const regions: DesignInlineGapRegion[] = [];
  const seen = new Set<string>();

  for (const leading of sorted) {
    let trailing: DesignInlineGapChild | null = null;
    let trailingCrossStart = 0;
    let trailingCrossEnd = 0;
    for (const candidate of sorted) {
      if (candidate === leading) continue;
      if (
        mainStart(candidate) <
        mainEnd(leading) - INLINE_GAP_GEOMETRY_EPSILON
      ) {
        continue;
      }
      const overlapStart = fullCrossSpan
        ? contentCrossStart
        : Math.max(
            containerCrossStart,
            crossStart(leading),
            crossStart(candidate),
          );
      const overlapEnd = fullCrossSpan
        ? contentCrossEnd
        : Math.min(containerCrossEnd, crossEnd(leading), crossEnd(candidate));
      if (overlapEnd - overlapStart <= INLINE_GAP_GEOMETRY_EPSILON) continue;
      if (
        !trailing ||
        mainStart(candidate) < mainStart(trailing) ||
        (mainStart(candidate) === mainStart(trailing) &&
          candidate.id.localeCompare(trailing.id) < 0)
      ) {
        trailing = candidate;
        trailingCrossStart = overlapStart;
        trailingCrossEnd = overlapEnd;
      }
    }
    if (!trailing) continue;
    const key = `${axis}:${leading.id}:${trailing.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const gapStart = Math.max(containerMainStart, mainEnd(leading));
    const gapEnd = Math.min(containerMainEnd, mainStart(trailing));
    if (gapEnd < gapStart - INLINE_GAP_GEOMETRY_EPSILON) continue;
    const localMain = roundedGapCoordinate(gapStart - containerMainStart);
    const localCross = roundedGapCoordinate(
      trailingCrossStart - containerCrossStart,
    );
    const mainLength = roundedGapCoordinate(Math.max(0, gapEnd - gapStart));
    const crossLength = roundedGapCoordinate(
      trailingCrossEnd - trailingCrossStart,
    );
    regions.push({
      key,
      property,
      axis,
      x: horizontal ? localMain : localCross,
      y: horizontal ? localCross : localMain,
      width: horizontal ? mainLength : crossLength,
      height: horizontal ? crossLength : mainLength,
      leadingId: leading.id,
      trailingId: trailing.id,
    });
  }
  return regions;
}

/** A CSS `space-between` distribution is the web equivalent of an Auto gap:
 * changing the minimum `gap` does not move children while distributable free
 * space remains. Dragging a concrete gap line is an explicit request for fixed
 * spacing, so only the distribution on that dragged flex axis is reset. */
export function designInlineGapDistributionStyles(input: {
  display: string | undefined;
  flexDirection?: string;
  flexWrap?: string;
  axis: "x" | "y";
  justifyContent?: string;
  alignContent?: string;
}): Record<string, string> {
  if (input.display !== "flex" && input.display !== "inline-flex") return {};
  const mainAxis = (input.flexDirection ?? "row").startsWith("row") ? "x" : "y";
  if (input.axis === mainAxis && input.justifyContent === "space-between") {
    return { "justify-content": "flex-start" };
  }
  if (
    input.axis !== mainAxis &&
    (input.flexWrap ?? "nowrap") !== "nowrap" &&
    input.alignContent === "space-between"
  ) {
    return { "align-content": "flex-start" };
  }
  return {};
}

/** Build bounded hit regions from the rendered boxes of a layout container's
 * direct children. Controls therefore live in actual inter-item space instead
 * of an arbitrary container center, and wrapped/grid layouts expose their two
 * independent CSS gap axes. */
export function designInlineGapRegions(input: {
  container: DesignCanvasRect;
  children: readonly DesignInlineGapChild[];
  display: string | undefined;
  flexDirection?: string;
  flexWrap?: string;
}): DesignInlineGapRegion[] {
  const display = input.display?.trim() ?? "";
  if (display === "grid" || display === "inline-grid") {
    return [
      ...designInlineGapRegionsForAxis(
        input.container,
        input.children,
        "x",
        "column-gap",
      ),
      ...designInlineGapRegionsForAxis(
        input.container,
        input.children,
        "y",
        "row-gap",
      ),
    ];
  }
  if (display !== "flex" && display !== "inline-flex") return [];
  const rowDirection = (input.flexDirection ?? "row").startsWith("row");
  const wraps = (input.flexWrap ?? "nowrap") !== "nowrap";
  if (wraps) {
    return [
      ...designInlineGapRegionsForAxis(
        input.container,
        input.children,
        "x",
        "column-gap",
      ),
      ...designInlineGapRegionsForAxis(
        input.container,
        input.children,
        "y",
        "row-gap",
      ),
    ];
  }
  return designInlineGapRegionsForAxis(
    input.container,
    input.children,
    rowDirection ? "x" : "y",
    "gap",
    true,
  );
}

function topLevelTrackTokens(value: string): string[] {
  const tokens: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index <= value.length; index += 1) {
    const character = value[index];
    if (character === "(") depth += 1;
    else if (character === ")") depth = Math.max(0, depth - 1);
    const boundary =
      index === value.length || (/\s/.test(character ?? "") && depth === 0);
    if (!boundary) continue;
    const token = value.slice(start, index).trim();
    if (token) tokens.push(token);
    start = index + 1;
  }
  return tokens.slice(0, 64);
}

/** Convert authored or computed grid tracks into percentage spans for a
 * scale-independent canvas overlay. Browsers usually return px tracks, while
 * source-cold previews may still expose a simple repeat() expression. */
export function designGridTrackSegments(
  value: string | undefined,
  availableSize: number,
): DesignGridTrackSegment[] {
  const source = value?.trim() ?? "";
  if (!source || source === "none" || availableSize <= 0) return [];
  const repeated = /^repeat\(\s*(\d+)\s*,\s*(.+)\)$/i.exec(source);
  const repeatedCount = repeated?.[1] ? Number(repeated[1]) : 0;
  const tokens =
    repeated && repeatedCount > 0 && repeatedCount <= 64 && repeated[2]
      ? Array.from({ length: repeatedCount }, () => repeated[2]!.trim())
      : topLevelTrackTokens(source);
  if (tokens.length === 0) return [];
  const numeric = tokens.map((token) => {
    const match = /^(\d+(?:\.\d+)?)(px|fr|%)$/i.exec(token);
    return match?.[1] ? Number(match[1]) : Number.NaN;
  });
  const allNumeric = numeric.every(
    (candidate) => Number.isFinite(candidate) && candidate >= 0,
  );
  const total = allNumeric
    ? numeric.reduce((sum, candidate) => sum + candidate, 0)
    : tokens.length;
  if (total <= 0) return [];
  let cursor = 0;
  return tokens.map((label, index) => {
    const start = Math.round(cursor * 10) / 10;
    cursor += ((allNumeric ? numeric[index]! : 1) / total) * 100;
    const end =
      index === tokens.length - 1 ? 100 : Math.round(cursor * 10) / 10;
    return { start, end, label };
  });
}

export type DesignSelectionClickIntent =
  | "primary"
  | "toggle"
  | "deepest"
  | "descend";

/** Resolve the release of a selected-layer pointer press after it proved to
 * be a click, not a drag. This delayed decision is what lets a selected group
 * move as one without sacrificing modifier-based nested selection. */
export function designSelectionClickIntent(input: {
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  detail: number;
}): DesignSelectionClickIntent {
  if (input.shiftKey) return "toggle";
  if (input.metaKey || input.ctrlKey) return "deepest";
  if (input.detail > 1) return "descend";
  return "primary";
}

/** Convert an outer-box drag delta back into the computed CSS width/height.
 * Browsers report content-box dimensions for `box-sizing: content-box`; using
 * the outer DOMRect as the CSS value would therefore grow padded nodes twice. */
export function designCssSizeAfterResize(
  computedSize: string | undefined,
  startOuterSize: number,
  resizedOuterSize: number,
): number {
  const match = /^(-?\d+(?:\.\d+)?)px$/i.exec(computedSize?.trim() ?? "");
  const base = match?.[1] ? Number(match[1]) : startOuterSize;
  return Math.max(0, base + resizedOuterSize - startOuterSize);
}

/** Snap moving edges/centers to the nearest peer axis within a world-space
 * threshold. X and Y resolve independently, matching design-tool smart guides. */
export function snapDesignRect(
  moving: DesignCanvasRect,
  peers: readonly DesignCanvasRect[],
  threshold: number,
): DesignSnapResult {
  const movingX = [
    moving.x,
    moving.x + moving.width / 2,
    moving.x + moving.width,
  ];
  const movingY = [
    moving.y,
    moving.y + moving.height / 2,
    moving.y + moving.height,
  ];
  let bestX: { delta: number; guide: number } | null = null;
  let bestY: { delta: number; guide: number } | null = null;
  for (const peer of peers) {
    const peerX = [peer.x, peer.x + peer.width / 2, peer.x + peer.width];
    const peerY = [peer.y, peer.y + peer.height / 2, peer.y + peer.height];
    for (const source of movingX) {
      for (const target of peerX) {
        const delta = target - source;
        if (
          Math.abs(delta) <= threshold &&
          (!bestX || Math.abs(delta) < Math.abs(bestX.delta))
        ) {
          bestX = { delta, guide: target };
        }
      }
    }
    for (const source of movingY) {
      for (const target of peerY) {
        const delta = target - source;
        if (
          Math.abs(delta) <= threshold &&
          (!bestY || Math.abs(delta) < Math.abs(bestY.delta))
        ) {
          bestY = { delta, guide: target };
        }
      }
    }
  }
  return {
    rect: {
      ...moving,
      x: moving.x + (bestX?.delta ?? 0),
      y: moving.y + (bestY?.delta ?? 0),
    },
    guides: {
      ...(bestX ? { x: bestX.guide } : {}),
      ...(bestY ? { y: bestY.guide } : {}),
    },
  };
}

export type DesignResizeHandle =
  | "n"
  | "ne"
  | "e"
  | "se"
  | "s"
  | "sw"
  | "w"
  | "nw";

export interface DesignAuthoredAxis {
  /** The integer CSS offset to author, and the integer CSS size. */
  offset: number;
  size: number;
  /** What those integers move, relative to where the gesture started. Painting
   * these instead of the pointer's own fractional travel is what keeps the
   * overlay on the same pixel as the element. */
  offsetTravel: number;
  sizeTravel: number;
}

/** Quantize one axis of a resize to the whole pixels it will actually author.
 *
 * A gesture writes integer CSS pixels, so a fractional layout base leaves two
 * independent rounding residues — one in the offset, one in the size — and their
 * difference is the edge the user is holding. Rounding them separately makes
 * that edge oscillate a whole pixel twice per pixel of travel: the shake.
 *
 * Quantizing the two EDGES instead keeps every edge monotone in its own travel,
 * so an edge the pointer is not moving does not move at all. When the gesture
 * does not author the offset (a plain east/south drag) the start edge is not
 * ours to touch, and only the size is quantized. */
export function designAuthoredResizeAxis(input: {
  /** Authored CSS offset (`left`/`top`) at gesture start. */
  offset: number;
  /** Authored CSS size (`width`/`height`) at gesture start. */
  size: number;
  /** Travel of the start and end edges in authored CSS units. */
  startTravel: number;
  endTravel: number;
  /** False for handles that keep the start edge where the document put it. */
  authorsOffset: boolean;
  /** False for a move, which carries its size along untouched. */
  authorsSize?: boolean;
  minimum?: number;
}): DesignAuthoredAxis {
  const minimum = input.minimum ?? 1;
  const offset = input.authorsOffset
    ? Math.round(input.offset + input.startTravel)
    : input.offset;
  const offsetTravel = offset - input.offset;
  if (input.authorsSize === false) {
    return { offset, size: input.size, offsetTravel, sizeTravel: 0 };
  }
  const size = input.authorsOffset
    ? Math.max(
        minimum,
        Math.round(input.offset + input.size + input.endTravel) - offset,
      )
    : Math.max(
        minimum,
        Math.round(input.size + input.endTravel - input.startTravel),
      );
  return { offset, size, offsetTravel, sizeTravel: size - input.size };
}

/** Resize handles author only the CSS dimensions they actually control.
 * Keeping the untouched axis authored as-is is especially important for text:
 * a horizontal resize must allow auto-height reflow instead of freezing and
 * clipping the old line box. */
export function designResizeStyleAxes(handle: DesignResizeHandle): {
  width: boolean;
  height: boolean;
} {
  return {
    width: handle.includes("e") || handle.includes("w"),
    height: handle.includes("n") || handle.includes("s"),
  };
}

interface DesignResizeOptions {
  minWidth?: number;
  minHeight?: number;
  keepAspect?: boolean;
  fromCenter?: boolean;
}

/** Pure direct-manipulation geometry shared by frame and element handles.
 * Shift preserves the authored aspect ratio; Alt/Option keeps the center
 * stationary. The dragged edge owns minimum-size clamping, so the opposite
 * anchor never jumps when a pointer crosses it. */
export function resizeDesignRect(
  start: DesignCanvasRect,
  deltaX: number,
  deltaY: number,
  handle: DesignResizeHandle,
  options: DesignResizeOptions = {},
): DesignCanvasRect {
  const minWidth = Math.max(1, options.minWidth ?? 1);
  const minHeight = Math.max(1, options.minHeight ?? 1);
  const west = handle.includes("w");
  const east = handle.includes("e");
  const north = handle.includes("n");
  const south = handle.includes("s");
  let left = start.x;
  let right = start.x + start.width;
  let top = start.y;
  let bottom = start.y + start.height;

  if (west) left += deltaX;
  if (east) right += deltaX;
  if (north) top += deltaY;
  if (south) bottom += deltaY;
  if (options.fromCenter) {
    if (west) right -= deltaX;
    if (east) left -= deltaX;
    if (north) bottom -= deltaY;
    if (south) top -= deltaY;
  }

  if (options.keepAspect && start.width > 0 && start.height > 0) {
    const ratio = start.width / start.height;
    const candidateWidth = Math.max(minWidth, right - left);
    const candidateHeight = Math.max(minHeight, bottom - top);
    const widthChange = Math.abs(candidateWidth / start.width - 1);
    const heightChange = Math.abs(candidateHeight / start.height - 1);
    let width = candidateWidth;
    let height = candidateHeight;
    if ((west || east) && ((!north && !south) || widthChange >= heightChange)) {
      height = width / ratio;
    } else {
      width = height * ratio;
    }
    const minimumScale = Math.max(1, minWidth / width, minHeight / height);
    width *= minimumScale;
    height *= minimumScale;

    const centerX = start.x + start.width / 2;
    const centerY = start.y + start.height / 2;
    if (options.fromCenter || (!west && !east)) {
      left = centerX - width / 2;
      right = centerX + width / 2;
    } else if (west) {
      left = right - width;
    } else {
      right = left + width;
    }
    if (options.fromCenter || (!north && !south)) {
      top = centerY - height / 2;
      bottom = centerY + height / 2;
    } else if (north) {
      top = bottom - height;
    } else {
      bottom = top + height;
    }
  }

  if (right - left < minWidth) {
    if (options.fromCenter) {
      const center = start.x + start.width / 2;
      left = center - minWidth / 2;
      right = center + minWidth / 2;
    } else if (west && !east) left = right - minWidth;
    else if (east && !west) right = left + minWidth;
    else {
      const center = (left + right) / 2;
      left = center - minWidth / 2;
      right = center + minWidth / 2;
    }
  }
  if (bottom - top < minHeight) {
    if (options.fromCenter) {
      const center = start.y + start.height / 2;
      top = center - minHeight / 2;
      bottom = center + minHeight / 2;
    } else if (north && !south) top = bottom - minHeight;
    else if (south && !north) bottom = top + minHeight;
    else {
      const center = (top + bottom) / 2;
      top = center - minHeight / 2;
      bottom = center + minHeight / 2;
    }
  }

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

/** Project one child rectangle from an original multi-selection box into its
 * resized box. Positions and dimensions use the same independent axis scales
 * as design-tool group resizing; degenerate source axes translate without
 * producing infinities. */
export function resizeDesignRectWithinBounds(
  rect: DesignCanvasRect,
  sourceBounds: DesignCanvasRect,
  resizedBounds: DesignCanvasRect,
): DesignCanvasRect {
  const scaleX =
    sourceBounds.width > 0 ? resizedBounds.width / sourceBounds.width : 1;
  const scaleY =
    sourceBounds.height > 0 ? resizedBounds.height / sourceBounds.height : 1;
  return {
    x: resizedBounds.x + (rect.x - sourceBounds.x) * scaleX,
    y: resizedBounds.y + (rect.y - sourceBounds.y) * scaleY,
    width: Math.max(1, rect.width * scaleX),
    height: Math.max(1, rect.height * scaleY),
  };
}

/** Snap only the actively dragged resize edges. Unlike move snapping, the
 * opposite edge remains the anchor and the size absorbs the guide delta. */
export function snapDesignResizeRect(
  resized: DesignCanvasRect,
  handle: DesignResizeHandle,
  peers: readonly DesignCanvasRect[],
  threshold: number,
): DesignSnapResult {
  const peerX = peers.flatMap((peer) => [
    peer.x,
    peer.x + peer.width / 2,
    peer.x + peer.width,
  ]);
  const peerY = peers.flatMap((peer) => [
    peer.y,
    peer.y + peer.height / 2,
    peer.y + peer.height,
  ]);
  const nearest = (source: number, targets: readonly number[]) => {
    let best: { delta: number; guide: number } | null = null;
    for (const target of targets) {
      const delta = target - source;
      if (
        Math.abs(delta) <= threshold &&
        (!best || Math.abs(delta) < Math.abs(best.delta))
      ) {
        best = { delta, guide: target };
      }
    }
    return best;
  };

  const west = handle.includes("w");
  const east = handle.includes("e");
  const north = handle.includes("n");
  const south = handle.includes("s");
  const xSnap = west
    ? nearest(resized.x, peerX)
    : east
      ? nearest(resized.x + resized.width, peerX)
      : null;
  const ySnap = north
    ? nearest(resized.y, peerY)
    : south
      ? nearest(resized.y + resized.height, peerY)
      : null;
  let { x, y, width, height } = resized;
  if (xSnap) {
    if (west) {
      x += xSnap.delta;
      width -= xSnap.delta;
    } else {
      width += xSnap.delta;
    }
  }
  if (ySnap) {
    if (north) {
      y += ySnap.delta;
      height -= ySnap.delta;
    } else {
      height += ySnap.delta;
    }
  }
  return {
    rect: { x, y, width: Math.max(1, width), height: Math.max(1, height) },
    guides: {
      ...(xSnap ? { x: xSnap.guide } : {}),
      ...(ySnap ? { y: ySnap.guide } : {}),
    },
  };
}

const MEASURE_EPSILON = 0.5;

/** Option/Alt distance feedback between the selection and one measured target
 * (the hovered node, or the selection's parent when nothing is hovered), in
 * frame-local coordinates. When one box contains the other, all four inset
 * distances are measured on the inner box's center axes; otherwise each axis
 * reports either the gap between facing edges or, when the boxes overlap on
 * that axis, both same-side edge deltas. Lines that would leave the target's
 * span get a dashed extension along the target edge they terminate on. */
export function designMeasureSpacing(
  selected: DesignCanvasRect,
  target: DesignCanvasRect,
): DesignMeasureSpacing {
  const sel = {
    left: selected.x,
    top: selected.y,
    right: selected.x + selected.width,
    bottom: selected.y + selected.height,
    centerX: selected.x + selected.width / 2,
    centerY: selected.y + selected.height / 2,
  };
  const tgt = {
    left: target.x,
    top: target.y,
    right: target.x + target.width,
    bottom: target.y + target.height,
  };
  const lines: DesignSpacingMeasurement[] = [];
  const extensions: DesignMeasureExtension[] = [];
  const line = (
    side: DesignSpacingMeasurement["side"],
    axis: DesignSpacingMeasurement["axis"],
    x: number,
    y: number,
    length: number,
  ) => {
    if (!Number.isFinite(length) || length < MEASURE_EPSILON) return;
    lines.push({ side, axis, x, y, length, distance: length });
  };
  /** Dashed reach along the target edge when the measurement line's cross
   * coordinate exits the target's span on that axis. */
  const extend = (
    axis: DesignMeasureExtension["axis"],
    edge: number,
    cross: number,
    spanStart: number,
    spanEnd: number,
  ) => {
    const from = cross < spanStart ? cross : cross > spanEnd ? spanEnd : null;
    const length =
      cross < spanStart
        ? spanStart - cross
        : cross > spanEnd
          ? cross - spanEnd
          : 0;
    if (from === null || length < MEASURE_EPSILON) return;
    extensions.push(
      axis === "vertical"
        ? { axis, x: edge, y: from, length }
        : { axis, x: from, y: edge, length },
    );
  };

  const contains = (outer: typeof tgt, inner: typeof tgt): boolean =>
    outer.left <= inner.left + MEASURE_EPSILON &&
    outer.top <= inner.top + MEASURE_EPSILON &&
    outer.right >= inner.right - MEASURE_EPSILON &&
    outer.bottom >= inner.bottom - MEASURE_EPSILON;

  const selBox = {
    left: sel.left,
    top: sel.top,
    right: sel.right,
    bottom: sel.bottom,
  };
  if (contains(tgt, selBox) || contains(selBox, tgt)) {
    const inner = contains(tgt, selBox) ? selBox : tgt;
    const outer = contains(tgt, selBox) ? tgt : selBox;
    const centerX = (inner.left + inner.right) / 2;
    const centerY = (inner.top + inner.bottom) / 2;
    line("left", "horizontal", outer.left, centerY, inner.left - outer.left);
    line(
      "right",
      "horizontal",
      inner.right,
      centerY,
      outer.right - inner.right,
    );
    line("top", "vertical", centerX, outer.top, inner.top - outer.top);
    line(
      "bottom",
      "vertical",
      centerX,
      inner.bottom,
      outer.bottom - inner.bottom,
    );
    return { lines, extensions };
  }

  if (tgt.left >= sel.right) {
    line("right", "horizontal", sel.right, sel.centerY, tgt.left - sel.right);
    extend("vertical", tgt.left, sel.centerY, tgt.top, tgt.bottom);
  } else if (tgt.right <= sel.left) {
    line("left", "horizontal", tgt.right, sel.centerY, sel.left - tgt.right);
    extend("vertical", tgt.right, sel.centerY, tgt.top, tgt.bottom);
  } else {
    line(
      "left",
      "horizontal",
      Math.min(sel.left, tgt.left),
      sel.centerY,
      Math.abs(sel.left - tgt.left),
    );
    extend("vertical", tgt.left, sel.centerY, tgt.top, tgt.bottom);
    line(
      "right",
      "horizontal",
      Math.min(sel.right, tgt.right),
      sel.centerY,
      Math.abs(sel.right - tgt.right),
    );
    extend("vertical", tgt.right, sel.centerY, tgt.top, tgt.bottom);
  }

  if (tgt.top >= sel.bottom) {
    line("bottom", "vertical", sel.centerX, sel.bottom, tgt.top - sel.bottom);
    extend("horizontal", tgt.top, sel.centerX, tgt.left, tgt.right);
  } else if (tgt.bottom <= sel.top) {
    line("top", "vertical", sel.centerX, tgt.bottom, sel.top - tgt.bottom);
    extend("horizontal", tgt.bottom, sel.centerX, tgt.left, tgt.right);
  } else {
    line(
      "top",
      "vertical",
      sel.centerX,
      Math.min(sel.top, tgt.top),
      Math.abs(sel.top - tgt.top),
    );
    extend("horizontal", tgt.top, sel.centerX, tgt.left, tgt.right);
    line(
      "bottom",
      "vertical",
      sel.centerX,
      Math.min(sel.bottom, tgt.bottom),
      Math.abs(sel.bottom - tgt.bottom),
    );
    extend("horizontal", tgt.bottom, sel.centerX, tgt.left, tgt.right);
  }

  return { lines, extensions };
}

/** One selection's geometry in frame coordinates, decoupled from the axis
 * aligned bounding box so a rotated element can be outlined, handled, and
 * resized along its own axes. Mirrors the runtime box, with a rect-shaped
 * fallback for older runtimes. */
export interface DesignSelectionBox {
  /** Frame-space position of the element's own top-left corner. */
  x: number;
  y: number;
  /** Untransformed border-box size in layout pixels. */
  width: number;
  height: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  /** Pivot as a fraction of the box; 0.5 is the center, and values outside
   * 0–1 place the pivot outside the box. */
  originX: number;
  originY: number;
}

/** DOM placement for a rotated selection overlay. The pivot is the one point
 * a rotation cannot move, so anchoring the overlay there lets a rotation
 * gesture repaint nothing but `transform`. */
export interface DesignSelectionOverlayFrame {
  left: number;
  top: number;
  /** Painted size, so a scaled element still outlines its visible bounds while
   * its handles and labels stay square. */
  width: number;
  height: number;
  rotation: number;
  /** Pivot in the overlay's own unrotated coordinates. */
  pivotX: number;
  pivotY: number;
}

const DESIGN_ORIGIN_ANCHORS = [0, 0.5, 1] as const;

function rotateVector(
  vector: { x: number; y: number },
  degrees: number,
): { x: number; y: number } {
  if (degrees === 0) return { x: vector.x, y: vector.y };
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    x: vector.x * cos - vector.y * sin,
    y: vector.x * sin + vector.y * cos,
  };
}

/** Rotate a frame-space pointer delta into a rotated element's own axes, so
 * dragging its right edge widens it along that edge rather than along the
 * screen's x axis. */
export function designLocalDelta(
  delta: { x: number; y: number },
  rotation: number,
): { x: number; y: number } {
  return rotateVector(delta, -rotation);
}

function originFractionFromComputed(
  value: string | undefined,
  size: number,
  fallback = 0.5,
): number {
  if (size <= 0) return fallback;
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed / size : fallback;
}

/** Resolve one node's selection geometry. Runtimes that predate the transform
 * aware box still report their pivot through computed `transform-origin`, so
 * the origin marker stays correct even when the outline cannot rotate. */
export function designSelectionBox(details: {
  rect: DesignCanvasRect;
  box?: DesignSelectionBox;
  styles?: Record<string, string>;
}): DesignSelectionBox {
  if (details.box) return details.box;
  const origin = (details.styles?.transformOrigin ?? "").trim().split(/\s+/);
  return {
    x: details.rect.x,
    y: details.rect.y,
    width: details.rect.width,
    height: details.rect.height,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    originX: originFractionFromComputed(origin[0], details.rect.width),
    originY: originFractionFromComputed(origin[1], details.rect.height),
  };
}

function designSelectionBoxSize(box: DesignSelectionBox): {
  width: number;
  height: number;
} {
  return {
    width: box.width * box.scaleX,
    height: box.height * box.scaleY,
  };
}

export function designSelectionOverlayFrame(
  box: DesignSelectionBox,
): DesignSelectionOverlayFrame {
  const { width, height } = designSelectionBoxSize(box);
  const pivotX = box.originX * width;
  const pivotY = box.originY * height;
  const turned = rotateVector({ x: pivotX, y: pivotY }, box.rotation);
  return {
    left: box.x + turned.x - pivotX,
    top: box.y + turned.y - pivotY,
    width,
    height,
    rotation: box.rotation,
    pivotX,
    pivotY,
  };
}

/** The axis-aligned bounding box of a painted selection. Equals the box itself
 * while upright, and the box a rotation spans once it turns — the frame that
 * constraint guides and other screen-aligned chrome measure against. */
export function designSelectionBoxBounds(
  box: DesignSelectionBox,
): DesignCanvasRect {
  const corners = designSelectionBoxCorners(box);
  const xs = corners.map((corner) => corner.x);
  const ys = corners.map((corner) => corner.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** The parent edges an element's own CSS pins it to. This is what Figma calls a
 * constraint, expressed in the properties HTML actually has: `position` plus the
 * authored `left`/`right`/`top`/`bottom` offsets. Pinning both sides of an axis
 * stretches the element with its parent; pinning neither leaves it to document
 * flow, which starts at the block/inline start edge. */
export type DesignConstraintSide = "left" | "right" | "top" | "bottom";

export interface DesignConstraintSides {
  horizontal: readonly DesignConstraintSide[];
  vertical: readonly DesignConstraintSide[];
}

export function designConstraintSides(input: {
  position: string | undefined;
  /** Computed keys with a direct active declaration. Relative offsets resolve
   * symmetrically (`top: 10px` computes `bottom: -10px`), so only the authored
   * side is a real constraint. */
  authored?: readonly string[];
  styles?: Record<string, string>;
}): DesignConstraintSides {
  const position = (input.position ?? "static").trim();
  // Offsets do not apply to a statically positioned box; flow anchors it to the
  // start edges.
  if (position === "static") {
    return { horizontal: ["left"], vertical: ["top"] };
  }
  const authored = input.authored ? new Set(input.authored) : null;
  const pinned = (side: DesignConstraintSide) => {
    if (authored) return authored.has(side);
    const value = input.styles?.[side]?.trim() ?? "auto";
    return value !== "auto" && value !== "";
  };
  const axis = (
    start: DesignConstraintSide,
    end: DesignConstraintSide,
  ): readonly DesignConstraintSide[] => {
    const hasStart = pinned(start);
    const hasEnd = pinned(end);
    if (hasStart && hasEnd) return [start, end];
    if (hasEnd) return [end];
    return [start];
  };
  return {
    horizontal: axis("left", "right"),
    vertical: axis("top", "bottom"),
  };
}

export interface DesignConstraintGuide {
  side: DesignConstraintSide;
  axis: "horizontal" | "vertical";
  /** Frame-space start of the dashed run, always axis-aligned. */
  x: number;
  y: number;
  length: number;
}

/** Dashed runs from the selection's bounding box to the parent edges it is
 * pinned to. They stay screen-aligned even when the element is rotated: the
 * constraint describes where the box is anchored, not which way it faces. */
export function designConstraintGuides(
  bounds: DesignCanvasRect,
  parent: DesignCanvasRect,
  sides: DesignConstraintSides,
): DesignConstraintGuide[] {
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  const guides: DesignConstraintGuide[] = [];
  const push = (
    side: DesignConstraintSide,
    axis: "horizontal" | "vertical",
    x: number,
    y: number,
    length: number,
  ) => {
    guides.push({ side, axis, x, y, length: Math.max(0, length) });
  };
  for (const side of sides.horizontal) {
    if (side === "left") {
      push("left", "horizontal", parent.x, centerY, bounds.x - parent.x);
    } else if (side === "right") {
      const right = bounds.x + bounds.width;
      push(
        "right",
        "horizontal",
        right,
        centerY,
        parent.x + parent.width - right,
      );
    }
  }
  for (const side of sides.vertical) {
    if (side === "top") {
      push("top", "vertical", centerX, parent.y, bounds.y - parent.y);
    } else if (side === "bottom") {
      const bottom = bounds.y + bounds.height;
      push(
        "bottom",
        "vertical",
        centerX,
        bottom,
        parent.y + parent.height - bottom,
      );
    }
  }
  return guides;
}

/** The painted corners in frame coordinates, in nw, ne, se, sw order. */
export function designSelectionBoxCorners(
  box: DesignSelectionBox,
): Array<{ x: number; y: number }> {
  const { width, height } = designSelectionBoxSize(box);
  return [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ].map((corner) => {
    const turned = rotateVector(corner, box.rotation);
    return { x: box.x + turned.x, y: box.y + turned.y };
  });
}

/** Frame-space position of the pivot future rotations turn about. */
export function designSelectionPivot(box: DesignSelectionBox): {
  x: number;
  y: number;
} {
  const { width, height } = designSelectionBoxSize(box);
  const turned = rotateVector(
    { x: box.originX * width, y: box.originY * height },
    box.rotation,
  );
  return { x: box.x + turned.x, y: box.y + turned.y };
}

/** Resolve a dragged pivot into box fractions, snapping to the nine standard
 * anchors while the pointer is within tolerance of one. Tolerance arrives in
 * box units so the caller can keep it constant on screen at any zoom. */
export function designOriginFraction(
  box: DesignSelectionBox,
  local: { x: number; y: number },
  tolerance = 0,
): { originX: number; originY: number; snappedX: boolean; snappedY: boolean } {
  const { width, height } = designSelectionBoxSize(box);
  const resolve = (value: number, size: number) => {
    const fraction = size > 0 ? value / size : 0.5;
    if (tolerance <= 0 || size <= 0) {
      return { fraction: clampOriginFraction(fraction), snapped: false };
    }
    for (const anchor of DESIGN_ORIGIN_ANCHORS) {
      if (Math.abs(value - anchor * size) <= tolerance) {
        return { fraction: anchor, snapped: true };
      }
    }
    return { fraction: clampOriginFraction(fraction), snapped: false };
  };
  const horizontal = resolve(local.x, width);
  const vertical = resolve(local.y, height);
  return {
    originX: horizontal.fraction,
    originY: vertical.fraction,
    snappedX: horizontal.snapped,
    snappedY: vertical.snapped,
  };
}

/** A pivot may sit outside its box, but not arbitrarily far: an origin ten
 * boxes away turns a small drag into an unusable orbit. */
function clampOriginFraction(fraction: number): number {
  if (!Number.isFinite(fraction)) return 0.5;
  return Math.round(Math.min(4, Math.max(-3, fraction)) * 10_000) / 10_000;
}

/** The element's own transform as a 2×2 linear map, in the order the transform
 * formatter authors it: rotate, then skew, then scale. */
export function designTransformLinear(transform: {
  rotate: number;
  scaleX: number;
  scaleY: number;
  skewX: number;
  skewY: number;
}): [number, number, number, number] {
  const radians = (transform.rotate * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const tanX = Math.tan((transform.skewX * Math.PI) / 180);
  const tanY = Math.tan((transform.skewY * Math.PI) / 180);
  // rotate · skew
  const a = cos + -sin * tanY;
  const b = sin + cos * tanY;
  const c = cos * tanX + -sin;
  const d = sin * tanX + cos;
  // · scale
  return [
    a * transform.scaleX,
    b * transform.scaleX,
    c * transform.scaleY,
    d * transform.scaleY,
  ];
}

/** Moving the pivot of an already-transformed element must not move the
 * element. CSS transforms about `transform-origin`, so changing that origin
 * re-places the shape unless this compensating translation is authored with
 * it: the shift is `(I - M)(origin - nextOrigin)` for the element's own
 * transform `M`. Returned in the element's own layout pixels, ready to add to
 * an existing `translate()`. */
export function designOriginTranslationShift(input: {
  /** Untransformed border-box size the origin fractions resolve against. */
  width: number;
  height: number;
  originX: number;
  originY: number;
  nextOriginX: number;
  nextOriginY: number;
  transform: {
    rotate: number;
    scaleX: number;
    scaleY: number;
    skewX: number;
    skewY: number;
  };
}): { x: number; y: number } {
  const [a, b, c, d] = designTransformLinear(input.transform);
  const shiftX = (input.originX - input.nextOriginX) * input.width;
  const shiftY = (input.originY - input.nextOriginY) * input.height;
  return {
    x: shiftX - (a * shiftX + c * shiftY),
    y: shiftY - (b * shiftX + d * shiftY),
  };
}

/** The point a resize gesture holds still, as box fractions, recovered from the
 * rectangle `resizeDesignRect` produced. Reading the anchor back out of that
 * result keeps every rule it owns — minimum size, Shift aspect, Option from
 * center, and the crossed-pointer clamp — intact under rotation. */
export function designResizeAnchor(
  start: DesignCanvasRect,
  next: DesignCanvasRect,
): { x: number; y: number } {
  const axis = (
    startPosition: number,
    startSize: number,
    nextPosition: number,
    nextSize: number,
  ) => {
    const delta = nextSize - startSize;
    if (Math.abs(delta) < 1e-9) return 0;
    const anchor = -(nextPosition - startPosition) / delta;
    return Object.is(anchor, -0) ? 0 : anchor;
  };
  return {
    x: axis(start.x, start.width, next.x, next.width),
    y: axis(start.y, start.height, next.y, next.height),
  };
}

/** Where a rotated box's own top-left corner lands once the resize keeps its
 * anchor pinned. Painted geometry follows `box + rotation · localPoint`, so the
 * box position moves by the rotated growth of the anchored corner. */
export function designRotatedResizeOrigin(input: {
  box: DesignSelectionBox;
  anchor: { x: number; y: number };
  /** Layout border-box size after the resize. */
  width: number;
  height: number;
}): { x: number; y: number } {
  const { box, anchor } = input;
  const shift = rotateVector(
    {
      x: anchor.x * (input.width - box.width) * box.scaleX,
      y: anchor.y * (input.height - box.height) * box.scaleY,
    },
    box.rotation,
  );
  return { x: box.x - shift.x, y: box.y - shift.y };
}

/** The offset a resized element must author on top of its existing position.
 * CSS grows an element away from its own top-left corner and turns it about a
 * pivot that is a fraction of its size, so a transformed element both grows and
 * drifts: `-(M · anchorGrowth) - (I - M)(pivotGrowth)` cancels the drift in the
 * element's own parent coordinates. Reduces to the plain anchor offset when the
 * element carries no transform. */
export function designResizeLayoutOffset(input: {
  anchor: { x: number; y: number };
  /** Pivot as a fraction of the box, matching `transform-origin`. */
  originX: number;
  originY: number;
  /** Layout border-box growth in the element's own axes. */
  deltaWidth: number;
  deltaHeight: number;
  transform: {
    rotate: number;
    scaleX: number;
    scaleY: number;
    skewX: number;
    skewY: number;
  };
}): { x: number; y: number } {
  const [a, b, c, d] = designTransformLinear(input.transform);
  const anchorX = input.anchor.x * input.deltaWidth;
  const anchorY = input.anchor.y * input.deltaHeight;
  const pivotX = input.originX * input.deltaWidth;
  const pivotY = input.originY * input.deltaHeight;
  return {
    x: -(a * anchorX + c * anchorY) - (pivotX - (a * pivotX + c * pivotY)),
    y: -(b * anchorX + d * anchorY) - (pivotY - (b * pivotX + d * pivotY)),
  };
}

/** The four rotation corners, with the glyph rotation that aims each cursor's
 * arc back at the box it turns. */
export const DESIGN_ROTATION_CORNERS = [
  { corner: "nw", x: 0, y: 0, cursorAngle: -45 },
  { corner: "ne", x: 1, y: 0, cursorAngle: 45 },
  { corner: "se", x: 1, y: 1, cursorAngle: 135 },
  { corner: "sw", x: 0, y: 1, cursorAngle: -135 },
] as const;

export type DesignRotationCorner =
  (typeof DESIGN_ROTATION_CORNERS)[number]["corner"];

/** Quantizing the baked angle keeps the browser reusing a small set of decoded
 * cursor images while a rotation drag streams new angles. */
const DESIGN_ROTATION_CURSOR_STEP = 15;

/** A rotation cursor pointing the way the pointer will turn: two opposing
 * curved arrows around the point being turned. CSS has no rotate cursor and
 * cannot transform a cursor image, so the angle is baked into an inline SVG.
 * Its colors are literal percent-encoded values — a cursor image resolves no
 * CSS variables, and `#` must be encoded inside a data URL. */
export function designRotationCursor(degrees: number): string {
  const normalized = Number.isFinite(degrees) ? degrees : 0;
  const angle =
    Math.round(normalized / DESIGN_ROTATION_CURSOR_STEP) *
    DESIGN_ROTATION_CURSOR_STEP;
  // Two 120° arcs of one circle, each ending in a tangential arrowhead.
  const upper = "M6.37 8.75A6.5 6.5 0 0 1 17.63 8.75";
  const lower = "M17.63 15.25A6.5 6.5 0 0 1 6.37 15.25";
  const upperHead = "M19.93 12.73 15.64 9.9 19.62 7.6Z";
  const lowerHead = "M4.07 11.27 8.36 14.1 4.38 16.4Z";
  const svg =
    "<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>" +
    `<g transform='rotate(${angle} 12 12)' stroke-linecap='round' stroke-linejoin='round'>` +
    `<path d='${upper}' fill='none' stroke='%23fff' stroke-width='4.6'/>` +
    `<path d='${lower}' fill='none' stroke='%23fff' stroke-width='4.6'/>` +
    `<path d='${upperHead}' fill='%23fff' stroke='%23fff' stroke-width='3'/>` +
    `<path d='${lowerHead}' fill='%23fff' stroke='%23fff' stroke-width='3'/>` +
    `<path d='${upper}' fill='none' stroke='%23000' stroke-width='1.8'/>` +
    `<path d='${lower}' fill='none' stroke='%23000' stroke-width='1.8'/>` +
    `<path d='${upperHead}' fill='%23000'/>` +
    `<path d='${lowerHead}' fill='%23000'/>` +
    "</g></svg>";
  return `url("data:image/svg+xml,${svg}") 12 12, crosshair`;
}

/** Convert two screen-space pointer rays into a stable signed rotation. The
 * seam normalization prevents a drag across -180°/180° from jumping a full
 * turn; an optional interval implements design-tool Shift snapping. */
export function designPointerRotation(
  center: { x: number; y: number },
  start: { x: number; y: number },
  current: { x: number; y: number },
  snapInterval = 0,
): number {
  const degrees = (point: { x: number; y: number }) =>
    (Math.atan2(point.y - center.y, point.x - center.x) * 180) / Math.PI;
  const raw = degrees(current) - degrees(start);
  const normalized = ((raw + 540) % 360) - 180;
  if (snapInterval <= 0) return normalized;
  return Math.round(normalized / snapInterval) * snapInterval;
}

/** Reconcile a direct-DOM drag preview with the engine's authoritative result.
 * Even a commit equal to the pre-drag geometry must repaint: React sees no prop
 * change in that clamp case and therefore cannot repair the preview itself. */
export async function settleDesignFrameGesture<T>(
  commit: Promise<T>,
  start: T,
  paint: (geometry: T) => void,
): Promise<T> {
  try {
    const committed = await commit;
    paint(committed);
    return committed;
  } catch (error) {
    paint(start);
    throw error;
  }
}

/** Keep the world point beneath a screen-space pointer fixed while zooming. */
export function zoomDesignViewportAtPoint(
  viewport: DesignViewport,
  nextZoom: number,
  point: { x: number; y: number },
): DesignViewport {
  const zoom = clampDesignZoom(nextZoom);
  const worldX = (point.x - viewport.panX) / viewport.zoom;
  const worldY = (point.y - viewport.panY) / viewport.zoom;
  return {
    zoom,
    panX: point.x - worldX * zoom,
    panY: point.y - worldY * zoom,
  };
}

/** Normalize WheelEvent deltas before applying one shared exponential zoom
 * curve. Chromium reports trackpad pinch in pixels with ctrlKey, while mouse
 * wheels may report line or page units. */
export function designWheelDeltaPixels(
  delta: number,
  deltaMode: number,
  pageSize: number,
): number {
  if (!Number.isFinite(delta)) return 0;
  const multiplier =
    deltaMode === 1 ? 16 : deltaMode === 2 ? Math.max(1, pageSize) : 1;
  return delta * multiplier;
}

/** Chromium encodes a trackpad pinch as a ctrl-modified wheel event whose
 * deltaY approximates -100·ln(scale), so exp(-deltaY / 100) reproduces the
 * native pinch scale and the canvas tracks the fingers 1:1. */
const DESIGN_PINCH_ZOOM_RATE = 0.01;
/** One synthesized pinch update rarely exceeds |deltaY| ≈ 30. The clamp keeps
 * a physical ctrl-scrolled mouse notch (|deltaY| ≈ 120) at a familiar
 * ~1.35× step instead of a disorienting 3× jump per detent. */
const DESIGN_PINCH_ZOOM_MAX_STEP = 0.3;
/** Command-scroll zoom keeps the flatter curve tuned for high-frequency
 * trackpad scroll deltas, which are an order of magnitude larger per event
 * than pinch updates. */
const DESIGN_SCROLL_ZOOM_RATE = 0.002;
const DESIGN_SCROLL_ZOOM_MAX_STEP = 4;

/** Resolve one modifier-wheel event into a multiplicative zoom factor.
 * Pinch and Cmd/Ctrl-scroll share the exponential curve — equal input, equal
 * proximity — but each input device gets the rate its delta scale encodes. */
export function designWheelZoomFactor(event: {
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  metaKey: boolean;
  pageHeight: number;
}): number {
  const pixels = designWheelDeltaPixels(
    event.deltaY,
    event.deltaMode,
    event.pageHeight,
  );
  const pinch = event.ctrlKey && !event.metaKey;
  const exponent = pinch
    ? Math.max(
        -DESIGN_PINCH_ZOOM_MAX_STEP,
        Math.min(DESIGN_PINCH_ZOOM_MAX_STEP, -pixels * DESIGN_PINCH_ZOOM_RATE),
      )
    : Math.max(
        -DESIGN_SCROLL_ZOOM_MAX_STEP,
        Math.min(
          DESIGN_SCROLL_ZOOM_MAX_STEP,
          -pixels * DESIGN_SCROLL_ZOOM_RATE,
        ),
      );
  return Math.exp(exponent);
}

/** Fit one or more frame rectangles without coupling viewport math to React. */
export function fitDesignRects(
  rects: readonly DesignCanvasRect[],
  viewport: DesignViewportSize,
  padding = 64,
): DesignViewport | null {
  if (rects.length === 0 || viewport.width <= 0 || viewport.height <= 0) {
    return null;
  }
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  const contentWidth = Math.max(1, right - left);
  const contentHeight = Math.max(1, bottom - top);
  const availableWidth = Math.max(1, viewport.width - padding * 2);
  const availableHeight = Math.max(1, viewport.height - padding * 2);
  const zoom = clampDesignZoom(
    Math.min(availableWidth / contentWidth, availableHeight / contentHeight),
  );
  return {
    zoom,
    panX: (viewport.width - contentWidth * zoom) / 2 - left * zoom,
    panY: (viewport.height - contentHeight * zoom) / 2 - top * zoom,
  };
}

/** Keep only the closest bounded iframe set live. Far frames can retain a
 * raster snapshot without keeping their document/runtime/observers mounted. */
export function selectLiveDesignFrameFiles(input: {
  frames: readonly DesignCanvasFrameRect[];
  viewport: DesignViewportSize;
  view: DesignViewport;
  selectedFrame: string | null;
  maxLive: number;
  /** Frames whose layer tree is open in the panel. Their runtime is the only
   * thing that can answer with a tree, so this demand ranks with the selection
   * rather than with distance: an open frame parked off-canvas must not stall. */
  requiredFiles?: readonly string[];
}): ReadonlySet<string> {
  const limit = Math.max(1, Math.floor(input.maxLive));
  const worldLeft = -input.view.panX / input.view.zoom;
  const worldTop = -input.view.panY / input.view.zoom;
  const worldWidth = input.viewport.width / input.view.zoom;
  const worldHeight = input.viewport.height / input.view.zoom;
  const centerX = worldLeft + worldWidth / 2;
  const centerY = worldTop + worldHeight / 2;
  const overscanX = worldWidth;
  const overscanY = worldHeight;
  const ranked = input.frames
    .map((frame) => {
      const near =
        frame.x + frame.width >= worldLeft - overscanX &&
        frame.x <= worldLeft + worldWidth + overscanX &&
        frame.y + frame.height >= worldTop - overscanY &&
        frame.y <= worldTop + worldHeight + overscanY;
      const dx = frame.x + frame.width / 2 - centerX;
      const dy = frame.y + frame.height / 2 - centerY;
      return { frame, near, distance: dx * dx + dy * dy };
    })
    .sort(
      (left, right) =>
        Number(right.near) - Number(left.near) ||
        left.distance - right.distance ||
        left.frame.file.localeCompare(right.frame.file),
    );
  const result = new Set<string>();
  if (
    input.selectedFrame &&
    input.frames.some((frame) => frame.file === input.selectedFrame)
  ) {
    result.add(input.selectedFrame);
  }
  for (const file of input.requiredFiles ?? []) {
    if (result.size >= limit) break;
    if (input.frames.some((frame) => frame.file === file)) result.add(file);
  }
  for (const candidate of ranked) {
    if (result.size >= limit) break;
    result.add(candidate.frame.file);
  }
  return result;
}

/** Preserve already-mounted runtimes while their owner surface is hidden.
 * Removed frames are pruned immediately and the explicit bound is enforced,
 * so retained iframes cannot grow with navigation history. */
export function retainLiveDesignFrameFiles(input: {
  previous: ReadonlySet<string>;
  available: readonly string[];
  active: boolean;
  maxLive: number;
  next: ReadonlySet<string>;
}): ReadonlySet<string> {
  const limit = Math.max(1, Math.floor(input.maxLive));
  const allowed = new Set(input.available);
  const source = input.active ? input.next : input.previous;
  const retained = new Set<string>();
  for (const file of source) {
    if (!allowed.has(file)) continue;
    retained.add(file);
    if (retained.size >= limit) break;
  }
  if (
    retained.size === input.previous.size &&
    [...retained].every((file) => input.previous.has(file))
  ) {
    return input.previous;
  }
  return retained;
}

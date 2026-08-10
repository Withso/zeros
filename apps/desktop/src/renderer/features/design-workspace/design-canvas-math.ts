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

export interface DesignSnapResult {
  rect: DesignCanvasRect;
  guides: { x?: number; y?: number };
}

export interface DesignSpacingMeasurement {
  side: "left" | "right" | "top" | "bottom";
  axis: "horizontal" | "vertical";
  x: number;
  y: number;
  length: number;
  distance: number;
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

/** Resolve the closest non-overlapping sibling on each side. The output uses
 * frame-local coordinates so a canvas overlay can draw exact Option/Alt gap
 * feedback without reading layout during pointer movement. */
export function designSpacingMeasurements(
  selected: DesignCanvasRect,
  peers: readonly DesignCanvasRect[],
): DesignSpacingMeasurement[] {
  const selectedRight = selected.x + selected.width;
  const selectedBottom = selected.y + selected.height;
  const candidates = new Map<
    DesignSpacingMeasurement["side"],
    DesignSpacingMeasurement
  >();
  const consider = (measurement: DesignSpacingMeasurement) => {
    if (!Number.isFinite(measurement.distance) || measurement.distance < 0) {
      return;
    }
    const current = candidates.get(measurement.side);
    if (!current || measurement.distance < current.distance) {
      candidates.set(measurement.side, measurement);
    }
  };

  for (const peer of peers) {
    const peerRight = peer.x + peer.width;
    const peerBottom = peer.y + peer.height;
    const verticalStart = Math.max(selected.y, peer.y);
    const verticalEnd = Math.min(selectedBottom, peerBottom);
    const horizontalStart = Math.max(selected.x, peer.x);
    const horizontalEnd = Math.min(selectedRight, peerRight);
    if (verticalEnd >= verticalStart && peerRight <= selected.x) {
      const distance = selected.x - peerRight;
      consider({
        side: "left",
        axis: "horizontal",
        x: peerRight,
        y: (verticalStart + verticalEnd) / 2,
        length: distance,
        distance,
      });
    }
    if (verticalEnd >= verticalStart && peer.x >= selectedRight) {
      const distance = peer.x - selectedRight;
      consider({
        side: "right",
        axis: "horizontal",
        x: selectedRight,
        y: (verticalStart + verticalEnd) / 2,
        length: distance,
        distance,
      });
    }
    if (horizontalEnd >= horizontalStart && peerBottom <= selected.y) {
      const distance = selected.y - peerBottom;
      consider({
        side: "top",
        axis: "vertical",
        x: (horizontalStart + horizontalEnd) / 2,
        y: peerBottom,
        length: distance,
        distance,
      });
    }
    if (horizontalEnd >= horizontalStart && peer.y >= selectedBottom) {
      const distance = peer.y - selectedBottom;
      consider({
        side: "bottom",
        axis: "vertical",
        x: (horizontalStart + horizontalEnd) / 2,
        y: selectedBottom,
        length: distance,
        distance,
      });
    }
  }

  return (["left", "right", "top", "bottom"] as const).flatMap((side) => {
    const measurement = candidates.get(side);
    return measurement ? [measurement] : [];
  });
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

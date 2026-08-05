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

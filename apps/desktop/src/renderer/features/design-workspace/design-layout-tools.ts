import type { DesignCanvasRect } from "./design-canvas-math";

/** Geometry for the canvas's direct layout tools — padding bands, gap
 * gutters, grid tracks, constraint runs and the size badge — in the selection
 * overlay's own coordinate space.
 *
 * The overlay is the owner's border box: it is placed at the box origin, sized
 * `box.width * scaleX` by `box.height * scaleY`, and turned by the accumulated
 * rotation. Everything here is therefore "local": left/top of the border box
 * is (0, 0), and the axes follow the element rather than the screen. Computed
 * CSS lengths are layout pixels, so they are multiplied by the box scale on
 * the way in and divided by it on the way out. */

export type DesignPaddingSide = "top" | "right" | "bottom" | "left";
export type DesignPaddingProperty = `padding-${DesignPaddingSide}`;

export interface DesignBoxEdges {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface DesignLayoutToolScale {
  x: number;
  y: number;
}

const UNIT_SCALE: DesignLayoutToolScale = { x: 1, y: 1 };

/** A computed length in pixels, or null for anything that is not one (`auto`,
 * `normal`, a percentage the browser kept, an unresolved expression). */
export function designLayoutPixels(value: string | undefined): number | null {
  const match = /^(-?\d*\.?\d+(?:e-?\d+)?)px$/i.exec(value?.trim() ?? "");
  if (!match?.[1]) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

const nonNegative = (value: string | undefined) =>
  Math.max(0, designLayoutPixels(value) ?? 0);

function safeScale(scale: DesignLayoutToolScale | undefined) {
  const axis = (value: number | undefined) =>
    Number.isFinite(value) && (value ?? 0) > 0 ? value! : 1;
  return { x: axis(scale?.x), y: axis(scale?.y) };
}

/** Border and padding widths in local pixels. */
export function designLayoutBoxEdges(
  styles: Record<string, string>,
  scale: DesignLayoutToolScale = UNIT_SCALE,
): { border: DesignBoxEdges; padding: DesignBoxEdges } {
  const { x, y } = safeScale(scale);
  return {
    border: {
      top: nonNegative(styles.borderTopWidth) * y,
      right: nonNegative(styles.borderRightWidth) * x,
      bottom: nonNegative(styles.borderBottomWidth) * y,
      left: nonNegative(styles.borderLeftWidth) * x,
    },
    padding: {
      top: nonNegative(styles.paddingTop) * y,
      right: nonNegative(styles.paddingRight) * x,
      bottom: nonNegative(styles.paddingBottom) * y,
      left: nonNegative(styles.paddingLeft) * x,
    },
  };
}

export interface DesignPaddingBand {
  side: DesignPaddingSide;
  property: DesignPaddingProperty;
  opposite: DesignPaddingProperty;
  /** The CSS value in layout pixels — what the label reads and a drag edits. */
  value: number;
  /** The painted band: from the inner border edge to the content edge. Zero
   * padding leaves a zero-thickness band that still has a handle. */
  rect: DesignCanvasRect;
  /** Center of the band, where its handle sits. */
  handle: { x: number; y: number };
  /** Local axis a drag reads, and the sign that grows the padding. */
  axis: "x" | "y";
  direction: 1 | -1;
}

const OPPOSITE_SIDE: Record<DesignPaddingSide, DesignPaddingSide> = {
  top: "bottom",
  right: "left",
  bottom: "top",
  left: "right",
};

/** The four padding bands of a border box. Bands start inside the border —
 * a border is not padding — and keep their full measured depth: a 400px left
 * padding in a 600px box is drawn 400px deep, never capped at half the box. */
export function designPaddingBands(input: {
  width: number;
  height: number;
  styles: Record<string, string>;
  scale?: DesignLayoutToolScale;
}): DesignPaddingBand[] {
  const width = Math.max(0, input.width);
  const height = Math.max(0, input.height);
  const { border, padding } = designLayoutBoxEdges(input.styles, input.scale);
  const innerWidth = Math.max(0, width - border.left - border.right);
  const innerHeight = Math.max(0, height - border.top - border.bottom);
  const depth = {
    top: Math.min(padding.top, innerHeight),
    right: Math.min(padding.right, innerWidth),
    bottom: Math.min(padding.bottom, innerHeight),
    left: Math.min(padding.left, innerWidth),
  };
  const values = {
    top: nonNegative(input.styles.paddingTop),
    right: nonNegative(input.styles.paddingRight),
    bottom: nonNegative(input.styles.paddingBottom),
    left: nonNegative(input.styles.paddingLeft),
  };
  const band = (
    side: DesignPaddingSide,
    rect: DesignCanvasRect,
    axis: "x" | "y",
    direction: 1 | -1,
  ): DesignPaddingBand => ({
    side,
    property: `padding-${side}`,
    opposite: `padding-${OPPOSITE_SIDE[side]}`,
    value: values[side],
    rect,
    handle: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
    axis,
    direction,
  });
  return [
    band(
      "top",
      { x: border.left, y: border.top, width: innerWidth, height: depth.top },
      "y",
      1,
    ),
    band(
      "right",
      {
        x: width - border.right - depth.right,
        y: border.top,
        width: depth.right,
        height: innerHeight,
      },
      "x",
      -1,
    ),
    band(
      "bottom",
      {
        x: border.left,
        y: height - border.bottom - depth.bottom,
        width: innerWidth,
        height: depth.bottom,
      },
      "y",
      -1,
    ),
    band(
      "left",
      {
        x: border.left,
        y: border.top,
        width: depth.left,
        height: innerHeight,
      },
      "x",
      1,
    ),
  ];
}

/** The band under a local point. Where two bands meet in a corner the one
 * whose outer edge is nearer wins, so the corner splits along its diagonal
 * the way the pointer approached it. */
export function designPaddingBandAtPoint(
  bands: readonly DesignPaddingBand[],
  point: { x: number; y: number },
): DesignPaddingBand | null {
  let best: DesignPaddingBand | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const band of bands) {
    const { x, y, width, height } = band.rect;
    if (width <= 0 || height <= 0) continue;
    if (
      point.x < x ||
      point.x > x + width ||
      point.y < y ||
      point.y > y + height
    ) {
      continue;
    }
    const distance =
      band.side === "top"
        ? point.y - y
        : band.side === "bottom"
          ? y + height - point.y
          : band.side === "left"
            ? point.x - x
            : x + width - point.x;
    if (distance < bestDistance) {
      best = band;
      bestDistance = distance;
    }
  }
  return best;
}

/** Map a direct child's box into its container's local coordinates. The
 * runtime reports frame-space bounding boxes; while the container is upright
 * and unscaled that is exact. A turned or scaled container needs the child's
 * untransformed layout box, which newer runtimes send as `local` (relative to
 * the container's padding box). Older runtimes fall back to inverting the
 * rotation, exact at quarter turns and approximate between them. */
export function designLayoutChildLocalRect(
  child: {
    rect: DesignCanvasRect;
    local?: DesignCanvasRect;
  },
  container: {
    rect: DesignCanvasRect;
    box?: {
      x: number;
      y: number;
      rotation: number;
      scaleX: number;
      scaleY: number;
    };
    styles: Record<string, string>;
  },
): DesignCanvasRect {
  const box = container.box;
  const rotation = box ? normalizedDegrees(box.rotation) : 0;
  const scale = safeScale({ x: box?.scaleX ?? 1, y: box?.scaleY ?? 1 });
  const transformed =
    Math.abs(rotation) > 0.01 ||
    Math.abs(scale.x - 1) > 0.0001 ||
    Math.abs(scale.y - 1) > 0.0001;
  if (!box || !transformed) {
    return {
      x: child.rect.x - container.rect.x,
      y: child.rect.y - container.rect.y,
      width: child.rect.width,
      height: child.rect.height,
    };
  }
  if (child.local) {
    const { border } = designLayoutBoxEdges(container.styles);
    return {
      x: (child.local.x + border.left) * scale.x,
      y: (child.local.y + border.top) * scale.y,
      width: child.local.width * scale.x,
      height: child.local.height * scale.y,
    };
  }
  const radians = (rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const centerX = child.rect.x + child.rect.width / 2 - box.x;
  const centerY = child.rect.y + child.rect.height / 2 - box.y;
  // Inverse rotation of the child's center into the container's axes.
  const localCenter = {
    x: centerX * cos + centerY * sin,
    y: -centerX * sin + centerY * cos,
  };
  // A rectangle turned by θ spans |cos|w + |sin|h by |sin|w + |cos|h.
  const c = Math.abs(cos);
  const s = Math.abs(sin);
  const determinant = c * c - s * s;
  let width: number;
  let height: number;
  if (Math.abs(determinant) > 0.2) {
    width = (c * child.rect.width - s * child.rect.height) / determinant;
    height = (c * child.rect.height - s * child.rect.width) / determinant;
  } else {
    // Near 45° the spans no longer tell width from height.
    width = height = Math.min(child.rect.width, child.rect.height) / Math.SQRT2;
  }
  width = Math.max(0, width);
  height = Math.max(0, height);
  return {
    x: localCenter.x - width / 2,
    y: localCenter.y - height / 2,
    width,
    height,
  };
}

function normalizedDegrees(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const turned = ((value % 360) + 360) % 360;
  return turned > 180 ? turned - 360 : turned;
}

/** Project a screen-pixel pointer delta onto one local axis of a turned,
 * scaled box, in layout pixels. Dragging a padding handle of a box rotated
 * 90° therefore follows the handle, not the screen's x axis. */
export function designLocalAxisDelta(input: {
  dx: number;
  dy: number;
  axis: "x" | "y";
  rotation?: number;
  zoom: number;
  scale?: DesignLayoutToolScale;
}): number {
  const zoom = Number.isFinite(input.zoom) && input.zoom > 0 ? input.zoom : 1;
  const radians = (normalizedDegrees(input.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const scale = safeScale(input.scale);
  const frameX = input.dx / zoom;
  const frameY = input.dy / zoom;
  return input.axis === "x"
    ? (frameX * cos + frameY * sin) / scale.x
    : (-frameX * sin + frameY * cos) / scale.y;
}

/** The resize cursor that points along a turned local axis. */
export function designLocalAxisCursor(
  axis: "x" | "y",
  rotation = 0,
): "ew-resize" | "ns-resize" | "nwse-resize" | "nesw-resize" {
  const angle =
    ((((axis === "x" ? 0 : 90) + normalizedDegrees(rotation)) % 180) + 180) %
    180;
  const sector = Math.round(angle / 45) % 4;
  return sector === 0
    ? "ew-resize"
    : sector === 1
      ? "nwse-resize"
      : sector === 2
        ? "ns-resize"
        : "nesw-resize";
}

/** How a spacing drag or entry spreads. Figma's documented contract: Option
 * sets the opposite side too, Shift+Option all four sides, and Shift alone is
 * the big nudge. Shift is not also a nudge while it means "all sides". */
export function designSpacingModifiers(
  modifiers: { altKey: boolean; shiftKey: boolean },
  padding: boolean,
): { mirror: "none" | "opposite" | "all"; step: number } {
  if (padding && modifiers.altKey) {
    return { mirror: modifiers.shiftKey ? "all" : "opposite", step: 1 };
  }
  return { mirror: "none", step: modifiers.shiftKey ? 10 : 1 };
}

export const DESIGN_SPACING_DRAG_THRESHOLD = 3;

/** One spacing value from a drag. Values stay whole pixels at the normal step
 * and snap to the big-nudge step when requested; CSS padding and gaps cannot
 * be negative. */
export function designSpacingDragValue(input: {
  start: number;
  delta: number;
  direction: 1 | -1;
  step: number;
}): number {
  const step = Number.isFinite(input.step) && input.step > 0 ? input.step : 1;
  // A drag back to its origin keeps the exact authored value (20.5 stays
  // 20.5, 23 does not snap to 20): nothing moved, so nothing is rewritten.
  if (Math.abs(input.delta) < 0.5) return Math.max(0, input.start);
  const raw = Math.max(0, input.start + input.delta * input.direction);
  return Math.max(0, Math.round(raw / step) * step);
}

// --- GAPS ---

export type DesignGapProperty = "row-gap" | "column-gap";

export interface DesignLayoutGapChild {
  id: string;
  /** Local rect (see `designLayoutChildLocalRect`). */
  rect: DesignCanvasRect;
  position?: string;
  /** Used margins, local pixels. Part of the space between two boxes that is
   * not gap. */
  margins?: DesignBoxEdges;
  /** CSS `order`: flex lays items out in order-modified document order. */
  order?: number;
}

export interface DesignLayoutGap extends DesignCanvasRect {
  key: string;
  /** The CSS longhand that owns this space. A row's items are separated by
   * `column-gap`; its lines by `row-gap`. */
  property: DesignGapProperty;
  /** Local axis across the gap: a drag along it changes the value. */
  axis: "x" | "y";
  /** Rendered size of the space, which Auto distribution can make larger than
   * the authored gap. */
  size: number;
  /** The part of `size` that belongs to the neighbors' margins. */
  margin: number;
  leadingId: string | null;
  trailingId: string | null;
}

const GAP_EPSILON = 0.5;
const GAP_CHILD_LIMIT = 64;

function participates(child: DesignLayoutGapChild): boolean {
  const { x, y, width, height } = child.rect;
  return (
    child.position !== "absolute" &&
    child.position !== "fixed" &&
    [x, y, width, height].every(Number.isFinite) &&
    width >= 0 &&
    height >= 0 &&
    width + height > 0
  );
}

const rounded = (value: number) => Math.round(value * 10) / 10;

/** Split flow items into flex lines. Items arrive in document order, and a
 * line fills from its main-start edge: a wrap is where an item starts behind
 * the one before it. Cross-axis overlap is no test — items aligned to opposite
 * cross edges of one stretched line need not overlap at all. */
function flexLines(
  items: readonly DesignLayoutGapChild[],
  mainAxis: "x" | "y",
  forward: boolean,
): DesignLayoutGapChild[][] {
  const start = (item: DesignLayoutGapChild) =>
    mainAxis === "x" ? item.rect.x : item.rect.y;
  const end = (item: DesignLayoutGapChild) =>
    start(item) + (mainAxis === "x" ? item.rect.width : item.rect.height);
  const lines: DesignLayoutGapChild[][] = [];
  let current: DesignLayoutGapChild[] = [];
  for (const item of items) {
    const previous = current.at(-1);
    const wrapped =
      previous !== undefined &&
      (forward
        ? start(item) < end(previous) - GAP_EPSILON
        : end(item) > start(previous) + GAP_EPSILON);
    if (wrapped) {
      lines.push(current);
      current = [];
    }
    current.push(item);
  }
  if (current.length) lines.push(current);
  return lines;
}

/** The spaces between a flex container's items and, when it wraps, between
 * its lines. Regions come from the browser's rendered boxes, so margins and
 * distribution show up as the real space they are; `size` reports it. */
export function designFlexGaps(input: {
  /** Local content box. */
  content: DesignCanvasRect;
  children: readonly DesignLayoutGapChild[];
  flexDirection?: string;
  flexWrap?: string;
  /** CSS `direction`; a right-to-left row fills from the right. */
  direction?: string;
}): DesignLayoutGap[] {
  // Flex places items in order-modified document order (stable by `order`).
  const items = input.children
    .filter(participates)
    .slice(0, GAP_CHILD_LIMIT)
    .map((item, index) => ({ item, index }))
    .sort(
      (left, right) =>
        (left.item.order ?? 0) - (right.item.order ?? 0) ||
        left.index - right.index,
    )
    .map(({ item }) => item);
  if (items.length === 0) return [];
  const flow = (input.flexDirection ?? "row").trim();
  const row = !flow.startsWith("column");
  const mainAxis: "x" | "y" = row ? "x" : "y";
  const crossAxis: "x" | "y" = row ? "y" : "x";
  const wraps = (input.flexWrap ?? "nowrap") !== "nowrap";
  const rtl = row && (input.direction ?? "ltr").trim() === "rtl";
  const forward = flow.endsWith("-reverse") === rtl;
  const lines = wraps ? flexLines(items, mainAxis, forward) : [items];
  const start = (rect: DesignCanvasRect, axis: "x" | "y") =>
    axis === "x" ? rect.x : rect.y;
  const size = (rect: DesignCanvasRect, axis: "x" | "y") =>
    axis === "x" ? rect.width : rect.height;
  const end = (rect: DesignCanvasRect, axis: "x" | "y") =>
    start(rect, axis) + size(rect, axis);
  const regions: DesignLayoutGap[] = [];
  const region = (
    key: string,
    property: DesignGapProperty,
    axis: "x" | "y",
    along: { start: number; end: number },
    across: { start: number; end: number },
    leadingId: string | null,
    trailingId: string | null,
    margin = 0,
  ) => {
    const main = rounded(Math.max(0, along.end - along.start));
    const cross = rounded(Math.max(0, across.end - across.start));
    regions.push({
      key,
      property,
      axis,
      x: rounded(axis === "x" ? along.start : across.start),
      y: rounded(axis === "x" ? across.start : along.start),
      width: axis === "x" ? main : cross,
      height: axis === "x" ? cross : main,
      size: main,
      // Signed: a negative margin pulls a neighbor into the gutter.
      margin: rounded(Math.min(main, margin)),
      leadingId,
      trailingId,
    });
  };
  const marginAfter = (item: DesignLayoutGapChild, axis: "x" | "y") =>
    axis === "x" ? (item.margins?.right ?? 0) : (item.margins?.bottom ?? 0);
  const marginBefore = (item: DesignLayoutGapChild, axis: "x" | "y") =>
    axis === "x" ? (item.margins?.left ?? 0) : (item.margins?.top ?? 0);
  const mainProperty: DesignGapProperty = row ? "column-gap" : "row-gap";
  const crossProperty: DesignGapProperty = row ? "row-gap" : "column-gap";
  const lineSpans = lines
    .map((line) => ({
      items: [...line].sort(
        (left, right) =>
          start(left.rect, mainAxis) - start(right.rect, mainAxis) ||
          left.id.localeCompare(right.id),
      ),
      crossStart: Math.min(...line.map((item) => start(item.rect, crossAxis))),
      crossEnd: Math.max(...line.map((item) => end(item.rect, crossAxis))),
      // A line box spans its items' margin boxes; the gap is between those.
      outerStart: Math.min(
        ...line.map(
          (item) => start(item.rect, crossAxis) - marginBefore(item, crossAxis),
        ),
      ),
      outerEnd: Math.max(
        ...line.map(
          (item) => end(item.rect, crossAxis) + marginAfter(item, crossAxis),
        ),
      ),
    }))
    .sort((left, right) => left.crossStart - right.crossStart);
  for (const line of lineSpans) {
    for (let index = 1; index < line.items.length; index += 1) {
      const leading = line.items[index - 1]!;
      const trailing = line.items[index]!;
      const gapStart = end(leading.rect, mainAxis);
      const gapEnd = start(trailing.rect, mainAxis);
      // Overlapping items (negative margins) leave no space to edit.
      if (gapEnd < gapStart - GAP_EPSILON) continue;
      region(
        `${mainAxis}:${leading.id}:${trailing.id}`,
        mainProperty,
        mainAxis,
        { start: gapStart, end: Math.max(gapStart, gapEnd) },
        { start: line.crossStart, end: line.crossEnd },
        leading.id,
        trailing.id,
        marginAfter(leading, mainAxis) + marginBefore(trailing, mainAxis),
      );
    }
  }
  if (wraps) {
    const contentMainStart = start(input.content, mainAxis);
    const contentMainEnd = end(input.content, mainAxis);
    for (let index = 1; index < lineSpans.length; index += 1) {
      const leading = lineSpans[index - 1]!;
      const trailing = lineSpans[index]!;
      if (trailing.crossStart < leading.crossEnd - GAP_EPSILON) continue;
      region(
        `${crossAxis}:line:${index - 1}:${index}`,
        crossProperty,
        crossAxis,
        {
          start: leading.crossEnd,
          end: Math.max(leading.crossEnd, trailing.crossStart),
        },
        { start: contentMainStart, end: contentMainEnd },
        leading.items[0]?.id ?? null,
        trailing.items[0]?.id ?? null,
        leading.outerEnd -
          leading.crossEnd +
          (trailing.crossStart - trailing.outerStart),
      );
    }
  }
  return regions;
}

export interface DesignGridTrack {
  /** Local start along the axis. */
  start: number;
  size: number;
  /** Layout pixels, for the label. */
  value: number;
}

export interface DesignGridTrackLayout {
  tracks: DesignGridTrack[];
  /** Spaces between consecutive tracks: the gutter plus any distributed free
   * space. */
  gutters: Array<{ start: number; size: number }>;
}

function templateTokens(value: string): string[] {
  const tokens: string[] = [];
  let depth = 0;
  let bracket = 0;
  let current = "";
  for (const character of value) {
    if (character === "(") depth += 1;
    else if (character === ")") depth = Math.max(0, depth - 1);
    else if (character === "[") bracket += 1;
    else if (character === "]") bracket = Math.max(0, bracket - 1);
    if (/\s/.test(character) && depth === 0 && bracket === 0) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (current) tokens.push(current);
  // Named lines are boundaries, not tracks.
  return tokens.filter((token) => !token.startsWith("["));
}

/** Resolved track sizes in layout pixels. Browsers serialize a grid
 * container's computed template as the used track sizes, so this is exact for
 * a laid-out grid. Anything else — `repeat()`, `fr`, `minmax()` from a source
 * that has not been laid out — is not guessed at. */
export function designGridTrackSizes(
  template: string | undefined,
): number[] | null {
  const source = template?.trim() ?? "";
  if (!source || source === "none") return null;
  const sizes = templateTokens(source).map(designLayoutPixels);
  if (sizes.length === 0 || sizes.length > 64) return null;
  if (sizes.some((size) => size === null || size < 0)) return null;
  return sizes as number[];
}

/** Place a grid axis's tracks inside its content box, including the space a
 * `justify-content`/`align-content` distribution adds between them. */
export function designGridTrackLayout(input: {
  template: string | undefined;
  gap: number;
  /** Local start and size of the content box on this axis. */
  contentStart: number;
  contentSize: number;
  distribution?: string;
  scale?: number;
}): DesignGridTrackLayout | null {
  const sizes = designGridTrackSizes(input.template);
  if (!sizes) return null;
  const scale =
    Number.isFinite(input.scale) && (input.scale ?? 0) > 0 ? input.scale! : 1;
  const gap = Math.max(0, Number.isFinite(input.gap) ? input.gap : 0) * scale;
  const scaled = sizes.map((size) => size * scale);
  const count = scaled.length;
  const used = scaled.reduce((sum, size) => sum + size, 0) + gap * (count - 1);
  const free = input.contentSize - used;
  const distribution = (input.distribution ?? "normal").replace(
    /^(safe|unsafe)\s+/,
    "",
  );
  let offset = 0;
  let extra = 0;
  if (free > 0) {
    if (distribution === "space-between") {
      extra = count > 1 ? free / (count - 1) : 0;
    } else if (distribution === "space-around") {
      extra = free / count;
      offset = extra / 2;
    } else if (distribution === "space-evenly") {
      extra = free / (count + 1);
      offset = extra;
    } else if (distribution === "center") {
      offset = free / 2;
    } else if (["end", "flex-end", "right"].includes(distribution)) {
      offset = free;
    }
  } else if (
    ["center", "space-around", "space-evenly"].includes(distribution)
  ) {
    offset = free / 2;
  } else if (["end", "flex-end", "right"].includes(distribution)) {
    offset = free;
  }
  const tracks: DesignGridTrack[] = [];
  const gutters: Array<{ start: number; size: number }> = [];
  let cursor = input.contentStart + offset;
  scaled.forEach((size, index) => {
    if (index > 0) {
      gutters.push({ start: rounded(cursor), size: rounded(gap + extra) });
      cursor += gap + extra;
    }
    tracks.push({
      start: rounded(cursor),
      size: rounded(size),
      value: sizes[index]!,
    });
    cursor += size;
  });
  return { tracks, gutters };
}

/** Grid gutters as editable regions: each column gutter spans the rows, each
 * row gutter the columns. Unlike child pairs, this holds for empty cells and
 * spanning items. */
export function designGridGaps(input: {
  columns: DesignGridTrackLayout | null;
  rows: DesignGridTrackLayout | null;
  content: DesignCanvasRect;
}): DesignLayoutGap[] {
  const regions: DesignLayoutGap[] = [];
  const columnSpan = input.rows?.tracks.length
    ? {
        start: input.rows.tracks[0]!.start,
        end: input.rows.tracks.at(-1)!.start + input.rows.tracks.at(-1)!.size,
      }
    : { start: input.content.y, end: input.content.y + input.content.height };
  const rowSpan = input.columns?.tracks.length
    ? {
        start: input.columns.tracks[0]!.start,
        end:
          input.columns.tracks.at(-1)!.start +
          input.columns.tracks.at(-1)!.size,
      }
    : { start: input.content.x, end: input.content.x + input.content.width };
  input.columns?.gutters.forEach((gutter, index) => {
    regions.push({
      key: `x:track:${index}`,
      property: "column-gap",
      axis: "x",
      x: gutter.start,
      y: rounded(columnSpan.start),
      width: gutter.size,
      height: rounded(Math.max(0, columnSpan.end - columnSpan.start)),
      size: gutter.size,
      margin: 0,
      leadingId: null,
      trailingId: null,
    });
  });
  input.rows?.gutters.forEach((gutter, index) => {
    regions.push({
      key: `y:track:${index}`,
      property: "row-gap",
      axis: "y",
      x: rounded(rowSpan.start),
      y: gutter.start,
      width: rounded(Math.max(0, rowSpan.end - rowSpan.start)),
      height: gutter.size,
      size: gutter.size,
      margin: 0,
      leadingId: null,
      trailingId: null,
    });
  });
  return regions;
}

/** Whether a gap axis is distributed ("Auto"): the rendered space comes from
 * `justify-content`/`align-content`, not the gap value. Dragging such a gap is
 * a request for fixed spacing, so `reset` releases that axis's distribution
 * and the drag starts from the space the user can see. */
export function designGapDistribution(input: {
  display: string | undefined;
  flexDirection?: string;
  flexWrap?: string;
  justifyContent?: string;
  alignContent?: string;
  property: DesignGapProperty;
}): { automatic: boolean; reset: Record<string, string> } {
  const distributed = (value: string | undefined) =>
    ["space-between", "space-around", "space-evenly"].includes(
      (value ?? "").replace(/^(safe|unsafe)\s+/, ""),
    );
  const display = input.display?.trim() ?? "";
  if (display === "grid" || display === "inline-grid") {
    return input.property === "column-gap"
      ? distributed(input.justifyContent)
        ? { automatic: true, reset: { "justify-content": "start" } }
        : { automatic: false, reset: {} }
      : distributed(input.alignContent)
        ? { automatic: true, reset: { "align-content": "start" } }
        : { automatic: false, reset: {} };
  }
  if (display !== "flex" && display !== "inline-flex") {
    return { automatic: false, reset: {} };
  }
  const row = !(input.flexDirection ?? "row").startsWith("column");
  const mainProperty: DesignGapProperty = row ? "column-gap" : "row-gap";
  if (input.property === mainProperty) {
    return distributed(input.justifyContent)
      ? { automatic: true, reset: { "justify-content": "flex-start" } }
      : { automatic: false, reset: {} };
  }
  return (input.flexWrap ?? "nowrap") !== "nowrap" &&
    distributed(input.alignContent)
    ? { automatic: true, reset: { "align-content": "flex-start" } }
    : { automatic: false, reset: {} };
}

/** A gap's used length in layout pixels: a plain length, `normal` (0 in flex
 * and grid), or a percentage of the content box on its axis. Null when only
 * layout can resolve it (`calc()`), so callers use the rendered space. */
export function designGapUsedValue(
  styles: Record<string, string>,
  property: DesignGapProperty,
  reference: number,
): number | null {
  const value = (property === "row-gap" ? styles.rowGap : styles.columnGap)
    ?.trim()
    .toLowerCase();
  if (!value || value === "normal") return 0;
  const pixels = designLayoutPixels(value);
  if (pixels !== null) return Math.max(0, pixels);
  const percent = /^(-?\d*\.?\d+)%$/.exec(value);
  if (percent?.[1] && Number.isFinite(reference)) {
    return Math.max(0, (Number(percent[1]) / 100) * reference);
  }
  return null;
}

/** A gap's CSS value in layout pixels, or null when it is not a plain length
 * (`normal` resolves to 0 for flex and grid; a percentage stays unknown so the
 * caller can start from the rendered space instead of zero). */
export function designGapValue(
  styles: Record<string, string>,
  property: DesignGapProperty,
): number | null {
  const value = (property === "row-gap" ? styles.rowGap : styles.columnGap)
    ?.trim()
    .toLowerCase();
  if (!value || value === "normal") return 0;
  const pixels = designLayoutPixels(value);
  return pixels === null ? null : Math.max(0, pixels);
}

// --- CONSTRAINTS ---

/** Canvas constraint runs describe CSS positioning, not flow. An element laid
 * out by its parent's flex, grid or block flow is placed, not pinned, and a
 * top-level frame has no parent at all; only out-of-flow boxes measured
 * against the parent they are positioned in carry constraints. */
export function designConstraintGuidesApply(input: {
  hasParent: boolean;
  position: string | undefined;
  /** False when the parent is not this box's containing block (an absolute
   * box inside a static parent is positioned against a further ancestor). */
  parentIsContainingBlock?: boolean;
}): boolean {
  if (!input.hasParent) return false;
  const position = (input.position ?? "static").trim();
  if (position !== "absolute" && position !== "fixed") return false;
  return input.parentIsContainingBlock !== false;
}

/** The parent box constraint insets are measured from: its padding box, just
 * inside the border. */
export function designConstraintReferenceRect(
  parent: DesignCanvasRect,
  styles: Record<string, string> | undefined,
): DesignCanvasRect {
  if (!styles) return parent;
  const { border } = designLayoutBoxEdges(styles);
  return {
    x: parent.x + border.left,
    y: parent.y + border.top,
    width: Math.max(0, parent.width - border.left - border.right),
    height: Math.max(0, parent.height - border.top - border.bottom),
  };
}

// --- SIZE BADGE ---

export type DesignSizeBadgeMode = "fixed" | "hug" | "fill" | "custom";

/** `600 × 300`, with a mode word after each dimension that is not a fixed
 * length: `546 × 388 Hug`, `600 Fill × 300 Hug`. */
export function designSizeBadgeText(
  width: number,
  height: number,
  modes?: { x?: DesignSizeBadgeMode; y?: DesignSizeBadgeMode },
): string {
  const part = (value: number, mode: DesignSizeBadgeMode | undefined) => {
    const number = String(Math.round(value));
    if (mode === "hug") return `${number} Hug`;
    if (mode === "fill") return `${number} Fill`;
    return number;
  };
  return `${part(width, modes?.x)} × ${part(height, modes?.y)}`;
}

// --- VISIBILITY ---

/** On-screen size below which a box's spacing handles would crowd its resize
 * chrome; the inspector remains the editor there. */
export const DESIGN_LAYOUT_TOOLS_MIN_SCREEN_SIZE = 48;

export function designLayoutToolsFit(input: {
  width: number;
  height: number;
  zoom: number;
}): boolean {
  const zoom = Number.isFinite(input.zoom) && input.zoom > 0 ? input.zoom : 1;
  return (
    input.width * zoom >= DESIGN_LAYOUT_TOOLS_MIN_SCREEN_SIZE &&
    input.height * zoom >= DESIGN_LAYOUT_TOOLS_MIN_SCREEN_SIZE
  );
}

// --- MODEL ---

/** Which way along its axis a gap drag grows the gap. The far side of a gap
 * is the side that moves when it grows, so the handle follows the pointer:
 * items packed at the start push the trailing side outward (drag toward the
 * end), items packed at the end push the leading side (drag toward the
 * start). Reversed flows and wrap-reverse mirror the packing edge. */
export function designGapDragDirection(input: {
  display: string | undefined;
  flexDirection?: string;
  flexWrap?: string;
  justifyContent?: string;
  alignContent?: string;
  /** CSS `direction`: a right-to-left inline axis starts on the right. */
  direction?: string;
  property: DesignGapProperty;
}): 1 | -1 {
  const clean = (value: string | undefined) =>
    (value ?? "normal").replace(/^(safe|unsafe)\s+/, "").trim();
  const rtl = (input.direction ?? "ltr").trim() === "rtl";
  const display = input.display?.trim() ?? "";
  /** Whether items pack against the physical end (right/bottom) of an axis,
   * given where that axis's writing-mode start and flow start lie. */
  const packedAtEnd = (
    alignment: string,
    inline: boolean,
    flowStartAtEnd: boolean,
  ) => {
    if (alignment === "left") return false;
    if (alignment === "right") return true;
    if (alignment === "center") return false;
    if (alignment === "start" || alignment === "self-start")
      return inline && rtl;
    if (alignment === "end" || alignment === "self-end")
      return !(inline && rtl);
    if (alignment === "flex-end") return !flowStartAtEnd;
    // flex-start, normal, stretch, and distributions released to start.
    return flowStartAtEnd;
  };
  if (display === "grid" || display === "inline-grid") {
    const inline = input.property === "column-gap";
    const alignment = clean(inline ? input.justifyContent : input.alignContent);
    return packedAtEnd(alignment, inline, inline && rtl) ? -1 : 1;
  }
  const flow = (input.flexDirection ?? "row").trim();
  const row = !flow.startsWith("column");
  const mainProperty: DesignGapProperty = row ? "column-gap" : "row-gap";
  if (input.property === mainProperty) {
    const flowStartAtEnd = flow.endsWith("-reverse") !== (row && rtl);
    return packedAtEnd(clean(input.justifyContent), row, flowStartAtEnd)
      ? -1
      : 1;
  }
  const crossInline = !row;
  const crossStartAtEnd =
    ((input.flexWrap ?? "nowrap").trim() === "wrap-reverse") !==
    (crossInline && rtl);
  return packedAtEnd(clean(input.alignContent), crossInline, crossStartAtEnd)
    ? -1
    : 1;
}

export interface DesignLayoutToolGap extends DesignLayoutGap {
  /** The value a drag starts from and the label shows: the CSS gap, or the
   * rendered space when the axis is distributed or the gap is not a length. */
  value: number;
  automatic: boolean;
  /** Styles that release a distributed axis when the gap becomes fixed. */
  reset: Record<string, string>;
  direction: 1 | -1;
}

export interface DesignLayoutToolModel {
  kind: "flex" | "grid";
  bands: DesignPaddingBand[];
  gaps: DesignLayoutToolGap[];
  content: DesignCanvasRect;
  columns: DesignGridTrackLayout | null;
  rows: DesignGridTrackLayout | null;
}

/** Everything the canvas draws for one auto-layout owner, from its local
 * border-box size, computed styles and direct children in local space. Null
 * for anything that is not flex or grid: CSS padding exists on every box, but
 * only an auto-layout container arranges children by padding and gap. */
export function designLayoutToolModel(input: {
  width: number;
  height: number;
  styles: Record<string, string>;
  scale?: DesignLayoutToolScale;
  children: readonly DesignLayoutGapChild[];
}): DesignLayoutToolModel | null {
  const display = input.styles.display?.trim() ?? "";
  const grid = display === "grid" || display === "inline-grid";
  const flex = display === "flex" || display === "inline-flex";
  if (!grid && !flex) return null;
  const scale = safeScale(input.scale);
  const bands = designPaddingBands({
    width: input.width,
    height: input.height,
    styles: input.styles,
    scale,
  });
  const { border, padding } = designLayoutBoxEdges(input.styles, scale);
  const content = {
    x: border.left + padding.left,
    y: border.top + padding.top,
    width: Math.max(
      0,
      input.width - border.left - border.right - padding.left - padding.right,
    ),
    height: Math.max(
      0,
      input.height - border.top - border.bottom - padding.top - padding.bottom,
    ),
  };
  let columns: DesignGridTrackLayout | null = null;
  let rows: DesignGridTrackLayout | null = null;
  let regions: DesignLayoutGap[];
  if (grid) {
    // A column-gap percentage resolves against the grid's width. A row-gap
    // percentage of an auto-height grid has no definite basis, so only a
    // plain length is trusted there.
    const columnGap = designGapUsedValue(
      input.styles,
      "column-gap",
      content.width / scale.x,
    );
    const rowGap = designGapValue(input.styles, "row-gap");
    columns = designGridTrackLayout({
      template: input.styles.gridTemplateColumns,
      gap: columnGap ?? 0,
      contentStart: content.x,
      contentSize: content.width,
      distribution: input.styles.justifyContent,
      scale: scale.x,
    });
    rows = designGridTrackLayout({
      template: input.styles.gridTemplateRows,
      gap: rowGap ?? 0,
      contentStart: content.y,
      contentSize: content.height,
      distribution: input.styles.alignContent,
      scale: scale.y,
    });
    // A gutter only layout can size (`calc()`, an indefinite percentage) is
    // not placed by guesswork: that axis draws neither tracks nor gutters.
    if (columnGap === null) columns = null;
    if (rowGap === null) rows = null;
    regions = designGridGaps({ columns, rows, content });
  } else {
    regions = designFlexGaps({
      content,
      children: input.children,
      flexDirection: input.styles.flexDirection,
      flexWrap: input.styles.flexWrap,
      direction: input.styles.direction,
    });
  }
  const gaps = regions.map((region): DesignLayoutToolGap => {
    const distribution = designGapDistribution({
      display,
      flexDirection: input.styles.flexDirection,
      flexWrap: input.styles.flexWrap,
      justifyContent: input.styles.justifyContent,
      alignContent: input.styles.alignContent,
      property: region.property,
    });
    const axisScale = region.axis === "x" ? scale.x : scale.y;
    // Grid gutters are placed from resolved lengths; a flex gap that is not a
    // plain length (a percentage of an auto size, `calc()`) starts from the
    // space the browser actually rendered.
    const authored = grid
      ? region.property === "column-gap"
        ? designGapUsedValue(
            input.styles,
            "column-gap",
            content.width / axisScale,
          )
        : designGapValue(input.styles, "row-gap")
      : designGapValue(input.styles, region.property);
    // The space between two boxes, less their margins, is what a gap owns.
    const rendered = Math.max(0, region.size - region.margin) / axisScale;
    return {
      ...region,
      value:
        distribution.automatic || authored === null
          ? Math.round(rendered * 10) / 10
          : authored,
      automatic: distribution.automatic,
      reset: distribution.reset,
      direction: designGapDragDirection({
        display,
        flexDirection: input.styles.flexDirection,
        flexWrap: input.styles.flexWrap,
        justifyContent: input.styles.justifyContent,
        alignContent: input.styles.alignContent,
        direction: input.styles.direction,
        property: region.property,
      }),
    };
  });
  return { kind: grid ? "grid" : "flex", bands, gaps, content, columns, rows };
}

/** Human names for accessible labels and entry fields. */
export function designSpacingLabel(property: string): string {
  switch (property) {
    case "padding-top":
      return "Top padding";
    case "padding-right":
      return "Right padding";
    case "padding-bottom":
      return "Bottom padding";
    case "padding-left":
      return "Left padding";
    case "row-gap":
      return "Row gap";
    case "column-gap":
      return "Column gap";
    default:
      return "Gap";
  }
}

/** The compact canvas readout: whole pixels, like every other canvas label.
 * Typing shows the exact value (`designSpacingDraft`). */
export function designSpacingReadout(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value)) : "0";
}

/** The exact value an entry field opens with, to two decimals at most. */
export function designSpacingDraft(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return String(Math.round(value * 100) / 100);
}

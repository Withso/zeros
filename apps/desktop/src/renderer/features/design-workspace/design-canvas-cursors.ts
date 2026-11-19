/** Figma's canvas cursors. CSS has no rotate cursor, cannot turn a cursor
 * image and resolves no variables inside one, so each glyph is an inline SVG
 * with its angle baked in and literal colors (`#` percent-encoded, as a data
 * URL requires). Every image names itself with an `id` so a computed `cursor`
 * says which glyph and angle the browser was handed. */

/** Quantizing a baked angle keeps the browser reusing a small set of decoded
 * cursor images while a drag streams new angles. */
const DESIGN_CURSOR_ANGLE_STEP = 15;

const DESIGN_CURSOR_SHADOW =
  "<filter id='s' x='-50%' y='-50%' width='200%' height='200%'>" +
  "<feDropShadow dx='0' dy='1' stdDeviation='1' flood-color='%23000' flood-opacity='0.35'/>" +
  "</filter>";

function designSvgCursor(
  id: string,
  body: string,
  hotspot: { x: number; y: number },
  fallback: string,
): string {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' id='${id}' width='32' height='32' viewBox='0 0 32 32'>` +
    `<defs>${DESIGN_CURSOR_SHADOW}</defs><g filter='url(%23s)'>${body}</g></svg>`;
  return `url("data:image/svg+xml,${svg}") ${hotspot.x} ${hotspot.y}, ${fallback}`;
}

function quantizedDegrees(degrees: number, period: number): number {
  const finite = Number.isFinite(degrees) ? degrees : 0;
  const step =
    Math.round(finite / DESIGN_CURSOR_ANGLE_STEP) * DESIGN_CURSOR_ANGLE_STEP;
  return ((step % period) + period) % period;
}

// Figma's head at the macOS arrow's size: about 11 by 17 points outlined.
const ARROW = "M5 4 14 11.3 9.5 13.5 7 18.5Z";

/** The canvas arrow: a dark grey head in a thick white outline, tip top left. */
export const DESIGN_ARROW_CURSOR = designSvgCursor(
  "zd-cursor-arrow",
  `<path d='${ARROW}' fill='%23fff' stroke='%23fff' stroke-width='2.5' stroke-linejoin='round'/>` +
    `<path d='${ARROW}' fill='%23333' stroke='%23333' stroke-width='0.6' stroke-linejoin='round'/>`,
  { x: 5, y: 4 },
  "default",
);

// The macOS resize cursors' proportions: 22 points long, 6-point heads.
const RESIZE = "M6 16 11.5 13V15.1H20.5V13L26 16 20.5 19V16.9H11.5V19Z";
const RESIZE_KEYWORDS = ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"] as const;

/** A double-headed resize arrow along a screen direction: 0° is horizontal,
 * 90° vertical and 45° runs from the top left to the bottom right. */
export function designResizeCursor(degrees: number): string {
  const angle = quantizedDegrees(degrees, 180);
  return designSvgCursor(
    `zd-cursor-resize-${angle}`,
    `<g transform='rotate(${angle} 16 16)'>` +
      `<path d='${RESIZE}' fill='%23fff' stroke='%23fff' stroke-width='2.5' stroke-linejoin='round'/>` +
      `<path d='${RESIZE}' fill='%23000'/></g>`,
    { x: 16, y: 16 },
    RESIZE_KEYWORDS[Math.round(angle / 45) % 4]!,
  );
}

// A quarter arc wrapping the north-west corner, an arrowhead at each end.
const ROTATE_ARC = "M12 18V16A4 4 0 0 1 16 12H18";
const ROTATE_HEADS = ["M9.5 18H14.5L12 22Z", "M18 9.5V14.5L22 12Z"];

/** The rotation cursor for a corner whose screen direction from the box
 * centre, a quarter turn on, is `degrees`: -45° is an upright box's
 * north-west corner, 45° its north-east. The arc wraps that corner. */
export function designRotationCursor(degrees: number): string {
  const angle = quantizedDegrees(degrees + 45, 360);
  const heads = (paint: string) =>
    ROTATE_HEADS.map((head) => `<path d='${head}' ${paint}/>`).join("");
  return designSvgCursor(
    `zd-cursor-rotate-${angle}`,
    `<g transform='rotate(${angle} 16 16)'>` +
      `<path d='${ROTATE_ARC}' fill='none' stroke='%23fff' stroke-width='4.3'/>` +
      heads("fill='%23fff' stroke='%23fff' stroke-width='2.5' stroke-linejoin='round'") +
      `<path d='${ROTATE_ARC}' fill='none' stroke='%23000' stroke-width='1.8'/>` +
      heads("fill='%23000'") +
      "</g>",
    { x: 16, y: 16 },
    "crosshair",
  );
}

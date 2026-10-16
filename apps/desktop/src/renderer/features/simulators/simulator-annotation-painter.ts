import type { SimulatorAnnotationSnapshot } from "@zeros/protocol/simulator-captures";

import {
  ANNOTATION_COLORS,
  annotationMarkScale,
  markBadgeCenter,
  markBadgeRadius,
  type AnnotationColor,
  type AnnotationMark,
  type AnnotationPoint,
  type AnnotationSize,
} from "./simulator-annotation-model";

// Paints marks on a canvas. The annotator's live layer and the PNG that Add
// to chat sends use the same strokes, so the agent sees what the user drew.
// Sizes are in points on a phone, grow with a bigger screen, and scale with
// the canvas.

const ANNOTATION_STROKE = 3;
const ANNOTATION_TEXT_SIZE = 16;
const ANNOTATION_TEXT_LINE_HEIGHT = 1.25;
const ANNOTATION_FONT_FAMILY =
  "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif";
const TEXT_WEIGHT = 600;
const TEXT_HALO = 3;
/** Text wraps this far before the screen's right edge, and never narrower
 * than TEXT_MIN_WIDTH. */
const TEXT_MARGIN = 6;
const TEXT_MIN_WIDTH = 40;
const ARROW_HEAD = 12;
const ARROW_HEAD_ANGLE = Math.PI / 7;
const BADGE_TEXT_SIZE = 13;

export interface AnnotationPalette {
  color: Record<AnnotationColor, string>;
  /** Numbers on a mark's color, and the halo that keeps text readable. */
  contrast: string;
}

type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function annotationFont(sizePx: number): string {
  return `${TEXT_WEIGHT} ${sizePx}px ${ANNOTATION_FONT_FAMILY}`;
}

/** Where a text mark's lines may run to, in points from its start. */
export function annotationTextWidth(mark: { at: AnnotationPoint }, screen: AnnotationSize): number {
  const size = annotationMarkScale(screen);
  return Math.max(TEXT_MIN_WIDTH * size, screen.width - mark.at.x - TEXT_MARGIN * size);
}

/** A text mark's line height, in points. */
export function annotationTextLineHeight(screen: AnnotationSize): number {
  return ANNOTATION_TEXT_SIZE * ANNOTATION_TEXT_LINE_HEIGHT * annotationMarkScale(screen);
}

/** `text` in lines no wider than `maxWidth`, breaking between words; a
 * word wider than that has a line to itself. */
export function wrapAnnotationText(
  text: string,
  maxWidth: number,
  measure: (text: string) => number,
): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && measure(next) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** An arrow head's two back corners, `length` from the tip. */
export function arrowHeadCorners(
  from: AnnotationPoint,
  to: AnnotationPoint,
  length: number,
): [AnnotationPoint, AnnotationPoint] {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const corner = (side: number) => ({
    x: to.x - length * Math.cos(angle + side * ARROW_HEAD_ANGLE),
    y: to.y - length * Math.sin(angle + side * ARROW_HEAD_ANGLE),
  });
  return [corner(1), corner(-1)];
}

function paintMark(
  context: Context,
  mark: AnnotationMark,
  scale: number,
  palette: AnnotationPalette,
  screen: AnnotationSize,
): void {
  const color = palette.color[mark.color];
  const at = (point: AnnotationPoint) => [point.x * scale, point.y * scale] as const;
  /** Canvas pixels per point of a phone-sized stroke, text or head. */
  const unit = scale * annotationMarkScale(screen);
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = ANNOTATION_STROKE * unit;
  context.beginPath();
  switch (mark.kind) {
    case "pen": {
      const [first, ...rest] = mark.points;
      if (!first) return;
      if (rest.length === 0) {
        context.arc(...at(first), (ANNOTATION_STROKE * unit) / 2, 0, Math.PI * 2);
        context.fill();
        return;
      }
      context.moveTo(...at(first));
      for (const point of rest) context.lineTo(...at(point));
      context.stroke();
      return;
    }
    case "line":
      context.moveTo(...at(mark.from));
      context.lineTo(...at(mark.to));
      context.stroke();
      return;
    case "arrow": {
      const length = Math.hypot(mark.to.x - mark.from.x, mark.to.y - mark.from.y);
      // A short arrow keeps a head in proportion to it.
      const head = Math.min(ARROW_HEAD * annotationMarkScale(screen), length * 0.6);
      const [left, right] = arrowHeadCorners(mark.from, mark.to, head);
      const base = { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
      context.moveTo(...at(mark.from));
      context.lineTo(...at(base));
      context.stroke();
      context.beginPath();
      context.moveTo(...at(mark.to));
      context.lineTo(...at(left));
      context.lineTo(...at(right));
      context.closePath();
      context.fill();
      context.stroke();
      return;
    }
    case "rectangle": {
      const x = Math.min(mark.from.x, mark.to.x);
      const y = Math.min(mark.from.y, mark.to.y);
      context.strokeRect(
        x * scale,
        y * scale,
        Math.abs(mark.to.x - mark.from.x) * scale,
        Math.abs(mark.to.y - mark.from.y) * scale,
      );
      return;
    }
    case "ellipse":
      context.ellipse(
        ((mark.from.x + mark.to.x) / 2) * scale,
        ((mark.from.y + mark.to.y) / 2) * scale,
        (Math.abs(mark.to.x - mark.from.x) / 2) * scale,
        (Math.abs(mark.to.y - mark.from.y) / 2) * scale,
        0,
        0,
        Math.PI * 2,
      );
      context.stroke();
      return;
    case "text": {
      const size = ANNOTATION_TEXT_SIZE * unit;
      context.font = annotationFont(size);
      context.textBaseline = "top";
      const lines = wrapAnnotationText(
        mark.note,
        annotationTextWidth(mark, screen) * scale,
        (text) => context.measureText(text).width,
      );
      context.strokeStyle = palette.contrast;
      context.lineWidth = TEXT_HALO * unit;
      lines.forEach((line, index) => {
        const y = mark.at.y * scale + index * size * ANNOTATION_TEXT_LINE_HEIGHT;
        context.strokeText(line, mark.at.x * scale, y);
        context.fillText(line, mark.at.x * scale, y);
      });
      return;
    }
  }
}

function paintBadge(
  context: Context,
  mark: AnnotationMark,
  number: number,
  scale: number,
  palette: AnnotationPalette,
  screen: AnnotationSize,
): void {
  const center = markBadgeCenter(mark, screen);
  context.beginPath();
  context.arc(center.x * scale, center.y * scale, markBadgeRadius(screen) * scale, 0, Math.PI * 2);
  context.fillStyle = palette.color[mark.color];
  context.fill();
  context.font = `700 ${BADGE_TEXT_SIZE * annotationMarkScale(screen) * scale}px ${ANNOTATION_FONT_FAMILY}`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = palette.contrast;
  context.fillText(String(number), center.x * scale, center.y * scale);
}

/** Every mark, then every number on top, at `scale` canvas pixels per
 * point. `draft` is the mark still being drawn, which has no number yet. */
export function paintAnnotationMarks(
  context: Context,
  marks: readonly AnnotationMark[],
  {
    scale,
    palette,
    screen,
    draft,
  }: {
    scale: number;
    palette: AnnotationPalette;
    screen: AnnotationSize;
    draft?: AnnotationMark | null;
  },
): void {
  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";
  for (const mark of marks) paintMark(context, mark, scale, palette, screen);
  if (draft) paintMark(context, draft, scale, palette, screen);
  marks.forEach((mark, index) => {
    context.save();
    paintBadge(context, mark, index + 1, scale, palette, screen);
    context.restore();
  });
  context.restore();
}

const COLOR_TOKENS: Record<AnnotationColor, string> = {
  red: "var(--red-primary)",
  yellow: "var(--yellow-primary)",
  green: "var(--green-primary)",
  blue: "var(--blue-primary)",
  violet: "var(--violet-primary)",
};

/** The theme's colors as a canvas takes them, read where `element` is. */
export function readAnnotationPalette(element: HTMLElement): AnnotationPalette {
  const probe = document.createElement("span");
  probe.hidden = true;
  element.appendChild(probe);
  try {
    const resolve = (token: string) => {
      probe.style.color = token;
      return getComputedStyle(probe).color;
    };
    const color = Object.fromEntries(
      ANNOTATION_COLORS.map((name) => [name, resolve(COLOR_TOKENS[name])]),
    ) as Record<AnnotationColor, string>;
    return { color, contrast: resolve("var(--bg1)") };
  } finally {
    probe.remove();
  }
}

/** The frozen screen with its marks and numbers, at the screenshot's own
 * resolution, as a PNG. */
export async function renderAnnotatedScreen(
  snapshot: SimulatorAnnotationSnapshot,
  marks: readonly AnnotationMark[],
  palette: AnnotationPalette,
): Promise<Blob> {
  const bitmap = await createImageBitmap(
    new Blob([snapshot.png as BlobPart], { type: "image/png" }),
  );
  try {
    const canvas = new OffscreenCanvas(snapshot.widthPx, snapshot.heightPx);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Zeros couldn't draw the annotations.");
    context.drawImage(bitmap, 0, 0, snapshot.widthPx, snapshot.heightPx);
    paintAnnotationMarks(context, marks, {
      scale: snapshot.widthPx / snapshot.width,
      palette,
      screen: snapshot,
    });
    return await canvas.convertToBlob({ type: "image/png" });
  } finally {
    bitmap.close();
  }
}

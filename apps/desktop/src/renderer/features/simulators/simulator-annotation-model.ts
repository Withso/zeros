import {
  simulatorCaptureStem,
  simulatorElementName,
  simulatorElementsAt,
  type SimulatorAnnotationSnapshot,
  type SimulatorUiElement,
  type SimulatorUiRect,
} from "@zeros/protocol/simulator-captures";
import type { SimulatorOrientation } from "@zeros/protocol/simulators";

// Annotate: marks drawn on a frozen screen, and the marks file that says what
// each one is on. Marks are in the screen's points as it is shown upright,
// the space the snapshot's elements use. Free of the DOM, so the annotator
// and the painter share one set of rules.

export const ANNOTATION_TOOLS = ["pen", "line", "arrow", "rectangle", "ellipse", "text"] as const;
export type AnnotationTool = (typeof ANNOTATION_TOOLS)[number];

export const ANNOTATION_COLORS = ["red", "yellow", "green", "blue", "violet"] as const;
export type AnnotationColor = (typeof ANNOTATION_COLORS)[number];

/** Numbers stay two digits wide on their badges. */
export const MAX_ANNOTATION_MARKS = 99;
export const MAX_ANNOTATION_NOTE = 500;
/** A shape dragged shorter than this, in points, was a click. */
export const MIN_MARK_SIZE = 4;
/** The radius of a mark's number badge, in points, on a phone. */
export const BADGE_RADIUS = 11;
/** Marks are sized for a phone's screen, this many points across, and grow
 * in proportion on a bigger one. */
const PHONE_SCREEN_SIDE = 402;
const MAX_PEN_POINTS = 2_000;
/** A pen point this close to the last adds nothing anyone could see. */
const PEN_POINT_SPACING = 1.5;
const MAX_HISTORY = 100;

export interface AnnotationPoint {
  x: number;
  y: number;
}

export interface AnnotationSize {
  width: number;
  height: number;
}

export type AnnotationShapeKind = "line" | "arrow" | "rectangle" | "ellipse";

interface MarkBase {
  color: AnnotationColor;
  /** What the user wrote about the mark. For a text mark, its text. */
  note: string;
}

export type AnnotationMark =
  | (MarkBase & { kind: "pen"; points: readonly AnnotationPoint[] })
  | (MarkBase & { kind: AnnotationShapeKind; from: AnnotationPoint; to: AnnotationPoint })
  | (MarkBase & { kind: "text"; at: AnnotationPoint });

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** How many times a phone's size strokes, text and badges are on `screen`,
 * so marks on a tablet look as they do on a phone. */
export function annotationMarkScale(screen: AnnotationSize): number {
  return Math.max(1, Math.min(screen.width, screen.height) / PHONE_SCREEN_SIDE);
}

/** `point` on the screen, rounded to a tenth of a point. */
export function screenPoint(point: AnnotationPoint, screen: AnnotationSize): AnnotationPoint {
  return {
    x: round(Math.min(screen.width, Math.max(0, point.x))),
    y: round(Math.min(screen.height, Math.max(0, point.y))),
  };
}

/** A new mark where the pointer went down. */
export function startMark(
  tool: AnnotationTool,
  color: AnnotationColor,
  at: AnnotationPoint,
): AnnotationMark {
  switch (tool) {
    case "pen":
      return { kind: "pen", color, note: "", points: [at] };
    case "text":
      return { kind: "text", color, note: "", at };
    default:
      return { kind: tool, color, note: "", from: at, to: at };
  }
}

/** The mark as the pointer moves to `to`. */
export function dragMark(mark: AnnotationMark, to: AnnotationPoint): AnnotationMark {
  switch (mark.kind) {
    case "pen": {
      const last = mark.points[mark.points.length - 1]!;
      if (
        mark.points.length >= MAX_PEN_POINTS ||
        Math.hypot(to.x - last.x, to.y - last.y) < PEN_POINT_SPACING
      ) {
        return mark;
      }
      return { ...mark, points: [...mark.points, to] };
    }
    case "text":
      return mark;
    default:
      return { ...mark, to };
  }
}

/** Whether a finished drag drew something worth keeping: a pen click is a
 * dot, a shape click is nothing, and text needs words. */
export function markIsDrawn(mark: AnnotationMark): boolean {
  switch (mark.kind) {
    case "pen":
      return mark.points.length > 0;
    case "text":
      return mark.note.trim().length > 0;
    default:
      return (
        Math.max(Math.abs(mark.to.x - mark.from.x), Math.abs(mark.to.y - mark.from.y)) >=
        MIN_MARK_SIZE
      );
  }
}

/** The smallest upright box around the mark; a point for text, whose size
 * depends on the font that draws it. */
export function markBounds(mark: AnnotationMark): SimulatorUiRect {
  const points =
    mark.kind === "pen" ? mark.points : mark.kind === "text" ? [mark.at] : [mark.from, mark.to];
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** The radius of a mark's number badge on `screen`, in points. */
export function markBadgeRadius(screen: AnnotationSize): number {
  return BADGE_RADIUS * annotationMarkScale(screen);
}

/** Where the mark's number badge sits: at its start, or a box's top-left
 * corner, kept whole on the screen. */
export function markBadgeCenter(mark: AnnotationMark, screen: AnnotationSize): AnnotationPoint {
  const radius = markBadgeRadius(screen);
  let at: AnnotationPoint;
  switch (mark.kind) {
    case "pen":
      at = mark.points[0]!;
      break;
    case "line":
    case "arrow":
      at = mark.from;
      break;
    case "text":
      at = { x: mark.at.x - radius - 2 * annotationMarkScale(screen), y: mark.at.y + radius };
      break;
    default: {
      const bounds = markBounds(mark);
      at = { x: bounds.x, y: bounds.y };
    }
  }
  return {
    x: Math.min(Math.max(at.x, radius), Math.max(radius, screen.width - radius)),
    y: Math.min(Math.max(at.y, radius), Math.max(radius, screen.height - radius)),
  };
}

/** A badge is this much easier to hit than to see, in points on a phone. */
const BADGE_HIT_SLOP = 3;

/** The mark whose number badge is at `point`, the topmost when badges
 * overlap; -1 when there is none. */
export function markAtBadge(
  marks: readonly AnnotationMark[],
  point: AnnotationPoint,
  screen: AnnotationSize,
): number {
  const reach = markBadgeRadius(screen) + BADGE_HIT_SLOP * annotationMarkScale(screen);
  for (let index = marks.length - 1; index >= 0; index -= 1) {
    const center = markBadgeCenter(marks[index]!, screen);
    if (Math.hypot(point.x - center.x, point.y - center.y) <= reach) return index;
  }
  return -1;
}

function cleanNote(note: string): string {
  return note.replace(/\s+/g, " ").trim().slice(0, MAX_ANNOTATION_NOTE);
}

/** The marks with mark `index`'s note set. A text mark left without words is
 * removed. */
export function setMarkNote(
  marks: readonly AnnotationMark[],
  index: number,
  note: string,
): readonly AnnotationMark[] {
  const mark = marks[index];
  if (!mark) return marks;
  const clean = cleanNote(note);
  if (mark.kind === "text" && !clean) return marks.filter((_, at) => at !== index);
  if (clean === mark.note) return marks;
  return marks.map((entry, at) => (at === index ? { ...entry, note: clean } : entry));
}

// ── Undo and redo ──────────────────────────────────────────

export interface AnnotationHistory {
  readonly past: readonly (readonly AnnotationMark[])[];
  readonly marks: readonly AnnotationMark[];
  readonly future: readonly (readonly AnnotationMark[])[];
}

export const EMPTY_ANNOTATION_HISTORY: AnnotationHistory = { past: [], marks: [], future: [] };

/** `marks` as a new step, which ends what redo could bring back. */
export function commitMarks(
  history: AnnotationHistory,
  marks: readonly AnnotationMark[],
): AnnotationHistory {
  if (marks === history.marks) return history;
  return { past: [...history.past, history.marks].slice(-MAX_HISTORY), marks, future: [] };
}

/** `marks` in place of the latest step, such as the note of the mark that
 * step drew. */
export function amendMarks(
  history: AnnotationHistory,
  marks: readonly AnnotationMark[],
): AnnotationHistory {
  return marks === history.marks ? history : { ...history, marks };
}

export function undoMarks(history: AnnotationHistory): AnnotationHistory {
  const previous = history.past[history.past.length - 1];
  if (!previous) return history;
  return {
    past: history.past.slice(0, -1),
    marks: previous,
    future: [history.marks, ...history.future],
  };
}

export function redoMarks(history: AnnotationHistory): AnnotationHistory {
  const next = history.future[0];
  if (!next) return history;
  return { past: [...history.past, history.marks], marks: next, future: history.future.slice(1) };
}

/** Clear is a step of its own, so undo brings the marks back. */
export function clearMarks(history: AnnotationHistory): AnnotationHistory {
  return history.marks.length === 0 ? history : commitMarks(history, []);
}

// ── What each mark is on ───────────────────────────────────

/** An element this much of the screen, such as the app's window, is behind
 * every mark and says nothing about any of them. */
const BACKDROP_SHARE = 0.8;
const MAX_INSIDE = 8;
const MAX_UNDER = 3;
const MAX_AT_EACH_END = 2;
/** A box drawn around an element rarely clears it exactly. */
const ENCLOSE_SLOP = 2;

export type MarkElementsRelation = "inside" | "under" | "tip" | "ends";

export interface MarkElements {
  relation: MarkElementsRelation;
  elements: SimulatorUiElement[];
}

function isBackdrop(element: SimulatorUiElement, screen: AnnotationSize): boolean {
  return element.frame.width * element.frame.height >= BACKDROP_SHARE * screen.width * screen.height;
}

function encloses(region: SimulatorUiRect, frame: SimulatorUiRect): boolean {
  return (
    frame.x >= region.x - ENCLOSE_SLOP &&
    frame.y >= region.y - ENCLOSE_SLOP &&
    frame.x + frame.width <= region.x + region.width + ENCLOSE_SLOP &&
    frame.y + frame.height <= region.y + region.height + ENCLOSE_SLOP
  );
}

function readingOrder(a: SimulatorUiElement, b: SimulatorUiElement): number {
  return a.frame.y - b.frame.y || a.frame.x - b.frame.x;
}

/** The elements a mark is on: what a box, ellipse or pen mark encloses, or
 * failing that what is under its middle; what an arrow points at; what is at
 * a line's ends; what text was written on. */
export function markElements(
  mark: AnnotationMark,
  elements: readonly SimulatorUiElement[],
  screen: AnnotationSize,
): MarkElements {
  const candidates = elements.filter((element) => !isBackdrop(element, screen));
  const at = (point: AnnotationPoint, max: number) =>
    simulatorElementsAt(candidates, point).slice(0, max);
  switch (mark.kind) {
    case "arrow":
      return { relation: "tip", elements: at(mark.to, MAX_UNDER) };
    case "line":
      return {
        relation: "ends",
        elements: [
          ...new Set([...at(mark.from, MAX_AT_EACH_END), ...at(mark.to, MAX_AT_EACH_END)]),
        ],
      };
    case "text":
      return { relation: "under", elements: at(mark.at, MAX_UNDER) };
    default: {
      const region = markBounds(mark);
      const inside = candidates
        .filter((element) => encloses(region, element.frame))
        .sort(readingOrder)
        .slice(0, MAX_INSIDE);
      if (inside.length > 0) return { relation: "inside", elements: inside };
      return {
        relation: "under",
        elements: at(
          { x: region.x + region.width / 2, y: region.y + region.height / 2 },
          MAX_UNDER,
        ),
      };
    }
  }
}

// ── The files Add to chat sends ────────────────────────────

const ANNOTATION_PREFIX = "Simulator Annotation";

/** The annotated screen and its marks file, named like Simulator's own
 * captures. */
export function annotationFileNames(
  deviceName: string,
  at: Date,
): { image: string; marks: string } {
  const stem = simulatorCaptureStem(ANNOTATION_PREFIX, deviceName, at);
  return { image: `${stem}.png`, marks: `${stem} marks.txt` };
}

const ORIENTATIONS: Record<SimulatorOrientation, string> = {
  portrait: "portrait",
  "portrait-upside-down": "portrait, upside down",
  "landscape-left": "landscape left",
  "landscape-right": "landscape right",
};

const KINDS: Record<AnnotationMark["kind"], string> = {
  pen: "pen mark",
  line: "line",
  arrow: "arrow",
  rectangle: "rectangle",
  ellipse: "ellipse",
  text: "text",
};

const RELATIONS: Record<MarkElementsRelation, string> = {
  inside: "UI elements inside it",
  under: "UI elements under it",
  tip: "UI elements at its tip",
  ends: "UI elements at its ends",
};

function pointText(point: AnnotationPoint): string {
  return `(${Math.round(point.x)}, ${Math.round(point.y)})`;
}

function placeText(mark: AnnotationMark): string {
  switch (mark.kind) {
    case "text":
      return `at ${pointText(mark.at)}`;
    case "line":
    case "arrow":
      return `from ${pointText(mark.from)} to ${pointText(mark.to)}`;
    default: {
      const box = markBounds(mark);
      const span = `${pointText(box)} to ${pointText({ x: box.x + box.width, y: box.y + box.height })}`;
      return mark.kind === "pen" ? `covering ${span}` : `from ${span}`;
    }
  }
}

function elementText(element: SimulatorUiElement): string {
  const { frame } = element;
  return `${simulatorElementName(element)} at ${pointText(frame)}, ${Math.round(frame.width)} × ${Math.round(frame.height)}`;
}

function appText(snapshot: SimulatorAnnotationSnapshot): string {
  if (snapshot.appName && snapshot.appId) return `${snapshot.appName} (${snapshot.appId})`;
  return snapshot.appName ?? snapshot.appId ?? "unknown";
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The marks file: the device and app, then each numbered mark with its
 * note and the UI elements it is on, by type, label and position. */
export function annotationMarksText({
  imageName,
  snapshot,
  marks,
}: {
  imageName: string;
  snapshot: SimulatorAnnotationSnapshot;
  marks: readonly AnnotationMark[];
}): string {
  const readElements = snapshot.elements.length > 0;
  const lines = [
    `Annotated screenshot: ${imageName}`,
    `Device: ${snapshot.deviceName}, ${snapshot.osLabel}, ${ORIENTATIONS[snapshot.orientation]}`,
    `App: ${appText(snapshot)}`,
    `Positions are in points from the screen's top-left corner. The screen is ${Math.round(snapshot.width)} × ${Math.round(snapshot.height)} points.`,
  ];
  if (!readElements) lines.push("Zeros couldn't read the UI elements on this screen.");
  marks.forEach((mark, index) => {
    lines.push("", `${index + 1}. ${capitalized(mark.color)} ${KINDS[mark.kind]} ${placeText(mark)}`);
    lines.push(mark.note ? `   Note: ${mark.note}` : "   No note");
    if (!readElements) return;
    const found = markElements(mark, snapshot.elements, snapshot);
    if (found.elements.length === 0) {
      lines.push(`   ${RELATIONS[found.relation]}: none`);
      return;
    }
    lines.push(`   ${RELATIONS[found.relation]}:`);
    for (const element of found.elements) lines.push(`   - ${elementText(element)}`);
  });
  return `${lines.join("\n")}\n`;
}

import { describe, expect, it } from "vitest";
import type {
  SimulatorAnnotationSnapshot,
  SimulatorUiElement,
} from "@zeros/protocol/simulator-captures";

import {
  BADGE_RADIUS,
  EMPTY_ANNOTATION_HISTORY,
  MAX_ANNOTATION_NOTE,
  amendMarks,
  annotationFileNames,
  annotationMarkScale,
  annotationMarksText,
  clearMarks,
  commitMarks,
  dragMark,
  markAtBadge,
  markBadgeCenter,
  markBounds,
  markElements,
  markIsDrawn,
  redoMarks,
  screenPoint,
  setMarkNote,
  startMark,
  undoMarks,
  type AnnotationMark,
} from "../simulator-annotation-model";

const SCREEN = { width: 402, height: 874 };

function element(
  type: string,
  label: string | null,
  frame: SimulatorUiElement["frame"],
  identifier: string | null = null,
): SimulatorUiElement {
  return { type, label, value: null, identifier, frame };
}

const WINDOW = element("Window", "Settings", { x: 0, y: 0, width: 402, height: 874 });
const CELL = element("Cell", "General", { x: 16, y: 200, width: 370, height: 44 });
const CELL_TEXT = element("StaticText", "General", { x: 60, y: 212, width: 80, height: 20 });
const SIGN_IN = element("Button", "Sign in", { x: 150, y: 600, width: 100, height: 44 });
const LOGO = element("Image", null, { x: 170, y: 100, width: 60, height: 60 }, "logo");
const ELEMENTS = [WINDOW, SIGN_IN, CELL_TEXT, CELL, LOGO];

function snapshot(elements: SimulatorUiElement[] = ELEMENTS): SimulatorAnnotationSnapshot {
  return {
    png: new Uint8Array([137, 80, 78, 71]),
    widthPx: 1206,
    heightPx: 2622,
    width: SCREEN.width,
    height: SCREEN.height,
    orientation: "portrait",
    deviceName: "iPhone 17 Pro",
    osLabel: "iOS 26.0",
    appName: "Settings",
    appId: "com.apple.Preferences",
    elements,
  };
}

const box = (
  kind: "rectangle" | "ellipse" | "line" | "arrow",
  from: [number, number],
  to: [number, number],
  note = "",
): AnnotationMark => ({
  kind,
  color: "red",
  note,
  from: { x: from[0], y: from[1] },
  to: { x: to[0], y: to[1] },
});

describe("drawing marks", () => {
  it("keeps points on the screen, to a tenth of a point", () => {
    expect(screenPoint({ x: -5, y: 900 }, SCREEN)).toEqual({ x: 0, y: 874 });
    expect(screenPoint({ x: 12.345, y: 7.06 }, SCREEN)).toEqual({ x: 12.3, y: 7.1 });
  });

  it("follows the pointer for each tool", () => {
    const pen = startMark("pen", "red", { x: 10, y: 10 });
    const moved = dragMark(dragMark(pen, { x: 10.5, y: 10.5 }), { x: 20, y: 10 });
    expect(moved).toMatchObject({ kind: "pen", points: [{ x: 10, y: 10 }, { x: 20, y: 10 }] });

    const arrow = dragMark(startMark("arrow", "blue", { x: 1, y: 2 }), { x: 30, y: 40 });
    expect(arrow).toEqual({
      kind: "arrow",
      color: "blue",
      note: "",
      from: { x: 1, y: 2 },
      to: { x: 30, y: 40 },
    });

    const text = startMark("text", "green", { x: 5, y: 6 });
    expect(dragMark(text, { x: 50, y: 60 })).toBe(text);
  });

  it("keeps a pen dot, drops a shape that was a click and text without words", () => {
    expect(markIsDrawn(startMark("pen", "red", { x: 1, y: 1 }))).toBe(true);
    expect(markIsDrawn(box("rectangle", [10, 10], [12, 13]))).toBe(false);
    expect(markIsDrawn(box("rectangle", [10, 10], [10, 14]))).toBe(true);
    expect(markIsDrawn(startMark("text", "red", { x: 1, y: 1 }))).toBe(false);
    expect(markIsDrawn({ ...startMark("text", "red", { x: 1, y: 1 }), note: "Here" })).toBe(true);
  });

  it("measures a box the same whichever way it was dragged", () => {
    expect(markBounds(box("rectangle", [300, 250], [10, 190]))).toEqual({
      x: 10,
      y: 190,
      width: 290,
      height: 60,
    });
    expect(markBounds({ kind: "text", color: "red", note: "Hi", at: { x: 4, y: 5 } })).toEqual({
      x: 4,
      y: 5,
      width: 0,
      height: 0,
    });
  });

  it("puts each number at the mark's start, whole on the screen", () => {
    expect(markBadgeCenter(box("rectangle", [300, 250], [40, 190]), SCREEN)).toEqual({
      x: 40,
      y: 190,
    });
    expect(markBadgeCenter(box("arrow", [400, 2], [10, 10]), SCREEN)).toEqual({
      x: SCREEN.width - BADGE_RADIUS,
      y: BADGE_RADIUS,
    });
    expect(
      markBadgeCenter({ kind: "text", color: "red", note: "Hi", at: { x: 100, y: 50 } }, SCREEN),
    ).toEqual({ x: 100 - BADGE_RADIUS - 2, y: 50 + BADGE_RADIUS });
  });

  it("finds the mark whose number is under the pointer, the top one first", () => {
    const marks = [
      box("rectangle", [40, 190], [300, 250]),
      box("arrow", [44, 192], [10, 10]),
      box("line", [200, 400], [250, 450]),
    ];
    expect(markAtBadge(marks, { x: 42, y: 191 }, SCREEN)).toBe(1);
    expect(markAtBadge(marks, { x: 200 + BADGE_RADIUS + 2, y: 400 }, SCREEN)).toBe(2);
    expect(markAtBadge(marks, { x: 200 + BADGE_RADIUS + 4, y: 400 }, SCREEN)).toBe(-1);
    expect(markAtBadge([], { x: 0, y: 0 }, SCREEN)).toBe(-1);
  });

  it("sizes marks to the screen, so a tablet's look like a phone's", () => {
    expect(annotationMarkScale(SCREEN)).toBe(1);
    expect(annotationMarkScale({ width: 375, height: 667 })).toBe(1);
    const tablet = { width: 804, height: 1180 };
    expect(annotationMarkScale(tablet)).toBe(2);
    expect(annotationMarkScale({ width: 1180, height: 804 })).toBe(2);
    const radius = BADGE_RADIUS * 2;
    expect(markBadgeCenter(box("arrow", [2, 2], [100, 100]), tablet)).toEqual({
      x: radius,
      y: radius,
    });
    expect(
      markBadgeCenter({ kind: "text", color: "red", note: "Hi", at: { x: 100, y: 50 } }, tablet),
    ).toEqual({ x: 100 - radius - 4, y: 50 + radius });
    const line = [box("line", [400, 400], [500, 500])];
    expect(markAtBadge(line, { x: 400 + radius + 5, y: 400 }, tablet)).toBe(0);
    expect(markAtBadge(line, { x: 400 + radius + 7, y: 400 }, tablet)).toBe(-1);
  });

  it("cleans notes, and removes text left without words", () => {
    const marks = [box("rectangle", [0, 0], [50, 50]), startMark("text", "red", { x: 1, y: 1 })];
    expect(setMarkNote(marks, 0, "  Make\nthis   bigger ")[0]!.note).toBe("Make this bigger");
    expect(setMarkNote(marks, 0, "x".repeat(900))[0]!.note).toHaveLength(MAX_ANNOTATION_NOTE);
    expect(setMarkNote(marks, 1, "   ")).toEqual([marks[0]]);
    expect(setMarkNote(marks, 0, "")).toBe(marks);
    expect(setMarkNote(marks, 5, "Nothing there")).toBe(marks);
  });
});

describe("annotation history", () => {
  const one = [box("rectangle", [0, 0], [50, 50])];
  const two = [...one, box("arrow", [0, 0], [50, 50])];

  it("undoes and redoes each step", () => {
    const drawn = commitMarks(commitMarks(EMPTY_ANNOTATION_HISTORY, one), two);
    const undone = undoMarks(drawn);
    expect(undone.marks).toBe(one);
    expect(redoMarks(undone).marks).toBe(two);
    expect(undoMarks(undone).marks).toEqual([]);
    expect(undoMarks(EMPTY_ANNOTATION_HISTORY)).toBe(EMPTY_ANNOTATION_HISTORY);
    expect(redoMarks(drawn)).toBe(drawn);
  });

  it("ends redo once something new is drawn", () => {
    const undone = undoMarks(commitMarks(commitMarks(EMPTY_ANNOTATION_HISTORY, one), two));
    const redrawn = commitMarks(undone, [...one, box("line", [1, 1], [60, 60])]);
    expect(redrawn.future).toEqual([]);
    expect(redoMarks(redrawn)).toBe(redrawn);
  });

  it("clears as one step that undo brings back", () => {
    const cleared = clearMarks(commitMarks(EMPTY_ANNOTATION_HISTORY, two));
    expect(cleared.marks).toEqual([]);
    expect(undoMarks(cleared).marks).toBe(two);
    expect(clearMarks(EMPTY_ANNOTATION_HISTORY)).toBe(EMPTY_ANNOTATION_HISTORY);
  });

  it("amends the latest step without adding one", () => {
    const drawn = commitMarks(EMPTY_ANNOTATION_HISTORY, one);
    const noted = amendMarks(drawn, setMarkNote(one, 0, "Too small"));
    expect(noted.past).toBe(drawn.past);
    expect(undoMarks(noted).marks).toEqual([]);
  });

  it("keeps a bounded number of steps", () => {
    let history = EMPTY_ANNOTATION_HISTORY;
    for (let step = 0; step < 150; step++) {
      history = commitMarks(history, [box("line", [step, 0], [step, 50])]);
    }
    expect(history.past).toHaveLength(100);
  });
});

describe("what a mark is on", () => {
  it("lists what a box encloses in reading order, never the window behind it", () => {
    expect(markElements(box("rectangle", [392, 250], [10, 190]), ELEMENTS, SCREEN)).toEqual({
      relation: "inside",
      elements: [CELL, CELL_TEXT],
    });
  });

  it("falls back to what is under a small box's middle, most specific first", () => {
    expect(markElements(box("ellipse", [70, 215], [100, 230]), ELEMENTS, SCREEN)).toEqual({
      relation: "under",
      elements: [CELL_TEXT, CELL],
    });
  });

  it("names what an arrow points at and what is at a line's ends", () => {
    expect(markElements(box("arrow", [300, 800], [200, 620]), ELEMENTS, SCREEN)).toEqual({
      relation: "tip",
      elements: [SIGN_IN],
    });
    expect(markElements(box("line", [200, 620], [190, 130]), ELEMENTS, SCREEN)).toEqual({
      relation: "ends",
      elements: [SIGN_IN, LOGO],
    });
    expect(markElements(box("line", [200, 620], [210, 630]), ELEMENTS, SCREEN).elements).toEqual([
      SIGN_IN,
    ]);
  });

  it("treats a pen mark around something as enclosing it", () => {
    const circled: AnnotationMark = {
      kind: "pen",
      color: "red",
      note: "",
      points: [
        { x: 160, y: 90 },
        { x: 240, y: 90 },
        { x: 240, y: 170 },
        { x: 160, y: 170 },
      ],
    };
    expect(markElements(circled, ELEMENTS, SCREEN)).toEqual({
      relation: "inside",
      elements: [LOGO],
    });
  });

  it("finds nothing under text written on empty space", () => {
    expect(
      markElements({ kind: "text", color: "red", note: "Hi", at: { x: 20, y: 400 } }, ELEMENTS, SCREEN),
    ).toEqual({ relation: "under", elements: [] });
  });
});

describe("the files Add to chat sends", () => {
  const at = new Date(2025, 9, 2, 4, 3, 2);

  it("names them like Simulator's captures", () => {
    expect(annotationFileNames("iPhone 17 Pro", at)).toEqual({
      image: "Simulator Annotation - iPhone 17 Pro - 2025-10-02 at 04.03.02.png",
      marks: "Simulator Annotation - iPhone 17 Pro - 2025-10-02 at 04.03.02 marks.txt",
    });
  });

  it("lists each numbered mark with its note and what it is on", () => {
    const marks: AnnotationMark[] = [
      box("rectangle", [392, 250], [10, 190], "Make this row taller"),
      { ...box("arrow", [300, 800], [200, 620]), color: "blue" },
      { kind: "text", color: "green", note: "Wrong color", at: { x: 20, y: 400 } },
    ];
    expect(
      annotationMarksText({
        imageName: annotationFileNames("iPhone 17 Pro", at).image,
        snapshot: snapshot(),
        marks,
      }),
    ).toBe(
      [
        "Annotated screenshot: Simulator Annotation - iPhone 17 Pro - 2025-10-02 at 04.03.02.png",
        "Device: iPhone 17 Pro, iOS 26.0, portrait",
        "App: Settings (com.apple.Preferences)",
        "Positions are in points from the screen's top-left corner. The screen is 402 × 874 points.",
        "",
        "1. Red rectangle from (10, 190) to (392, 250)",
        "   Note: Make this row taller",
        "   UI elements inside it:",
        '   - Cell "General" at (16, 200), 370 × 44',
        '   - StaticText "General" at (60, 212), 80 × 20',
        "",
        "2. Blue arrow from (300, 800) to (200, 620)",
        "   No note",
        "   UI elements at its tip:",
        '   - Button "Sign in" at (150, 600), 100 × 44',
        "",
        "3. Green text at (20, 400)",
        "   Note: Wrong color",
        "   UI elements under it: none",
        "",
      ].join("\n"),
    );
  });

  it("says when Zeros couldn't read the screen's elements", () => {
    const text = annotationMarksText({
      imageName: "a.png",
      snapshot: { ...snapshot([]), appName: null, orientation: "landscape-left" },
      marks: [box("ellipse", [0, 0], [40, 40])],
    });
    expect(text).toContain("Device: iPhone 17 Pro, iOS 26.0, landscape left\n");
    expect(text).toContain("App: com.apple.Preferences\n");
    expect(text).toContain("Zeros couldn't read the UI elements on this screen.\n");
    expect(text).not.toContain("UI elements under it");
    expect(text.endsWith("1. Red ellipse from (0, 0) to (40, 40)\n   No note\n")).toBe(true);
  });
});

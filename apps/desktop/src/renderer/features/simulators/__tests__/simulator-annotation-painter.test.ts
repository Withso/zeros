import { describe, expect, it } from "vitest";

import type { AnnotationMark } from "../simulator-annotation-model";
import {
  arrowHeadCorners,
  annotationTextWidth,
  paintAnnotationMarks,
  wrapAnnotationText,
  type AnnotationPalette,
} from "../simulator-annotation-painter";

const PALETTE: AnnotationPalette = {
  color: {
    red: "paint-red",
    yellow: "paint-yellow",
    green: "paint-green",
    blue: "paint-blue",
    violet: "paint-violet",
  },
  contrast: "paint-contrast",
};

/** A 2D context that writes down what was painted. */
function recordingContext() {
  const painted: string[] = [];
  const state = { fillStyle: "", strokeStyle: "", lineWidth: 0, font: "" };
  const context = {
    ...state,
    lineCap: "butt",
    lineJoin: "miter",
    textAlign: "start",
    textBaseline: "alphabetic",
    save: () => {},
    restore: () => {},
    beginPath: () => {},
    closePath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    arc: () => {},
    ellipse: () => {},
    stroke() {
      painted.push(`stroke ${this.strokeStyle} ${this.lineWidth}`);
    },
    fill() {
      painted.push(`fill ${this.fillStyle}`);
    },
    strokeRect(x: number, y: number, width: number, height: number) {
      painted.push(`rect ${this.strokeStyle} ${x},${y},${width},${height}`);
    },
    strokeText(text: string, x: number, y: number) {
      painted.push(`halo ${this.strokeStyle} ${text} ${x},${y}`);
    },
    fillText(text: string, x: number, y: number) {
      painted.push(`text ${this.fillStyle} ${text} ${x},${y}`);
    },
    measureText: (text: string) => ({ width: text.length * 10 }),
  };
  return { context: context as unknown as CanvasRenderingContext2D, painted };
}

describe("annotation painter", () => {
  it("wraps text between words, giving a long word its own line", () => {
    const measure = (text: string) => text.length;
    expect(wrapAnnotationText("make this   row taller", 9, measure)).toEqual([
      "make this",
      "row",
      "taller",
    ]);
    expect(wrapAnnotationText("a extraordinarily b", 5, measure)).toEqual([
      "a",
      "extraordinarily",
      "b",
    ]);
    expect(wrapAnnotationText("   ", 5, measure)).toEqual([]);
  });

  it("wraps text before the screen's edge, never too narrow to read", () => {
    const screen = { width: 402, height: 874 };
    expect(annotationTextWidth({ at: { x: 100, y: 0 } }, screen)).toBe(296);
    expect(annotationTextWidth({ at: { x: 395, y: 0 } }, screen)).toBe(40);
  });

  it("points an arrow's head back along it", () => {
    const [left, right] = arrowHeadCorners({ x: 0, y: 0 }, { x: 100, y: 0 }, 10);
    expect(left.x).toBeCloseTo(100 - 10 * Math.cos(Math.PI / 7));
    expect(right.x).toBeCloseTo(left.x);
    expect(left.y).toBeCloseTo(-right.y);
    expect(Math.abs(left.y)).toBeCloseTo(10 * Math.sin(Math.PI / 7));
  });

  it("paints every mark at scale, then the numbers on top, and no number on the draft", () => {
    const { context, painted } = recordingContext();
    const marks: AnnotationMark[] = [
      { kind: "rectangle", color: "red", note: "", from: { x: 30, y: 40 }, to: { x: 10, y: 20 } },
      { kind: "text", color: "blue", note: "Too small", at: { x: 50, y: 60 } },
    ];
    paintAnnotationMarks(context, marks, {
      scale: 2,
      palette: PALETTE,
      screen: { width: 402, height: 874 },
      draft: { kind: "line", color: "green", note: "", from: { x: 0, y: 0 }, to: { x: 9, y: 9 } },
    });
    expect(painted).toEqual([
      "rect paint-red 20,40,40,40",
      "halo paint-contrast Too small 100,120",
      "text paint-blue Too small 100,120",
      "stroke paint-green 6",
      "fill paint-red",
      "text paint-contrast 1 22,40",
      "fill paint-blue",
      "text paint-contrast 2 74,142",
    ]);
  });

  it("paints marks bigger on a bigger screen, in proportion", () => {
    const tablet = { width: 804, height: 1180 };
    expect(annotationTextWidth({ at: { x: 100, y: 0 } }, tablet)).toBe(692);
    expect(annotationTextWidth({ at: { x: 795, y: 0 } }, tablet)).toBe(80);
    const { context, painted } = recordingContext();
    paintAnnotationMarks(
      context,
      [{ kind: "line", color: "red", note: "", from: { x: 100, y: 100 }, to: { x: 200, y: 200 } }],
      { scale: 1, palette: PALETTE, screen: tablet },
    );
    expect(painted).toEqual([
      "stroke paint-red 6",
      "fill paint-red",
      "text paint-contrast 1 100,100",
    ]);
    expect(context.font).toMatch(/^700 26px /);
  });
});

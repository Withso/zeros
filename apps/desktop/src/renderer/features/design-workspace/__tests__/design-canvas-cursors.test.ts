import { describe, expect, it } from "vitest";

import {
  DESIGN_ARROW_CURSOR,
  DESIGN_CROSSHAIR_CURSOR,
  DESIGN_TEXT_CURSOR,
  designResizeCursor,
  designRotationCursor,
} from "../design-canvas-cursors";

const glyph = (cursor: string) => /id='zd-cursor-([a-z]+(?:-\d+)?)'/.exec(cursor)?.[1];

describe("canvas cursors", () => {
  it("draws the arrow with its hotspot on the tip and a system fallback", () => {
    expect(DESIGN_ARROW_CURSOR.startsWith('url("data:image/svg+xml,<svg')).toBe(true);
    expect(glyph(DESIGN_ARROW_CURSOR)).toBe("arrow");
    expect(DESIGN_ARROW_CURSOR).toContain("<path d='M6 5 ");
    expect(DESIGN_ARROW_CURSOR.endsWith('") 6 5, default')).toBe(true);
  });

  it("keeps colors and references percent-encoded literals", () => {
    // A cursor image resolves no CSS variables, and a data URL cannot carry a
    // raw "#".
    for (const cursor of [DESIGN_ARROW_CURSOR, DESIGN_CROSSHAIR_CURSOR, DESIGN_TEXT_CURSOR, designResizeCursor(0), designRotationCursor(0)]) {
      expect(cursor).not.toContain("var(");
      expect(cursor.replace(/^url\("/, "").split('")')[0]).not.toContain("#");
      expect(cursor).toContain("filter='url(%23s)'");
    }
  });

  it("draws the drawing tools' crosshair and the text tool's I-beam centred on the pointer", () => {
    expect(glyph(DESIGN_CROSSHAIR_CURSOR)).toBe("crosshair");
    expect(DESIGN_CROSSHAIR_CURSOR.endsWith('") 16 16, crosshair')).toBe(true);
    expect(glyph(DESIGN_TEXT_CURSOR)).toBe("text");
    expect(DESIGN_TEXT_CURSOR.endsWith('") 16 16, text')).toBe(true);
  });

  it("turns the resize arrow in quantized steps along its axis", () => {
    expect(glyph(designResizeCursor(0))).toBe("resize-0");
    expect(glyph(designResizeCursor(46))).toBe("resize-45");
    expect(glyph(designResizeCursor(-45))).toBe("resize-135");
    expect(glyph(designResizeCursor(270))).toBe("resize-90");
    expect(glyph(designResizeCursor(Number.NaN))).toBe("resize-0");
    expect(designResizeCursor(30)).toContain("rotate(30 16 16)");
    // The keyword fallback is the nearest system resize direction.
    expect(designResizeCursor(0).endsWith(" 16 16, ew-resize")).toBe(true);
    expect(designResizeCursor(45).endsWith(" 16 16, nwse-resize")).toBe(true);
    expect(designResizeCursor(90).endsWith(" 16 16, ns-resize")).toBe(true);
    expect(designResizeCursor(135).endsWith(" 16 16, nesw-resize")).toBe(true);
    expect(designResizeCursor(170).endsWith(" 16 16, ew-resize")).toBe(true);
  });

  it("wraps each corner's rotation arrow around that corner", () => {
    // Corner angles: the corner's screen direction from the centre plus 90°.
    expect(glyph(designRotationCursor(-45))).toBe("rotate-0");
    expect(glyph(designRotationCursor(45))).toBe("rotate-90");
    expect(glyph(designRotationCursor(135))).toBe("rotate-180");
    expect(glyph(designRotationCursor(-135))).toBe("rotate-270");
    expect(glyph(designRotationCursor(-38))).toBe("rotate-0");
    expect(glyph(designRotationCursor(Number.NaN))).toBe("rotate-0");
    expect(designRotationCursor(45).endsWith('") 16 16, crosshair')).toBe(true);
  });
});

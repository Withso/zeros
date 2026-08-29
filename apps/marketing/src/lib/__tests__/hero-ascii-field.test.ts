import { describe, expect, it } from "vitest";
import {
  ASCII_CLOUD_RAMP,
  ASCII_STAR_GLYPHS,
  HERO_ASCII_VOID,
  cellSizeForWidth,
  cloudDensity,
  glyphAt,
  headlineWell,
  paintHeroAsciiField,
} from "../hero-ascii-field";

const ALLOWED = new Set<string>([...ASCII_CLOUD_RAMP, ...ASCII_STAR_GLYPHS]);

function sampleGrid(cols: number, rows: number) {
  let glyphs = 0;
  let headline = 0;
  let corner = 0;
  let stars = 0;
  const seen = new Set<string>();
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const glyph = glyphAt(col, row, cols, rows);
      if (!glyph) continue;
      glyphs += 1;
      seen.add(glyph.ch);
      const nx = (col + 0.5) / cols;
      const ny = (row + 0.5) / rows;
      if (nx < 0.55 && ny < 0.32) headline += 1;
      if ((nx < 0.18 || nx > 0.82) && ny > 0.62) corner += 1;
      if (ASCII_STAR_GLYPHS.includes(glyph.ch as (typeof ASCII_STAR_GLYPHS)[number]) &&
          cloudDensity(nx, ny, cols / rows) < 0.055) {
        stars += 1;
      }
    }
  }
  return { glyphs, headline, corner, stars, seen };
}

describe("hero ASCII cloud field", () => {
  it("uses the terminal dither ramp and a pure-black void", () => {
    expect([...ASCII_CLOUD_RAMP]).toEqual([
      ".",
      ",",
      ":",
      ";",
      "+",
      "*",
      "x",
      "#",
      "%",
      "@",
      "0",
      "1",
    ]);
    expect(ASCII_STAR_GLYPHS).toContain("+");
    expect(HERO_ASCII_VOID).toBe("#000000");
    expect(cellSizeForWidth(390)).toBe(8);
    expect(cellSizeForWidth(1440)).toBe(8);
  });

  it("keeps the left-aligned headline well empty relative to the corners", () => {
    const aspect = 1440 / 900;
    expect(headlineWell(0.32, 0.18, aspect)).toBeGreaterThan(0.9);
    expect(headlineWell(0.92, 0.9, aspect)).toBeLessThan(0.15);
    expect(cloudDensity(0.34, 0.2, aspect)).toBeLessThan(0.08);
    expect(cloudDensity(0.06, 0.88, aspect)).toBeGreaterThan(
      cloudDensity(0.36, 0.2, aspect),
    );
    expect(cloudDensity(0.94, 0.86, aspect)).toBeGreaterThan(
      cloudDensity(0.4, 0.18, aspect),
    );
  });

  it("puts billows toward the edges and leaves the upper-middle void", () => {
    const desktop = sampleGrid(160, 90);
    expect(desktop.glyphs).toBeGreaterThan(800);
    expect(desktop.corner).toBeGreaterThan(desktop.headline);
    expect(desktop.headline / desktop.glyphs).toBeLessThan(0.12);
    expect(desktop.stars).toBeGreaterThan(0);
    for (const ch of desktop.seen) {
      expect(ALLOWED.has(ch), ch).toBe(true);
    }

    const mobile = sampleGrid(48, 96);
    expect(mobile.glyphs).toBeGreaterThan(200);
    expect(cloudDensity(0.5, 0.14, 390 / 844)).toBeLessThan(0.1);
    expect(cloudDensity(0.02, 0.16, 390 / 844)).toBeGreaterThan(0.05);
    expect(cloudDensity(0.02, 0.36, 390 / 844)).toBeGreaterThan(0.08);
    expect(cloudDensity(0.98, 0.34, 390 / 844)).toBeGreaterThan(0.08);
    expect(cloudDensity(0.5, 0.92, 390 / 844)).toBeGreaterThan(0.12);
  });

  it("paints a black fill and only ramp/star glyphs", () => {
    const texts: string[] = [];
    let voidFill = "";
    const ctx = {
      fillRect() {},
      fillText(text: string) {
        texts.push(text);
      },
      font: "",
      textAlign: "",
      textBaseline: "",
      set fillStyle(value: string) {
        if (!voidFill) voidFill = value;
      },
      get fillStyle() {
        return voidFill;
      },
    };
    paintHeroAsciiField(ctx, 320, 240);
    expect(voidFill).toBe("#000000");
    expect(texts.length).toBeGreaterThan(40);
    expect(texts.every((ch) => ALLOWED.has(ch))).toBe(true);
    expect(texts.some((ch) => ASCII_CLOUD_RAMP.includes(ch as (typeof ASCII_CLOUD_RAMP)[number]))).toBe(
      true,
    );
  });
});

import { describe, expect, it } from "vitest";
import {
  ASCII_CLOUD_RAMP,
  ASCII_STAR_GLYPHS,
  HERO_ASCII_CYAN_RGB,
  HERO_ASCII_VOID,
  cellSizeForWidth,
  cloudDensity,
  glyphAt,
  headlineWell,
  horizonGate,
  paintHeroAsciiField,
  productSkyline,
  productWell,
  skyGate,
  streakField,
} from "../hero-ascii-field";

const ALLOWED = new Set<string>([...ASCII_CLOUD_RAMP, ...ASCII_STAR_GLYPHS]);

function sampleGrid(cols: number, rows: number) {
  let glyphs = 0;
  let headline = 0;
  let sky = 0;
  let horizon = 0;
  let product = 0;
  const seen = new Set<string>();
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const glyph = glyphAt(col, row, cols, rows);
      if (!glyph) continue;
      glyphs += 1;
      seen.add(glyph.ch);
      const nx = (col + 0.5) / cols;
      const ny = (row + 0.5) / rows;
      if (nx > 0.12 && nx < 0.55 && ny > 0.2 && ny < 0.42) headline += 1;
      if (ny < 0.22 && (nx < 0.16 || nx > 0.7)) sky += 1;
      if (ny > 0.54 && ny < 0.78) horizon += 1;
      if (ny > 0.86) product += 1;
    }
  }
  return { glyphs, headline, sky, horizon, product, seen };
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
    expect(HERO_ASCII_CYAN_RGB[1]).toBeGreaterThan(180);
    expect(cellSizeForWidth(390)).toBe(8);
    expect(cellSizeForWidth(1440)).toBe(8);
  });

  it("keeps the upper void and headline well empty relative to the horizon", () => {
    const aspect = 1440 / 900;
    expect(headlineWell(0.32, 0.32, aspect)).toBeGreaterThan(0.9);
    expect(headlineWell(0.92, 0.66, aspect)).toBeLessThan(0.15);
    expect(horizonGate(0.12, aspect)).toBeLessThan(0.12);
    expect(horizonGate(0.68, aspect)).toBeGreaterThan(0.85);
    expect(skyGate(0.12, aspect)).toBeGreaterThan(0.8);
    expect(productSkyline(0.08, aspect)).toBe(1);
    expect(productSkyline(0.82, aspect)).toBeLessThan(0.2);
    expect(productWell(0.5, 0.82, aspect)).toBeGreaterThan(0.7);
    expect(cloudDensity(0.34, 0.3, aspect)).toBeLessThan(0.08);
    expect(cloudDensity(0.82, 0.64, aspect)).toBeGreaterThan(
      cloudDensity(0.36, 0.3, aspect),
    );
    expect(cloudDensity(0.16, 0.62, aspect)).toBeGreaterThan(
      cloudDensity(0.36, 0.3, aspect),
    );
  });

  it("puts luminous billows around the product peek, not in the upper sky", () => {
    const aspect = 1440 / 900;
    expect(cloudDensity(0.5, 0.12, aspect)).toBeLessThan(0.08);
    expect(cloudDensity(0.78, 0.58, aspect)).toBeGreaterThan(0.12);
    expect(streakField(0.55, 0.64)).toBeGreaterThan(streakField(0.2, 0.12));

    const desktop = sampleGrid(160, 90);
    expect(desktop.glyphs).toBeGreaterThan(400);
    expect(desktop.horizon).toBeGreaterThan(desktop.headline);
    expect(desktop.horizon).toBeGreaterThan(desktop.sky);
    expect(desktop.headline / desktop.glyphs).toBeLessThan(0.18);
    expect(desktop.product).toBeLessThan(desktop.horizon * 0.45);
    for (const ch of desktop.seen) {
      expect(ALLOWED.has(ch), ch).toBe(true);
    }

    const mobile = sampleGrid(48, 96);
    expect(mobile.glyphs).toBeGreaterThan(80);
    expect(cloudDensity(0.5, 0.16, 390 / 844)).toBeLessThan(0.1);
    expect(cloudDensity(0.9, 0.6, 390 / 844)).toBeGreaterThan(0.05);
  });

  it("keeps horizon billows on the mid ramp instead of a 0/1 slab", () => {
    let zeros = 0;
    let ones = 0;
    let other = 0;
    for (let row = 0; row < 90; row += 1) {
      for (let col = 0; col < 160; col += 1) {
        const glyph = glyphAt(col, row, 160, 90);
        if (!glyph) continue;
        if (glyph.ch === "0") zeros += 1;
        else if (glyph.ch === "1") ones += 1;
        else other += 1;
      }
    }
    expect(other).toBeGreaterThan(zeros + ones);
    expect(zeros + ones).toBeLessThan(other * 0.55);
  });

  it("paints a black fill and lit ramp/star glyphs", () => {
    const texts: string[] = [];
    const fills: string[] = [];
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
        fills.push(value);
      },
      get fillStyle() {
        return voidFill;
      },
    };
    paintHeroAsciiField(ctx, 320, 240);
    expect(voidFill).toBe("#000000");
    expect(texts.length).toBeGreaterThan(40);
    expect(texts.every((ch) => ALLOWED.has(ch))).toBe(true);
    expect(
      texts.some((ch) =>
        ASCII_CLOUD_RAMP.includes(ch as (typeof ASCII_CLOUD_RAMP)[number]),
      ),
    ).toBe(true);
    expect(fills.some((fill) => fill.startsWith("rgba("))).toBe(true);
    expect(fills.some((fill) => fill.includes("214"))).toBe(true);
  });
});

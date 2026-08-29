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
  productSkyline,
  skyGate,
} from "../hero-ascii-field";

const ALLOWED = new Set<string>([...ASCII_CLOUD_RAMP, ...ASCII_STAR_GLYPHS]);

function sampleGrid(cols: number, rows: number) {
  let glyphs = 0;
  let headline = 0;
  let sky = 0;
  let product = 0;
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
      if (nx > 0.12 && nx < 0.55 && ny > 0.08 && ny < 0.3) headline += 1;
      if (ny < 0.3 && (nx < 0.16 || nx > 0.7)) sky += 1;
      if (ny > 0.58) product += 1;
      if (
        ASCII_STAR_GLYPHS.includes(
          glyph.ch as (typeof ASCII_STAR_GLYPHS)[number],
        ) &&
        cloudDensity(nx, ny, cols / rows) < 0.055
      ) {
        stars += 1;
      }
    }
  }
  return { glyphs, headline, sky, product, stars, seen };
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

  it("keeps the left-aligned headline well empty relative to the top sky", () => {
    const aspect = 1440 / 900;
    expect(headlineWell(0.32, 0.18, aspect)).toBeGreaterThan(0.9);
    expect(headlineWell(0.92, 0.08, aspect)).toBeLessThan(0.15);
    expect(skyGate(0.12, aspect)).toBeGreaterThan(0.95);
    expect(skyGate(0.85, aspect)).toBe(0);
    expect(productSkyline(0.08)).toBe(1);
    expect(productSkyline(0.7)).toBe(0);
    expect(cloudDensity(0.34, 0.2, aspect)).toBeLessThan(0.08);
    expect(cloudDensity(0.94, 0.08, aspect)).toBeGreaterThan(
      cloudDensity(0.36, 0.2, aspect),
    );
    expect(cloudDensity(0.06, 0.08, aspect)).toBeGreaterThan(
      cloudDensity(0.36, 0.2, aspect),
    );
  });

  it("clears the lower band so the product UI sits on black", () => {
    const aspect = 1440 / 900;
    expect(productSkyline(0.08)).toBe(1);
    expect(productSkyline(0.7)).toBe(0);
    expect(cloudDensity(0.5, 0.72, aspect)).toBe(0);
    expect(cloudDensity(0.06, 0.88, aspect)).toBe(0);
    expect(cloudDensity(0.94, 0.86, aspect)).toBe(0);
    expect(glyphAt(8, 70, 160, 90)).toBeNull();
    expect(glyphAt(150, 80, 160, 90)).toBeNull();
  });

  it("puts billows in the top sky and leaves the product band empty", () => {
    const desktop = sampleGrid(160, 90);
    expect(desktop.glyphs).toBeGreaterThan(400);
    expect(desktop.sky).toBeGreaterThan(desktop.headline);
    expect(desktop.product).toBe(0);
    expect(desktop.headline / desktop.glyphs).toBeLessThan(0.18);
    expect(desktop.stars).toBeGreaterThan(0);
    for (const ch of desktop.seen) {
      expect(ALLOWED.has(ch), ch).toBe(true);
    }

    const mobile = sampleGrid(48, 96);
    expect(mobile.glyphs).toBeGreaterThan(80);
    expect(mobile.product).toBe(0);
    expect(cloudDensity(0.5, 0.14, 390 / 844)).toBeLessThan(0.1);
    expect(cloudDensity(0.02, 0.1, 390 / 844)).toBeGreaterThan(0.05);
    expect(cloudDensity(0.98, 0.08, 390 / 844)).toBeGreaterThan(0.08);
    expect(cloudDensity(0.5, 0.92, 390 / 844)).toBe(0);
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

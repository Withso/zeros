import { describe, expect, it } from "vitest";
import {
  CODE_SCRAMBLE,
  DESIGN_ICONS,
  DESIGN_MARKS,
  DESIGN_SCRAMBLE,
  escapeHtml,
  fillScrambleCells,
  MATRIX_SCRAMBLE,
  renderGlyphRun,
  rotateScrambleIcons,
  SCRAMBLE_PALETTE,
  scrambleFill,
  scrambleGlyphKind,
  scrambleTail,
} from "../../components/scramble-text";

const ROLE_WORDS = /builders|developers|designers|components/;
const NON_ASCII = /[^\u0020-\u007E]/;
const CJK_OR_KATAKANA = /[\u3000-\u9FFF\uFF00-\uFFEF\u30A0-\u30FF]/;
const LONG_DESIGN_WORDS = /auto|hug|fill|gap|align|var|8px/;

function visibleText(html: string): string {
  let out = "";
  let inTag = false;
  for (const ch of html) {
    if (!inTag && ch === "<") {
      inTag = true;
      continue;
    }
    if (inTag) {
      if (ch === ">") inTag = false;
      continue;
    }
    out += ch;
  }
  return out;
}

function svgCount(html: string): number {
  return html.match(/<svg/g)?.length ?? 0;
}

function iconName(html: string): string {
  return html.match(/data-hero-scramble-icon="([^"]+)"/)?.[1] ?? "";
}

describe("hero scramble fill", () => {
  it("returns an empty string for non-positive length", () => {
    expect(scrambleFill(0, "abc")).toBe("");
    expect(scrambleTail(0, CODE_SCRAMBLE)).toBe("");
  });

  it("stays within the requested length", () => {
    for (let i = 0; i < 40; i += 1) {
      const out = scrambleFill(8, "{}[]01");
      expect(out.length).toBe(8);
    }
  });

  it("escapes markup in revealed text", () => {
    expect(escapeHtml("</>")).toBe("&lt;/&gt;");
  });

  it("keeps the matrix charset to ASCII digits", () => {
    expect(MATRIX_SCRAMBLE.chars).toMatch(/[01]/);
    expect(MATRIX_SCRAMBLE.chars).toMatch(/^[01]+$/);
    expect(MATRIX_SCRAMBLE.chars).not.toMatch(NON_ASCII);
    expect(MATRIX_SCRAMBLE.chars).not.toMatch(CJK_OR_KATAKANA);
    expect(MATRIX_SCRAMBLE.chars).not.toMatch(/ﾊ/);
  });

  it("keeps the code and matrix charsets unchanged", () => {
    expect(CODE_SCRAMBLE.chars).toBe("{}[]</>;:=()*&|#$@!?\\^~`01");
    expect(CODE_SCRAMBLE.icons).toBeUndefined();
    expect(MATRIX_SCRAMBLE.chars).toBe("01");
    expect(MATRIX_SCRAMBLE.icons).toBeUndefined();
  });

  it("varies the designers scramble across distinct design-tool marks", () => {
    expect([...DESIGN_MARKS]).toEqual([
      "arrow",
      "bars",
      "layout",
      "swatch",
      "sync",
      "media",
      "select",
      "crop",
    ]);
    expect(DESIGN_ICONS.length).toBe(8);
    expect(new Set(DESIGN_ICONS).size).toBe(8);
    expect(DESIGN_SCRAMBLE.icons).toBe(DESIGN_ICONS);
    expect(DESIGN_SCRAMBLE.chars).toMatch(/^[\#|+]+$/);
    expect(DESIGN_SCRAMBLE.chars).not.toMatch(ROLE_WORDS);
    expect(DESIGN_SCRAMBLE.chars).not.toMatch(LONG_DESIGN_WORDS);
    expect([...SCRAMBLE_PALETTE]).toEqual([
      "#68E098",
      "#F0C840",
      "#E87038",
      "#E84848",
      "#E840A8",
      "#B838F0",
      "#3888F0",
      "#E8E8E8",
    ]);

    const catalog = DESIGN_ICONS.join("");
    expect(catalog).toMatch(/hero-scramble-icon/);
    expect(catalog).toMatch(/<circle /);
    expect(catalog).toMatch(/<rect /);
    expect(catalog).not.toMatch(/<ellipse /);
    expect(catalog).not.toMatch(/currentColor/);
    for (const name of DESIGN_MARKS) {
      expect(catalog).toMatch(`data-hero-scramble-icon="${name}"`);
    }
    for (const color of SCRAMBLE_PALETTE) {
      expect(catalog.toUpperCase()).toContain(color);
    }
    expect(catalog.split("<svg ").length - 1).toBe(DESIGN_ICONS.length);

    const seen = new Set<string>();
    for (let i = 0; i < 40; i += 1) {
      const cells = fillScrambleCells(10, DESIGN_SCRAMBLE);
      expect(cells).toHaveLength(10);
      const icons = cells.filter((cell) => cell.kind === "icon");
      const chars = cells.filter((cell) => cell.kind === "char");
      expect(icons.length).toBeLessThan(chars.length);
      expect(icons.length).toBeGreaterThanOrEqual(3);
      expect(icons.length).toBeLessThanOrEqual(4);
      expect(new Set(icons.map((cell) => cell.html)).size).toBe(icons.length);
      expect(new Set(icons.map((cell) => iconName(cell.html))).size).toBe(
        icons.length,
      );
      for (const cell of chars) {
        expect(SCRAMBLE_PALETTE).toContain(cell.color);
      }
      for (let j = 1; j < cells.length; j += 1) {
        const prev = cells[j - 1]!;
        const next = cells[j]!;
        if (prev.kind === "icon" && next.kind === "icon") {
          expect(prev.html).not.toBe(next.html);
          expect(iconName(prev.html)).not.toBe(iconName(next.html));
        }
      }
      for (const cell of icons) seen.add(cell.html);
      const html = scrambleTail(10, DESIGN_SCRAMBLE);
      expect(svgCount(html)).toBeGreaterThanOrEqual(3);
      expect(svgCount(html)).toBeLessThanOrEqual(4);
      expect(visibleText(html)).not.toMatch(ROLE_WORDS);
      expect(visibleText(html)).not.toMatch(LONG_DESIGN_WORDS);
      expect(visibleText(html)).not.toMatch(CJK_OR_KATAKANA);
    }
    expect(seen.size).toBe(DESIGN_ICONS.length);
  });

  it("slides design marks instead of reprinting the same set in place", () => {
    let changed = 0;
    for (let trial = 0; trial < 80; trial += 1) {
      const cells = fillScrambleCells(10, DESIGN_SCRAMBLE);
      const rotated = rotateScrambleIcons(cells, 1);
      const names = (row: typeof cells) =>
        row
          .filter((cell) => cell.kind === "icon")
          .map((cell) => iconName(cell.html));
      const from = names(cells);
      const to = names(rotated);
      expect(from.length).toBeGreaterThanOrEqual(3);
      expect(from.length).toBeLessThanOrEqual(4);
      expect(to).toHaveLength(from.length);
      expect([...to].sort()).toEqual([...from].sort());
      if (to.join() !== from.join()) changed += 1;
      for (let j = 1; j < rotated.length; j += 1) {
        const prev = rotated[j - 1]!;
        const next = rotated[j]!;
        if (prev.kind === "icon" && next.kind === "icon") {
          expect(iconName(prev.html)).not.toBe(iconName(next.html));
        }
      }
    }
    expect(changed).toBeGreaterThan(50);
  });

  it("does not plant full role words into code or matrix scrambles", () => {
    const samples = [
      ...Array.from({ length: 40 }, () => scrambleTail(11, CODE_SCRAMBLE)),
      ...Array.from({ length: 40 }, () => scrambleTail(11, MATRIX_SCRAMBLE)),
    ];
    for (const html of samples) {
      expect(html).not.toMatch(/hero-scramble-icon/);
      expect(html).not.toMatch(/<svg/i);
      expect(html).toMatch(/style="color:#/);
      const colors = [
        ...html.matchAll(/style="color:(#[0-9A-Fa-f]{6})"/g),
      ].map((match) => match[1]);
      expect(colors.length).toBeGreaterThan(0);
      expect(new Set(colors).size).toBeGreaterThan(1);
      for (const color of colors) {
        expect(SCRAMBLE_PALETTE).toContain(color);
      }
      expect(visibleText(html)).not.toMatch(ROLE_WORDS);
      expect(visibleText(html)).not.toMatch(CJK_OR_KATAKANA);
    }
  });

  it("renders matrix tails as digit runs at the same glyph role", () => {
    const html = scrambleTail(11, MATRIX_SCRAMBLE);
    expect(html).toMatch(/hero-scramble-symbol/);
    expect(visibleText(html)).toMatch(/^[01]+$/);
    expect(visibleText(html)).toHaveLength(11);
  });

  it("decrypts as a left-to-right wave instead of flashing the whole word", () => {
    expect(scrambleGlyphKind(0, 0, 10)).toBe("from");
    expect(scrambleGlyphKind(9, 0, 10)).toBe("from");
    expect(scrambleGlyphKind(0, 0.5, 10)).toBe("to");
    expect(scrambleGlyphKind(9, 0.5, 10)).toBe("scramble");
    expect(scrambleGlyphKind(9, 1, 10)).toBe("to");
    for (let i = 0; i < 10; i += 1) {
      expect(scrambleGlyphKind(i, 0.3, 10)).toBe("scramble");
      expect(scrambleGlyphKind(i, 1, 10)).toBe("to");
    }
  });

  it("wraps settled letters, scramble digits, and icons", () => {
    const html = renderGlyphRun([
      { kind: "to", ch: "d" },
      { kind: "to", ch: "e" },
      { kind: "scramble", ch: "#", color: "#68E098" },
      { kind: "icon", html: '<svg class="hero-scramble-icon"></svg>' },
    ]);
    expect(html).toBe(
      '<span class="hero-scramble-text hero-role-revealed">de</span><span class="hero-scramble-symbol" style="color:#68E098">#</span><svg class="hero-scramble-icon"></svg>',
    );
  });
});

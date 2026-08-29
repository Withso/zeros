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
  scrambleFill,
  scrambleGlyphKind,
  scrambleTail,
} from "../../components/scramble-text";

const ROLE_WORDS = /builders|developers|designers|components/;
const NON_ASCII = /[^\x00-\x7F]/;
const CJK_OR_KATAKANA = /[\u3000-\u9FFF\uFF00-\uFFEF\u30A0-\u30FF]/;
const LONG_DESIGN_WORDS = /auto|hug|fill|gap|align|var|8px/;

function visibleText(html: string): string {
  return html.replace(/<[^>]+>/g, "");
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
      "frame",
      "component",
      "align",
      "rect",
      "circle",
      "triangle",
    ]);
    expect(DESIGN_ICONS.length).toBe(6);
    expect(new Set(DESIGN_ICONS).size).toBe(6);
    expect(DESIGN_SCRAMBLE.icons).toBe(DESIGN_ICONS);
    expect(DESIGN_SCRAMBLE.chars).toMatch(/^[\#|+]+$/);
    expect(DESIGN_SCRAMBLE.chars).not.toMatch(ROLE_WORDS);
    expect(DESIGN_SCRAMBLE.chars).not.toMatch(LONG_DESIGN_WORDS);

    const catalog = DESIGN_ICONS.join("");
    expect(catalog).toMatch(/hero-scramble-icon/);
    expect(catalog).toMatch(/<circle /);
    expect(catalog).toMatch(/<rect /);
    expect(catalog).not.toMatch(/<ellipse /);
    for (const name of DESIGN_MARKS) {
      expect(catalog).toMatch(`data-hero-scramble-icon="${name}"`);
    }
    expect(catalog.split("<svg ").length - 1).toBe(DESIGN_ICONS.length);

    const seen = new Set<string>();
    for (let i = 0; i < 40; i += 1) {
      const cells = fillScrambleCells(10, DESIGN_SCRAMBLE);
      expect(cells).toHaveLength(10);
      const icons = cells.filter((cell) => cell.kind === "icon");
      const chars = cells.filter((cell) => cell.kind === "char");
      expect(icons.length).toBeGreaterThan(chars.length);
      expect(icons.length).toBeGreaterThanOrEqual(6);
      expect(new Set(icons.map((cell) => cell.html)).size).toBeGreaterThanOrEqual(
        5,
      );
      expect(
        new Set(icons.map((cell) => iconName(cell.html))).size,
      ).toBeGreaterThanOrEqual(5);
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
      expect(svgCount(html)).toBeGreaterThanOrEqual(6);
      expect(visibleText(html)).not.toMatch(ROLE_WORDS);
      expect(visibleText(html)).not.toMatch(LONG_DESIGN_WORDS);
      expect(visibleText(html)).not.toMatch(CJK_OR_KATAKANA);
    }
    expect(seen.size).toBe(DESIGN_ICONS.length);
  });

  it("slides design marks instead of reprinting the same set in place", () => {
    const cells = fillScrambleCells(10, DESIGN_SCRAMBLE);
    const rotated = rotateScrambleIcons(cells, 1);
    const names = (row: typeof cells) =>
      row
        .filter((cell) => cell.kind === "icon")
        .map((cell) => iconName(cell.html));
    const from = names(cells);
    const to = names(rotated);
    expect(from.length).toBeGreaterThanOrEqual(6);
    expect(to).toHaveLength(from.length);
    expect([...to].sort()).toEqual([...from].sort());
    expect(to).not.toEqual(from);
    for (let i = 1; i < to.length; i += 1) {
      expect(to[i]).not.toBe(to[i - 1]);
    }
  });

  it("does not plant full role words into code or matrix scrambles", () => {
    const samples = [
      ...Array.from({ length: 40 }, () => scrambleTail(11, CODE_SCRAMBLE)),
      ...Array.from({ length: 40 }, () => scrambleTail(11, MATRIX_SCRAMBLE)),
    ];
    for (const html of samples) {
      expect(html).not.toMatch(/hero-scramble-icon/);
      expect(html).not.toMatch(/<svg/i);
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
      { kind: "scramble", ch: "#" },
      { kind: "icon", html: '<svg class="hero-scramble-icon"></svg>' },
    ]);
    expect(html).toBe(
      '<span class="hero-scramble-text hero-role-revealed">de</span><span class="hero-scramble-symbol">#</span><svg class="hero-scramble-icon"></svg>',
    );
  });
});

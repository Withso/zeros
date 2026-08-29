import { describe, expect, it } from "vitest";
import {
  CODE_SCRAMBLE,
  DESIGN_ICON_MAX,
  DESIGN_ICONS,
  DESIGN_SCRAMBLE,
  escapeHtml,
  fillScrambleCells,
  MATRIX_SCRAMBLE,
  renderGlyphRun,
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

  it("keeps the designers scramble as short as a character run", () => {
    expect(DESIGN_ICONS).toHaveLength(4);
    expect(DESIGN_SCRAMBLE.icons).toBe(DESIGN_ICONS);
    expect(DESIGN_SCRAMBLE.chars).not.toMatch(ROLE_WORDS);
    expect(DESIGN_SCRAMBLE.chars).not.toMatch(LONG_DESIGN_WORDS);

    for (let i = 0; i < 40; i += 1) {
      const cells = fillScrambleCells(9, DESIGN_SCRAMBLE);
      expect(cells).toHaveLength(9);
      const icons = cells.filter((cell) => cell.kind === "icon");
      expect(icons.length).toBeLessThanOrEqual(DESIGN_ICON_MAX);
      const htmls = icons.map((cell) => cell.html);
      expect(new Set(htmls).size).toBe(htmls.length);
      const html = scrambleTail(9, DESIGN_SCRAMBLE);
      expect(svgCount(html)).toBeLessThanOrEqual(DESIGN_ICON_MAX);
      expect(visibleText(html)).not.toMatch(ROLE_WORDS);
      expect(visibleText(html)).not.toMatch(LONG_DESIGN_WORDS);
      expect(visibleText(html)).not.toMatch(CJK_OR_KATAKANA);
    }
    const samples = Array.from({ length: 40 }, () => scrambleTail(9, DESIGN_SCRAMBLE));
    expect(samples.some((html) => html.includes("hero-scramble-icon"))).toBe(true);
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

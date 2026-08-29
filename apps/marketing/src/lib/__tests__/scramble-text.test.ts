import { describe, expect, it } from "vitest";
import {
  CODE_SCRAMBLE,
  DESIGN_ICONS,
  DESIGN_SCRAMBLE,
  DESIGN_TOKENS,
  escapeHtml,
  MATRIX_SCRAMBLE,
  renderGlyphRun,
  scrambleFill,
  scrambleGlyphKind,
  scrambleTail,
} from "../../components/scramble-text";

const ROLE_WORDS = /builders|developers|designers|components/;
const NON_ASCII = /[^\x00-\x7F]/;
const CJK_OR_KATAKANA = /[\u3000-\u9FFF\uFF00-\uFFEF\u30A0-\u30FF]/;

function visibleText(html: string): string {
  return html.replace(/<[^>]+>/g, "");
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

  it("mixes alignment and Figma marks into the designers scramble", () => {
    expect(DESIGN_ICONS.length).toBeGreaterThanOrEqual(6);
    expect(DESIGN_SCRAMBLE.icons).toBe(DESIGN_ICONS);
    expect(DESIGN_TOKENS).toEqual(
      expect.arrayContaining(["auto", "hug", "fill", "gap", "align"]),
    );
    expect(DESIGN_TOKENS.join(" ")).not.toMatch(/components/);
    expect(DESIGN_SCRAMBLE.chars).not.toMatch(ROLE_WORDS);

    const samples = Array.from({ length: 50 }, () => scrambleTail(11, DESIGN_SCRAMBLE));
    expect(samples.some((html) => html.includes("hero-scramble-icon"))).toBe(true);
    expect(samples.some((html) => html.includes("<svg"))).toBe(true);
    const joined = samples.map(visibleText).join("");
    expect(joined).toMatch(/auto|hug|fill|gap|align|var|8px/);
    for (const html of samples) {
      expect(visibleText(html)).not.toMatch(ROLE_WORDS);
      expect(visibleText(html)).not.toMatch(CJK_OR_KATAKANA);
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

  it("wraps settled letters, scramble digits, tokens, and icons", () => {
    const html = renderGlyphRun([
      { kind: "to", ch: "d" },
      { kind: "to", ch: "e" },
      { kind: "token", ch: "a" },
      { kind: "token", ch: "u" },
      { kind: "scramble", ch: "#" },
      { kind: "icon", html: '<svg class="hero-scramble-icon"></svg>' },
    ]);
    expect(html).toBe(
      '<span class="hero-scramble-text hero-role-revealed">de</span><span class="hero-scramble-token">au</span><span class="hero-scramble-symbol">#</span><svg class="hero-scramble-icon"></svg>',
    );
  });
});

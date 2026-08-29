import { describe, expect, it } from "vitest";
import {
  CODE_SCRAMBLE,
  DESIGN_SCRAMBLE,
  escapeHtml,
  MATRIX_SCRAMBLE,
  scrambleFill,
  scrambleTail,
} from "../../components/scramble-text";

describe("hero scramble fill", () => {
  it("returns an empty string for non-positive length", () => {
    expect(scrambleFill(0, "abc", ["fn"])).toBe("");
    expect(scrambleTail(0, CODE_SCRAMBLE)).toBe("");
  });

  it("stays within the requested length", () => {
    for (let i = 0; i < 40; i += 1) {
      const out = scrambleFill(8, "{}[]", ["fn", "git"]);
      expect(out.length).toBe(8);
    }
  });

  it("escapes markup in revealed text", () => {
    expect(escapeHtml("</>")).toBe("&lt;/&gt;");
  });

  it("mixes design tokens and icon markup into the designers scramble", () => {
    expect(DESIGN_SCRAMBLE.tokens).toEqual(
      expect.arrayContaining(["align", "frame", "design", "components"]),
    );
    expect(DESIGN_SCRAMBLE.icons.length).toBeGreaterThan(0);
    expect(CODE_SCRAMBLE.tokens).toEqual(expect.arrayContaining(["const", "async"]));
    expect(MATRIX_SCRAMBLE.chars).toMatch(/[01]/);
    expect(MATRIX_SCRAMBLE.chars).toMatch(/ﾊ/);

    const samples = Array.from({ length: 40 }, () => scrambleTail(11, DESIGN_SCRAMBLE));
    expect(samples.some((html) => html.includes("hero-scramble-icon"))).toBe(true);
    const joined = samples.join("");
    expect(joined).toMatch(/align|frame|design|components|auto|layer|stack|grid|layout/);
  });
});

import { describe, it, expect } from "vitest";
import {
  leadingWhitespaceColumns,
  hangingIndentStyle,
} from "../wrapped-line-indent";

describe("leadingWhitespaceColumns", () => {
  it("counts leading spaces", () => {
    expect(leadingWhitespaceColumns('      "description": "x"', 4)).toBe(6);
  });

  it("advances tabs to the next tab stop", () => {
    expect(leadingWhitespaceColumns("\tx", 4)).toBe(4);
    // space then tab: the tab completes the same 4-column stop
    expect(leadingWhitespaceColumns(" \tx", 4)).toBe(4);
    // tab then space: one column past the stop
    expect(leadingWhitespaceColumns("\t x", 4)).toBe(5);
    expect(leadingWhitespaceColumns("\t\tx", 2)).toBe(4);
  });

  it("counts NBSP as one column", () => {
    expect(leadingWhitespaceColumns("  x", 4)).toBe(2);
  });

  it("returns 0 for unindented and empty lines", () => {
    expect(leadingWhitespaceColumns("const x = 1;", 4)).toBe(0);
    expect(leadingWhitespaceColumns("", 4)).toBe(0);
  });

  it("stops at the first non-whitespace character", () => {
    expect(leadingWhitespaceColumns("  x  y", 4)).toBe(2);
  });
});

describe("hangingIndentStyle", () => {
  it("returns null for unindented lines (nothing to hang)", () => {
    expect(hangingIndentStyle("const x = 1;", 4, 100)).toBeNull();
    expect(hangingIndentStyle("", 4, 100)).toBeNull();
  });

  it("hangs the indent on every row but the first", () => {
    expect(hangingIndentStyle("      x", 4, 100)).toBe(
      "text-indent: 6ch hanging;",
    );
  });

  it("measures tab indents in visible columns", () => {
    expect(hangingIndentStyle("\t\tx", 4, 100)).toBe(
      "text-indent: 8ch hanging;",
    );
  });

  // Regression: the classic `padding-left: Nch; text-indent: -Nch` pair moved
  // row 1 out of the line's content box, which moves the CSS tab-stop origin
  // with it. A leading tab on a line whose indent is not a whole number of tab
  // stops then rendered short — `\t\t "x"` (9 columns at tab-size 4) drew its
  // content at column 6. A positive hanging indent leaves row 1 alone, so the
  // tab stops stay where the guides and the continuation rows expect them.
  it("never shifts row 1 (no negative indent, no padding override)", () => {
    for (const text of ["\t x", "\t\t x", "\t\t   x", "  \tx", "    x"]) {
      const style = hangingIndentStyle(text, 4, 100);
      expect(style).not.toBeNull();
      expect(style).not.toContain("padding");
      expect(style).not.toMatch(/:\s*-/); // no negative indent
      expect(style).toContain("hanging");
    }
  });

  it("counts a mixed tab/space indent in visible columns", () => {
    expect(hangingIndentStyle("\t x", 4, 100)).toBe(
      "text-indent: 5ch hanging;",
    );
    expect(hangingIndentStyle("\t\t x", 4, 100)).toBe(
      "text-indent: 9ch hanging;",
    );
  });

  it("drops the indent beyond maxColumns instead of clamping", () => {
    // A clamped hang would align continuation rows with no real indent level;
    // falling back to flat wrapping (today's behavior) reads better.
    expect(hangingIndentStyle("          x", 4, 8)).toBeNull();
    expect(hangingIndentStyle("        x", 4, 8)).not.toBeNull();
  });

  it("still hangs whitespace-only lines (harmless: there is no second row)", () => {
    expect(hangingIndentStyle("    ", 4, 100)).toBe(
      "text-indent: 4ch hanging;",
    );
  });
});

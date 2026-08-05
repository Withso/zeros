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

  it("pairs padding-left with an equal negative text-indent", () => {
    expect(hangingIndentStyle("      x", 4, 100)).toBe(
      "padding-left: calc(6ch + 6px); text-indent: -6ch;",
    );
  });

  it("measures tab indents in visible columns", () => {
    expect(hangingIndentStyle("\t\tx", 4, 100)).toBe(
      "padding-left: calc(8ch + 6px); text-indent: -8ch;",
    );
  });

  it("drops the indent beyond maxColumns instead of clamping", () => {
    // A clamped hang would align continuation rows with no real indent level;
    // falling back to flat wrapping (today's behavior) reads better.
    expect(hangingIndentStyle("          x", 4, 8)).toBeNull();
    expect(hangingIndentStyle("        x", 4, 8)).not.toBeNull();
  });

  it("still hangs whitespace-only lines (harmless: workbench is the only row)", () => {
    expect(hangingIndentStyle("    ", 4, 100)).toBe(
      "padding-left: calc(4ch + 6px); text-indent: -4ch;",
    );
  });
});

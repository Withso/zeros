import { describe, it, expect } from "vitest";
import {
  indentEndOffset,
  isPlainPointerClick,
  snapClickOutOfIndent,
} from "../indent-click-snap";

describe("indentEndOffset", () => {
  it("measures leading spaces in characters", () => {
    expect(indentEndOffset('      "!docs/**",')).toBe(6);
  });

  it("counts each tab and NBSP as one character (offsets, not columns)", () => {
    expect(indentEndOffset("\t\tx")).toBe(2);
    expect(indentEndOffset("  x")).toBe(2);
    expect(indentEndOffset(" \t x")).toBe(3);
  });

  it("returns 0 when there is no indentation", () => {
    expect(indentEndOffset("const x = 1;")).toBe(0);
    expect(indentEndOffset("")).toBe(0);
  });

  it("stops at the first non-whitespace character", () => {
    expect(indentEndOffset("  x  y")).toBe(2);
  });

  it("treats a whitespace-only line as indentation all the way to its end", () => {
    expect(indentEndOffset("      ")).toBe(6);
  });
});

describe("snapClickOutOfIndent", () => {
  // The reported bug: clicking the leftmost indent guide of
  //     |      "!docs/**",
  // left the caret at column 0, so typing produced `dfs      "!docs/**",` —
  // outside the nesting, with the line's guides and hanging indent gone.
  const line = { from: 100, text: '      "!docs/**",' };

  it("moves a click on the leftmost guide (column 0) to the content start", () => {
    expect(snapClickOutOfIndent(line, 100)).toBe(106);
  });

  it("moves a click anywhere inside the indentation to the content start", () => {
    expect(snapClickOutOfIndent(line, 101)).toBe(106);
    expect(snapClickOutOfIndent(line, 103)).toBe(106);
    expect(snapClickOutOfIndent(line, 105)).toBe(106);
  });

  it("leaves a click at the content start alone", () => {
    expect(snapClickOutOfIndent(line, 106)).toBe(106);
  });

  it("leaves a click inside the content alone", () => {
    expect(snapClickOutOfIndent(line, 110)).toBe(110);
    expect(snapClickOutOfIndent(line, line.from + line.text.length)).toBe(117);
  });

  it("leaves every position on an unindented line alone", () => {
    const flat = { from: 0, text: "const x = 1;" };
    expect(snapClickOutOfIndent(flat, 0)).toBe(0);
    expect(snapClickOutOfIndent(flat, 5)).toBe(5);
  });

  it("counts a tab indent in characters, not columns", () => {
    // Two tabs render as 4+ columns but are 2 document offsets: a click on the
    // second guide must land after the tabs, not 4 characters in.
    const tabbed = { from: 40, text: '\t\t"tabbed": true' };
    expect(snapClickOutOfIndent(tabbed, 40)).toBe(42);
    expect(snapClickOutOfIndent(tabbed, 41)).toBe(42);
    expect(snapClickOutOfIndent(tabbed, 42)).toBe(42);
  });

  it("puts a click on a whitespace-only line at the end of its indentation", () => {
    const blank = { from: 200, text: "      " };
    expect(snapClickOutOfIndent(blank, 200)).toBe(206);
    expect(snapClickOutOfIndent(blank, 203)).toBe(206);
    expect(snapClickOutOfIndent(blank, 206)).toBe(206);
  });

  it("ignores a position that is not on the line", () => {
    expect(snapClickOutOfIndent(line, 99)).toBe(99);
  });
});

describe("isPlainPointerClick", () => {
  const plain = {
    button: 0,
    detail: 1,
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
  };

  it("accepts a single primary-button click", () => {
    expect(isPlainPointerClick(plain)).toBe(true);
    // Synthesized clicks can report detail 0.
    expect(isPlainPointerClick({ ...plain, detail: 0 })).toBe(true);
  });

  it("keeps CodeMirror's own behaviour for every richer gesture", () => {
    // Word/line selection, extend, multi-cursor, rectangular selection.
    expect(isPlainPointerClick({ ...plain, detail: 2 })).toBe(false);
    expect(isPlainPointerClick({ ...plain, detail: 3 })).toBe(false);
    expect(isPlainPointerClick({ ...plain, shiftKey: true })).toBe(false);
    expect(isPlainPointerClick({ ...plain, metaKey: true })).toBe(false);
    expect(isPlainPointerClick({ ...plain, ctrlKey: true })).toBe(false);
    expect(isPlainPointerClick({ ...plain, altKey: true })).toBe(false);
  });

  it("ignores non-primary buttons", () => {
    expect(isPlainPointerClick({ ...plain, button: 1 })).toBe(false);
    expect(isPlainPointerClick({ ...plain, button: 2 })).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import {
  indentEndOffset,
  isPlainPointerClick,
  remapGestureAfterChange,
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

describe("remapGestureAfterChange", () => {
  // A file is rewritten (agent turn, Git checkout) while the button is held.
  // The caret CodeMirror holds was mapped through that change; `reselect` is
  // the only way a freshly derived target reaches it, so it has to be true
  // exactly when mapping alone would leave the caret in the wrong place.
  const shiftBy = (delta: number) => (pos: number) => pos + delta;

  it("asks for a re-select when the edit deepened the line's indentation", () => {
    // Pressed column 0 of `  x`, snapped to its content at 102. The rewrite
    // re-indents the line to 6 spaces, so 102 is now INSIDE the indentation —
    // the stranded caret this exists to prevent.
    const next = remapGestureAfterChange(
      { pressed: 100, target: 102 },
      shiftBy(0),
      () => ({ from: 100, text: '      "!docs/**",' }),
    );
    expect(next).toEqual({ pressed: 100, target: 106, reselect: true });
  });

  it("asks for a re-select when the edit removed the indentation", () => {
    const next = remapGestureAfterChange(
      { pressed: 100, target: 106 },
      shiftBy(0),
      () => ({ from: 100, text: '"!docs/**",' }),
    );
    expect(next).toEqual({ pressed: 100, target: 100, reselect: true });
  });

  it("stays quiet when mapping already lands the caret at the content start", () => {
    // An insert above the line shifts everything by 20; the indentation is
    // untouched, so CodeMirror's own mapped caret is already correct.
    const next = remapGestureAfterChange(
      { pressed: 100, target: 106 },
      shiftBy(20),
      () => ({ from: 120, text: '      "!docs/**",' }),
    );
    expect(next).toEqual({ pressed: 120, target: 126, reselect: false });
  });

  it("re-derives from the new text rather than mapping the old target", () => {
    // Mapping alone would say 126; the line now has 2 spaces, so 122 is right.
    const next = remapGestureAfterChange(
      { pressed: 100, target: 106 },
      shiftBy(20),
      () => ({ from: 120, text: '  "!docs/**",' }),
    );
    expect(next.target).toBe(122);
    expect(next.reselect).toBe(true);
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

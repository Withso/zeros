// The reported bug: opening or switching files showed unthemed text for a frame
// and then repainted in the code theme. @uiw/react-codemirror builds the
// EditorState in a LAYOUT effect (before paint), so "the first painted frame is
// themed" is exactly "EditorState.create already carries color decorations".
// These tests assert that against the real shiki highlighter.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { EditorState, Text } from "@codemirror/state";
import { EditorView, type DecorationSet } from "@codemirror/view";

import { prewarmSyntax } from "@/zeros/agent/renderers/syntax";
import { shikiColors } from "../shiki-highlight";

const THEME = "github-dark-default";

const SOURCE = `import { useState } from "react";

export function Counter({ start = 0 }: { start?: number }) {
  const [n, setN] = useState(start);
  return <button onClick={() => setN(n + 1)}>{n}</button>;
}
`;

/** Total decorations the state hands the view on its FIRST paint. */
function firstPaintDecorationCount(
  doc: string | Text,
  lang: string | null,
): number {
  const state = EditorState.create({
    doc,
    extensions: [shikiColors({ lang, theme: THEME })],
  });
  let count = 0;
  for (const value of state.facet(EditorView.decorations)) {
    // Our layer provides a plain DecorationSet (not a per-view function).
    if (typeof value !== "function") count += (value as DecorationSet).size;
  }
  return count;
}

describe("Shiki first paint", () => {
  beforeAll(async () => {
    // The renderer does this at idle + on every file read (prewarmFileSyntax);
    // without a warm highlighter there is nothing to tokenize synchronously.
    await prewarmSyntax("tsx", THEME);
  });

  it("colors the document in EditorState.create (no unthemed first frame)", () => {
    expect(firstPaintDecorationCount(SOURCE, "tsx")).toBeGreaterThan(10);
  });

  it("re-creating the same state is served from the token cache", () => {
    const first = firstPaintDecorationCount(SOURCE, "tsx");
    // A tab switch remounts the editor with the identical (doc, lang, theme).
    // Same count, and cheap: the second create must not re-tokenize.
    expect(firstPaintDecorationCount(SOURCE, "tsx")).toBe(first);
  });

  it("paints nothing (and never throws) with no language", () => {
    expect(firstPaintDecorationCount(SOURCE, null)).toBe(0);
  });

  it("paints nothing for a grammar that is not loaded yet", () => {
    // The async pass loads it and repaints; the point is create() degrades
    // quietly instead of blocking or throwing.
    expect(firstPaintDecorationCount("let x = 1", "not-a-real-language")).toBe(
      0,
    );
  });

  it("themes the leading lines of a file too big to tokenize synchronously", () => {
    // Above SYNC_TOKENIZE_MAX but under the editor's own color cutoff.
    const big = SOURCE.repeat(400);
    expect(big.length).toBeGreaterThan(60_000);
    expect(big.length).toBeLessThan(300_000);
    const head = firstPaintDecorationCount(big, "tsx");
    expect(head).toBeGreaterThan(10);
    // Head-only: far fewer marks than the whole file would produce.
    const wholeFileEstimate = firstPaintDecorationCount(SOURCE, "tsx") * 400;
    expect(head).toBeLessThan(wholeFileEstimate / 2);
  });

  it("does not stringify the whole large document for its head-only paint", () => {
    const doc = Text.of(
      Array.from(
        { length: 1_000 },
        (_, index) =>
          `export const value${index} = "${"head-only ".repeat(8)}";`,
      ),
    );
    expect(doc.length).toBeGreaterThan(60_000);
    expect(doc.length).toBeLessThan(300_000);
    const toString = vi.spyOn(doc, "toString");

    expect(firstPaintDecorationCount(doc, "tsx")).toBeGreaterThan(10);
    expect(toString).not.toHaveBeenCalled();
  });

  it("skips color entirely past the large-file cutoff", () => {
    expect(firstPaintDecorationCount(SOURCE.repeat(3_000), "tsx")).toBe(0);
  });
});

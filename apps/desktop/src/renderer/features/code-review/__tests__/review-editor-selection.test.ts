import { describe, expect, it } from "vitest";
import { EditorSelection, Text } from "@codemirror/state";
import { editorReviewLineRange } from "../review-editor-selection";

describe("editable source review ranges", () => {
  const doc = Text.of(["one", "two", "three", ""]);

  it("converts forward and backward text selections to inclusive lines", () => {
    expect(editorReviewLineRange(doc, EditorSelection.range(1, 9))).toEqual({
      start: 1,
      end: 3,
    });
    expect(editorReviewLineRange(doc, EditorSelection.range(9, 1))).toEqual({
      start: 1,
      end: 3,
    });
  });

  it("does not include the next line when its start is the exclusive end", () => {
    expect(editorReviewLineRange(doc, EditorSelection.range(0, 8))).toEqual({
      start: 1,
      end: 2,
    });
    expect(editorReviewLineRange(doc, EditorSelection.range(8, 0))).toEqual({
      start: 1,
      end: 2,
    });
  });

  it("uses the caret line for keyboard comments and omits a phantom final line", () => {
    expect(editorReviewLineRange(doc, EditorSelection.cursor(5))).toEqual({
      start: 2,
      end: 2,
    });
    expect(
      editorReviewLineRange(doc, EditorSelection.cursor(doc.length)),
    ).toEqual({ start: 3, end: 3 });
    expect(
      editorReviewLineRange(Text.of([""]), EditorSelection.cursor(0)),
    ).toEqual({ start: 1, end: 1 });
  });
});

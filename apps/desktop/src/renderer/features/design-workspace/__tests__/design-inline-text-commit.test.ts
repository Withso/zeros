import { describe, expect, it } from "vitest";

import {
  beginInlineTextCommit,
  cancelInlineTextCommit,
  createInlineTextCommitGuard,
  finishInlineTextCommit,
  inlineTextKeepsSelection,
  inlineTextSettleFrame,
} from "../design-inline-text-commit";

describe("design inline-text commit guard", () => {
  it("treats the blur after Escape as cancellation without poisoning a reopened edit", () => {
    const guard = createInlineTextCommitGuard<object>();
    const cancelledEdit = {};

    cancelInlineTextCommit(guard, cancelledEdit);
    expect(beginInlineTextCommit(guard, cancelledEdit, "frame\0node\0v1")).toBe(
      false,
    );

    const reopenedEdit = {};
    expect(beginInlineTextCommit(guard, reopenedEdit, "frame\0node\0v1")).toBe(
      true,
    );
    expect(beginInlineTextCommit(guard, reopenedEdit, "frame\0node\0v1")).toBe(
      false,
    );
    finishInlineTextCommit(guard, "frame\0node\0v1");
    expect(beginInlineTextCommit(guard, reopenedEdit, "frame\0node\0v1")).toBe(
      true,
    );
  });
});

describe("settling a committed text edit", () => {
  const frames = [
    { file: "page-1/card.html", sourceVersion: "a".repeat(24) },
    { file: "page-1/hero.html", sourceVersion: "b".repeat(24) },
  ];
  const edit = { frame: "page-1/hero.html", nodeId: "hero-title", sourceVersion: "b".repeat(24) };

  it("settles in the edited frame at its committed generation, whatever is selected", () => {
    // With nothing selected the canvas falls back to the page's first frame;
    // settling looked there and never found an edit made in another frame.
    expect(inlineTextSettleFrame(frames, edit)).toBe(frames[1]);
    expect(inlineTextSettleFrame(frames, { ...edit, sourceVersion: "c".repeat(24) })).toBeNull();
    expect(inlineTextSettleFrame(frames, { ...edit, frame: "page-1/gone.html" })).toBeNull();
  });

  it("keeps the edited text selected only while the selection is still the edit's", () => {
    expect(inlineTextKeepsSelection({ selectedFrame: "page-1/hero.html", selectedNodeId: "hero-title" }, edit)).toBe(true);
    // An empty-canvas click ended the edit and deselected: it stays deselected.
    expect(inlineTextKeepsSelection({ selectedFrame: null, selectedNodeId: null }, edit)).toBe(false);
    expect(inlineTextKeepsSelection({ selectedFrame: "page-1/hero.html", selectedNodeId: "hero-sub" }, edit)).toBe(false);
    expect(inlineTextKeepsSelection({ selectedFrame: "page-1/card.html", selectedNodeId: "hero-title" }, edit)).toBe(false);
  });
});

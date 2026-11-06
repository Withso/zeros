import { describe, expect, it } from "vitest";
import { parseMergeConflicts } from "@zeros/protocol/merge-conflicts";
import {
  conflictPosition,
  conflictRowKind,
  stepConflict,
} from "../merge-conflict-rows";
import { conflictAnnotations, conflictRowsStyle } from "../merge-conflict-pierre";

const TWO = [
  "a",
  "<<<<<<< HEAD",
  "ours",
  "||||||| base",
  "old",
  "=======",
  "theirs",
  ">>>>>>> topic",
  "b",
  "<<<<<<< HEAD",
  "two",
  "=======",
  "zwei",
  ">>>>>>> topic",
  "",
].join("\n");

describe("merge conflict rows", () => {
  it("names every row of a diff3 block", () => {
    const [block] = parseMergeConflicts(TWO).conflicts;
    expect(
      Array.from({ length: block!.endLine - block!.startLine + 1 }, (_, i) =>
        conflictRowKind(block!, block!.startLine + i),
      ),
    ).toEqual([
      "current-marker",
      "current",
      "base",
      "base",
      "separator",
      "incoming",
      "incoming-marker",
    ]);
  });

  it("shows the block at or below the caret and wraps both arrows", () => {
    const { conflicts } = parseMergeConflicts(TWO);
    expect(conflictPosition(conflicts, 1)).toEqual({ shown: 1, next: 0, previous: 1 });
    expect(conflictPosition(conflicts, 3)).toEqual({ shown: 1, next: 1, previous: 1 });
    expect(conflictPosition(conflicts, 9)).toEqual({ shown: 2, next: 1, previous: 0 });
    expect(conflictPosition(conflicts, 15)).toEqual({ shown: 2, next: 0, previous: 1 });
    expect(conflictPosition([], 1).shown).toBe(0);
    expect(stepConflict(undefined, 2, 1)).toBe(0);
    expect(stepConflict(undefined, 2, -1)).toBe(1);
    expect(stepConflict(1, 2, 1)).toBe(0);
    expect(stepConflict(5, 2, -1)).toBe(1);
    expect(stepConflict(0, 0, 1)).toBe(-1);
  });

  it("puts an accept row above each block, or one notice when markers are broken or read-only", () => {
    const payload = (conflict: unknown, id: string) => ({ id, conflict });
    expect(
      conflictAnnotations(parseMergeConflicts(TWO), { canAccept: true, payload }),
    ).toEqual([
      { lineNumber: 1, metadata: { id: "conflict-actions:2", conflict: { kind: "actions", index: 0, count: 2 } } },
      { lineNumber: 9, metadata: { id: "conflict-actions:68", conflict: { kind: "actions", index: 1, count: 2 } } },
    ]);
    expect(
      conflictAnnotations(parseMergeConflicts(TWO), {
        canAccept: false,
        readOnlyNotice: "Open the live editable file to resolve these conflicts.",
        payload,
      }),
    ).toEqual([
      {
        lineNumber: 0,
        metadata: {
          id: "conflict-notice",
          conflict: { kind: "notice", tone: "neutral", message: "Open the live editable file to resolve these conflicts." },
        },
      },
    ]);
    expect(
      conflictAnnotations(parseMergeConflicts("<<<<<<< HEAD\nx\n"), { canAccept: true, payload }),
    ).toEqual([
      {
        lineNumber: 0,
        metadata: {
          id: "conflict-notice",
          conflict: { kind: "notice", tone: "error", message: "Line 1 has no separator or closing marker. Fix it by hand." },
        },
      },
    ]);
    expect(conflictAnnotations(parseMergeConflicts("plain\n"), { canAccept: true, payload })).toEqual([]);
  });

  it("keys Pierre row tints and marker labels to the block's lines only", () => {
    const css = conflictRowsStyle(parseMergeConflicts(TWO));
    expect(css).toContain('[data-line="2"],[data-column-number="2"],[data-line="10"],[data-column-number="10"]{--diffs-computed-decoration-bg:var(--conflict-current-band);}');
    expect(css).toContain('[data-line="4"],[data-column-number="4"],[data-line="5"],[data-column-number="5"]{--diffs-computed-decoration-bg:var(--conflict-neutral);}');
    expect(css).toContain('[data-line="8"]::after,[data-line="14"]::after{content:"(Incoming change)"');
    expect(css).not.toContain('[data-line="1"]');
    expect(css).not.toContain('[data-line="9"]');
    expect(conflictRowsStyle(parseMergeConflicts("<<<<<<< HEAD\nx\n"))).toBe("");
  });
});

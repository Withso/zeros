import { describe, expect, it } from "vitest";
import { getSingularPatch } from "@pierre/diffs";
import {
  anchorFromSelection,
  reviewContentRevision,
  reviewThreadPlacement,
  type ReviewCodeSnapshot,
} from "../review-anchors";
import type { CodeReviewThreadItem } from "../review-thread-model";

const patch = [
  "diff --git a/src/old.ts b/src/new.ts",
  "similarity index 60%",
  "rename from src/old.ts",
  "rename to src/new.ts",
  "--- a/src/old.ts",
  "+++ b/src/new.ts",
  "@@ -40,3 +70,4 @@",
  " const before = true;",
  "-const value = 1;",
  "+const value = 2;",
  "+const added = true;",
  " export { value };",
  "",
].join("\n");
const diff: ReviewCodeSnapshot = {
  kind: "diff",
  path: "src/new.ts",
  revision: reviewContentRevision(patch),
  fileDiff: getSingularPatch(patch),
};
const file: ReviewCodeSnapshot = {
  kind: "file",
  path: "src/new.ts",
  revision: reviewContentRevision("one\ntwo\nthree\n"),
  content: "one\ntwo\nthree\n",
};
function thread(anchor: CodeReviewThreadItem["anchor"]): CodeReviewThreadItem {
  return {
    id: "thread-a",
    source: "workspace",
    anchor,
    comments: [],
    resolved: false,
    version: 1,
  };
}

describe("review line anchors", () => {
  it("captures the opaque published PR revision, including its base and owner", () => {
    const confirmedRevision = "github:workspace:pr-7:base-1:head-1";
    const published = { ...diff, confirmedRevision };
    expect(
      anchorFromSelection(published, { start: 41, end: 41, side: "deletions" }),
    ).toMatchObject({ revision: confirmedRevision, path: "src/old.ts" });
    const changedBase = {
      ...published,
      confirmedRevision: "github:workspace:pr-7:base-2:head-1",
    };
    expect(
      anchorFromSelection(changedBase, {
        start: 41,
        end: 41,
        side: "deletions",
      })!.revision,
    ).not.toBe(confirmedRevision);
  });

  it("retains old/new native sides and sparse hunk line numbers", () => {
    expect(
      anchorFromSelection(diff, { start: 41, end: 41, side: "deletions" }),
    ).toMatchObject({
      path: "src/old.ts",
      side: "old",
      startLine: 41,
      endLine: 41,
      context: "const value = 1;",
    });
    expect(
      anchorFromSelection(diff, { start: 72, end: 71, side: "additions" }),
    ).toMatchObject({
      path: "src/new.ts",
      side: "new",
      startLine: 71,
      endLine: 72,
      context: "const value = 2;\nconst added = true;",
    });
  });

  it("rejects cross-side, invalid, and unrepresented ranges", () => {
    expect(
      anchorFromSelection(diff, {
        start: 41,
        end: 71,
        side: "deletions",
        endSide: "additions",
      }),
    ).toBeNull();
    expect(
      anchorFromSelection(diff, { start: 1, end: 3, side: "additions" }),
    ).toBeNull();
    expect(anchorFromSelection(file, { start: 0, end: 1 })).toBeNull();
    expect(anchorFromSelection(file, { start: 1.5, end: 2 })).toBeNull();
    expect(anchorFromSelection(file, { start: 1, end: 4 })).toBeNull();
  });

  it("uses inclusive ranges without a phantom trailing line", () => {
    expect(anchorFromSelection(file, { start: 3, end: 2 })).toMatchObject({
      side: "file",
      startLine: 2,
      endLine: 3,
      context: "two\nthree",
    });
  });

  it("retains confirmed context during unrelated edits, but never attaches mismatched code", () => {
    const anchor = anchorFromSelection(file, { start: 2, end: 2 })!;
    const changed: ReviewCodeSnapshot = {
      ...file,
      revision: "another",
      content: "changed\ntwo\nthree\n",
    };
    expect(reviewThreadPlacement(thread(anchor), changed)).toEqual({
      lineNumber: 2,
      state: "current",
    });
    expect(
      reviewThreadPlacement(thread(anchor), {
        ...changed,
        content: "one\nother\nthree\n",
      }),
    ).toEqual({ lineNumber: 0, state: "outdated" });
  });

  it("retains missing original ranges as file-level annotations", () => {
    const anchor = {
      path: diff.path,
      side: "new" as const,
      startLine: 12,
      endLine: 13,
      revision: "old",
      context: "removed\ncode",
    };
    expect(reviewThreadPlacement(thread(anchor), diff)).toMatchObject({
      lineNumber: 0,
      state: "unavailable",
    });
  });

  it("places external comments only on a confirmed PR comparison", () => {
    const external = {
      ...thread({
        path: diff.path,
        side: "new",
        startLine: 71,
        endLine: 71,
        revision: "pr-head",
      }),
      source: "github" as const,
    };
    expect(reviewThreadPlacement(external, diff)).toMatchObject({
      lineNumber: 0,
      state: "unavailable",
    });
    expect(
      reviewThreadPlacement(external, {
        ...diff,
        confirmedRevision: "pr-head",
      }),
    ).toMatchObject({ lineNumber: 71, state: "current" });
    expect(
      reviewThreadPlacement(
        { ...external, outdated: true },
        { ...diff, confirmedRevision: "pr-head" },
      ),
    ).toMatchObject({ lineNumber: 0, state: "outdated" });
  });

  it("does not reuse equal-length source revisions", () => {
    expect(reviewContentRevision("one")).not.toBe(reviewContentRevision("two"));
    expect(reviewContentRevision("one")).toBe(reviewContentRevision("one"));
  });
});

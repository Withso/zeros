import { describe, expect, it } from "vitest";
import { parseMergeConflicts, applyConflictChoices } from "../merge-conflicts";
import { splitReviewHunks, reverseReviewHunkContent } from "../review-hunks";

describe("merge conflict previews", () => {
  const source =
    "prefix\n<<<<<<< HEAD\nours\n||||||| ancestor\nbase\n=======\ntheirs\n>>>>>>> topic\nsuffix\n";
  it("parses diff3 labels and previews each choice without touching other bytes", () => {
    const parsed = parseMergeConflicts(source);
    expect(parsed.errors).toEqual([]);
    expect(parsed.conflicts).toHaveLength(1);
    const conflict = parsed.conflicts[0];
    expect(conflict).toMatchObject({
      current: "ours\n",
      base: "base\n",
      incoming: "theirs\n",
      currentLabel: "HEAD",
      incomingLabel: "topic",
      startLine: 2,
      endLine: 8,
    });
    for (const [choice, expected] of [
      ["current", "ours\n"],
      ["incoming", "theirs\n"],
      ["both", "ours\ntheirs\n"],
    ] as const) {
      expect(applyConflictChoices(source, { [conflict.id]: choice })).toEqual({
        content: `prefix\n${expected}suffix\n`,
        remaining: 0,
      });
    }
    expect(source).toContain("||||||| ancestor");
  });
  it("keeps unresolved blocks verbatim and resolves multiple blocks independently", () => {
    const second = "<<<<<<< current\nA\n=======\nB\n>>>>>>> incoming\n";
    const full = source + second;
    const blocks = parseMergeConflicts(full).conflicts;
    expect(applyConflictChoices(full, { [blocks[0].id]: "incoming" })).toEqual({
      content: "prefix\ntheirs\nsuffix\n" + second,
      remaining: 1,
    });
    expect(
      applyConflictChoices(full, {
        [blocks[0].id]: "current",
        [blocks[1].id]: "both",
      }).content,
    ).toBe("prefix\nours\nsuffix\nA\nB\n");
  });
  it("preserves CRLF, Unicode, empty sides, variable marker widths and no final newline", () => {
    const crlf =
      "α\r\n<<<<<<<<<< left\r\n=======oops\r\n==========\r\nβ\r\n>>>>>>>>>> right";
    const block = parseMergeConflicts(crlf).conflicts[0];
    expect(block.current).toBe("=======oops\r\n");
    expect(applyConflictChoices(crlf, { [block.id]: "incoming" }).content).toBe(
      "α\r\nβ",
    );
    const empty = "<<<<<<< left\n=======\nright\n>>>>>>> incoming\n";
    const id = parseMergeConflicts(empty).conflicts[0].id;
    expect(applyConflictChoices(empty, { [id]: "current" }).content).toBe("");
  });
  it.each([
    "<<<<<<< ours\na\n=======\nb\n",
    "<<<<<<< ours\n<<<<<<< nested\na\n=======\nb\n>>>>>>> theirs\n",
    "<<<<<<< ours\na\n||||||| base\nb\n>>>>>>> theirs\n",
    "<<<<<<< ours\na\n========\nb\n>>>>>>> theirs\n",
  ])(
    "refuses malformed or nested markers without producing a savable preview",
    (bad) => {
      expect(parseMergeConflicts(bad).errors.length).toBeGreaterThan(0);
      expect(() => applyConflictChoices(bad, {})).toThrow();
    },
  );
  it("rejects choices from another content snapshot", () => {
    expect(() =>
      applyConflictChoices(source, { "unknown-block": "both" }),
    ).toThrow();
  });
});

describe("exact single-hunk reversal", () => {
  const header =
    "diff --git a/file.txt b/file.txt\nindex 1111111..2222222 100644\n--- a/file.txt\n+++ b/file.txt\n";
  const first = "@@ -1,2 +1,2 @@\n-old\n+new\n anchor\n";
  const second = "@@ -10 +10 @@\n-before\n+after\n";
  it("splits complete per-hunk patches without joining another file", () => {
    const hunks = splitReviewHunks(header + first + second);
    expect(hunks.map((hunk) => hunk.patch)).toEqual([
      header + first,
      header + second,
    ]);
    expect(hunks[1]).toMatchObject({
      oldStart: 10,
      newStart: 10,
      oldLines: 1,
      newLines: 1,
    });
    expect(splitReviewHunks(header + first + header + second)).toEqual([]);
  });
  it("changes only the exact hunk and refuses shifted/fuzzy matches", () => {
    expect(
      reverseReviewHunkContent("new\nanchor\nunrelated\n", header + first),
    ).toBe("old\nanchor\nunrelated\n");
    expect(() =>
      reverseReviewHunkContent("extra\nnew\nanchor\n", header + first),
    ).toThrow();
    expect(() =>
      reverseReviewHunkContent("NEW\nanchor\n", header + first),
    ).toThrow();
  });
  it("restores deletions at their exact zero-line position", () => {
    const deletion = "@@ -2 +1,0 @@\n-removed\n";
    expect(reverseReviewHunkContent("first\nlast\n", header + deletion)).toBe(
      "first\nremoved\nlast\n",
    );
  });
  it("preserves CRLF and Git's no-final-newline marker", () => {
    const patch =
      "@@ -1,2 +1,2 @@\n old\r\n-before\n\\ No newline at end of file\n+after\n\\ No newline at end of file\n";
    expect(reverseReviewHunkContent("old\r\nafter", header + patch)).toBe(
      "old\r\nbefore",
    );
  });
  it("distinguishes file deletion from an empty existing file", () => {
    const added =
      "diff --git a/file.txt b/file.txt\nnew file mode 100644\n--- /dev/null\n+++ b/file.txt\n@@ -0,0 +1 @@\n+new\n";
    const removed =
      "diff --git a/file.txt b/file.txt\ndeleted file mode 100644\n--- a/file.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n";
    expect(reverseReviewHunkContent("new\n", added)).toBeNull();
    expect(reverseReviewHunkContent(null, removed)).toBe("old\n");
  });
  it("refuses binary, rename, copy, mode-only and multi-hunk mutation targets", () => {
    expect(
      splitReviewHunks(
        header.replace("index", "rename from old\nindex") + first,
      ),
    ).toEqual([]);
    expect(
      splitReviewHunks(
        header.replace("index", "old mode 100644\nnew mode 100755\nindex") +
          first,
      ),
    ).toEqual([]);
    expect(splitReviewHunks("GIT binary patch\n" + header + first)).toEqual([]);
    expect(() =>
      reverseReviewHunkContent("new\nanchor\n", header + first + second),
    ).toThrow();
  });
});

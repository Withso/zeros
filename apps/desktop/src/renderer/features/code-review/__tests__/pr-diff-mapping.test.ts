import { describe, expect, it } from "vitest";
import type { CodeReviewAnchor } from "@zeros/protocol/code-review";
import { mapAnchorToPrDiff, parsePrDiff } from "../pr-diff-mapping";

const patch = [
  "diff --git a/src/auth.ts b/src/auth.ts",
  "index 111..222 100644",
  "--- a/src/auth.ts",
  "+++ b/src/auth.ts",
  "@@ -1,4 +1,5 @@",
  " import a from 'a';",
  "-const token = read();",
  "+const token = readToken();",
  "+check(token);",
  " export { token };",
  " // end",
  "@@ -20,2 +21,3 @@ function later() {",
  "   return 1;",
  "+  // added",
  " }",
  "diff --git a/old name.ts b/new name.ts",
  "similarity index 90%",
  "rename from old name.ts",
  "rename to new name.ts",
  "--- a/old name.ts",
  "+++ b/new name.ts",
  "@@ -3 +3 @@",
  "-before",
  "+after",
  "diff --git a/gone.md b/gone.md",
  "deleted file mode 100644",
  "--- a/gone.md",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-one",
  "-two",
  "",
].join("\n");
const files = parsePrDiff(patch);

function anchor(over: Partial<CodeReviewAnchor>): CodeReviewAnchor {
  return {
    path: "src/auth.ts",
    side: "new",
    startLine: 2,
    endLine: 2,
    revision: "local:new",
    context: "const token = readToken();",
    ...over,
  };
}

describe("mapping a local comment onto the published pull request diff", () => {
  it("keeps exact lines whose text matches GitHub's diff", () => {
    expect(mapAnchorToPrDiff(files, anchor({}))).toEqual({
      ok: true,
      path: "src/auth.ts",
      side: "RIGHT",
      startLine: 2,
      line: 2,
    });
    expect(
      mapAnchorToPrDiff(
        files,
        anchor({ startLine: 2, endLine: 3, context: "const token = readToken();\ncheck(token);" }),
      ),
    ).toMatchObject({ ok: true, startLine: 2, line: 3 });
  });

  it("maps the old side of a deleted line to LEFT", () => {
    expect(
      mapAnchorToPrDiff(
        files,
        anchor({ side: "old", context: "const token = read();" }),
      ),
    ).toEqual({ ok: true, path: "src/auth.ts", side: "LEFT", startLine: 2, line: 2 });
  });

  it("never moves a comment to other lines with the same text", () => {
    // Shifted by a local edit, or added locally with text the PR has elsewhere.
    expect(
      mapAnchorToPrDiff(files, anchor({ startLine: 9, endLine: 9, context: "check(token);" })),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("push") });
    const twice = parsePrDiff(
      "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,0 +1,2 @@\n+same\n+same\n",
    );
    expect(
      mapAnchorToPrDiff(twice, anchor({ path: "x.ts", startLine: 7, endLine: 7, context: "same" })),
    ).toMatchObject({ ok: false });
  });

  it("refuses a selection whose neighbors read differently in the local copy", () => {
    const local = new Map([
      [1, "import a from 'a';"],
      [2, "const token = readToken();"],
      [3, "check(token);"],
      [4, "export { token };"],
    ]);
    const localLine = (line: number) => local.get(line) ?? null;
    expect(mapAnchorToPrDiff(files, anchor({}), localLine)).toMatchObject({ ok: true, line: 2 });
    // Same text on line 2, but the local file has moved on around it.
    local.set(3, "audit(token);");
    expect(mapAnchorToPrDiff(files, anchor({}), localLine)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("differs"),
    });
    // A neighbor the comparison doesn't show can't be compared and is skipped.
    local.delete(3);
    expect(mapAnchorToPrDiff(files, anchor({}), localLine)).toMatchObject({ ok: true });
  });

  it("posts on a renamed file's new path from either side, and on deleted files", () => {
    expect(
      mapAnchorToPrDiff(files, anchor({ path: "old name.ts", side: "old", startLine: 3, endLine: 3, context: "before" })),
    ).toEqual({ ok: true, path: "new name.ts", side: "LEFT", startLine: 3, line: 3 });
    expect(
      mapAnchorToPrDiff(files, anchor({ path: "new name.ts", startLine: 3, endLine: 3, context: "after" })),
    ).toMatchObject({ ok: true, path: "new name.ts", side: "RIGHT" });
    expect(
      mapAnchorToPrDiff(files, anchor({ path: "gone.md", side: "old", startLine: 1, endLine: 2, context: "one\ntwo" })),
    ).toEqual({ ok: true, path: "gone.md", side: "LEFT", startLine: 1, line: 2 });
  });

  it("reads Git's quoted, octal-escaped paths", () => {
    const quoted = parsePrDiff(
      'diff --git "a/src/\\302\\265 \\"x\\".ts" "b/src/\\302\\265 \\"x\\".ts"\n--- "a/src/\\302\\265 \\"x\\".ts"\n+++ "b/src/\\302\\265 \\"x\\".ts"\n@@ -1 +1 @@\n-a\n+b\n',
    );
    expect(quoted[0]!.newPath).toBe('src/µ "x".ts');
    expect(
      mapAnchorToPrDiff(quoted, anchor({ path: 'src/µ "x".ts', startLine: 1, endLine: 1, context: "b" })),
    ).toMatchObject({ ok: true, path: 'src/µ "x".ts' });
  });

  it("does not mistake a deleted line that starts with dashes for a file header", () => {
    const tricky = parsePrDiff(
      "diff --git a/y.md b/y.md\n--- a/y.md\n+++ b/y.md\n@@ -1,2 +1,1 @@\n--- not a header\n keep\n",
    );
    expect(tricky[0]!.left.lines.get(1)?.[1]).toBe("-- not a header");
    expect(tricky[0]!.oldPath).toBe("y.md");
  });
});

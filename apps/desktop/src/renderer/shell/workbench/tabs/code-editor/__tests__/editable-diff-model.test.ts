import { describe, expect, it } from "vitest";
import { createTwoFilesPatch } from "diff";
import { editableDiffBase } from "../editable-diff-model";

describe("editable diff baseline", () => {
  it.each(["file.ts", "space name.ts", "日本語.ts"])(
    "retains full context and EOF for %s",
    (path) => {
      const before = Array.from({ length: 60 }, (_, i) => `line ${i}`).join(
        "\r\n",
      );
      const after = before.replace("line 30", "changed 30");
      const patch = createTwoFilesPatch(
        path,
        path,
        before,
        after,
        undefined,
        undefined,
        { context: Infinity },
      );
      expect(editableDiffBase(patch, path, after)).toEqual({
        name: path,
        contents: before,
      });
    },
  );
  it("uses the saved source as a clean file's baseline", () => {
    expect(editableDiffBase("", "clean.ts", "unchanged\n")).toEqual({
      name: "clean.ts",
      contents: "unchanged\n",
    });
  });
  it("represents new and empty untracked files without inventing a baseline", () => {
    expect(editableDiffBase("", "new.ts", "", true)).toBeNull();
    const patch =
      "diff --git a/new.ts b/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+new\n";
    expect(editableDiffBase(patch, "new.ts", "new\n")).toBeNull();
  });
  it("keeps the old path for a rename", () => {
    const patch =
      "diff --git a/old.ts b/new.ts\nsimilarity index 80%\nrename from old.ts\nrename to new.ts\n--- a/old.ts\n+++ b/new.ts\n@@ -1 +1 @@\n-before\n+after\n";
    expect(editableDiffBase(patch, "new.ts", "after\n")).toEqual({
      name: "old.ts",
      contents: "before\n",
    });
  });
  it("refuses binary, deleted and unrelated comparisons", () => {
    expect(() =>
      editableDiffBase(
        "diff --git a/a.png b/a.png\nBinary files a/a.png and b/a.png differ\n",
        "a.png",
        "",
      ),
    ).toThrow();
    expect(() =>
      editableDiffBase(
        "diff --git a/a.ts b/a.ts\ndeleted file mode 100644\n--- a/a.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n",
        "a.ts",
        "",
      ),
    ).toThrow();
    expect(() =>
      editableDiffBase(
        createTwoFilesPatch("other.ts", "other.ts", "a\n", "b\n"),
        "a.ts",
        "b\n",
      ),
    ).toThrow();
  });
  it("refuses a partial hunk instead of treating its prefix as a whole file", () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${i}\n`).join("");
    const after = before.replace("line 15", "changed 15");
    expect(() =>
      editableDiffBase(
        createTwoFilesPatch("a.ts", "a.ts", before, after),
        "a.ts",
        after,
      ),
    ).toThrow();
  });
});

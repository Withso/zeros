import { describe, expect, it } from "vitest";
import { comparisonCommand, printedFile, splitCommandOutput } from "../renderers/command-output";

const gitDiff = [
  "diff --git a/apps/a.ts b/apps/a.ts",
  "index 32901fa..77008af 100644",
  "--- a/apps/a.ts",
  "+++ b/apps/a.ts",
  "@@ -12,4 +12,2 @@ export function f(",
  " const a = 1;",
  "-const b = 2;",
  "",
  "--- not a header, a removed line",
].join("\n");

describe("splitCommandOutput", () => {
  it("lifts a git diff out of the surrounding output", () => {
    const output = `  52128 ./main.ts\n 3135004 total\n${gitDiff}\n`;
    expect(splitCommandOutput(output)).toEqual([
      { kind: "text", text: "  52128 ./main.ts\n 3135004 total" },
      { kind: "diff", path: "apps/a.ts", patch: `${gitDiff}\n` },
    ]);
  });

  it("splits several files and keeps text after the last hunk", () => {
    const second = "diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-x\n+y\n\\ No newline at end of file";
    const parts = splitCommandOutput(`${gitDiff}\n${second}\nDone.`);
    expect(parts.map((part) => part.kind === "diff" ? part.path : part.text)).toEqual(["apps/a.ts", "b.ts", "Done."]);
    expect(parts[1]).toMatchObject({ patch: `${second}\n` });
  });

  it("reads a plain diff -u and a new file", () => {
    const plain = "--- old.txt\t2026-01-01\n+++ new.txt\t2026-01-02\n@@ -1,2 +1,2 @@\n a\n-b\n+c";
    expect(splitCommandOutput(plain)).toEqual([{ kind: "diff", path: "new.txt", patch: `${plain}\n` }]);
    const created = "diff --git a/n.ts b/n.ts\nnew file mode 100644\n--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1 @@\n+hi";
    expect(splitCommandOutput(created)[0]).toMatchObject({ kind: "diff", path: "n.ts" });
  });

  it("names a Git-quoted file by its decoded path", () => {
    const quoted = 'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"\n--- "a/caf\\303\\251.ts"\n+++ "b/caf\\303\\251.ts"\n@@ -1 +1 @@\n-a\n+b';
    expect(splitCommandOutput(quoted)[0]).toMatchObject({ kind: "diff", path: "café.ts" });
    const escaped = '--- "a/say \\"hi\\".txt"\n+++ "b/say \\"hi\\".txt"\n@@ -1 +1 @@\n-a\n+b';
    expect(splitCommandOutput(escaped)[0]).toMatchObject({ kind: "diff", path: 'say "hi".txt' });
  });

  it("leaves output alone when a diff is truncated or only looks like one", () => {
    const truncated = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,5 +1,5 @@\n a\n-b";
    expect(splitCommandOutput(truncated)).toEqual([{ kind: "text", text: truncated }]);
    expect(splitCommandOutput("--- summary ---\nall good")).toEqual([{ kind: "text", text: "--- summary ---\nall good" }]);
    expect(splitCommandOutput("diff --stat only\n 2 files changed")).toEqual([{ kind: "text", text: "diff --stat only\n 2 files changed" }]);
  });
});

describe("printedFile", () => {
  it.each([
    ["cat src/a.ts", "src/a.ts", 1],
    ["sed -n '120,180p' apps/b.tsx", "apps/b.tsx", 120],
    ["sed -n 5p c.py", "c.py", 5],
    ["head -n 40 d.go", "d.go", 1],
    ["head -40 d.go", "d.go", 1],
    ["tail e.rs", "e.rs", null],
    ["bat -p f.md", "f.md", 1],
    [["bash", "-lc", "cat g.json"], "g.json", 1],
  ])("finds the one file %j prints", (command, path, startLine) => {
    expect(printedFile({ command })).toEqual({ path, startLine });
  });

  it.each([
    "cat a.ts b.ts",
    "cat -n a.ts",
    "cat a.ts | head",
    "sed 's/a/b/' a.ts",
    "sed -n '/x/p' a.ts",
    "sed -i -n 1p a.ts",
    "head -n 5",
    "ls a.ts",
    "cat $FILE",
  ])("prints no single file for %j", (command) => {
    expect(printedFile({ command })).toBeNull();
  });
});

describe("comparisonCommand", () => {
  it.each([
    ["diff -u old.txt new.txt", true],
    ["git diff --no-index a.ts b.ts", true],
    ["git diff --exit-code", true],
    [["bash", "-lc", "diff -ru a b"], true],
    ["git diff", false],
    ["cat a.ts", false],
    ["diff a b | head", false],
  ])("%j reports differences through exit code 1: %s", (command, expected) => {
    expect(comparisonCommand({ command })).toBe(expected);
  });
});

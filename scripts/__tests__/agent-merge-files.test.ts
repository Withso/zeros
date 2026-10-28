import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { readImmutableMergeFiles } from "../agent-merge.mjs";

it("reads immutable Git objects including protected paths renamed away", () => {
  const root = mkdtempSync(path.join(tmpdir(), "zeros-merge-objects-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    git(["init", "-q"]);
    git(["config", "user.email", "test@example.test"]);
    git(["config", "user.name", "Test"]);
    mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
    writeFileSync(path.join(root, ".github/workflows/test.yml"), "name: test\n");
    git(["add", "."]); git(["commit", "-qm", "base"]);
    const base = git(["rev-parse", "HEAD"]).trim();
    renameSync(path.join(root, ".github/workflows/test.yml"), path.join(root, "moved.yml"));
    git(["add", "-A"]); git(["commit", "-qm", "move"]);
    const head = git(["rev-parse", "HEAD"]).trim();
    writeFileSync(path.join(root, "uncommitted.txt"), "ignored");
    expect(readImmutableMergeFiles(base, head, git)).toEqual([
      { filename: "moved.yml", previous_filename: ".github/workflows/test.yml", status: "R100" },
    ]);
    expect(() => readImmutableMergeFiles(base, head, (args: string[]) => args.includes("diff") ? "M\0truncated" : git(args))).toThrow();
    expect(() => readImmutableMergeFiles(base, head, (args: string[]) => args.includes("--is-shallow-repository") ? "true" : git(args))).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

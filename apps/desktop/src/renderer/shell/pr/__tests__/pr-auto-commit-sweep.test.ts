// The one assumption in the Create PR auto-commit that unit tests cannot check:
// whether the exact visible paths produced from status stage edits, additions,
// deletions, and pathspec-hostile filenames when the engine literalizes them.
// This pins those semantics against a real git while keeping `.zeros` outside
// the status-derived list handed across the workspace bridge.
//
// It shells out to git in a temp repo — the same shape as the engine's own git
// suites (see the temp-repo note in vitest.config.ts). It deliberately does NOT
// call the engine's `stagePaths`: that needs the workspace registry and its
// SQLite state, and the subject here is the pathspec, not the plumbing.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  summarizePendingWork,
  type WorktreeFacts,
} from "../pr-auto-commit";

const execFileAsync = promisify(execFile);

describe("the auto-commit sweep, against a real git", () => {
  let workdir: string;
  let repo: string;
  const git = (...args: string[]) =>
    execFileAsync("git", args, { cwd: repo }).then((r) => r.stdout);
  const stageVisible = async (facts: WorktreeFacts) => {
    const paths = summarizePendingWork(facts).paths;
    if (paths.length === 0) return;
    await git("add", "--", ...paths.map((path) => `:(literal)${path}`));
  };

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "zeros-pr-sweep-"));
    repo = path.join(workdir, "repo");
    await mkdir(repo, { recursive: true });
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    // Local identity + no hooks/signing: a contributor's global config must not
    // decide whether this test passes.
    await git("config", "user.email", "t@t");
    await git("config", "user.name", "t");
    await git("config", "commit.gpgsign", "false");
    await git("config", "core.hooksPath", path.join(workdir, "no-hooks"));
    await writeFile(path.join(repo, "kept.txt"), "one\n");
    await writeFile(path.join(repo, "gone.txt"), "two\n");
    await mkdir(path.join(repo, ".zeros"), { recursive: true });
    await writeFile(path.join(repo, ".zeros", "settings.toml"), "[git]\n");
    await git("add", "-A");
    await git("commit", "-q", "-m", "init");
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  });

  it("stages edits, additions, deletions and glob-hostile names — never .zeros", async () => {
    await writeFile(path.join(repo, "kept.txt"), "one changed\n");
    await rm(path.join(repo, "gone.txt"));
    await mkdir(path.join(repo, "sub"), { recursive: true });
    await writeFile(path.join(repo, "sub", "new.txt"), "three\n");
    // A literal filename that IS a pathspec character class.
    await writeFile(path.join(repo, "weird[1].txt"), "four\n");
    // Tracked and modified, and still invisible everywhere in Zeros.
    await writeFile(path.join(repo, ".zeros", "settings.toml"), "[git]\nx=1\n");

    await stageVisible({
      staged: [],
      unstaged: [{ path: "gone.txt" }, { path: "kept.txt" }],
      untracked: ["sub/new.txt", "weird[1].txt"],
      conflicted: [],
      conflictState: null,
    });

    const staged = (await git("diff", "--cached", "--name-status"))
      .trim()
      .split("\n")
      .sort();
    expect(staged).toEqual([
      "A\tsub/new.txt",
      "A\tweird[1].txt",
      "D\tgone.txt",
      "M\tkept.txt",
    ]);
    // The `.zeros` edit is still sitting in the working tree, uncommitted.
    expect(await git("diff", "--name-only")).toContain(".zeros/settings.toml");
  });

  it("leaves an untracked .zeros tree alone", async () => {
    await git("rm", "-r", "-q", "--cached", ".zeros");
    await git("commit", "-q", "-m", "untrack");
    await writeFile(path.join(repo, "kept.txt"), "changed\n");

    await stageVisible({
      staged: [],
      unstaged: [{ path: "kept.txt" }],
      untracked: [".zeros/settings.toml"],
      conflicted: [],
      conflictState: null,
    });

    expect(await git("diff", "--cached", "--name-only")).toBe("kept.txt\n");
    expect(await git("status", "--porcelain")).toContain("?? .zeros/");
  });

  it("honours .gitignore, so an ignored build tree is never swept in", async () => {
    await writeFile(path.join(repo, ".gitignore"), "dist/\n");
    await mkdir(path.join(repo, "dist"), { recursive: true });
    await writeFile(path.join(repo, "dist", "bundle.js"), "// built\n");

    await stageVisible({
      staged: [],
      unstaged: [],
      untracked: [".gitignore"],
      conflicted: [],
      conflictState: null,
    });

    const staged = await git("diff", "--cached", "--name-only");
    expect(staged).toContain(".gitignore");
    expect(staged).not.toContain("dist/");
  });

  // The engine answers an empty staged tree with VALIDATION_FAILED rather than
  // an empty commit — the orchestrator treats that as "the tree went clean",
  // which is only correct if git really does refuse.
  it("commits nothing when the sweep found nothing", async () => {
    await stageVisible({
      staged: [],
      unstaged: [],
      untracked: [],
      conflicted: [],
      conflictState: null,
    });
    await expect(git("commit", "-m", "empty")).rejects.toMatchObject({
      stdout: expect.stringContaining("nothing to commit"),
    });
  });
});

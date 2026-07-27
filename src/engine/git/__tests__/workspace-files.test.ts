// Tests for the composer @-mention file lister. It's on the hot path for
// every @ open (the `git_list_files` IPC) and degrades to `[]` on failure,
// so a regression would be SILENT (empty picker, no error). These pin the
// two branches: the `git ls-files -co --exclude-standard` repo path (which
// gives .gitignore-respect for free) and the bounded non-git fallback walk.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { listWorkspaceFiles } from "../workspace-files";

const execFileAsync = promisify(execFile);

async function initRepo(dir: string): Promise<void> {
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: dir });
}

async function commitAll(dir: string): Promise<void> {
  await execFileAsync("git", ["-C", dir, "add", "-A"]);
  await execFileAsync("git", [
    "-C",
    dir,
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-q",
    "-m",
    "init",
  ]);
}

describe("listWorkspaceFiles", () => {
  let workdir = "";

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "zeros-wsfiles-"));
  });

  afterEach(async () => {
    if (workdir) await rm(workdir, { recursive: true, force: true });
  });

  it("returns [] for an empty cwd", async () => {
    expect(await listWorkspaceFiles("")).toEqual([]);
  });

  describe("git repo path", () => {
    it("lists tracked + untracked-not-ignored files and honours .gitignore", async () => {
      const repo = path.join(workdir, "repo");
      await mkdir(repo);
      await initRepo(repo);
      await writeFile(path.join(repo, "tracked.ts"), "export const a = 1;");
      await writeFile(
        path.join(repo, ".gitignore"),
        "ignored.log\nnode_modules/\n",
      );
      await commitAll(repo);
      // Untracked-but-not-ignored — brand-new file the user just made; must
      // surface so it's mentionable.
      await writeFile(path.join(repo, "untracked.ts"), "export const b = 2;");
      // Ignored — must NOT surface.
      await writeFile(path.join(repo, "ignored.log"), "noise");
      await mkdir(path.join(repo, "node_modules", "pkg"), { recursive: true });
      await writeFile(path.join(repo, "node_modules", "pkg", "index.js"), "x");

      const files = await listWorkspaceFiles(repo);

      expect(files).toContain("tracked.ts");
      expect(files).toContain("untracked.ts");
      expect(files).toContain(".gitignore");
      expect(files).not.toContain("ignored.log");
      expect(files.some((f) => f.startsWith("node_modules/"))).toBe(false);
    });

    it("respects the limit cap", async () => {
      const repo = path.join(workdir, "repo2");
      await mkdir(repo);
      await initRepo(repo);
      for (let i = 0; i < 6; i++) {
        await writeFile(path.join(repo, `f${i}.txt`), String(i));
      }
      const files = await listWorkspaceFiles(repo, 3);
      expect(files.length).toBe(3);
    });

    it("excludes tracked paths deleted from disk", async () => {
      const repo = path.join(workdir, "repo-deleted");
      await mkdir(repo);
      await initRepo(repo);
      await writeFile(path.join(repo, "kept.txt"), "keep");
      await writeFile(path.join(repo, "deleted.txt"), "delete");
      await commitAll(repo);
      await rm(path.join(repo, "deleted.txt"));

      const files = await listWorkspaceFiles(repo);

      expect(files).toContain("kept.txt");
      expect(files).not.toContain("deleted.txt");
    });
  });

  describe("non-git fallback walk", () => {
    it("lists files, skips heavy dirs and dotdirs (except .github)", async () => {
      const plain = path.join(workdir, "plain");
      await mkdir(plain);
      await writeFile(path.join(plain, "index.ts"), "x");
      await mkdir(path.join(plain, "src"));
      await writeFile(path.join(plain, "src", "app.ts"), "x");
      // Heavy dep dir — skipped by SKIP_DIRS.
      await mkdir(path.join(plain, "node_modules", "pkg"), { recursive: true });
      await writeFile(path.join(plain, "node_modules", "pkg", "i.js"), "x");
      // Generic dotdir — skipped.
      await mkdir(path.join(plain, ".cache"));
      await writeFile(path.join(plain, ".cache", "c"), "x");
      // .github is the one dotdir we keep (real config lives there).
      await mkdir(path.join(plain, ".github", "workflows"), {
        recursive: true,
      });
      await writeFile(path.join(plain, ".github", "workflows", "ci.yml"), "x");

      const files = await listWorkspaceFiles(plain);

      expect(files).toContain("index.ts");
      expect(files).toContain("src/app.ts");
      expect(files).toContain(".github/workflows/ci.yml");
      expect(files.some((f) => f.startsWith("node_modules/"))).toBe(false);
      expect(files.some((f) => f.startsWith(".cache/"))).toBe(false);
    });

    it("returns POSIX-separated repo-relative paths", async () => {
      const plain = path.join(workdir, "plain2");
      await mkdir(path.join(plain, "a", "b"), { recursive: true });
      await writeFile(path.join(plain, "a", "b", "deep.ts"), "x");
      const files = await listWorkspaceFiles(plain);
      expect(files).toContain("a/b/deep.ts");
    });
  });
});

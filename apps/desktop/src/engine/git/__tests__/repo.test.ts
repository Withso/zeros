import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  getInProgressState,
  isRepo,
  repoSlugFromOriginUrl,
  resolveGitdir,
} from "../repo";

const execFileAsync = promisify(execFile);

describe("repo", () => {
  describe("repoSlugFromOriginUrl", () => {
    it("derives from https github URL", () => {
      expect(repoSlugFromOriginUrl("https://github.com/Acme/example.git")).toBe(
        "acme-example",
      );
      expect(repoSlugFromOriginUrl("https://github.com/Acme/example")).toBe(
        "acme-example",
      );
    });

    it("derives from ssh-style URL", () => {
      expect(repoSlugFromOriginUrl("git@github.com:Acme/example.git")).toBe(
        "acme-example",
      );
    });

    it("handles nested paths", () => {
      expect(
        repoSlugFromOriginUrl("https://gitlab.com/group/sub/project.git"),
      ).toBe("group-sub-project");
    });

    it("lowercases everything", () => {
      expect(repoSlugFromOriginUrl("https://github.com/FOO/BAR")).toBe(
        "foo-bar",
      );
    });

    it("strips trailing .git", () => {
      expect(repoSlugFromOriginUrl("https://x/y.git")).toBe("y");
    });

    it("throws on empty input", () => {
      expect(() => repoSlugFromOriginUrl("")).toThrow();
    });
  });

  describe("on-disk helpers (require git)", () => {
    let workdir: string;

    beforeEach(async () => {
      workdir = await mkdtemp(path.join(tmpdir(), "zeros-repo-test-"));
    });

    afterEach(async () => {
      try {
        await rm(workdir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    });

    it("isRepo returns false for a plain dir", async () => {
      const plain = path.join(workdir, "plain");
      await mkdir(plain);
      expect(await isRepo(plain)).toBe(false);
    });

    it("isRepo returns true for a git repo", async () => {
      const repo = path.join(workdir, "repo");
      await mkdir(repo);
      await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repo });
      expect(await isRepo(repo)).toBe(true);
    });

    it("resolveGitdir returns .git dir for the primary worktree", async () => {
      const repo = path.join(workdir, "repo");
      await mkdir(repo);
      await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repo });
      const gitdir = await resolveGitdir(repo);
      expect(gitdir).toBe(path.join(repo, ".git"));
    });

    it("resolveGitdir resolves the gitdir file for a linked worktree", async () => {
      const repo = path.join(workdir, "repo");
      await mkdir(repo);
      await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repo });
      // Need a commit before worktree add will accept a base ref.
      await writeFile(path.join(repo, "a.txt"), "hi");
      await execFileAsync("git", ["-C", repo, "add", "."]);
      await execFileAsync("git", [
        "-C",
        repo,
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "commit",
        "-q",
        "-m",
        "init",
      ]);
      const wt = path.join(workdir, "wt-a");
      await execFileAsync("git", [
        "-C",
        repo,
        "worktree",
        "add",
        "-b",
        "branch-a",
        wt,
      ]);
      const gitdir = await resolveGitdir(wt);
      // Should point INTO the repo's .git/worktrees/<name>/
      expect(gitdir).toMatch(/\.git\/worktrees\/wt-a$/);
    });

    it("getInProgressState returns null on a clean repo", async () => {
      const repo = path.join(workdir, "repo");
      await mkdir(repo);
      await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repo });
      expect(await getInProgressState(repo)).toBeNull();
    });

    it("getInProgressState detects MERGE_HEAD", async () => {
      const repo = path.join(workdir, "repo");
      await mkdir(repo);
      await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repo });
      // Fake a merge-in-progress by creating MERGE_HEAD directly.
      await writeFile(
        path.join(repo, ".git", "MERGE_HEAD"),
        "deadbeef\n",
      );
      expect(await getInProgressState(repo)).toBe("merge");
    });
  });
});

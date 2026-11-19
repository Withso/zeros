import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { link, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  canSkipPerFileRetry,
  assertDesignDirHasNoHardlinkAliases,
  designDirFenceEntries,
  designDirAliasHazards,
  isInsideDir,
  lockableFiles,
  normalizeDesignDir,
  resolveDesignDirForLock,
} from "../design-lock";
import { setWorkingDirectories } from "../../git/sparse-checkout";

const execFileAsync = promisify(execFile);

describe("canSkipPerFileRetry", () => {
  // Real macOS 26.3 stderr shapes.
  const noAcl =
    "chmod: No ACL present 'b.txt'\nchmod: No ACL present 'd.txt'\n";

  it("accepts a batch whose only errors are 'No ACL present'", () => {
    expect(canSkipPerFileRetry(noAcl)).toBe(true);
  });

  it("forces a per-file retry when ANY other chmod error is present", () => {
    expect(
      canSkipPerFileRetry(`${noAcl}chmod: Operation not permitted 'x.txt'\n`),
    ).toBe(false);
    expect(
      canSkipPerFileRetry("chmod: Unable to translate 'deny' to a UUID\n"),
    ).toBe(false);
  });

  it("does not treat an empty stderr as benign", () => {
    expect(canSkipPerFileRetry("")).toBe(false);
  });
});

describe("normalizeDesignDir", () => {
  it("strips separators and normalizes", () => {
    expect(normalizeDesignDir("designs")).toBe("designs");
    expect(normalizeDesignDir("a/b/")).toBe("a/b");
    expect(normalizeDesignDir("a\\b")).toBe("a/b");
    expect(normalizeDesignDir("a/./b")).toBe("a/b");
  });

  it("returns empty for anything that escapes or is not a dir", () => {
    expect(normalizeDesignDir("")).toBe("");
    expect(normalizeDesignDir(".")).toBe("");
    expect(normalizeDesignDir("/")).toBe("");
    expect(normalizeDesignDir("..")).toBe("");
    expect(normalizeDesignDir("../escape")).toBe("");
    expect(normalizeDesignDir("a/../..")).toBe("");
  });

  it("returns empty for an absolute path instead of rebasing it", () => {
    expect(normalizeDesignDir("/abs/designs")).toBe("");
    expect(normalizeDesignDir("/Users/me/repo/styles/Designs")).toBe("");
    expect(normalizeDesignDir("//abs//designs//")).toBe("");
    // A decorative slash cannot be distinguished from an absolute path.
    expect(normalizeDesignDir("/designs/")).toBe("");
  });
});

describe("isInsideDir", () => {
  it("matches on segment boundaries only", () => {
    expect(isInsideDir("designs/a.css", "designs")).toBe(true);
    expect(isInsideDir("designs", "designs")).toBe(true);
    expect(isInsideDir("designs/deep/a.css", "designs")).toBe(true);
    expect(isInsideDir("designs-old/a.css", "designs")).toBe(false);
    expect(isInsideDir("src/designs/a.css", "designs")).toBe(false);
    expect(isInsideDir("designs/a.css", "")).toBe(false);
  });
});

describe("lockableFiles", () => {
  let workdir: string;
  let repo: string;

  const git = (...args: string[]): Promise<unknown> =>
    execFileAsync("git", args, { cwd: repo });

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "zeros-design-lock-"));
    repo = path.join(workdir, "repo");
    await mkdir(path.join(repo, "src"), { recursive: true });
    await mkdir(path.join(repo, "designs"), { recursive: true });
    await mkdir(path.join(repo, "designs-old"), { recursive: true });
    await mkdir(path.join(repo, "drop"), { recursive: true });
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    await git("config", "user.email", "t@t");
    await git("config", "user.name", "t");
    await writeFile(path.join(repo, ".gitignore"), "ignored/\n");
    await writeFile(path.join(repo, "src", "a.ts"), "a\n");
    await writeFile(path.join(repo, "designs", "d.css"), "d\n");
    await writeFile(path.join(repo, "designs-old", "o.css"), "o\n");
    await writeFile(path.join(repo, "drop", "b.ts"), "b\n");
    await writeFile(path.join(repo, "root.ts"), "r\n");
    await git("add", "-A");
    await git("commit", "-q", "-m", "init");
    await mkdir(path.join(repo, "ignored"), { recursive: true });
    await writeFile(path.join(repo, "ignored", "build.js"), "x\n");
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("locks tracked files outside the design dir, and nothing else", async () => {
    const files = await lockableFiles(repo, "designs");
    expect(files).toContain("src/a.ts");
    expect(files).toContain("root.ts");
    expect(files).toContain(".gitignore");
    expect(files).not.toContain("designs/d.css");
    expect(files).toContain("designs-old/o.css");
    expect(files).not.toContain("ignored/build.js");
    expect(files.some((f) => f.startsWith("ignored/"))).toBe(false);
  });

  it("enumerates the real Design tree, including ignored drafts and every nested directory", async () => {
    await writeFile(
      path.join(repo, ".gitignore"),
      "ignored/\ndesigns/private/\n",
    );
    await mkdir(path.join(repo, "designs", "drafts", "nested"), {
      recursive: true,
    });
    await mkdir(path.join(repo, "designs", "private"), { recursive: true });
    await writeFile(
      path.join(repo, "designs", "drafts", "nested", "option.html"),
      "untracked\n",
    );
    await writeFile(
      path.join(repo, "designs", "private", "ignored.html"),
      "ignored\n",
    );
    await symlink("../src", path.join(repo, "designs", "code-link"), "dir");

    const entries = await designDirFenceEntries(repo, "designs");
    expect(entries.directories).toEqual([
      "designs",
      "designs/drafts",
      "designs/drafts/nested",
      "designs/private",
    ]);
    expect(entries.files).toEqual([
      "designs/code-link",
      "designs/d.css",
      "designs/drafts/nested/option.html",
      "designs/private/ignored.html",
    ]);
    expect(entries.files).not.toContain("designs/code-link/a.ts");
  });

  it("fails closed when a Design inode already has a hard-link alias", async () => {
    const alias = path.join(repo, "src", "design-alias.css");
    await link(path.join(repo, "designs", "d.css"), alias);

    await expect(designDirAliasHazards(repo, "designs")).resolves.toEqual([
      { path: "designs/d.css", links: 2 },
    ]);
    await expect(
      assertDesignDirHasNoHardlinkAliases(repo, "designs"),
    ).rejects.toThrow(/hard-linked file/i);
  });

  it("accepts ordinary files and symlinks without following them", async () => {
    await symlink("../src/a.ts", path.join(repo, "designs", "code-file"));
    await expect(designDirAliasHazards(repo, "designs")).resolves.toEqual([]);
    await expect(
      assertDesignDirHasNoHardlinkAliases(repo, "designs"),
    ).resolves.toBeUndefined();
  });

  it("sweeps everything when no design dir is given (the unlock path)", async () => {
    const files = await lockableFiles(repo, "");
    expect(files).toContain("designs/d.css");
    expect(files).toContain("src/a.ts");
  });

  it("skips files git tracks but that are absent from the worktree", async () => {
    // Sparse checkout keeps removed paths in Git's index.
    await setWorkingDirectories(repo, ["src", "designs"]);
    const files = await lockableFiles(repo, "designs");
    expect(files).toContain("src/a.ts");
    expect(files).not.toContain("drop/b.ts");
    expect(files).not.toContain("designs-old/o.css");
  });

  it("still locks a file pinned with --skip-worktree outside a sparse checkout", async () => {
    // Outside sparse mode, skip-worktree can pin a file still on disk.
    await git("update-index", "--skip-worktree", "src/a.ts");
    const files = await lockableFiles(repo, "designs");
    expect(files).toContain("src/a.ts");
  });

  it("also skips tracked files deleted from disk", async () => {
    await rm(path.join(repo, "src", "a.ts"));
    const files = await lockableFiles(repo, "designs");
    expect(files).not.toContain("src/a.ts");
    expect(files).toContain("root.ts");
  });

  describe("resolveDesignDirForLock", () => {
    it("accepts a real repo-relative folder", async () => {
      await expect(resolveDesignDirForLock(repo, "designs")).resolves.toBe(
        "designs",
      );
      await expect(resolveDesignDirForLock(repo, "/designs/")).rejects.toThrow(
        /repo-relative design folder/i,
      );
    });

    it("refuses a dir that collapses to the empty sentinel", async () => {
      for (const bad of ["", ".", "..", "../x", "/abs/designs"]) {
        await expect(resolveDesignDirForLock(repo, bad)).rejects.toThrow(
          /repo-relative design folder/i,
        );
      }
    });

    it("refuses a folder that isn't in the workspace", async () => {
      await expect(resolveDesignDirForLock(repo, "nope")).rejects.toThrow(
        /not in this workspace/i,
      );
      await expect(
        resolveDesignDirForLock(repo, "designs/missing"),
      ).rejects.toThrow(/not in this workspace/i);
    });

    it("refuses a symlink in the active Design-directory path", async () => {
      await symlink("designs", path.join(repo, "design-link"), "dir");
      await expect(
        resolveDesignDirForLock(repo, "design-link"),
      ).rejects.toThrow(/real, symlink-free directory/i);
    });

    it("refuses a case-mismatched spelling and names the real one", async () => {
      await expect(resolveDesignDirForLock(repo, "Designs")).rejects.toThrow(
        /spelled exactly as on disk; got "Designs", found "designs"/,
      );
    });
  });
});

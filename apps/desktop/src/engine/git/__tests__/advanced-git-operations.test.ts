// Advanced Git operation coverage: diff modes, conflicts, reset/discard/clean,
// continue/abort, merge/cherry-pick/revert, stashes, branches, tags, and
// hunk-level application.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  appendFile,
  readFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  abortOperation,
  applyStash,
  checkoutBranch,
  cherryPick,
  clean,
  closeState,
  continueOperation,
  createTag,
  createWorkspace,
  deleteBranch,
  deleteTag,
  diff,
  discardFiles,
  discardHunk,
  dropStash,
  getWorkspace,
  listStashes,
  listTags,
  merge,
  reset,
  restoreFrom,
  revert,
  setStateRootForTesting,
  showCommit,
  stageHunk,
  stagePaths,
  stashSave,
  status,
  unstageHunk,
} from "..";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

async function initRepo(repoRoot: string): Promise<void> {
  await mkdir(repoRoot, { recursive: true });
  await git(repoRoot, "init", "-q", "-b", "main");
  await git(
    repoRoot,
    "remote",
    "add",
    "origin",
    "https://example.com/t/advanced-operations.git",
  );
  await git(repoRoot, "config", "user.email", "t@t");
  await git(repoRoot, "config", "user.name", "t");
  await writeFile(path.join(repoRoot, "README.md"), "base\n");
  await git(repoRoot, "add", ".");
  await git(repoRoot, "commit", "-q", "-m", "initial");
}

describe("advanced Git operations", () => {
  let workdir: string;
  let repoRoot: string;
  let workspaceId: string;
  let wsPath: string;

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "zeros-advanced-git-"));
    repoRoot = path.join(workdir, "repo");
    setStateRootForTesting(path.join(workdir, "state"));
    await initRepo(repoRoot);
    const created = await createWorkspace({ repoRoot });
    workspaceId = created.workspaceId;
    wsPath = getWorkspace(workspaceId).path;
  });

  afterEach(async () => {
    closeState();
    setStateRootForTesting(null);
    try {
      await rm(workdir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  describe("diff modes and showCommit", () => {
    it("mode index-vs-head shows staged changes only", async () => {
      await writeFile(path.join(wsPath, "s.txt"), "staged\n");
      await stagePaths({ workspaceId, paths: ["s.txt"] });
      const staged = await diff({ workspaceId, mode: "index-vs-head" });
      expect(staged.hunks.some((h) => h.filePath === "s.txt")).toBe(true);
      // worktree-vs-index (default) should be empty — nothing unstaged.
      const unstaged = await diff({ workspaceId, mode: "worktree-vs-index" });
      expect(unstaged.hunks).toEqual([]);
    });

    it("rawPatch returns the raw unified diff string", async () => {
      await appendFile(path.join(wsPath, "README.md"), "more\n");
      const d = await diff({ workspaceId, rawPatch: true });
      expect(typeof d.patch).toBe("string");
      expect(d.patch).toContain("diff --git");
      expect(d.patch).toContain("+more");
    });

    it("returns bounded file metadata instead of an oversized aggregate patch", async () => {
      await appendFile(path.join(wsPath, "README.md"), "more\n");
      await writeFile(path.join(wsPath, "generated.txt"), "generated\n");
      await git(wsPath, "add", "generated.txt");

      const d = await diff({
        workspaceId,
        mode: "worktree-vs-head",
        rawPatch: true,
        summaryLimit: 1,
      });

      expect(d.summary).toBe(true);
      expect(d.patch).toBeUndefined();
      expect(d.hunks).toEqual([]);
      expect(d.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "README.md",
            status: "modified",
            additions: 1,
            deletions: 0,
          }),
          expect.objectContaining({
            path: "generated.txt",
            status: "added",
            additions: 1,
            deletions: 0,
          }),
        ]),
      );
    });

    it("mode refs compares two branches (3-dot)", async () => {
      await writeFile(path.join(wsPath, "feat.txt"), "feat\n");
      await git(wsPath, "add", ".");
      await git(wsPath, "commit", "-q", "-m", "feat");
      const d = await diff({
        workspaceId,
        mode: "refs",
        base: "main",
        head: "HEAD",
      });
      expect(d.hunks.some((h) => h.filePath === "feat.txt")).toBe(true);
    });

    it("refs mode without base throws", async () => {
      await expect(diff({ workspaceId, mode: "refs" })).rejects.toThrow();
    });

    it("showCommit returns files + patch", async () => {
      await writeFile(path.join(wsPath, "c.txt"), "c\n");
      await git(wsPath, "add", ".");
      await git(wsPath, "commit", "-q", "-m", "add c");
      const sha = (await git(wsPath, "rev-parse", "HEAD")).trim();
      const res = await showCommit(workspaceId, sha);
      expect(res.files.find((f) => f.path === "c.txt")?.status).toBe("added");
      expect(res.patch).toContain("c.txt");
    });
  });

  describe("conflict status, continue, and abort", () => {
    async function makeMergeConflict(): Promise<void> {
      // Diverge README on the workspace branch...
      await writeFile(path.join(wsPath, "README.md"), "ours\n");
      await git(wsPath, "commit", "-aqm", "ours");
      // ...and on a sibling branch "other" via the root checkout.
      await git(repoRoot, "checkout", "-q", "-b", "other");
      await writeFile(path.join(repoRoot, "README.md"), "theirs\n");
      await git(repoRoot, "commit", "-aqm", "theirs");
      await git(repoRoot, "checkout", "-q", "main");
    }

    it("surfaces conflicted files + conflictState, then aborts", async () => {
      await makeMergeConflict();
      const r = await merge({ workspaceId, branch: "other" });
      expect(r.merged).toBe(false);
      expect(r.conflicts).toContain("README.md");

      const s = await status(workspaceId);
      expect(s.conflicted.find((f) => f.path === "README.md")?.status).toBe(
        "conflicted",
      );
      expect(s.conflictState).toBe("merge");

      await abortOperation(workspaceId);
      const after = await status(workspaceId);
      expect(after.conflictState).toBeNull();
      expect(after.conflicted).toEqual([]);
    });

    it("continue completes a resolved merge", async () => {
      await makeMergeConflict();
      await merge({ workspaceId, branch: "other" });
      // Resolve by taking ours.
      await writeFile(path.join(wsPath, "README.md"), "resolved\n");
      await stagePaths({ workspaceId, paths: ["README.md"] });
      const res = await continueOperation(workspaceId);
      expect(res.conflicts).toEqual([]);
      const s = await status(workspaceId);
      expect(s.conflictState).toBeNull();
    });
  });

  describe("reset, discard, and clean", () => {
    it("limits targeted status discovery to the selected path", async () => {
      await appendFile(path.join(wsPath, "README.md"), "selected\n");
      await writeFile(path.join(wsPath, "unrelated.txt"), "unrelated\n");

      const selected = await status(workspaceId, {
        paths: ["README.md"],
        includeTracking: false,
      });

      expect(selected.unstaged).toEqual([
        { path: "README.md", status: "modified" },
      ]);
      expect(selected.untracked).toEqual([]);
      expect(selected.ahead).toBeNull();
      expect(selected.behind).toBeNull();
      expect(selected.upstream).toBeNull();
    });

    it("reset mixed unstages without touching the working tree", async () => {
      await writeFile(path.join(wsPath, "r.txt"), "r\n");
      await stagePaths({ workspaceId, paths: ["r.txt"] });
      await reset({ workspaceId, mode: "mixed" });
      const s = await status(workspaceId);
      expect(s.staged).toEqual([]);
      expect(s.untracked).toContain("r.txt"); // still on disk
    });

    it("discard reverts a tracked working-tree edit", async () => {
      await appendFile(path.join(wsPath, "README.md"), "junk\n");
      await discardFiles({ workspaceId, paths: ["README.md"] });
      expect(await readFile(path.join(wsPath, "README.md"), "utf8")).toBe(
        "base\n",
      );
    });

    it("reset --hard requires confirm", async () => {
      await expect(reset({ workspaceId, mode: "hard" })).rejects.toThrow(
        /confirm/,
      );
    });

    it("clean removes untracked files (with confirm)", async () => {
      await writeFile(path.join(wsPath, "junk.txt"), "x\n");
      await expect(clean({ workspaceId, confirm: false })).rejects.toThrow();
      const res = await clean({ workspaceId, confirm: true });
      expect(res.removed.some((p) => p.includes("junk.txt"))).toBe(true);
      expect(existsSync(path.join(wsPath, "junk.txt"))).toBe(false);
    });
  });

  describe("merge, cherry-pick, revert, stash, branch, and tags", () => {
    it("fast-forward merge succeeds cleanly", async () => {
      await git(repoRoot, "checkout", "-q", "-b", "ahead");
      await writeFile(path.join(repoRoot, "ff.txt"), "ff\n");
      await git(repoRoot, "add", ".");
      await git(repoRoot, "commit", "-qm", "ff");
      await git(repoRoot, "checkout", "-q", "main");
      const r = await merge({ workspaceId, branch: "ahead" });
      expect(r.merged).toBe(true);
      expect(existsSync(path.join(wsPath, "ff.txt"))).toBe(true);
    });

    it("revert undoes a commit", async () => {
      await writeFile(path.join(wsPath, "v.txt"), "v\n");
      await git(wsPath, "add", ".");
      await git(wsPath, "commit", "-qm", "add v");
      const sha = (await git(wsPath, "rev-parse", "HEAD")).trim();
      const res = await revert({ workspaceId, sha });
      expect(res.conflicts).toEqual([]);
      expect(existsSync(path.join(wsPath, "v.txt"))).toBe(false);
    });

    it("cherry-pick applies a commit from another branch", async () => {
      await git(repoRoot, "checkout", "-q", "-b", "src");
      await writeFile(path.join(repoRoot, "cp.txt"), "cp\n");
      await git(repoRoot, "add", ".");
      await git(repoRoot, "commit", "-qm", "cp commit");
      const sha = (await git(repoRoot, "rev-parse", "HEAD")).trim();
      await git(repoRoot, "checkout", "-q", "main");
      const res = await cherryPick({ workspaceId, sha });
      expect(res.conflicts).toEqual([]);
      expect(existsSync(path.join(wsPath, "cp.txt"))).toBe(true);
    });

    it("stash list / apply / drop round-trips", async () => {
      await appendFile(path.join(wsPath, "README.md"), "stashme\n");
      const { stashRef } = await stashSave({ workspaceId, message: "wip" });
      const list = await listStashes(workspaceId);
      expect(list.length).toBe(1);
      expect(list[0].message).toContain("wip");
      await applyStash({ workspaceId, stashRef });
      expect(await readFile(path.join(wsPath, "README.md"), "utf8")).toContain(
        "stashme",
      );
      await dropStash({ workspaceId, stashRef });
      expect((await listStashes(workspaceId)).length).toBe(0);
    });

    it("deleteBranch removes a branch but refuses the checked-out one", async () => {
      await git(wsPath, "branch", "tmp-branch");
      await deleteBranch({ workspaceId, branchName: "tmp-branch" });
      const branches = await git(wsPath, "branch", "--list", "tmp-branch");
      expect(branches.trim()).toBe("");
      const ws = getWorkspace(workspaceId);
      await expect(
        deleteBranch({ workspaceId, branchName: ws.branch }),
      ).rejects.toThrow();
    });

    it("tags create / list / delete", async () => {
      await createTag({ workspaceId, name: "v1.0.0", message: "release" });
      expect(await listTags(workspaceId)).toContain("v1.0.0");
      await deleteTag({ workspaceId, name: "v1.0.0" });
      expect(await listTags(workspaceId)).not.toContain("v1.0.0");
    });
  });

  describe("stage, unstage, and discard hunks", () => {
    it("stageHunk applies a patch to the index; unstageHunk reverses it", async () => {
      await appendFile(path.join(wsPath, "README.md"), "hunk line\n");
      // Real patch for the unstaged change.
      const d = await diff({
        workspaceId,
        mode: "worktree-vs-index",
        rawPatch: true,
      });
      expect(d.patch).toContain("hunk line");
      await stageHunk({ workspaceId, patch: d.patch! });
      let s = await status(workspaceId);
      expect(s.staged.find((f) => f.path === "README.md")?.status).toBe(
        "modified",
      );
      expect(s.unstaged).toEqual([]);
      // Reverse it back out of the index.
      const staged = await diff({
        workspaceId,
        mode: "index-vs-head",
        rawPatch: true,
      });
      await unstageHunk({ workspaceId, patch: staged.patch! });
      s = await status(workspaceId);
      expect(s.staged).toEqual([]);
    });

    it("discardHunk reverts a working-tree change", async () => {
      await appendFile(path.join(wsPath, "README.md"), "to discard\n");
      const d = await diff({
        workspaceId,
        mode: "worktree-vs-index",
        rawPatch: true,
      });
      await discardHunk({ workspaceId, patch: d.patch! });
      expect(await readFile(path.join(wsPath, "README.md"), "utf8")).toBe(
        "base\n",
      );
    });

    it("rejects an empty patch", async () => {
      await expect(stageHunk({ workspaceId, patch: "" })).rejects.toThrow();
    });
  });

  // ── Security: ref/branch flag-injection guard ────────────
  // refs/SHAs reach git as bare positionals (no `--` can protect them —
  // `git checkout -- x` means a *pathspec*), so a value like "--hard" or
  // "--abort" could change git's behavior. assertSafeGitRef rejects
  // "-"-leading refs across every ref-taking op, mirroring the path guard
  // already on stage/discard. git's own check-ref-format forbids
  // "-"-leading refs, so this never blocks a legitimate one.
  describe("ref/branch flag-injection guard", () => {
    it("merge rejects a flag-like branch", async () => {
      await expect(
        merge({ workspaceId, branch: "--abort" }),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    });

    it("cherryPick / revert reject a flag-like sha", async () => {
      await expect(
        cherryPick({ workspaceId, sha: "--quit" }),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      await expect(
        revert({ workspaceId, sha: "--no-edit" }),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    });

    it("reset rejects a flag-like ref (would inject --hard)", async () => {
      await expect(
        reset({ workspaceId, mode: "mixed", ref: "--hard" }),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    });

    it("checkoutBranch rejects a flag-like branch name", async () => {
      await expect(
        checkoutBranch({ workspaceId, branchName: "--orphan" }),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    });

    it("restoreFrom rejects a flag-like source", async () => {
      await expect(
        restoreFrom({
          workspaceId,
          paths: ["README.md"],
          source: "--staged",
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    });

    it("still accepts a legitimate branch (regression guard)", async () => {
      await git(repoRoot, "checkout", "-q", "-b", "legit");
      await writeFile(path.join(repoRoot, "ok.txt"), "ok\n");
      await git(repoRoot, "add", ".");
      await git(repoRoot, "commit", "-qm", "ok");
      await git(repoRoot, "checkout", "-q", "main");
      const r = await merge({ workspaceId, branch: "legit" });
      expect(r.merged).toBe(true);
    });
  });
});

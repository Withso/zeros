// Status + diff + log integration. Each test sets up a small repo and
// asserts the classifier handles statusMatrix triples correctly.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
  appendFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseUnifiedDiffFiles } from "../../../renderer/shell/workbench/tabs/changes-parse";
import {
  closeState,
  changeCounts,
  changeLineCounts,
  createWorkspace,
  diff,
  log,
  setStateRootForTesting,
  stagePaths,
  status,
} from "..";
import { upsertRepoByRoot } from "../../db/projects";

const execFileAsync = promisify(execFile);

/** Mirrors the Changes tab's own untracked "+N" rule (changes-tab.tsx), which
 *  is what the list on screen adds up. */
function countLines(content: string): number {
  if (content.length === 0) return 0;
  const body = content.endsWith("\n") ? content.slice(0, -1) : content;
  return body.length === 0 ? 0 : body.split("\n").length;
}

async function initRepo(repoRoot: string): Promise<void> {
  await mkdir(repoRoot, { recursive: true });
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repoRoot });
  await execFileAsync(
    "git",
    ["remote", "add", "origin", "https://example.com/test/diff.git"],
    {
      cwd: repoRoot,
    },
  );
  await execFileAsync("git", ["config", "user.email", "t@t"], {
    cwd: repoRoot,
  });
  await execFileAsync("git", ["config", "user.name", "t"], { cwd: repoRoot });
  await writeFile(path.join(repoRoot, "README.md"), "# initial\n");
  await execFileAsync("git", ["add", "."], { cwd: repoRoot });
  await execFileAsync("git", ["commit", "-q", "-m", "initial"], {
    cwd: repoRoot,
  });
}

describe("diff / status / log", () => {
  let workdir: string;
  let repoRoot: string;
  let stateRoot: string;
  let workspaceId: string;

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "zeros-diff-test-"));
    repoRoot = path.join(workdir, "repo");
    stateRoot = path.join(workdir, "state");
    setStateRootForTesting(stateRoot);
    await initRepo(repoRoot);
    const created = await createWorkspace({ repoRoot });
    workspaceId = created.workspaceId;
    // Set user.email/name in the worktree too so commits work there.
    await execFileAsync("git", [
      "-C",
      (await import("../state")).worktreesRoot(),
      "--version",
    ]);
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

  describe("status", () => {
    it("returns empty arrays on a clean worktree", async () => {
      const s = await status(workspaceId);
      expect(s.staged).toEqual([]);
      expect(s.unstaged).toEqual([]);
      expect(s.untracked).toEqual([]);
    });

    it("classifies a new untracked file", async () => {
      const ws = (await import("..")).getWorkspace(workspaceId);
      await writeFile(path.join(ws.path, "fresh.txt"), "hi\n");
      const s = await status(workspaceId);
      expect(s.untracked).toContain("fresh.txt");
      expect(s.staged).toEqual([]);
      expect(s.unstaged).toEqual([]);
    });

    it("classifies a new file as staged after git_stage", async () => {
      const ws = (await import("..")).getWorkspace(workspaceId);
      await writeFile(path.join(ws.path, "fresh.txt"), "hi\n");
      await stagePaths({ workspaceId, paths: ["fresh.txt"] });
      const s = await status(workspaceId);
      expect(s.staged.find((f) => f.path === "fresh.txt")?.status).toBe(
        "added",
      );
    });

    it("classifies a modified tracked file as unstaged", async () => {
      const ws = (await import("..")).getWorkspace(workspaceId);
      await appendFile(path.join(ws.path, "README.md"), "more\n");
      const s = await status(workspaceId);
      expect(s.unstaged.find((f) => f.path === "README.md")?.status).toBe(
        "modified",
      );
    });

    it("classifies a deletion as unstaged", async () => {
      const ws = (await import("..")).getWorkspace(workspaceId);
      await rm(path.join(ws.path, "README.md"));
      const s = await status(workspaceId);
      expect(s.unstaged.find((f) => f.path === "README.md")?.status).toBe(
        "deleted",
      );
    });

    it("treats a staged add deleted from disk as net-zero but keeps both index sides", async () => {
      const ws = (await import("..")).getWorkspace(workspaceId);
      await writeFile(path.join(ws.path, "test1.md"), "staged then removed\n");
      await stagePaths({ workspaceId, paths: ["test1.md"] });
      await rm(path.join(ws.path, "test1.md"));

      const s = await status(workspaceId);
      expect(s.staged).toContainEqual({ path: "test1.md", status: "added" });
      expect(s.unstaged).toContainEqual({
        path: "test1.md",
        status: "deleted",
      });
      await expect(changeCounts(workspaceId)).resolves.toEqual({
        all: 0,
        uncommitted: 0,
        staged: 1,
        unstaged: 1,
      });

      const [net, staged, unstaged] = await Promise.all([
        diff({ workspaceId, mode: "worktree-vs-head", rawPatch: true }),
        diff({ workspaceId, mode: "index-vs-head", rawPatch: true }),
        diff({ workspaceId, mode: "worktree-vs-index", rawPatch: true }),
      ]);
      expect(net.patch).toBe("");
      expect(staged.patch).toContain("new file mode");
      expect(unstaged.patch).toContain("deleted file mode");
    });
  });

  describe("changeLineCounts", () => {
    async function worktreePath(): Promise<string> {
      const ws = (await import("..")).getWorkspace(workspaceId);
      await execFileAsync("git", ["config", "user.email", "t@t"], {
        cwd: ws.path,
      });
      await execFileAsync("git", ["config", "user.name", "t"], {
        cwd: ws.path,
      });
      return ws.path;
    }

    it("is zero on a clean worktree", async () => {
      await expect(changeLineCounts(workspaceId)).resolves.toEqual({
        additions: 0,
        deletions: 0,
      });
    });

    it("sums committed and uncommitted tracked work in one net total", async () => {
      const cwd = await worktreePath();
      await writeFile(path.join(cwd, "feature.txt"), "a\nb\nc\n");
      await execFileAsync("git", ["add", "feature.txt"], { cwd });
      await execFileAsync("git", ["commit", "-q", "-m", "add feature"], {
        cwd,
      });
      // README.md starts as the single line "# initial".
      await writeFile(path.join(cwd, "README.md"), "# changed\nextra\n");

      await expect(changeLineCounts(workspaceId)).resolves.toEqual({
        additions: 5,
        deletions: 1,
      });
    });

    it("counts an untracked file's own lines, which no diff reports", async () => {
      const cwd = await worktreePath();
      // No trailing newline — the final partial line still counts, as Git counts it.
      await writeFile(path.join(cwd, "fresh.txt"), "one\ntwo\nthree");

      await expect(changeLineCounts(workspaceId)).resolves.toEqual({
        additions: 3,
        deletions: 0,
      });
    });

    it("ignores untracked binary content, matching Git's numstat '-'", async () => {
      const cwd = await worktreePath();
      await writeFile(
        path.join(cwd, "blob.bin"),
        Buffer.from([0x01, 0x00, 0x0a, 0x02]),
      );

      await expect(changeLineCounts(workspaceId)).resolves.toEqual({
        additions: 0,
        deletions: 0,
      });
    });

    it("counts a file whose first NUL is past Git's 8000-byte sniff", async () => {
      // Git's buffer_is_binary only inspects FIRST_FEW_BYTES (8000), so a file
      // whose first NUL lands after that is TEXT to Git and gets a real "+N".
      // Sniffing the WHOLE buffer instead scores it 0 while untracked and then
      // jumps to the true total the moment it is staged and the numstat path
      // takes over — the tab and the Changes list disagreeing in between.
      const cwd = await worktreePath();
      const text = Buffer.from(
        Array.from({ length: 2_000 }, (_, i) => `line ${i}`).join("\n") + "\n",
      );
      expect(text.length).toBeGreaterThan(10_000);
      await writeFile(
        path.join(cwd, "late-nul.txt"),
        Buffer.concat([
          text.subarray(0, 10_000),
          Buffer.from([0x00]),
          text.subarray(10_000),
        ]),
      );

      const untracked = await changeLineCounts(workspaceId);
      expect(untracked).toEqual({ additions: 2_000, deletions: 0 });
      // Staging routes the same file through `--numstat` instead. Git's own
      // count has to be the one we were already reporting.
      await stagePaths({ workspaceId, paths: ["late-nul.txt"] });
      await expect(changeLineCounts(workspaceId)).resolves.toEqual(untracked);
    });

    it("counts an untracked symlink as the one line Git stores for it", async () => {
      // Git stores a symlink's TARGET PATH as its blob content — one line —
      // never the bytes of whatever it points at. The scan opens untracked
      // paths with O_NOFOLLOW precisely so a link cannot redirect the read;
      // the ELOOP that refuses it is what this case is counted from. Without
      // that branch the link silently scores 0, and pointing one at a large
      // file inside the worktree would otherwise bill its whole contents here.
      const cwd = await worktreePath();
      const body = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
      await writeFile(path.join(cwd, "target.txt"), `${body}\n`);
      await symlink("target.txt", path.join(cwd, "link.txt"));

      // 40 for the real file, 1 for the link — not 80.
      await expect(changeLineCounts(workspaceId)).resolves.toEqual({
        additions: 41,
        deletions: 0,
      });
    });

    it("counts a deleted tracked file's removed lines", async () => {
      const cwd = await worktreePath();
      await rm(path.join(cwd, "README.md"));

      await expect(changeLineCounts(workspaceId)).resolves.toEqual({
        additions: 0,
        deletions: 1,
      });
    });

    it("reads a rename as its real edit, not a whole-file delete plus add", async () => {
      // `--numstat -z` writes a rename as an EMPTY path field followed by two
      // more NUL-terminated tokens. Mis-parsing that record is what turns one
      // appended line into a 13-add/12-delete pair, so the renamed file has to
      // exist at the FORK POINT for the record to appear at all.
      const body = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");
      await writeFile(path.join(repoRoot, "original.txt"), `${body}\n`);
      await execFileAsync("git", ["add", "original.txt"], { cwd: repoRoot });
      await execFileAsync("git", ["commit", "-q", "-m", "add original"], {
        cwd: repoRoot,
      });
      const renaming = await createWorkspace({ repoRoot });
      const cwd = (await import("..")).getWorkspace(renaming.workspaceId).path;
      await execFileAsync("git", ["mv", "original.txt", "renamed.txt"], {
        cwd,
      });
      await appendFile(path.join(cwd, "renamed.txt"), "line 12\n");

      await expect(changeLineCounts(renaming.workspaceId)).resolves.toEqual({
        additions: 1,
        deletions: 0,
      });
    });

    it("excludes filtered paths from BOTH the tracked and untracked totals", async () => {
      const cwd = await worktreePath();
      await writeFile(path.join(cwd, "README.md"), "# changed\n");
      await writeFile(path.join(cwd, ".env"), "SECRET=1\nOTHER=2\n");

      await expect(
        changeLineCounts(workspaceId, (filePath) => filePath !== ".env"),
      ).resolves.toEqual({ additions: 1, deletions: 1 });
      await expect(changeLineCounts(workspaceId, () => false)).resolves.toEqual(
        { additions: 0, deletions: 0 },
      );
    });

    it("never counts the internal .zeros/ seed", async () => {
      const cwd = await worktreePath();
      await mkdir(path.join(cwd, ".zeros"), { recursive: true });
      await writeFile(path.join(cwd, ".zeros", "seed.json"), "{}\nmore\n");

      await expect(changeLineCounts(workspaceId)).resolves.toEqual({
        additions: 0,
        deletions: 0,
      });
    });

    it("treats a staged-then-deleted add as net zero, like the All Changes count", async () => {
      const cwd = await worktreePath();
      await writeFile(path.join(cwd, "test1.md"), "staged then removed\n");
      await stagePaths({ workspaceId, paths: ["test1.md"] });
      await rm(path.join(cwd, "test1.md"));

      await expect(changeLineCounts(workspaceId)).resolves.toEqual({
        additions: 0,
        deletions: 0,
      });
    });

    it("does not measure a conflicted file's markers as changed lines", async () => {
      // An unmerged path DOES appear in `git diff --numstat`, and its diff is
      // the whole `<<<<<<< / ======= / >>>>>>>` block — five additions for a
      // one-line conflict here. The Changes list renders conflicts with no ±
      // (they need resolving, not measuring); the tab has to agree.
      const cwd = await worktreePath();
      await writeFile(path.join(cwd, "shared.txt"), "l1\nl2\nl3\n");
      await execFileAsync("git", ["add", "shared.txt"], { cwd });
      await execFileAsync("git", ["commit", "-q", "-m", "shared"], { cwd });
      await execFileAsync("git", ["checkout", "-q", "-b", "other"], { cwd });
      await writeFile(path.join(cwd, "shared.txt"), "l1\nOTHER\nl3\n");
      await execFileAsync("git", ["commit", "-q", "-am", "other"], { cwd });
      await execFileAsync("git", ["checkout", "-q", "-"], { cwd });
      await writeFile(path.join(cwd, "shared.txt"), "l1\nMINE\nl3\n");
      await execFileAsync("git", ["commit", "-q", "-am", "mine"], { cwd });
      await execFileAsync("git", ["merge", "-q", "other"], { cwd }).catch(
        () => {
          /* the conflict is the point */
        },
      );

      const tree = await status(workspaceId);
      expect(tree.conflicted.map((file) => file.path)).toEqual(["shared.txt"]);
      // shared.txt is the branch's only content, and all of it is conflicted.
      await expect(changeLineCounts(workspaceId)).resolves.toEqual({
        additions: 0,
        deletions: 0,
      });
    });

    it("agrees with the Changes list's own ± totals for the same scope", async () => {
      // The tab's pair and the Changes list are two different computations of
      // one number: a cheap `--numstat` here, a parsed whole-tree patch plus
      // per-file reads there. This is the test that keeps them honest.
      const cwd = await worktreePath();
      await writeFile(path.join(cwd, "committed.txt"), "a\nb\nc\nd\n");
      await execFileAsync("git", ["add", "committed.txt"], { cwd });
      await execFileAsync("git", ["commit", "-q", "-m", "committed work"], {
        cwd,
      });
      // …then every other shape the scope can contain, left uncommitted.
      await appendFile(path.join(cwd, "committed.txt"), "e\nf\n");
      await writeFile(path.join(cwd, "staged.txt"), "one\ntwo\n");
      await stagePaths({ workspaceId, paths: ["staged.txt"] });
      await writeFile(path.join(cwd, "untracked.txt"), "x\ny\nz\n");
      await rm(path.join(cwd, "README.md"));

      const [pair, patch, tree] = await Promise.all([
        changeLineCounts(workspaceId),
        diff({ workspaceId, mode: "worktree-vs-base", rawPatch: true }),
        status(workspaceId),
      ]);
      const listed = parseUnifiedDiffFiles(patch.patch ?? "");
      const untrackedAdditions = await Promise.all(
        tree.untracked.map(async (relativePath) =>
          countLines(await readFile(path.join(cwd, relativePath), "utf-8")),
        ),
      );

      expect(pair).toEqual({
        additions:
          listed.reduce((total, file) => total + file.additions, 0) +
          untrackedAdditions.reduce((total, lines) => total + lines, 0),
        deletions: listed.reduce((total, file) => total + file.deletions, 0),
      });
      // Guard the guard: a scope that measured nothing would pass vacuously.
      expect(pair.additions).toBeGreaterThan(0);
      expect(pair.deletions).toBeGreaterThan(0);
    });
  });

  describe("diff", () => {
    it("returns hunks for an unstaged modification", async () => {
      const ws = (await import("..")).getWorkspace(workspaceId);
      await writeFile(path.join(ws.path, "README.md"), "# changed\nmore\n");
      const d = await diff({ workspaceId });
      expect(d.hunks.length).toBeGreaterThan(0);
      const h = d.hunks[0];
      expect(h.filePath).toBe("README.md");
      expect(h.body).toMatch(/^@@/);
      expect(h.body).toContain("+# changed");
      expect(h.body).toContain("-# initial");
    });

    it("returns empty hunks when there's nothing to diff", async () => {
      const d = await diff({ workspaceId });
      expect(d.hunks).toEqual([]);
    });

    it("respects against=HEAD", async () => {
      const ws = (await import("..")).getWorkspace(workspaceId);
      await appendFile(path.join(ws.path, "README.md"), "more\n");
      await stagePaths({ workspaceId, paths: ["README.md"] });
      // Against index: should be empty (we staged everything).
      const dIndex = await diff({ workspaceId, against: "index" });
      expect(dIndex.hunks).toEqual([]);
      // Against HEAD: should show the change.
      const dHead = await diff({ workspaceId, against: "HEAD" });
      expect(dHead.hunks.length).toBeGreaterThan(0);
    });
  });

  describe("diff — worktree-vs-base (All changes)", () => {
    // Commit feature.txt on the worktree branch, then leave README.md modified in
    // the working tree (uncommitted). The two modes must disagree:
    //  • base ('base...HEAD', 3-dot) → ONLY the committed feature.txt.
    //  • worktree-vs-base ('git diff <forkPoint>') → committed feature.txt AND
    //    the uncommitted README.md — the branch's whole contribution.
    async function commitFeatureAndDirtyReadme(): Promise<string> {
      const ws = (await import("..")).getWorkspace(workspaceId);
      await execFileAsync("git", ["config", "user.email", "t@t"], {
        cwd: ws.path,
      });
      await execFileAsync("git", ["config", "user.name", "t"], {
        cwd: ws.path,
      });
      await writeFile(path.join(ws.path, "feature.txt"), "feature\n");
      await execFileAsync("git", ["add", "feature.txt"], { cwd: ws.path });
      await execFileAsync("git", ["commit", "-q", "-m", "add feature"], {
        cwd: ws.path,
      });
      // Uncommitted edit to a tracked file (no `git add`).
      await appendFile(path.join(ws.path, "README.md"), "uncommitted line\n");
      return ws.path;
    }

    it("includes BOTH committed and uncommitted tracked changes", async () => {
      await commitFeatureAndDirtyReadme();
      const d = await diff({
        workspaceId,
        mode: "worktree-vs-base",
        rawPatch: true,
      });
      expect(d.patch).toContain("feature.txt"); // committed
      expect(d.patch).toContain("README.md"); // uncommitted
      expect(d.patch).toContain("+uncommitted line");
    });

    it("base mode (3-dot) shows committed changes ONLY — the contrast", async () => {
      await commitFeatureAndDirtyReadme();
      const d = await diff({ workspaceId, mode: "base", rawPatch: true });
      expect(d.patch).toContain("feature.txt");
      expect(d.patch ?? "").not.toContain("README.md");
    });

    it("a fresh branch (no commits past base) shows just the uncommitted work", async () => {
      const ws = (await import("..")).getWorkspace(workspaceId);
      // No commit on the worktree — only a working-tree edit. The fork point is
      // HEAD itself, so worktree-vs-base degrades to `git diff HEAD`.
      await appendFile(path.join(ws.path, "README.md"), "wip\n");
      const d = await diff({
        workspaceId,
        mode: "worktree-vs-base",
        rawPatch: true,
      });
      expect(d.patch).toContain("README.md");
      expect(d.patch).toContain("+wip");
    });

    it("is empty on a clean worktree with no commits past base", async () => {
      const d = await diff({ workspaceId, mode: "worktree-vs-base" });
      expect(d.hunks).toEqual([]);
    });

    it("trunk ('Local main'): never anchors at the clone point — uncommitted only", async () => {
      // Regression: the trunk workspace sits ON the base branch, so
      // merge-base(base, HEAD) == HEAD and forkPoint used to fall back to the
      // branch's OLDEST reflog entry — which for a cloned repo is the clone
      // point. After a month of pulls that diffs the entire upstream history
      // (tens of MB: blows maxBuffer → "git diff <oid> failed", and every
      // upstream commit shows as a local change).
      const upstream = path.join(workdir, "upstream");
      await initRepo(upstream);
      const clone = path.join(workdir, "clone");
      await execFileAsync("git", ["clone", "-q", upstream, clone]);
      await execFileAsync("git", ["config", "user.email", "t@t"], {
        cwd: clone,
      });
      await execFileAsync("git", ["config", "user.name", "t"], { cwd: clone });
      // Upstream advances past the clone point, and the clone pulls it in —
      // main's oldest reflog entry (the clone point) is now behind HEAD.
      await writeFile(path.join(upstream, "upstream.txt"), "upstream work\n");
      await execFileAsync("git", ["add", "."], { cwd: upstream });
      await execFileAsync("git", ["commit", "-q", "-m", "upstream work"], {
        cwd: upstream,
      });
      await execFileAsync(
        "git",
        ["pull", "-q", "--ff-only", "origin", "main"],
        {
          cwd: clone,
        },
      );
      upsertRepoByRoot({ repoRoot: clone, repoSlug: "clone-sample" });

      // Clean trunk → no changes at all (NOT the pulled upstream history).
      const clean = await diff({
        workspaceId: clone,
        mode: "worktree-vs-base",
        rawPatch: true,
      });
      expect(clean.hunks).toEqual([]);
      expect(clean.patch ?? "").not.toContain("upstream.txt");

      // Dirty trunk → exactly the uncommitted edit.
      await appendFile(path.join(clone, "README.md"), "local wip\n");
      const dirty = await diff({
        workspaceId: clone,
        mode: "worktree-vs-base",
        rawPatch: true,
      });
      expect(dirty.patch).toContain("+local wip");
      expect(dirty.patch ?? "").not.toContain("upstream.txt");
    });

    it("a stale local base branch doesn't inflate the diff (fork point uses origin/<base>)", async () => {
      // Regression: worktrees are created from origin/<base>, but forkPoint
      // resolved the persisted base NAME to the bare local branch first. A
      // local `main` that's BEHIND origin/main anchored the fork point at the
      // stale local tip, so a brand-new clean worktree listed every upstream
      // commit local main was missing as its own changes (while the
      // status-based count badge said "no changes").
      const repo = path.join(workdir, "stale-base-repo");
      await initRepo(repo);
      // Local nonexistent remote URL → the best-effort fetch fails instantly
      // instead of hitting the network; the local origin/main ref set below
      // is what resolveWorktreeBase uses.
      await execFileAsync(
        "git",
        [
          "remote",
          "set-url",
          "origin",
          path.join(workdir, "no-such-remote.git"),
        ],
        { cwd: repo },
      );
      // Advance main by one commit, point origin/main at it, then rewind the
      // LOCAL main to the old tip — local main is now behind origin/main.
      const oldTip = (
        await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo })
      ).stdout.trim();
      await writeFile(path.join(repo, "newer.txt"), "newer upstream work\n");
      await execFileAsync("git", ["add", "."], { cwd: repo });
      await execFileAsync("git", ["commit", "-q", "-m", "newer"], {
        cwd: repo,
      });
      const newTip = (
        await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo })
      ).stdout.trim();
      await execFileAsync(
        "git",
        ["update-ref", "refs/remotes/origin/main", newTip],
        { cwd: repo },
      );
      await execFileAsync("git", ["remote", "set-head", "origin", "main"], {
        cwd: repo,
      });
      await execFileAsync("git", ["reset", "-q", "--hard", oldTip], {
        cwd: repo,
      });

      // createWorkspace forks from origin/main (the fetch is best-effort and
      // fails against the fake remote URL — the local origin/main ref is used).
      const created = await createWorkspace({
        repoRoot: repo,
        repoSlug: "stale-base",
      });
      const d = await diff({
        workspaceId: created.workspaceId,
        mode: "worktree-vs-base",
        rawPatch: true,
      });
      expect(d.hunks).toEqual([]);
      expect(d.patch ?? "").not.toContain("newer.txt");
    });
  });

  describe("log", () => {
    it("returns the initial commit", async () => {
      const commits = await log({ workspaceId });
      expect(commits.length).toBe(1);
      expect(commits[0].message).toContain("initial");
      expect(commits[0].sha).toMatch(/^[0-9a-f]{40}$/);
      expect(commits[0].abbreviatedSha).toMatch(/^[0-9a-f]{7}$/);
    });

    it("honors limit", async () => {
      const commits = await log({ workspaceId, limit: 1 });
      expect(commits.length).toBe(1);
    });

    it("rejects out-of-range limit", async () => {
      await expect(log({ workspaceId, limit: 10000 })).rejects.toThrow();
      await expect(log({ workspaceId, limit: 0 })).rejects.toThrow();
    });

    it("base scopes the log to this branch's own commits (base..HEAD)", async () => {
      const ws = (await import("..")).getWorkspace(workspaceId);
      // A commit ON the worktree branch, on top of main.
      await execFileAsync("git", ["config", "user.email", "t@t"], {
        cwd: ws.path,
      });
      await execFileAsync("git", ["config", "user.name", "t"], {
        cwd: ws.path,
      });
      await writeFile(path.join(ws.path, "feature.txt"), "feature\n");
      await execFileAsync("git", ["add", "feature.txt"], { cwd: ws.path });
      await execFileAsync("git", ["commit", "-q", "-m", "add feature"], {
        cwd: ws.path,
      });

      // Full history (no base) walks past the fork point into main's "initial".
      const all = await log({ workspaceId });
      expect(all.map((c) => c.message.trim())).toEqual([
        "add feature",
        "initial",
      ]);

      // base..HEAD lists ONLY the worktree's own commit — not main's history.
      const own = await log({ workspaceId, base: "main" });
      expect(own.length).toBe(1);
      expect(own[0].message.trim()).toBe("add feature");
      expect(own[0].sha).toMatch(/^[0-9a-f]{40}$/);
      expect(own[0].abbreviatedSha).toMatch(/^[0-9a-f]{7}$/);
      expect(own[0].authorName).toBe("t");
    });

    it("falls back to the trunk when base can't be resolved", async () => {
      const ws = (await import("..")).getWorkspace(workspaceId);
      await execFileAsync("git", ["config", "user.email", "t@t"], {
        cwd: ws.path,
      });
      await execFileAsync("git", ["config", "user.name", "t"], {
        cwd: ws.path,
      });
      await writeFile(path.join(ws.path, "feature.txt"), "feature\n");
      await execFileAsync("git", ["add", "feature.txt"], { cwd: ws.path });
      await execFileAsync("git", ["commit", "-q", "-m", "add feature"], {
        cwd: ws.path,
      });

      // A base that no longer exists must NOT yield an empty list — it falls
      // back to the trunk (main), so the worktree's own commit still shows.
      const own = await log({ workspaceId, base: "ghost-branch-deleted" });
      expect(own.map((c) => c.message.trim())).toEqual(["add feature"]);
    });

    it("recovers commits via the reflog after the base absorbs the branch", async () => {
      const ws = (await import("..")).getWorkspace(workspaceId);
      await execFileAsync("git", ["config", "user.email", "t@t"], {
        cwd: ws.path,
      });
      await execFileAsync("git", ["config", "user.name", "t"], {
        cwd: ws.path,
      });
      await writeFile(path.join(ws.path, "feature.txt"), "feature\n");
      await execFileAsync("git", ["add", "feature.txt"], { cwd: ws.path });
      await execFileAsync("git", ["commit", "-q", "-m", "add feature"], {
        cwd: ws.path,
      });
      const head = (
        await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: ws.path })
      ).stdout.trim();
      // Fast-forward main ONTO the worktree's commit: main now contains it, so
      // `main..HEAD` is empty even though this worktree is what added it.
      await execFileAsync("git", ["merge", "--ff-only", head], {
        cwd: repoRoot,
      });

      // The fork point is recovered from the branch's creation reflog, so the
      // worktree still shows the commit it contributed (not an empty list).
      const own = await log({ workspaceId, base: "main" });
      expect(own.map((c) => c.message.trim())).toEqual(["add feature"]);
    });
  });
});

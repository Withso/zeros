// Phase 0 critical-bug regression tests.
//   C1 — porcelain `-z` byte-exact paths (spaces / renames)
//   C4 — archiveWorkspace captures untracked files on a round-trip
//   C5 — commit() succeeds (and reports branch) on a detached HEAD
//   C6 — diff(against:'main') is 3-dot (base advances ≠ deletions)

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
  archiveWorkspace,
  closeState,
  commit,
  createWorkspace,
  createWorkspaceFromBranch,
  diff,
  getWorkspace,
  restoreWorkspace,
  setStateRootForTesting,
  stagePaths,
  status,
} from "..";
import {
  getWorkspaceById,
  seedFromDisk,
  worktreesRoot,
} from "../state";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

async function initRepo(repoRoot: string): Promise<void> {
  await mkdir(repoRoot, { recursive: true });
  await git(repoRoot, "init", "-q", "-b", "main");
  await git(repoRoot, "remote", "add", "origin", "https://example.com/t/p0.git");
  await git(repoRoot, "config", "user.email", "t@t");
  await git(repoRoot, "config", "user.name", "t");
  await writeFile(path.join(repoRoot, "README.md"), "# initial\n");
  await git(repoRoot, "add", ".");
  await git(repoRoot, "commit", "-q", "-m", "initial");
}

describe("Phase 0 fixes", () => {
  let workdir: string;
  let repoRoot: string;
  let workspaceId: string;
  let wsPath: string;

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "zeros-p0-"));
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

  // ── C1 ──────────────────────────────────────────────────
  describe("C1 — porcelain -z byte-exact paths", () => {
    it("reports a path with a space byte-exact (not C-quoted)", async () => {
      await writeFile(path.join(wsPath, "my file.txt"), "hi\n");
      const s = await status(workspaceId);
      expect(s.untracked).toContain("my file.txt");
      // The quoted form `"my file.txt"` must NOT appear.
      expect(s.untracked.some((p) => p.startsWith('"'))).toBe(false);
    });

    it("stages and diffs a spaced path end-to-end", async () => {
      await writeFile(path.join(wsPath, "a b.txt"), "one\n");
      await stagePaths({ workspaceId, paths: ["a b.txt"] });
      const s = await status(workspaceId);
      expect(s.staged.find((f) => f.path === "a b.txt")?.status).toBe("added");
      expect(s.untracked).not.toContain("a b.txt");
    });

    it("surfaces a rename with the correct old/new paths", async () => {
      await writeFile(path.join(wsPath, "old name.txt"), "x\n");
      await git(wsPath, "add", ".");
      await git(wsPath, "commit", "-q", "-m", "add old");
      await git(wsPath, "mv", "old name.txt", "new name.txt");
      const s = await status(workspaceId);
      const renamed = s.staged.find((f) => f.path === "new name.txt");
      expect(renamed?.status).toBe("renamed");
      expect(renamed?.oldPath).toBe("old name.txt");
    });
  });

  // ── C4 ──────────────────────────────────────────────────
  describe("C4 — archive captures untracked files", () => {
    it("round-trips both tracked edits and untracked files", async () => {
      await appendFile(path.join(wsPath, "README.md"), "tracked edit\n");
      await writeFile(path.join(wsPath, "untracked.txt"), "agent output\n");

      const { stashRef, archiveSnapshot } = await archiveWorkspace({
        workspaceId,
        stashUncommitted: true,
      });
      // v17: archive captures a durable snapshot (refs/zeros/archive/<id>),
      // not a stash — but the C4 guarantee (untracked work survives) holds.
      expect(stashRef).toBeNull();
      expect(archiveSnapshot).toBeTruthy();
      expect(existsSync(wsPath)).toBe(false);

      const { conflicts } = await restoreWorkspace(workspaceId);
      expect(conflicts).toEqual([]);
      // The untracked file must survive — this is the C4 data-loss bug.
      expect(existsSync(path.join(wsPath, "untracked.txt"))).toBe(true);
      expect(await readFile(path.join(wsPath, "untracked.txt"), "utf8")).toBe(
        "agent output\n",
      );
      expect(await readFile(path.join(wsPath, "README.md"), "utf8")).toContain(
        "tracked edit",
      );
    });

    it("does not capture a stale stash SHA on a clean worktree", async () => {
      const { stashRef } = await archiveWorkspace({
        workspaceId,
        stashUncommitted: true,
      });
      expect(stashRef).toBeNull();
    });
  });

  // ── C5 ──────────────────────────────────────────────────
  describe("C5 — commit on detached HEAD", () => {
    it("commits successfully and reports branch HEAD when detached", async () => {
      // Make a real commit so HEAD has somewhere to detach onto.
      await writeFile(path.join(wsPath, "f.txt"), "1\n");
      await stagePaths({ workspaceId, paths: ["f.txt"] });
      await commit({ workspaceId, message: "first" });

      await git(wsPath, "checkout", "--detach", "-q");
      await appendFile(path.join(wsPath, "f.txt"), "2\n");
      await stagePaths({ workspaceId, paths: ["f.txt"] });

      const res = await commit({ workspaceId, message: "on detached head" });
      expect(res.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(res.branch).toBe("HEAD");
      // The commit truly landed.
      const log = await git(wsPath, "log", "-1", "--format=%s");
      expect(log.trim()).toBe("on detached head");
    });
  });

  // ── C6 ──────────────────────────────────────────────────
  describe("C6 — 3-dot base diff", () => {
    it("does not render base-branch advances as deletions", async () => {
      // Workspace adds a feature commit on its own branch.
      await writeFile(path.join(wsPath, "feature.txt"), "feature\n");
      await git(wsPath, "add", ".");
      await git(wsPath, "commit", "-q", "-m", "add feature");

      // Meanwhile main advances in the root checkout.
      await appendFile(path.join(repoRoot, "README.md"), "main moved on\n");
      await git(repoRoot, "commit", "-aqm", "advance main");

      const d = await diff({ workspaceId, against: "main" });
      const body = d.hunks.map((h) => `${h.filePath}\n${h.body}`).join("\n");
      // Our feature shows up...
      expect(body).toContain("feature.txt");
      // ...and main's advance is NOT shown as a deletion of README.
      expect(body).not.toContain("-main moved on");
    });
  });

  // ── C9 ──────────────────────────────────────────────────
  describe("C9 — seedFromDisk safety", () => {
    it("skips a seed missing repoRoot/branch (no junk row)", async () => {
      const slug = "acme-bogus";
      const id = "bogus-ws-id";
      const dir = path.join(worktreesRoot(), slug, id, ".zeros");
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, "workspace.json"),
        JSON.stringify({ id, repoSlug: slug }), // no repoRoot / branch
        "utf8",
      );
      const res = seedFromDisk();
      expect(res.inserted).toBe(0);
      expect(getWorkspaceById(id)).toBeNull();
    });

    it("recovers a valid on-disk seed missing from the DB", async () => {
      const slug = "acme-recover";
      const id = "recover-ws-id";
      const wsPath = path.join(worktreesRoot(), slug, id);
      const dir = path.join(wsPath, ".zeros");
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, "workspace.json"),
        JSON.stringify({
          id,
          repoSlug: slug,
          repoRoot,
          branch: "zeros/recover-1234",
          baseBranch: "main",
        }),
        "utf8",
      );
      const res = seedFromDisk();
      expect(res.inserted).toBe(1);
      expect(getWorkspaceById(id)?.repoRoot).toBe(repoRoot);
    });
  });

  // ── C10 ─────────────────────────────────────────────────
  describe("C10 — branch uniqueness on adopt", () => {
    it("refuses to adopt a branch that already has a (archived) workspace", async () => {
      await git(repoRoot, "branch", "feature-x");
      const made = await createWorkspaceFromBranch({
        repoRoot,
        branchName: "feature-x",
      });
      // Archive it: folder removed, DB row remains as archived.
      await archiveWorkspace({
        workspaceId: made.workspaceId,
        stashUncommitted: false,
      });
      await expect(
        createWorkspaceFromBranch({ repoRoot, branchName: "feature-x" }),
      ).rejects.toMatchObject({ code: "WORKSPACE_ALREADY_EXISTS" });
    });
  });
});
